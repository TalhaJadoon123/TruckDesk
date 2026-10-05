import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { DomainError, PLANS } from '@truckdesk/shared';

import authPlugin, { sendError } from './auth.plugin.js';
import { describeCapabilities, type Env } from './env.js';
import { capabilityCatalog } from '@truckdesk/integrations';
import financeRoutes, { publicRoutes } from './routes/finance.js';
import fleetRoutes from './routes/fleet.js';
import integrationRoutes from './routes/integrations.js';
import loadRoutes from './routes/loads.js';
import { createServices, realtimeStatus, type Services } from './services/container.js';

/**
 * The Fastify application.
 *
 * `buildServer` returns an instance without listening, so tests can drive it with
 * `inject()` and the Worker can reuse the same wiring. Nothing here reads the
 * clock or the environment directly: everything arrives through the container.
 */

export interface BuildServerOptions {
  services?: Services;
  env?: Env;
  /** Force the in-memory store. Tests set this. */
  memory?: boolean;
  logger?: boolean;
}

export interface TruckDeskServer extends FastifyInstance {
  tdServices: Services;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<TruckDeskServer> {
  const services =
    options.services ??
    createServices({
      ...(options.env ? { env: options.env } : {}),
      ...(options.memory !== undefined ? { memory: options.memory } : {}),
    });

  const config = services.env;
  const logger =
    options.logger ?? (config.NODE_ENV !== 'test' && process.env['LOG_LEVEL'] !== 'silent');

  /**
   * Per-IP failure counter for the unauthenticated credential endpoints. Kept
   * in-process, which is the right trade for a single-node deploy: with several
   * replicas each holds its own window, so a distributed spray is under-counted
   * by the replica count. That is a deliberate accepted limit, recorded in
   * docs/OPERATIONS.md rather than left implicit.
   */
  const loginAttempts = new Map<string, { count: number; last: number }>();

  const app = Fastify({
    logger,
    // Behind a proxy, which is how Cloudflare and a Docker deploy both arrive.
    trustProxy: true,
    disableRequestLogging: config.NODE_ENV === 'production',
    // Must comfortably exceed the largest legal upload. A POD photo arrives as
    // base64 in a JSON envelope, which inflates the raw file by about 37%, so a
    // 12MB photo needs ~17MB of request body. Setting this lower than the
    // documented upload limit is a silent, hard-to-diagnose failure: the client
    // is told the file is too big while the app says 12MB is fine.
    bodyLimit: Math.ceil(config.MAX_UPLOAD_BYTES * 1.5) + 64 * 1024,
  }) as unknown as TruckDeskServer;

  app.decorate('tdServices', services);

  /* ------------------------------------------------------------ plugins */

  await app.register(cors, {
    origin: resolveOrigins(config),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Api-Key'],
  });

  await app.register(rateLimit, {
    // The free tiers are the binding constraint, so the limit is generous for
    // humans and tight enough to stop a runaway mobile retry loop.
    max: 600,
    timeWindow: '1 minute',
    // Only the health probe is exempt. `/track/ping` used to be exempt too,
    // which is wrong: it writes a row per ping, so an unauthenticated flood of
    // it is both a storage-exhaustion vector and a way to poison the map.
    // The driver's phone is bounded by the fact that a truck pings at most once
    // a minute, which is three orders of magnitude below this limit.
    allowList: (request) => request.url.startsWith('/health'),
    keyGenerator: (request) => {
      // Key on the token's tail so one driver's phone cannot exhaust another
      // driver's budget. It is a rate-limit key, not a secret, so hashing it
      // would add nothing.
      const header = request.headers.authorization;
      if (header && header.length > 20) return header.slice(-20);
      return request.ip;
    },
  });

  /**
   * A much tighter limit on the unauthenticated endpoints worth attacking:
   * signing in and the public calculator. A global limiter at 600/min would
   * leave a password spray effectively unthrottled.
   *
   * The hook is added to the *root* instance, not inside a `register()`ed
   * plugin. Fastify encapsulates: a hook added inside a plugin only applies to
   * that plugin's own routes and children, so registering it as a sibling would
   * silently never run for the routes it was written to protect. That mistake
   * was caught by `pnpm gate`, which is the reason the gate exists.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return;

    const path = request.url.split('?')[0] ?? request.url;
    if (path !== '/public/login' && path !== '/signup') return;

    const now = Date.now();
    const key = request.ip;
    const entry = loginAttempts.get(key);

    // Sliding window: five failures, then a fifteen-minute lockout.
    if (entry && entry.count >= 5 && now - entry.last < 15 * 60_000) {
      const retryAfter = Math.ceil((15 * 60_000 - (now - entry.last)) / 1000);
      return reply
        .header('Retry-After', String(retryAfter))
        .code(429)
        .send({
          error: {
            code: 'RATE_LIMITED',
            message: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
          },
        });
    }

    // Stale window: start a fresh count.
    if (!entry || now - entry.last > 15 * 60_000) {
      loginAttempts.set(key, { count: 0, last: now });
    }
  });

  /** Called by `/public/login` and `/signup` so a real failure is counted. */
  app.decorate('recordLoginFailure', (ip: string) => {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.last > 15 * 60_000) {
      loginAttempts.set(ip, { count: 1, last: now });
      return;
    }
    loginAttempts.set(ip, { count: entry.count + 1, last: now });
  });

  await app.register(authPlugin, { services });

  /* -------------------------------------------------------------- routes */

  await app.register(publicRoutes, { services });
  await app.register(loadRoutes, { services });
  await app.register(fleetRoutes, { services });
  await app.register(financeRoutes, { services });
  await app.register(integrationRoutes, { services });

  /* ------------------------------------------------------------- meta */

  app.get('/capabilities', async (_request, reply) => {
    return reply.send({
      capabilities: describeCapabilities(config),
      integrations: capabilityCatalog(),
      realtime: realtimeStatus(services),
      plans: Object.values(PLANS).map((plan) => ({
        id: plan.id,
        name: plan.name,
        priceCents: plan.priceCents,
        maxTrucks: plan.maxTrucks,
        maxDrivers: plan.maxDrivers,
      })),
    });
  });

  app.get('/', async (_request, reply) => {
    return reply.send({
      name: 'TruckDesk API',
      version: '1.0.0',
      docs: '/docs/README.md',
      endpoints: [
        'GET  /health',
        'GET  /capabilities',
        'GET  /pricing',
        'POST /public/ifta',
        'POST /signup',
        'GET  /dashboard',
        'GET  /loads',
        'POST /loads',
        'GET  /loads/:id',
        'POST /loads/parse-email',
        'POST /loads/import-csv',
        'GET  /dispatch/board',
        'POST /dispatch',
        'POST /dispatch/unassign',
        'POST /dispatch/bulk',
        'POST /dispatch/auto-assign',
        'POST /dispatch/match',
        'POST /loads/:id/status',
        'POST /loads/:id/cancel',
        'POST /loads/:id/stops/:stopId/arrive',
        'POST /loads/:id/stops/:stopId/complete',
        'POST /loads/:id/documents',
        'GET  /loads/:id/document.pdf?kind=bol|pod|rate_con',
        'GET  /trucks',
        'POST /trucks',
        'GET  /drivers',
        'POST /track/ping',
        'GET  /track',
        'GET  /track/:id',
        'GET  /hos',
        'GET  /integrations',
        'GET  /integrations/lane?from=&to=',
        'GET  /integrations/load/:id/weather',
        'GET  /integrations/geocode?q=',
        'POST /integrations/vin',
        'GET  /integrations/alerts?lat=&lng=',
        'POST /ifta/calculate',
        'GET  /ifta/jurisdictions',
        'POST /settle',
        'POST /invoice',
        'GET  /invoice/aging',
        'GET  /invoice/:id/quickpay',
      ],
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  app.setErrorHandler((raw: unknown, request, reply) => {
    const error = raw as { statusCode?: number; validation?: unknown; message?: string };
    if (error instanceof DomainError) {
      return sendError(reply, error);
    }

    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (status === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests; slow down.' },
      });
    }
    if (status === 400 && error.validation) {
      return sendError(reply, error);
    }

    request.log.error({ err: error }, 'Unhandled request error');

    return reply.code(status >= 500 ? 500 : status).send({
      error: {
        code: status >= 500 ? 'INTERNAL' : 'INVALID_INPUT',
        // Never leak an internal message or stack to a client.
        message: status >= 500 ? 'Internal server error' : (error.message ?? 'Bad request'),
      },
    });
  });

  return app;
}

function resolveOrigins(config: Env): true | string[] {
  if (config.CORS_ORIGINS) {
    return config.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }
  // Localhost by default; a wildcard in production would be a real hole.
  if (config.NODE_ENV === 'production') {
    return ['https://truckdesk.app'];
  }
  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:4000',
    'http://localhost:8081',
  ];
}

export type { Services };
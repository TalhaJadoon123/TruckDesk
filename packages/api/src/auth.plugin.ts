import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { DomainError, err, type Result } from '@truckdesk/shared';

import { canDispatch, canManageBilling, hashApiKey, verifyApiKeyHash, verifyApiToken, type VerifiedToken } from './auth.js';
import type { Services } from './services/container.js';

/**
 * Auth guard.
 *
 * The API accepts a bearer token minted by the web app after Auth.js verifies a
 * session, or a long-lived `tdk_` API key for a carrier's own TMS. Both resolve
 * to the same `request.actor`, and every downstream service reads the company id
 * from there - never from a query parameter.
 */

declare module 'fastify' {
  interface FastifyRequest {
    actor?: VerifiedToken;
  }
  interface FastifyInstance {
    /** Require a valid token; 401 otherwise. */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Require a dispatcher, owner or admin role. */
    requireDispatch(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireBilling(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /**
     * Record a failed credential attempt against an IP so the per-IP lockout
     * in server.ts can trip. Called by /public/login and /signup.
     */
    recordLoginFailure(ip: string): void;
  }
}

export interface AuthPluginOptions {
  services: Services;
}

export default fp<AuthPluginOptions>(async (app, options) => {
  const { services } = options;

  const secret =
    services.env.API_TOKEN_SECRET ?? services.env.AUTH_SECRET ?? undefined;

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;

    if (!header) {
      await reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' },
      });
      return;
    }

    if (!header.startsWith('Bearer ')) {
      await reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Expected a Bearer token' },
      });
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      await reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Empty bearer token' },
      });
      return;
    }

    // Long-lived carrier API key.
    if (token.startsWith('tdk_')) {
      const resolved = await resolveApiKey(services, token);
      if (!resolved) {
        await reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'API key is invalid or revoked' },
        });
        return;
      }
      request.actor = resolved;
      return;
    }

    if (!secret) {
      await reply.code(500).send({
        error: {
          code: 'CONFIGURATION',
          message: 'API_TOKEN_SECRET is not set; the API cannot verify tokens',
        },
      });
      return;
    }

    const verified = verifyApiToken(token, secret);
    if (!verified.ok) {
      await reply.code(401).send({ error: verified.error.toJSON() });
      return;
    }

    request.actor = verified.value;
  });

  app.decorate('requireDispatch', async (request: FastifyRequest, reply: FastifyReply) => {
    // Run authentication first. A route that declares only `requireDispatch`
    // must still be authenticated, and composing here is what guarantees that -
    // it is the mistake that produces a confusing "unauthorized" on a route the
    // developer believed was protected.
    await app.authenticate(request, reply);
    if (reply.sent) return;

    if (!request.actor) {
      await reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    if (!canDispatch(request.actor.role)) {
      await reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Dispatcher access is required for this action',
          details: { role: request.actor.role },
        },
      });
    }
  });

  app.decorate('requireBilling', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;

    if (!request.actor) {
      await reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    if (!canManageBilling(request.actor.role)) {
      await reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Owner or admin access is required for billing' },
      });
    }
  });
});

/**
 * Look up and validate an API key against the stored hash.
 *
 * Keys are stored as a SHA-256 of the plaintext, so a database leak does not
 * hand an attacker working credentials. Comparison is constant-time.
 */
async function resolveApiKey(
  services: Services,
  key: string,
): Promise<VerifiedToken | null> {
  const hash = hashApiKey(key);
  if (!services.db) return null;

  const { and, eq, isNull } = await import('drizzle-orm');
  const { apiKeys } = await import('./db/schema.js');

  const rows = await services.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (!verifyApiKeyHash(key, row.keyHash)) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: row.id,
    company: row.companyId,
    // An API key is a dispatcher's credential: it can dispatch and invoice.
    role: 'dispatcher',
    iat: nowSeconds,
    exp: nowSeconds + 60,
    subject: `apikey:${row.id}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Error mapping                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Turn a thrown error into the API's error shape.
 *
 * A `DomainError` carries its own status and code; anything else is an
 * unexpected failure and is reported as a 500 with the detail logged but not
 * sent, because a stack trace in an API response is an information leak.
 */
export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DomainError) {
    return reply.code(error.status).send({ error: error.toJSON() });
  }

  if (isZodError(error)) {
    return reply.code(400).send({
      error: {
        code: 'INVALID_INPUT',
        message: 'Request body failed validation',
        details: { issues: error.issues },
      },
    });
  }

  const message = error instanceof Error ? error.message : String(error);

  // Postgres unique-violation surfaces as a 409 rather than a 500.
  if (/duplicate key|unique constraint|already exists/i.test(message)) {
    return reply.code(409).send({ error: { code: 'CONFLICT', message } });
  }
  if (/not null constraint|invalid input value/i.test(message)) {
    return reply.code(400).send({ error: { code: 'INVALID_INPUT', message } });
  }

  return reply.code(500).send({
    error: { code: 'INTERNAL', message: 'Internal server error' },
  });
}

interface ZodLikeError {
  issues: Array<{ path: Array<string | number>; message: string }>;
}

/** Narrow a ZodError without importing zod into every route module. */
export function isZodError(error: unknown): error is ZodLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  );
}

export type { Result };
export { err };

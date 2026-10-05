import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { MemoryTrackingStore, TrackingEngine, calculateIfta } from '@truckdesk/core';
import { PLANS, Errors, formatUsd } from '@truckdesk/shared';
import type { JurisdictionMileage } from '@truckdesk/core';
import { parseBrokerEmail, GroqClient } from '@truckdesk/llm';
import { verifyApiToken } from './auth.js';
import { envValue } from './env.js';

/**
 * Cloudflare Worker entry point.
 *
 * Free tier: 100,000 requests/day, which is far more than a 25-truck carrier
 * needs, and it runs close to the driver so pings leave the phone and stop.
 *
 * What runs here is the read-heavy, compute-pure surface:
 *   - health, pricing and the public IFTA calculator
 *   - live truck positions from Durable Object-free in-isolate memory plus KV
 *   - broker email parsing with Groq
 *   - public load tracking
 *
 * What does not: writes. Postgres from Workers requires Hyperdrive, which is a
 * paid add-on, so the Worker proxies reads to the Node API (env `API_ORIGIN`) and
 * holds no durable state of its own. That split is stated in the README rather
 * than hidden behind a stub that 500s.
 */

/**
 * Minimal KV binding interface, declared locally rather than importing
 * `@cloudflare/workers-types` so the Node build of this package does not need a
 * Workers-only type package in its include path.
 */
interface KvNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

interface Env {
  API_ORIGIN?: string;
  API_TOKEN?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  POSITIONS?: KvNamespace;
  CORS_ORIGINS?: string;
  ENVIRONMENT?: string;
}

type Bindings = Env;

/** In-isolate ping buffer. Isolates are short-lived, which is fine for "now". */
const isolatePings = new Map<string, { lat: number; lng: number; at: string; unit: string }>();

const app = new Hono<{ Bindings: Bindings }>();

/* -------------------------------------------------------------------------- */
/* Middleware                                                                    */
/* -------------------------------------------------------------------------- */

app.use('*', cors({ origin: (origin) => origin ?? '*', allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'OPTIONS'] }));

app.onError((error, c) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return c.json({ error: { code: 'INTERNAL', message } }, 500);
});

/* -------------------------------------------------------------------------- */
/* Public                                                                        */
/* -------------------------------------------------------------------------- */

app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'truckdesk-worker', version: '1.0.0', timestamp: new Date().toISOString() }),
);

app.get('/pricing', (c) =>
  c.json({
    plans: Object.values(PLANS).map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      priceFormatted: plan.priceCents === 0 ? 'Free' : formatUsd(plan.priceCents),
      maxTrucks: plan.maxTrucks,
      maxDrivers: plan.maxDrivers,
    })),
  }),
);

/** The free IFTA calculator, same engine as the app. */
app.post('/public/ifta', async (c) => {
  try {
    const body = (await c.req.json()) as {
      milesByState?: Record<string, number>;
      gallonsByState?: Record<string, number>;
      mpg?: number;
    };

    const states = Object.entries(body.milesByState ?? {}).filter(([, miles]) => Number.isFinite(miles) && miles > 0);
    if (states.length === 0) throw Errors.invalidInput('Enter at least one state with miles');
    if (states.length > 12) throw Errors.invalidInput('That is more than 12 states; the calculator caps at 12');

    const period = {
      label: `${new Date().getUTCFullYear()}-H1`,
      start: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString(),
      end: new Date(Date.UTC(new Date().getUTCFullYear(), 5, 30, 23, 59, 59, 999)).toISOString(),
    };

    const vehicles = [
      {
        vehicleId: 'calculator',
        unit: 'Your truck',
        ...(body.mpg && body.mpg > 0 ? { actualMpg: body.mpg } : {}),
        mileage: states.map(([code, miles]): JurisdictionMileage => ({
          jurisdictionCode: code.toUpperCase(),
          totalMiles: Math.round(miles),
          loadedMiles: Math.round(miles),
          ...(body.gallonsByState?.[code] !== undefined
            ? { taxableGallons: body.gallonsByState[code] as number, fuelCreditGallons: body.gallonsByState[code] as number }
            : {}),
        })),
      },
    ];

    const result = calculateIfta({ vehicles, period });
    if (!result.ok) throw result.error;

    const combined = result.value.combined;
    return c.json({
      period,
      lines: combined.lines.map((line) => ({
        state: line.jurisdictionCode,
        name: line.jurisdictionName,
        miles: line.totalMiles,
        taxableFraction: line.taxableFraction,
        apportionedGallons: line.apportionedGallons,
        taxCents: line.apportionedTaxCents,
        creditCents: line.fuelCreditCents,
        netCents: line.netTaxDueCents,
      })),
      totalMiles: combined.totalMilesAllJurisdictions,
      netTaxDueCents: combined.netTaxDueCents,
      netTaxDueFormatted: formatUsd(combined.netTaxDueCents),
      note: 'Estimated from current IFTA rates. Confirm with your accountant before filing.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Calculation failed';
    const rawStatus = (error as { status?: unknown } | null)?.status;
    const status = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 400;
    return c.json({ error: { code: 'INVALID_INPUT', message } }, status as 400);
  }
});

/* -------------------------------------------------------------------------- */
/* Email parsing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Broker email parsing. Groq's free tier plus a short timeout means this is
 * comfortably inside the Worker's CPU limits; the deterministic parser covers the
 * case where Groq is unreachable.
 */
app.post('/parse-email', async (c) => {
  try {
    const body = (await c.req.json()) as {
      subject?: string;
      from?: string;
      body: string;
      receivedAt?: string;
    };
    if (!body.body) throw Errors.invalidInput('Email has no body');

    const config = c.env as Bindings;
    const client = new GroqClient({
      ...(config.GROQ_API_KEY ? { apiKey: config.GROQ_API_KEY } : {}),
      ...(config.GROQ_MODEL ? { model: config.GROQ_MODEL } : {}),
      timeoutMs: 15_000,
      offline: !config.GROQ_API_KEY,
    });

    const result = await parseBrokerEmail(
      { subject: body.subject, from: body.from, body: body.body, receivedAt: body.receivedAt },
      client,
    );
    if (!result.ok) throw result.error;

    return c.json({ ...result.value, llmLive: client.isLive() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Parse failed';
    return c.json({ error: { code: 'INVALID_INPUT', message } }, 400);
  }
});

/* -------------------------------------------------------------------------- */
/* Live positions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Accepts a ping, keeps it in memory for the isolate and in KV for a slightly
 * longer horizon, then answers position queries from whichever is available.
 */
app.post('/position', async (c) => {
  try {
    const config = c.env as Bindings;
    if (config.API_TOKEN) {
      const header = c.req.header('Authorization');
      if (!header?.startsWith('Bearer ') || header.slice(7).trim() !== config.API_TOKEN) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid worker token' } }, 401);
      }
    }

    const body = (await c.req.json()) as {
      truckId: string;
      unit?: string;
      lat: number;
      lng: number;
      at?: string;
      speedMph?: number;
      headingDeg?: number;
    };

    if (!body.truckId || !Number.isFinite(body.lat) || !Number.isFinite(body.lng)) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'truckId, lat and lng are required' } }, 400);
    }

    const record = {
      lat: body.lat,
      lng: body.lng,
      at: body.at ?? new Date().toISOString(),
      unit: body.unit ?? '',
    };

    isolatePings.set(body.truckId, record);

    // KV is eventually consistent, which is fine for a 60-second cache.
    const kv = config.POSITIONS;
    if (kv) {
      await kv.put(`pos:${body.truckId}`, JSON.stringify(record), { expirationTtl: 300 });
    }

    return c.json({ accepted: true, at: record.at });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed';
    return c.json({ error: { code: 'INTERNAL', message } }, 500);
  }
});

app.get('/positions', async (c) => {
  const config = c.env as Bindings;
  const out: Record<string, { lat: number; lng: number; at: string; unit: string }> = {};

  for (const [truckId, record] of isolatePings) out[truckId] = record;

  const kv = config.POSITIONS;
  if (kv) {
    const keys = await kv.list({ prefix: 'pos:' });
    for (const key of keys.keys) {
      const truckId = key.name.replace('pos:', '');
      if (out[truckId]) continue;
      const raw = await kv.get(key.name, 'json');
      if (raw && typeof raw === 'object' && 'lat' in raw) {
        out[truckId] = raw as { lat: number; lng: number; at: string; unit: string };
      }
    }
  }

  return c.json({ positions: out, count: Object.keys(out).length });
});

/* -------------------------------------------------------------------------- */
/* Proxy                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything else is proxied to the Node API. This is deliberate and documented:
 * Postgres from Workers needs Hyperdrive (paid), so the Worker is a fast edge
 * for reads and a thin proxy for writes, and the durable state lives in Postgres.
 */
app.all('/api/*', async (c) => {
  const config = c.env as Bindings;
  if (!config.API_ORIGIN) {
    return c.json(
      {
        error: {
          code: 'CONFIGURATION',
          message: 'Set API_ORIGIN so the Worker can proxy to the Node API.',
        },
      },
      503,
    );
  }

  const target = `${config.API_ORIGIN.replace(/\/$/, '')}${c.req.path.replace(/^\/api/, '')}`;

  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers) {
    if (value && !['host', 'connection'].includes(key.toLowerCase())) headers.set(key, value);
  }
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Worker', 'truckdesk');

  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';

  const upstream = await fetch(target, {
    method: c.req.method,
    headers,
    ...(hasBody ? { body: await c.req.text() } : {}),
  });

  const body = await upstream.text();
  const outHeaders = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) outHeaders.set('content-type', contentType);

  return new Response(body, { status: upstream.status, headers: outHeaders });
});

/* -------------------------------------------------------------------------- */
/* Token helper, used by the proxy and by local testing                          */
/* -------------------------------------------------------------------------- */

export function verifyWorkerToken(token: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  return Boolean(token) && token === expected;
}

export function verifyUpstreamToken(authHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  const result = verifyApiToken(token, secret);
  return result.ok;
}

export { envValue, MemoryTrackingStore, TrackingEngine };
export default app;
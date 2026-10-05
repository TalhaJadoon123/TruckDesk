/**
 * @truckdesk/api - the HTTP surface.
 *
 * Three entry points share one core:
 *   - `main.ts`   - Node process (Docker, VPS, Railway, Fly)
 *   - `worker.ts` - Cloudflare Workers via Hono (free, 100k req/day)
 *   - `server.ts` - buildServer(), exported so tests can drive it with inject()
 */

export { buildServer, type BuildServerOptions } from './server.js';
export { createServices, realtimeStatus, type Services } from './services/container.js';
export { env, loadEnv, describeCapabilities, type Env } from './env.js';
export * from './auth.js';
export * from './services/dispatch.service.js';
export * from './services/money.service.js';
export * from './services/ifta.service.js';
export * as schema from './db/schema.js';
export { createDb, db, closeDb } from './db/client.js';

export const API_VERSION = '1.0.0';
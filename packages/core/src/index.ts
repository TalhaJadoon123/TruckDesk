/**
 * @truckdesk/core - domain logic with zero I/O.
 *
 * Everything here is a pure function over plain data (or over a small port
 * interface). That is deliberate: the same code runs in the Fastify API, in the
 * Cloudflare Worker, in the Next.js marketing calculator, and in Vitest without
 * a database, a network or a mock framework.
 */

export * from './dispatch.js';
export * from './load-match.js';
export * from './tracking.js';
export * from './ifta.js';
export * from './settlement.js';
export * from './invoicing.js';
export * from './plans.js';
export * from './dashboard.js';
export * from './pdf.js';

export const CORE_VERSION = '1.0.0';
/**
 * @truckdesk/loads - load lifecycle, rate math, document rules.
 *
 * `core` decides *which* truck takes a load; this package owns everything about
 * the load itself: creating it properly, working its stops in order, pricing
 * it, and knowing what paperwork still has to exist before it can move.
 */

export * from './lifecycle.js';
export * from './rate.js';
export * from './checklist.js';
export * from './normalize.js';
export * from './repository.js';

export const LOADS_VERSION = '1.0.0';
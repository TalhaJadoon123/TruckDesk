/**
 * @truckdesk/shared - the one place types, schemas and pure helpers live.
 *
 * Every other package depends on this and nothing else internal, so it must
 * stay free of I/O, framework imports and Node-only APIs beyond `node:crypto`.
 */
export * from './types.js';
export * from './result.js';
export * from './geo.js';
export * from './money.js';
export * from './state.js';
export * from './schemas.js';
export * from './ids.js';
export * from './time.js';
export * from './plans.js';

export const TRUCKDESK_VERSION = '1.0.0';
export const TRUCKDESK_NAME = 'TruckDesk';
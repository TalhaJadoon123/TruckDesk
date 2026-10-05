import 'dotenv/config';

import type { Config } from 'drizzle-kit';

import { env } from '../env.js';

/**
 * Drizzle Kit config.
 *
 * `DATABASE_URL` is only needed for `push` and `studio`; `generate` reads the
 * schema file and works offline, so migrations can be produced in CI without
 * database credentials.
 */
const config = {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: env().DATABASE_URL ?? 'postgresql://localhost:5432/truckdesk',
  },
  strict: true,
  verbose: true,
} satisfies Config;

export default config;
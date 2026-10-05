import type { Config } from 'drizzle-kit';

/**
 * Drizzle Kit config.
 *
 * `dbCredentials.url` is only read by `push`, `migrate` and `studio`.
 * `generate` reads the schema file and works entirely offline, so migrations
 * can be produced in CI with no database credentials at all.
 *
 * The URL is read straight from `process.env` rather than through the app's Zod
 * schema on purpose: this file is loaded by drizzle-kit's own bundle, which
 * cannot resolve the app's compiled `dist/` output, and requiring the full env
 * schema would mean `generate` fails for anyone without a `.env`.
 */
const url = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/truckdesk';

const config = {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;

export default config;
import 'dotenv/config';

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { closeDb, db, requireDb, schema } from '../db/client.js';
import { env } from '../env.js';

/**
 * Migration runner.
 *
 * `drizzle-kit generate` writes SQL files; this applies them. Keeping it as a
 * script (rather than only `drizzle-kit migrate`) means Docker and CI can run it
 * with nothing but `tsx`, which matters when the deploy target is a bare Node
 * container.
 */
async function main(): Promise<void> {
  const config = env();

  if (!config.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Nothing to migrate.');
    console.error('');
    console.error('  Neon (free):     postgres://USER:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/truckdesk?sslmode=require');
    console.error('  Supabase (free): postgres://postgres.PROJECT:PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
    console.error('  Local Docker:    postgres://truckdesk:truckdesk@localhost:5432/truckdesk');
    process.exit(1);
  }

  const handle = db();
  const client = requireDb(handle);

  console.log('Applying migrations...');
  await migrate(client as never, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');

  // Confirm the tables the app needs actually exist. A silent half-migration is
  // worse than a loud failure at boot.
  const probe = handle.sql
    ? await handle.sql`select count(*)::int as count from ${handle.sql('companies')}`
    : null;
  console.log(`companies rows: ${probe?.[0]?.count ?? 'n/a'}`);

  void schema;
  await closeDb();
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

// Keep the import of `postgres` alive for the pooler note in the docs.
void postgres;
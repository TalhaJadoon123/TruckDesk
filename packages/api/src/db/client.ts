import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import { env, type Env } from '../env.js';
import * as schema from './schema.js';

/**
 * Database client.
 *
 * Uses postgres.js, which works unchanged against Neon, Supabase (direct or
 * the transaction-mode pooler) and a local Postgres. Two settings matter:
 *
 *   prepare: false  - required by Supabase's PgBouncer in transaction mode,
 *                     which rejects the extended-query protocol.
 *   max            - keep it small. Free tiers cap connections, and 10 is
 *                     enough for a 25-truck carrier.
 *
 * When there is no `DATABASE_URL` this returns `null` and the API runs on the
 * in-memory store instead of failing to boot. That is what makes `pnpm dev`
 * work on a laptop before anyone has signed up for a database.
 */

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database | null;
  sql: Sql | null;
  /** True when running against the in-memory fallback. */
  memory: boolean;
  close(): Promise<void>;
}

export function createDb(config: Env = env()): DbHandle {
  const url = config.DATABASE_URL;

  if (!url) {
    return { db: null, sql: null, memory: true, close: async () => {} };
  }

  const sql = postgres(url, {
    max: config.DATABASE_POOL_MAX,
    // Supabase pooler compatibility.
    prepare: config.DATABASE_PREPARE,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema });
  return { db, sql, memory: false, close: async () => { await sql.end({ timeout: 5 }); } };
}

let shared: DbHandle | null = null;

/** Process-wide handle, so routes do not each open a pool. */
export function db(): DbHandle {
  if (!shared) shared = createDb();
  return shared;
}

export function closeDb(): Promise<void> {
  if (!shared) return Promise.resolve();
  const handle = shared;
  shared = null;
  return handle.close();
}

/** Fail loudly rather than silently writing to nothing. */
export function requireDb(handle: DbHandle = db()): Database {
  if (!handle.db) {
    throw new Error(
      'No database configured. Set DATABASE_URL, or run against the in-memory store (no DATABASE_URL).',
    );
  }
  return handle.db;
}

export { schema };
export type { Database as Db };
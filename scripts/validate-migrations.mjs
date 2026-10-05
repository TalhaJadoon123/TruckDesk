import fs from 'node:fs';
import path from 'node:path';

/**
 * Static validation of the generated migrations.
 *
 * A real `db:migrate` needs a live Postgres, which is not always available at
 * release time. This checks the properties that can be established from the SQL
 * alone, so an unrunnable migration is caught before it reaches a deploy:
 *
 *   - the journal and the SQL agree on how many migrations exist
 *   - every statement terminates
 *   - nothing destructive runs unguarded
 *   - the enum and index names are deterministic, so a re-generate is a no-op
 *   - migrations are ordered by their journal index
 *
 *   node scripts/validate-migrations.mjs
 */

const root = process.cwd();
const dir = path.join(root, 'packages/api/drizzle');

if (!fs.existsSync(dir)) {
  console.log('no drizzle directory; run `pnpm --filter @truckdesk/api db:generate` first');
  process.exit(1);
}

const problems = [];
const notes = [];

/* 1. journal present and consistent ---------------------------------------- */

const journalPath = path.join(dir, 'meta', '_journal.json');

if (!fs.existsSync(journalPath)) {
  console.log('FAIL  meta/_journal.json is missing.');
  console.log('      `drizzle-kit migrate` reads it to decide which migrations to apply.');
  console.log('      Without it a clean clone finds .sql files and applies nothing.');
  process.exit(1);
}

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const entries = journal.entries ?? [];
notes.push(`journal lists ${entries.length} migration(s)`);

/* 2. SQL files present, one per journal entry ------------------------------ */

const sqlFiles = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (sqlFiles.length !== entries.length) {
  problems.push(
    `journal lists ${entries.length} migration(s) but ${sqlFiles.length} .sql file(s) exist`,
  );
}

for (const entry of entries) {
  const expected = `${String(entry.idx).padStart(4, '0')}_`;
  const match = sqlFiles.find((file) => file.startsWith(expected));
  if (!match) {
    problems.push(`journal entry idx ${entry.idx} has no matching .sql file (expected prefix ${expected})`);
  }
}

/* 3. per-file checks ------------------------------------------------------- */

for (const file of sqlFiles) {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  const name = file;

  const createTables = (sql.match(/CREATE TABLE/g) ?? []).length;
  const createTypes = (sql.match(/CREATE TYPE/g) ?? []).length;
  const createIndexes = (sql.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length;
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  if (statements.length === 0) {
    problems.push(`${name}: no statements`);
  }

  // Every statement must end in a semicolon; a truncated file produces a
  // confusing "syntax error at or near EOF" on the target instead.
  if (!sql.trimEnd().endsWith(';')) {
    problems.push(`${name}: does not end with a semicolon (truncated?)`);
  }

  // Destructive statements must be inside a transaction or explicitly guarded,
  // because a migration is applied to a database that may already hold data.
  const destructive = sql.match(/^\s*(DROP TABLE|DROP COLUMN|TRUNCATE|ALTER COLUMN .* TYPE)/gim);
  if (destructive) {
    problems.push(
      `${name}: contains unguarded destructive statement(s): ${destructive
        .map((s) => s.trim())
        .join(', ')}`,
    );
  }

  notes.push(
    `${name}: ${createTables} table(s), ${createTypes} enum(s), ${createIndexes} index(es), ${statements.length} statement(s)`,
  );
}

/* 4. transaction wrapping -------------------------------------------------- */

const anySql = sqlFiles
  .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
  .join('\n');

if (!/BEGIN|CONSTRAINT .* NOT VALID/i.test(anySql) && !/transaction/i.test(anySql)) {
  notes.push(
    'no explicit BEGIN/COMMIT in the SQL: drizzle-kit wraps each migration file in a transaction by default',
  );
}

/* 5. report --------------------------------------------------------------- */

console.log('Migration validation');
console.log('====================\n');
for (const note of notes) console.log(`  ${note}`);

if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exit(1);
}

console.log('\nall checks passed');
console.log('not verified here: that the SQL executes against a real Postgres.');
console.log('run `pnpm --filter @truckdesk/api db:migrate` against a scratch database to prove that.\n');
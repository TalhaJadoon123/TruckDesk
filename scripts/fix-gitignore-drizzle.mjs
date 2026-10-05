import fs from 'node:fs';
import path from 'node:path';

/**
 * Stop ignoring `packages/api/drizzle/meta/`.
 *
 * That directory is not build output. It holds `_journal.json`, the ordered
 * manifest that `drizzle-kit migrate` reads to decide which migrations to
 * apply. Ignoring it means a clean clone has the .sql files but no journal, so
 * `pnpm db:migrate` reports no migrations and the deploy silently leaves the
 * database empty.
 *
 *   node scripts/fix-gitignore-drizzle.mjs
 */

const target = path.join(process.cwd(), '.gitignore');
const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);

const entry = 'packages/api/drizzle/meta/';
const replacement = [
  '# NOT ignored: packages/api/drizzle/meta/_journal.json is the ordered',
  '# manifest drizzle-kit migrate reads to know which migrations to apply.',
  '# Ignoring it leaves a clean clone with .sql files and no journal, so',
  '# `pnpm db:migrate` finds nothing to do and the deploy leaves the schema',
  '# empty. Only the schema snapshot is machine-generated noise.',
  'packages/api/drizzle/meta/_journal.json',
].join('\n');

const index = lines.findIndex((line) => line.trim() === entry);

if (index === -1) {
  console.log(`no "${entry}" entry found; nothing to do`);
  process.exit(0);
}

lines.splice(index, 1, replacement);
fs.writeFileSync(target, `${lines.join('\n').replace(/\s+$/, '')}\n`, 'utf8');

console.log('gitignore updated: drizzle/meta/_journal.json is now tracked');
console.log('run `git add -f packages/api/drizzle/meta/_journal.json` or `git add packages/api/drizzle`');
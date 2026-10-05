import fs from 'node:fs';
import path from 'node:path';

/**
 * Restore `postgres` to `packages/api/package.json`.
 *
 * It was dropped by accident while reordering the dependency object. The API
 * needs the Postgres wire protocol driver; `drizzle-orm/postgres-js` is the
 * driver, not the transport.
 */

const target = path.join(process.cwd(), 'packages/api/package.json');
const raw = fs.readFileSync(target, 'utf8').replace(/^﻿/, '');
const pkg = JSON.parse(raw);

if (!pkg.dependencies['postgres']) {
  pkg.dependencies = {
    ...pkg.dependencies,
    postgres: '^3.4.9',
  };
}

const sorted = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
pkg.dependencies = sorted;

fs.writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log('api dependencies:', Object.keys(pkg.dependencies).join(', '));
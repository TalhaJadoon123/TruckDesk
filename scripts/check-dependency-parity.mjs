import fs from 'node:fs';
import path from 'node:path';

/**
 * Verify that every package's declared dependencies exist and are installed.
 *
 * Two bugs in this repo came from editing a `package.json` without a matching
 * install: `postgres` was dropped from the API and `fastify-plugin` was added
 * without one. Both compile fine locally against a stale `node_modules` and
 * both fail in a clean CI checkout, which is the worst possible time to find out.
 *
 *   node scripts/check-dependency-parity.mjs
 */

const root = process.cwd();
const workspace = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
const packagesDir = path.join(root, 'packages');

const SKIP = new Set(['node_modules', 'dist', 'build', '.next', 'release', 'coverage', 'drizzle']);

let checked = 0;
const problems = [];

function installed(pkgDir, name) {
  // pnpm's isolated layout links direct deps into the package's own node_modules.
  return (
    fs.existsSync(path.join(pkgDir, 'node_modules', name)) ||
    fs.existsSync(path.join(root, 'node_modules', name))
  );
}

function readPkg(dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// The root manifest.
const rootPkg = readPkg(root);
if (!rootPkg) {
  console.error('no root package.json');
  process.exit(1);
}

for (const [group, deps] of Object.entries({
  dependencies: rootPkg.dependencies ?? {},
  devDependencies: rootPkg.devDependencies ?? {},
})) {
  for (const name of Object.keys(deps)) {
    checked += 1;
    if (!installed(root, name)) problems.push(`root ${group}: ${name} is declared but not installed`);
  }
}

// Every workspace package.
for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || SKIP.has(entry.name)) continue;

  const dir = path.join(packagesDir, entry.name);
  const pkg = readPkg(dir);
  if (!pkg) continue;

  for (const [group, deps] of Object.entries({
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
  })) {
    for (const [name, range] of Object.entries(deps)) {
      checked += 1;

      // A workspace dependency must exist as a package.
      if (String(range).startsWith('workspace:')) {
        const target = path.join(packagesDir, name.replace('@truckdesk/', ''));
        if (!fs.existsSync(path.join(target, 'package.json'))) {
          problems.push(`${pkg.name} ${group}: ${name} is a workspace dep with no package`);
          continue;
        }
      }

      if (!installed(dir, name)) {
        problems.push(`${pkg.name} ${group}: ${name} (${range}) is declared but not installed`);
      }
    }
  }
}

console.log(`checked ${checked} declared dependency slot(s) across the workspace`);
console.log(`workspace: ${workspace.split('\n').filter((l) => l.includes('packages/')).join(', ').trim() || '(default)'}`);

if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exit(1);
}

console.log('\nall declared dependencies resolve to an installed package');
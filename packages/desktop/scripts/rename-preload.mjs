import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Electron loads `main` and `preload` by path and needs CommonJS extensions it
 * can require. TypeScript emits `.js` from the CommonJS config, so both are
 * renamed to `.cjs` here rather than adding another config for two files.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const renames = [
  ['main.js', 'main.cjs'],
  ['preload.js', 'preload.cjs'],
];

let renamed = 0;

for (const [from, to] of renames) {
  const source = join(dist, from);
  const target = join(dist, to);

  if (!existsSync(source)) {
    console.warn(`[desktop] dist/${from} not found; skipping`);
    continue;
  }
  if (existsSync(target)) {
    renameSync(source, target);
  } else {
    renameSync(source, target);
  }
  renamed += 1;
  console.log(`[desktop] ${from} -> ${to}`);
}

console.log(`[desktop] renamed ${renamed} file(s)`);
import fs from 'node:fs';
import path from 'node:path';

/**
 * Strip UTF-8 BOMs from every source file in the repo.
 *
 * A PowerShell `Set-Content -Encoding UTF8` round-trip writes a BOM, which is not
 * valid JSON per a strict parser and shows up as a confusing "Unexpected token"
 * from tools that read package.json. It is invisible in an editor, which is why
 * it survives.
 *
 *   node scripts/strip-boms.mjs
 */

const ROOTS = ['packages', 'tests', 'scripts', 'docker'];
const ROOT_FILES = ['package.json', 'tsconfig.base.json', 'turbo.json', 'vitest.config.ts'];
const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.css', '.yml', '.yaml',
  '.toml', '.html', '.env',
]);

const SKIP = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'release', '.git', 'coverage', 'drizzle']);

let fixed = 0;
let scanned = 0;

function strip(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 3) return false;
  // EF BB BF
  if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) return false;

  fs.writeFileSync(file, bytes.subarray(3));
  return true;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full);
      continue;
    }

    const ext = path.extname(entry.name);
    const isEnv = entry.name.startsWith('.env');
    if (!EXTENSIONS.has(ext) && !isEnv) continue;

    scanned += 1;
    if (strip(full)) {
      fixed += 1;
      console.log(`stripped BOM: ${path.relative(process.cwd(), full)}`);
    }
  }
}

for (const root of ROOTS) walk(root);
for (const file of ROOT_FILES) {
  if (!fs.existsSync(file)) continue;
  scanned += 1;
  if (strip(file)) {
    fixed += 1;
    console.log(`stripped BOM: ${file}`);
  }
}

console.log(`\nscanned ${scanned} file(s), stripped ${fixed} BOM(s)`);
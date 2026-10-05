import fs from 'node:fs';
import path from 'node:path';

/**
 * Add the maintenance script entries to `packages/api/package.json` without
 * PowerShell's JSON round-trip, which reorders keys and mangles formatting.
 */

const target = path.join(process.cwd(), 'packages/api/package.json');
// An earlier PowerShell round-trip left a BOM, which is not valid JSON.
const raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
const pkg = JSON.parse(raw);

pkg.scripts = {
  ...pkg.scripts,
  probe: 'tsx src/probe-adversarial.ts',
};

fs.writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log('api scripts:', Object.keys(pkg.scripts).join(', '));
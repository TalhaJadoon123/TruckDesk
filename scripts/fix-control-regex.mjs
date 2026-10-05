import fs from 'node:fs';
import path from 'node:path';

/**
 * Rewrite the storage-key control-character guard using escape sequences.
 *
 * The previous version had literal control bytes embedded in the regex literal,
 * which makes the file look binary to tooling and is fragile to edit. This script
 * replaces that one line with the readable equivalent: any char in
 * U+0000-U+001F, U+007F, or a backslash.
 *
 *   node scripts/fix-control-regex.mjs
 */

const target = path.join(process.cwd(), 'packages/loads/src/checklist.ts');
let text = fs.readFileSync(target, 'utf8');

const lines = text.split(/\r?\n/);
let changed = 0;

for (let i = 0; i < lines.length; i += 1) {
  // Match the old line by its stable shape: a /[ ... ]/.test(storageKey) guard.
  if (!/\.test\(storageKey\)/.test(lines[i])) continue;
  if (/\\x00/.test(lines[i])) continue;

  lines[i] = '  if (/[\\x00-\\x1F\\x7F\\\\]/.test(storageKey)) {';
  changed += 1;
}

if (changed > 0) {
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
}

console.log(changed === 0 ? 'control-character guard already escaped' : `rewrote ${changed} line(s)`);

// Report any remaining C0 control bytes anywhere in the file.
const bytes = fs.readFileSync(target);
const bad = [];
for (let i = 0; i < bytes.length; i += 1) {
  const byte = bytes[i];
  if (byte === 9 || byte === 10 || byte === 13) continue;
  if (byte < 32 || byte === 127) bad.push({ offset: i, byte });
}

console.log(bad.length === 0 ? 'no stray control bytes' : `WARNING: ${bad.length} stray control byte(s)`);
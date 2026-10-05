import fs from 'node:fs';
import path from 'node:path';

/**
 * Quote the YAML front-matter `description` in every docs page.
 *
 * Two descriptions contain ": " ("A native window around the same API: ...",
 * "... it takes. Total cost: zero."), which YAML reads as a nested mapping and
 * gray-matter then reports as a parse error at build time. Quoting the value
 * makes the colon literal, and does it for every file rather than the two that
 * happen to be broken today.
 *
 *   node scripts/quote-doc-descriptions.mjs
 */

const contentDir = path.join(process.cwd(), 'packages/docs/content');

if (!fs.existsSync(contentDir)) {
  console.log('no docs content directory; nothing to do');
  process.exit(0);
}

let quoted = 0;

for (const file of fs.readdirSync(contentDir)) {
  if (!file.endsWith('.md')) continue;

  const full = path.join(contentDir, file);
  const original = fs.readFileSync(full, 'utf8');
  const lines = original.split(/\r?\n/);

  let changed = false;

  for (let i = 0; i < Math.min(lines.length, 12); i += 1) {
    const line = lines[i];
    if (!line || !line.startsWith('description:')) continue;

    const value = line.slice('description:'.length).trim();
    if (!value) continue;
    if (value.startsWith('"') || value.startsWith("'")) continue;
    // Only a value containing ": " can be misread as a nested mapping.
    if (!value.includes(': ')) continue;

    lines[i] = `description: ${JSON.stringify(value)}`;
    changed = true;
    console.log(`quoted description in ${file} (line ${i + 1})`);
    break;
  }

  if (!changed) continue;

  // Normalise to LF with a single trailing newline: gray-matter mis-parses
  // front matter that is not newline-terminated.
  const normalised = `${lines.join('\n').replace(/\s+$/, '')}\n`;
  fs.writeFileSync(full, normalised, 'utf8');
  quoted += 1;
}

console.log(`\nnormalised ${quoted} file(s)`);
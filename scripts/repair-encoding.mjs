import fs from 'node:fs';
import path from 'node:path';

/**
 * Repair script: rewrites markdown files that PowerShell mangled (an em dash
 * became a replacement character) and normalises every text file to UTF-8
 * without a BOM.
 *
 *   node scripts/repair-encoding.mjs
 */

const root = process.cwd();
const targets = ['README.md', 'packages/docs/content', '.env.example'];

let fixed = 0;

for (const target of targets) {
  const full = path.join(root, target);
  if (!fs.existsSync(full)) continue;

  const files = fs.statSync(full).isDirectory()
    ? fs
        .readdirSync(full)
        .filter((file) => file.endsWith('.md'))
        .map((file) => path.join(full, file))
    : [full];

  for (const file of files) {
    const bytes = fs.readFileSync(file);
    let text = bytes.toString('utf8');

    // The mangled em dash: a replacement char followed by '?' and a T.
    const before = text;
    text = text.replace(/connection string \uFFFD+\?+\s*T/g, 'connection string ->');
    text = text.replace(/\uFFFD/g, '-');

    // Strip a BOM and write clean UTF-8.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    if (text !== before || bytes[0] === 0xef) {
      fs.writeFileSync(file, text, 'utf8');
      fixed += 1;
      console.log(`fixed ${path.relative(root, file)}`);
    }
  }
}

console.log(fixed === 0 ? 'no encoding issues found' : `${fixed} file(s) repaired`);
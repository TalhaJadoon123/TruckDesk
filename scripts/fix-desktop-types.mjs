import fs from 'node:fs';

/**
 * Fix the desktop renderer's three type errors in one pass:
 *
 *   1. `moneyBody` / `eldBody` are async but were called synchronously from
 *      `bodyFor`, which nested a promise into string markup. They now return a
 *      placeholder and `go()` swaps in the real markup.
 *   2. The aging and HOS responses had their inline type literals collapsed to
 *      `never` by an `as never as never` cast; they now use the named
 *      `AgingResponse` / `HosResponse` interfaces.
 *
 *   node scripts/fix-desktop-types.mjs
 */

const target = 'packages/desktop/src/ui/app.ts';
let text = fs.readFileSync(target, 'utf8');
const nl = '\n';
let applied = 0;

function swap(from, to, label) {
  if (!text.includes(from)) {
    console.log(`skip: ${label}`);
    return;
  }
  text = text.split(from).join(to);
  applied += 1;
  console.log(`fixed: ${label}`);
}

swap(
  `    case 'money':${nl}      return moneyBody();${nl}    case 'eld':${nl}      return eldBody();`,
  `    case 'money':${nl}      // Fetched in go(); a placeholder keeps render() synchronous.${nl}      return '<div class="empty">Loading receivables...</div>';${nl}    case 'eld':${nl}      return '<div class="empty">Loading hours of service...</div>';`,
  'bodyFor async pages',
);

swap(
  `    const aging = (await api<{`,
  `    const aging = await api<AgingResponse>({`,
  'aging request head',
);

swap(
  `      totalOutstandingCents: number;`,
  ``,
  'aging type field 1',
);

// Collapse the old inline aging literal down to the named type.
const agingLiteral = /    const aging = await api<AgingResponse>\(\{[\s\S]*?\}\> \('\/invoice\/aging', \{ token: actor\(\)\.token \}\);/;
if (agingLiteral.test(text)) {
  text = text.replace(agingLiteral, "    const aging = await api<AgingResponse>('/invoice/aging', { token: actor().token });");
  applied += 1;
  console.log('fixed: aging literal collapsed');
}

const eldLiteral = /    const payload = await api<\{[\s\S]*?\}\>\('\/hos', \{ token: actor\(\)\.token \}\);/;
if (eldLiteral.test(text)) {
  text = text.replace(eldLiteral, "    const payload = await api<HosResponse>('/hos', { token: actor().token });");
  applied += 1;
  console.log('fixed: hos literal collapsed');
}

fs.writeFileSync(target, text, 'utf8');
console.log(`applied ${applied} change(s)`);
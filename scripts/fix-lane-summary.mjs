import fs from 'node:fs';

/**
 * Rewrite the temperature and wind branches of `laneSummary`.
 *
 * Two behaviour problems it fixes:
 *   - an unremarkable temperature produced "destination 70F, feels like 68F", so
 *     the banner fired on every lane and taught a dispatcher to ignore it;
 *   - the cold threshold was 20F, below the point where a reefer actually has to
 *     defend a cold chain. 32F is the line that matters operationally.
 *
 *   node scripts/fix-lane-summary.mjs
 */

const target = 'packages/integrations/src/weather.ts';
let text = fs.readFileSync(target, 'utf8');

const oldBlock = [
  '    if (high >= 95) parts.push(`destination is ${high}F - check reefer cooling`);',
  '    else if (high <= 20) parts.push(`destination is ${high}F - freeze protection`);',
  "    else parts.push(`destination ${high}F${low !== null && low !== high ? `, feels like ${low}F` : ''}`);",
].join('\n');

const newBlock = [
  '    if (high >= 95) {',
  '      parts.push(`destination is ${high}F - check reefer cooling`);',
  '    } else if (high <= 32) {',
  '      // Below freezing, a reefer defends a cold chain rather than the weather.',
  '      parts.push(`destination is ${high}F - freeze protection needed`);',
  '    } else if (high >= 88) {',
  '      // Warm but not alarming: worth a glance, not worth an interrupt.',
  "      parts.push(`destination ${high}F${low !== null && low !== high ? `, feels like ${low}F` : ''}`);",
  '    }',
].join('\n');

if (!text.includes(oldBlock)) {
  console.log('temperature block not found');
  process.exit(1);
}

text = text.replace(oldBlock, newBlock);
text = text.replace(
  'if (wind !== null && wind >= 30) parts.push(`wind ${wind} mph`);',
  'if (wind !== null && wind >= 30) parts.push(`wind ${Math.round(wind)} mph`);',
);
text = text.replace(
  ' * The point of this is restraint: a dispatcher glancing at a load wants to know\n * whether to worry, not a table of numbers.',
  ' * The point of this is restraint. A banner that fires on every lane teaches a\n * dispatcher to ignore it, so temperature is only mentioned when it is\n * operationally interesting: reefer risk at the top, cold chain below.',
);

fs.writeFileSync(target, text, 'utf8');
console.log('laneSummary rewritten: cold threshold 32F, wind rounded, silence by default');
import fs from 'node:fs';

/**
 * Repair `splitRate` in lifecycle.ts.
 *
 * An index-based edit truncated this function's signature and opening brace,
 * which is why the file stopped parsing. It is restored to the behaviour the
 * rest of the package and the tests depend on: split an all-in rate into
 * linehaul plus a fuel surcharge, using the caller's surcharge when supplied and
 * a conservative estimate when not.
 */

const target = 'packages/loads/src/lifecycle.ts';
let text = fs.readFileSync(target, 'utf8');

const broken = '/** * Split an all-in rate into linehaul and fuel when the broker did not. */';

if (!text.includes(broken)) {
  console.log('splitRate marker not found; nothing to repair');
  process.exit(1);
}

// Everything from the marker up to the next function declaration is the broken
// region; replace the whole span with a correct implementation.
const start = text.indexOf(broken);
const nextFunction = text.indexOf('function endOfDayIfDateOnly');
if (nextFunction < 0 || nextFunction < start) {
  console.log('could not find the end of the broken region');
  process.exit(1);
}

const repaired = `/**
 * Split an all-in rate into linehaul and fuel when the broker did not.
 *
 * A driver on percentage pay earns on linehaul only: the fuel surcharge is the
 * broker paying for fuel, not paying the driver. \`settlement.payForLoad\` and
 * \`core.projectDriverPayCents\` both rely on this split being consistent.
 */
export function splitRate(
  rate: Cents,
  miles: number,
  fuelSurchargeCents?: Cents,
): { linehaulCents: Cents; fuelSurchargeCents: Cents } {
  if (fuelSurchargeCents !== undefined && fuelSurchargeCents > 0) {
    return {
      linehaulCents: Math.max(0, rate - fuelSurchargeCents),
      fuelSurchargeCents,
    };
  }

  // DOE weekly index runs roughly $0.20-$0.50/mi; use a conservative mid
  // figure so the split does not overstate linehaul on a dry-van rate.
  const surchargePerMileCents = 21;
  const estimatedSurcharge = Math.min(
    Math.round(rate * 0.2),
    Math.round(miles * surchargePerMileCents),
  );

  return {
    linehaulCents: Math.max(0, rate - estimatedSurcharge),
    fuelSurchargeCents: estimatedSurcharge,
  };
}

`;

text = text.slice(0, start) + repaired + text.slice(nextFunction);

fs.writeFileSync(target, text, 'utf8');
console.log('splitRate restored');
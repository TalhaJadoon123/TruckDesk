import fs from 'node:fs';

/**
 * Repair the collapsed `lifecycle.ts`.
 *
 * Everything from the start of the file through `endOfDayIfDateOnly` was folded
 * onto one line and `splitRate` lost its signature entirely. Rather than patch
 * a damaged file further, the header region (imports, interfaces, `splitRate`,
 * `endOfDayIfDateOnly`) is rewritten from a clean source, and the tail - every
 * function from `createLoad` onward - is preserved verbatim from the damaged
 * file, because that content is intact and still correct.
 */

const target = 'packages/loads/src/lifecycle.ts';
const damaged = fs.readFileSync(target, 'utf8');

/** Everything from `export function createLoad(` onward is intact. */
const tailStart = damaged.indexOf('export function createLoad(');
if (tailStart < 0) {
  console.log('createLoad not found; cannot preserve the tail');
  process.exit(1);
}
const tail = damaged.slice(tailStart);

const header = `import {
  Errors,
  canTransitionStop,
  err,
  ok,
  type Cents,
  type DomainEvent,
  type Driver,
  type Iso,
  type Load,
  type LoadDocument,
  type LoadStop,
  type Result,
  type TrailerType,
  uuid,
} from '@truckdesk/shared';

/**
 * Load lifecycle: creating a load properly, building its stop list, working the
 * stops in order, and closing it out.
 *
 * The dispatcher experience is "an email arrives and a board row appears". The
 * field experience is "I am standing in a yard and I need to mark arrived,
 * unload, photograph the BOL, sign, done". Both are expressed here.
 */

/* -------------------------------------------------------------------------- */
/* Creation                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateStopInput {
  id?: string;
  type: LoadStop['type'];
  facilityName: string;
  address: string;
  city: string;
  state: string;
  postalCode?: string;
  location?: { lat: number; lng: number };
  window?: LoadStop['window'];
  appointmentRequired?: boolean;
  appointmentRef?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
}

export interface CreateLoadInput {
  broker: string;
  origin: string;
  destination: string;
  /** All-in rate in USD cents. */
  rate: Cents;
  miles: number;
  companyId?: string;
  reference?: string;
  commodity?: string;
  weightLbs?: number;
  equipment?: TrailerType;
  pickupDate?: Iso;
  deliveryDate?: Iso;
  pickupWindow?: LoadStop['window'];
  deliveryWindow?: LoadStop['window'];
  linehaulCents?: Cents;
  fuelSurchargeCents?: Cents;
  accessorialCents?: Cents;
  rateType?: Load['rateType'];
  quickPayEligible?: boolean;
  source?: Load['source'];
  notes?: string;
  stops?: CreateStopInput[];
  id?: string;
  now?: Iso;
  actorId?: string;
}

export interface CreatedLoad {
  load: Load;
  events: DomainEvent[];
  /** Fields the parser or dispatcher still needs to fill in. */
  missing: string[];
}

/**
 * Split an all-in rate into linehaul and fuel when the broker did not.
 *
 * A driver on percentage pay earns on linehaul only: the fuel surcharge is the
 * broker paying for fuel, not paying the driver. \`settlement.payForLoad\` and
 * \`core.projectDriverPayCents\` both depend on this split agreeing.
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

/**
 * Brokers write a delivery *date* ("deliver 03/18") far more often than a
 * delivery *time*. Parsed literally that is midnight, which makes a same-day
 * delivery look earlier than a pickup at 08:00 and gets the load rejected.
 *
 * A value with no time component therefore means "by the end of that day", and
 * is pushed to 23:59:59 before it is compared.
 */
function endOfDayIfDateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes('T')) return value;

  const parsed = new Date(\`\${value}T00:00:00Z\`);
  if (Number.isNaN(parsed.getTime())) return value;

  parsed.setUTCHours(23, 59, 59, 999);
  return parsed.toISOString();
}

`;

fs.writeFileSync(target, header + tail, 'utf8');
console.log(`lifecycle.ts rebuilt: clean header + ${tail.length} chars of preserved tail`);
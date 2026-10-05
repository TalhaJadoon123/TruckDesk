import {
  Errors,
  applyBasisPoints,
  err,
  ok,
  perMileCents,
  type Cents,
  type Driver,
  type Iso,
  type Load,
  type Result,
  type Truck,
} from '@truckdesk/shared';

/**
 * Rate and margin math.
 *
 * A dispatcher quotes two numbers: the rate the broker pays and the rate the
 * driver makes. Everything here exists to keep those two honest, plus the fuel
 * surcharge and accessorials that small carriers routinely give away.
 */

/* -------------------------------------------------------------------------- */
/* Benchmarks                                                                   */
/* -------------------------------------------------------------------------- */

/** What the load "should" fetch, by trailer type. Cents per mile, all-in. */
export const MARKET_RATE_PER_MILE: Record<string, Cents> = {
  dry_van: 245,
  reefer: 305,
  flatbed: 275,
  step_deck: 320,
  tanker: 315,
  box_truck: 190,
  power_only: 165,
};

/** Industry average all-in operating cost per mile, by trailer type. */
export const OPERATING_COST_PER_MILE: Record<string, Cents> = {
  dry_van: 168,
  reefer: 212,
  flatbed: 189,
  step_deck: 224,
  tanker: 205,
  box_truck: 138,
  power_only: 121,
};

/** Empty miles as a share of total miles. The number every carrier is judged on. */
export const TYPICAL_EMPTY_RATIO = 0.28;

/* -------------------------------------------------------------------------- */
/* Breakdowns                                                                   */
/* -------------------------------------------------------------------------- */

export interface RateAnalysis {
  rateCents: Cents;
  miles: number;
  revenuePerMileCents: number;
  linehaulCents: Cents;
  linehaulPerMileCents: number;
  fuelSurchargeCents: Cents;
  accessorialCents: Cents;
  benchmarkPerMileCents: Cents;
  /** rate/mile minus the benchmark. Positive is above market. */
  varianceToMarketCents: number;
  varianceToMarketPct: number;
  operatingCostCents: Cents;
  contributionCents: Cents;
  contributionPerMileCents: number;
  contributionMarginPct: number;
  driverPayCents: Cents;
  driverPayPerMileCents: number;
  /** Contribution after driver pay. This is the owner's number. */
  netAfterDriverCents: Cents;
  rating: 'excellent' | 'good' | 'fair' | 'poor';
  notes: string[];
}

export function analyzeRate(load: Load, driver?: Driver): RateAnalysis {
  const notes: string[] = [];
  const equipment = load.equipment ?? 'dry_van';
  const miles = Math.max(0, load.miles);
  const rate = Math.max(0, load.rate);

  const linehaulCents = load.linehaulCents ?? Math.round(rate * 0.85);
  const fuelSurchargeCents = load.fuelSurchargeCents ?? Math.max(0, rate - linehaulCents);
  const accessorialCents = load.accessorialCents ?? 0;

  const revenuePerMileCents = miles > 0 ? Math.round(rate / miles) : 0;
  const linehaulPerMileCents = miles > 0 ? Math.round(linehaulCents / miles) : 0;

  const benchmark = MARKET_RATE_PER_MILE[equipment] ?? MARKET_RATE_PER_MILE['dry_van'] ?? 245;
  const varianceToMarketCents = revenuePerMileCents - benchmark;
  const varianceToMarketPct =
    benchmark > 0 ? Math.round((varianceToMarketCents / benchmark) * 10_000) / 10_000 : 0;

  const costPerMile = OPERATING_COST_PER_MILE[equipment] ?? OPERATING_COST_PER_MILE['dry_van'] ?? 168;
  const operatingCostCents = Math.round(costPerMile * miles);
  const contributionCents = rate - operatingCostCents;
  const contributionPerMileCents = revenuePerMileCents - costPerMile;
  const contributionMarginPct =
    rate > 0 ? Math.round((contributionCents / rate) * 10_000) / 10_000 : 0;

  const driverPayCents = load.driverPayCents ?? projectDriverPay(driver, load);
  const driverPayPerMileCents = miles > 0 ? Math.round(driverPayCents / miles) : 0;
  const netAfterDriverCents = contributionCents - driverPayCents;

  let rating: RateAnalysis['rating'];
  const netPerMile = miles > 0 ? Math.round(netAfterDriverCents / miles) : 0;
  if (netPerMile >= 45) rating = 'excellent';
  else if (netPerMile >= 20) rating = 'good';
  else if (netPerMile >= 0) rating = 'fair';
  else rating = 'poor';

  if (varianceToMarketCents < 0) {
    notes.push(
      `$${(revenuePerMileCents / 100).toFixed(2)}/mi is ${Math.abs(varianceToMarketCents)} cents under the ${equipment.replace('_', ' ')} benchmark of $${(benchmark / 100).toFixed(2)}`,
    );
  }
  if (contributionCents <= 0) {
    notes.push('Rate does not cover estimated operating cost before driver pay');
  }
  if (accessorialCents === 0) {
    notes.push('No accessorials claimed; check for detention, lumper and TIF fees');
  }
  if (fuelSurchargeCents === 0) {
    notes.push('No fuel surcharge on this rate - worth asking the broker');
  }

  return {
    rateCents: rate,
    miles,
    revenuePerMileCents,
    linehaulCents,
    linehaulPerMileCents,
    fuelSurchargeCents,
    accessorialCents,
    benchmarkPerMileCents: benchmark,
    varianceToMarketCents,
    varianceToMarketPct,
    operatingCostCents,
    contributionCents,
    contributionPerMileCents,
    contributionMarginPct,
    driverPayCents,
    driverPayPerMileCents,
    netAfterDriverCents,
    rating,
    notes,
  };
}

function projectDriverPay(driver: Driver | undefined, load: Load): Cents {
  if (!driver) return 0;
  switch (driver.payType) {
    case 'percentage':
      return Math.round(((load.linehaulCents ?? load.rate) * (driver.payRateBps ?? 2500)) / 10_000);
    case 'flat_per_mile':
      return Math.round((driver.payPerMileCents ?? 45) * load.miles);
    case 'flat_per_load':
      return driver.payPerMileCents ?? 0;
    default:
      return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Fuel surcharge                                                                */
/* -------------------------------------------------------------------------- */

export interface FuelSurchargeTable {
  /** Effective date of the table. */
  effectiveFrom: Iso;
  /** DOE weekly diesel price, USD per gallon, x1000 to keep it an integer. */
  doePriceMilliPerGallon: number;
  /** MPG basis, typically 6.0-6.5 for a loaded reefer. */
  mpg: number;
  rows: Array<{ minPerMileCents: number; surchargePerMileCents: number }>;
}

/**
 * The 2024 DOE fuel surcharge table, which most brokers still reference. Rows
 * are the published breakpoints: at or above a given all-in rate per mile, the
 * surcharge is the listed cents-per-mile.
 */
export const DEFAULT_FUEL_SURCHARGE_TABLE: FuelSurchargeTable = {
  effectiveFrom: '2024-07-15T00:00:00.000Z',
  doePriceMilliPerGallon: 3_850_000,
  mpg: 6.0,
  rows: [
    { minPerMileCents: 333, surchargePerMileCents: 20 },
    { minPerMileCents: 323, surchargePerMileCents: 19 },
    { minPerMileCents: 313, surchargePerMileCents: 18 },
    { minPerMileCents: 303, surchargePerMileCents: 17 },
    { minPerMileCents: 293, surchargePerMileCents: 16 },
    { minPerMileCents: 283, surchargePerMileCents: 15 },
    { minPerMileCents: 273, surchargePerMileCents: 14 },
    { minPerMileCents: 263, surchargePerMileCents: 13 },
    { minPerMileCents: 253, surchargePerMileCents: 12 },
    { minPerMileCents: 243, surchargePerMileCents: 11 },
    { minPerMileCents: 233, surchargePerMileCents: 10 },
    { minPerMileCents: 223, surchargePerMileCents: 9 },
    { minPerMileCents: 213, surchargePerMileCents: 8 },
    { minPerMileCents: 203, surchargePerMileCents: 7 },
    { minPerMileCents: 193, surchargePerMileCents: 6 },
    { minPerMileCents: 183, surchargePerMileCents: 5 },
    { minPerMileCents: 173, surchargePerMileCents: 4 },
    { minPerMileCents: 163, surchargePerMileCents: 3 },
    { minPerMileCents: 153, surchargePerMileCents: 2 },
    { minPerMileCents: 0, surchargePerMileCents: 0 },
  ],
};

/** What the DOE surcharge would be for this rate and miles. */
export function computeFuelSurchargeCents(
  allInRateCents: Cents,
  miles: number,
  table: FuelSurchargeTable = DEFAULT_FUEL_SURCHARGE_TABLE,
): Cents {
  if (miles <= 0) return 0;
  const perMile = allInRateCents / miles;
  // Rows are listed high to low; the first match at or below the rate wins.
  for (const row of table.rows) {
    if (perMile >= row.minPerMileCents) {
      return Math.round(row.surchargePerMileCents * miles);
    }
  }
  return 0;
}

export function linehaulToAllIn(linehaulCents: Cents, miles: number, table?: FuelSurchargeTable): Cents {
  return linehaulCents + computeFuelSurchargeCents(linehaulCents, miles, table);
}

/** A realistic DOE surcharge for a given diesel price, scaled from the table. */
export function surchargeForDieselPrice(
  dollarsPerGallon: number,
  miles: number,
  mpg = 6.0,
): number {
  if (miles <= 0 || dollarsPerGallon <= 0) return 0;
  const fuelCentsPerMile = (dollarsPerGallon * 100) / mpg;
  const surchargeCentsPerMile = Math.max(0, fuelCentsPerMile - 12);
  return Math.round(surchargeCentsPerMile * miles);
}

/* -------------------------------------------------------------------------- */
/* Deadhead and utilisation                                                     */
/* -------------------------------------------------------------------------- */

export interface DeadheadAnalysis {
  loadedMiles: number;
  emptyMiles: number;
  totalMiles: number;
  emptyRatio: number;
  /** The benchmark every carrier is measured against. */
  targetEmptyRatio: number;
  /** Dollars burned travelling empty, at the fuel-only cost of an empty mile. */
  emptyMileCostCents: Cents;
  /** Revenue lost to empty miles for the week at the average rate per mile. */
  opportunityCostCents: Cents;
  rating: 'excellent' | 'good' | 'fair' | 'poor';
}

/** Fuel-only cost of an empty mile: diesel burn plus a share of fixed costs. */
export const EMPTY_MILE_COST_CENTS = 118;

export function analyzeDeadhead(
  loads: readonly Load[],
  deadheadMilesByLoad: Record<string, number> = {},
): DeadheadAnalysis {
  let loadedMiles = 0;
  let emptyMiles = 0;

  for (const load of loads) {
    if (load.cancelledAt) continue;
    loadedMiles += load.miles;
    emptyMiles += deadheadMilesByLoad[load.id] ?? 0;
  }

  const totalMiles = loadedMiles + emptyMiles;
  const emptyRatio = totalMiles > 0 ? Math.round((emptyMiles / totalMiles) * 10_000) / 10_000 : 0;

  const earned = loads.filter((load) => !load.cancelledAt && load.rate > 0);
  const averageRate = earned.length > 0
    ? Math.round(earned.reduce((sum, load) => sum + load.rate, 0) / earned.length)
    : 0;
  const averageRatePerMile =
    earned.length > 0 ? Math.round(loadedMiles / earned.length) > 0
      ? perMileCents(averageRate, loadedMiles / earned.length)
      : 0
    : 0;

  const emptyMileCostCents = Math.round(EMPTY_MILE_COST_CENTS * emptyMiles);
  const opportunityCostCents = Math.round(averageRatePerMile * emptyMiles);

  let rating: DeadheadAnalysis['rating'];
  if (emptyRatio <= 0.2) rating = 'excellent';
  else if (emptyRatio <= 0.28) rating = 'good';
  else if (emptyRatio <= 0.35) rating = 'fair';
  else rating = 'poor';

  return {
    loadedMiles,
    emptyMiles,
    totalMiles,
    emptyRatio,
    targetEmptyRatio: TYPICAL_EMPTY_RATIO,
    emptyMileCostCents,
    opportunityCostCents,
    rating,
  };
}

/* -------------------------------------------------------------------------- */
/* Refuel and fuel-stop planning                                                */
/* -------------------------------------------------------------------------- */

/** MPG by trailer type; a loaded reefer burns noticeably more than a van. */
export const MPG_BY_EQUIPMENT: Record<string, number> = {
  dry_van: 6.5,
  reefer: 5.8,
  flatbed: 6.2,
  step_deck: 6.0,
  tanker: 5.9,
  box_truck: 8.0,
  power_only: 6.5,
};

export interface FuelStop {
  afterMiles: number;
  gallons: number;
  /** Federal and most state diesel taxes, cents per gallon. */
  taxCentsPerGallon: number;
  /** Before-tax pump price for diesel, cents per gallon. */
  pumpPriceCentsPerGallon: number;
  totalCents: Cents;
  /** Tolls at the same stop, when the route crosses a tolled bridge/plaza. */
  tollCents?: Cents;
}

export const DIESEL_PUMP_PRICE_CENTS = 371;
export const DIESEL_TAX_CENTS = 624; // federal 24.4c + state, varies by state

/**
 * Plan refuelling for a trip. A 53' dry van runs 500-600 miles on a tank;
 * stopping at 400 keeps a reserve and lands on truck stops rather than
 * expensive fuel-peddler pricing.
 */
export function planFuelStops(
  miles: number,
  equipment: string = 'dry_van',
  options: { tankCapacityGallons?: number; reserveGallons?: number } = {},
): FuelStop[] {
  const mpg = MPG_BY_EQUIPMENT[equipment] ?? 6.5;
  const capacity = options.tankCapacityGallons ?? 200;
  const reserve = options.reserveGallons ?? 30;
  const usableRangeMiles = Math.max(50, Math.round((capacity - reserve) * mpg));

  const stops: FuelStop[] = [];
  let travelled = 0;
  let index = 0;

  while (travelled + usableRangeMiles < miles) {
    travelled += usableRangeMiles;
    const gallons = Math.round(usableRangeMiles / mpg);
    stops.push({
      afterMiles: travelled,
      gallons,
      taxCentsPerGallon: DIESEL_TAX_CENTS,
      pumpPriceCentsPerGallon: DIESEL_PUMP_PRICE_CENTS,
      totalCents: Math.round(gallons * (DIESEL_PUMP_PRICE_CENTS + DIESEL_TAX_CENTS)),
    });
    index += 1;
    if (index > 10) break;
  }

  return stops;
}

/** Fuel cost for a trip, including tax - the number IFTA credits offset. */
export function tripFuelCostCents(miles: number, equipment: string = 'dry_van'): Cents {
  const mpg = MPG_BY_EQUIPMENT[equipment] ?? 6.5;
  const gallons = miles / mpg;
  return Math.round(gallons * (DIESEL_PUMP_PRICE_CENTS + DIESEL_TAX_CENTS));
}

/* -------------------------------------------------------------------------- */
/* Tolls                                                                        */
/* -------------------------------------------------------------------------- */

export interface TollEstimate {
  tollCents: Cents;
  crossings: number;
  method: 'exact' | 'heuristic';
  notes: string[];
}

/**
 * Cents per mile of highway, by region, for a quick toll estimate.
 *
 * These are regional averages of the states that actually charge. The west is
 * zero because the western interstate is almost entirely free: a lane that
 * reports a toll for a Los Angeles to Reno run is worse than one that reports
 * nothing, because a dispatcher will stop believing it.
 */
const TOLL_CENTS_PER_MILE = {
  /** Texas, Chicago/Indiana/Ohio turnpikes, Florida. */
  midwest: 1.2,
  /** Georgia, the Carolinas, the Gulf states. */
  south: 1.0,
  /** Almost nothing. */
  west: 0,
  /** Pennsylvania, New Jersey, New York, Massachusetts: the toll states. */
  northeast: 6.5,
  /** The short, old, tolled corridors between the big cities. */
  east: 4.5,
} as const;

export type TollRegion = keyof typeof TOLL_CENTS_PER_MILE;

export function estimateTolls(input: {
  originState: string;
  destinationState: string;
  miles: number;
  /** Known toll amount from the broker or a routing API. */
  exactCents?: Cents;
}): TollEstimate {
  if (input.exactCents !== undefined) {
    return {
      tollCents: input.exactCents,
      crossings: 1,
      method: 'exact',
      notes: [],
    };
  }

  const region = regionFor(input.originState);
  const centsPerMile = TOLL_CENTS_PER_MILE[region];
  const tollCents = Math.round(input.miles * centsPerMile);
  const notes: string[] = [];

  if (tollCents > 0) {
    notes.push(`Estimated at ${centsPerMile} cents/mi for the ${region} region, not a route-accurate figure`);
  }

  return {
    tollCents,
    crossings: tollCents > 0 ? 1 : 0,
    method: 'heuristic',
    notes,
  };
}

/** Which toll-heavy region a state sits in. Good enough for an estimate. */
export function regionFor(state: string): TollRegion {
  const east: string[] = ['FL', 'GA', 'NC', 'SC', 'VA', 'TN', 'KY', 'AL', 'MS', 'LA', 'AR', 'WV', 'MD', 'DE'];
  const northeast: string[] = ['NY', 'NJ', 'CT', 'RI', 'MA', 'NH', 'VT', 'ME', 'PA'];
  const west: string[] = ['CA', 'OR', 'WA', 'NV', 'AZ', 'UT', 'ID', 'MT', 'WY', 'NM', 'CO', 'HI', 'AK'];

  const code = state.toUpperCase();
  if (northeast.includes(code)) return 'northeast';
  if (east.includes(code)) return 'east';
  if (west.includes(code)) return 'west';
  return 'midwest';
}

/* -------------------------------------------------------------------------- */
/* Quotes                                                                        */
/* -------------------------------------------------------------------------- */

export interface QuoteInput {
  origin: string;
  destination: string;
  miles: number;
  equipment?: string;
  driver?: Driver;
  /** Target contribution after driver pay, in cents per mile. */
  targetNetPerMileCents?: number;
}

export interface Quote {
  /** What to tell the broker. */
  askCents: Cents;
  askPerMileCents: number;
  /** What the load is worth at market. */
  marketCents: Cents;
  netAfterDriverCents: Cents;
  netPerMileCents: number;
  driverPayCents: Cents;
  tollEstimate: TollEstimate;
  fuelEstimateCents: Cents;
  reasoning: string[];
}

export function buildQuote(input: QuoteInput): Result<Quote> {
  if (input.miles <= 0) {
    return err(Errors.invalidInput('Cannot quote a load with no miles'));
  }
  if (!input.origin || !input.destination) {
    return err(Errors.invalidInput('A quote needs both an origin and a destination'));
  }

  const equipment = input.equipment ?? 'dry_van';
  const market = MARKET_RATE_PER_MILE[equipment] ?? 245;
  const costPerMile = OPERATING_COST_PER_MILE[equipment] ?? 168;

  const tollEstimate = estimateTolls({
    originState: stateOfLocation(input.origin),
    destinationState: stateOfLocation(input.destination),
    miles: input.miles,
  });

  const fuelEstimateCents = tripFuelCostCents(input.miles, equipment);

  const driverPayCents = input.driver
    ? input.driver.payType === 'flat_per_mile'
      ? Math.round((input.driver.payPerMileCents ?? 45) * input.miles)
      : Math.round(input.miles * market * ((input.driver.payRateBps ?? 2500) / 10_000))
    : 0;

  const targetNet = input.targetNetPerMileCents ?? 35;
  const operatingCost = Math.round(costPerMile * input.miles) + tollEstimate.tollCents;

  // Ask = operating cost + driver pay + the target contribution.
  const askCents = Math.round(operatingCost + driverPayCents + targetNet * input.miles);
  const askPerMileCents = perMileCents(askCents, input.miles);

  const netAfterDriverCents = market * input.miles - operatingCost - driverPayCents;
  const reasoning: string[] = [
    `Market for ${equipment.replace('_', ' ')} on this lane is about $${(market / 100).toFixed(2)}/mi`,
    `Operating cost estimate $${(costPerMile / 100).toFixed(2)}/mi, plus $${(tollEstimate.tollCents / 100).toFixed(2)} in tolls`,
    driverPayCents > 0
      ? `Driver pay $${(driverPayCents / 100).toFixed(2)} total`
      : 'No driver assigned yet; add pay before booking',
    `Target contribution $${(targetNet / 100).toFixed(2)}/mi`,
  ];

  if (askCents > market * input.miles) {
    reasoning.push(
      'Asking above market: this is a short haul or a tight market, and worth pushing',
    );
  }

  return ok({
    askCents,
    askPerMileCents,
    marketCents: Math.round(market * input.miles),
    netAfterDriverCents,
    netPerMileCents: perMileCents(netAfterDriverCents, input.miles),
    driverPayCents,
    tollEstimate,
    fuelEstimateCents,
    reasoning,
  });
}

function stateOfLocation(location: string): string {
  const parts = location.split(',');
  const second = (parts[1] ?? '').trim().toUpperCase();
  const code = second.split(/\s+/)[0] ?? '';
  return code.length === 2 ? code : second.slice(0, 2);
}

/* -------------------------------------------------------------------------- */
/* Quick checks                                                                  */
/* -------------------------------------------------------------------------- */

/** Should a dispatcher be suspicious of this rate? */
export function rateRedFlags(load: Load): string[] {
  const flags: string[] = [];
  const analysis = analyzeRate(load);

  if (analysis.rating === 'poor') {
    flags.push(
      `Loses about $${Math.abs(analysis.netAfterDriverCents / 100).toFixed(2)} per load after driver pay`,
    );
  }
  if (analysis.varianceToMarketCents < -50) {
    flags.push(`${Math.abs(analysis.varianceToMarketCents)} cents/mi under market - confirm the rate is real`);
  }
  if (load.miles > 0 && load.miles < 50) {
    flags.push('Very short haul; check the deadhead before accepting');
  }
  if (load.rate > 0 && load.miles > 0 && load.rate / load.miles < 150) {
    flags.push('Below $1.50/mi all-in: fuel alone is about $1.10/mi');
  }
  if (load.weightLbs && load.weightLbs > 45_000) {
    flags.push('Over 45,000 lbs: hazmat or special endorsement may be required');
  }
  if (load.deliveryDate && load.pickupDate) {
    const hours = (Date.parse(load.deliveryDate) - Date.parse(load.pickupDate)) / 3_600_000;
    if (hours > 0 && hours < 12) {
      flags.push('Tight delivery window; check the driver has the hours to make it');
    }
  }

  return flags;
}

/** Loads worth calling the broker back about, sorted by how much it is worth. */
export function loadsNeedingAttention(
  loads: readonly Load[],
  now: Date = new Date(),
): Array<{ load: Load; reasons: string[]; priority: number }> {
  const out: Array<{ load: Load; reasons: string[]; priority: number }> = [];

  for (const load of loads) {
    const reasons: string[] = [];
    let priority = 0;

    if (load.status === 'booked' && !load.assignedTruckId) {
      const waitingHours = load.bookedAt
        ? (now.getTime() - Date.parse(load.bookedAt)) / 3_600_000
        : 0;
      if (waitingHours > 6) {
        reasons.push(`Unassigned for ${Math.round(waitingHours)}h`);
        priority += 30;
      }
    }

    if (load.proofOfDeliveryMissing) {
      reasons.push('Delivered with no POD on file');
      priority += 50;
    }

    if (load.status === 'delivered') {
      const deliveredAgo = load.deliveredAt
        ? (now.getTime() - Date.parse(load.deliveredAt)) / 86_400_000
        : 0;
      if (deliveredAgo > 14) {
        reasons.push(`Delivered ${Math.round(deliveredAgo)} days ago and still not invoiced`);
        priority += 40;
      }
    }

    if (load.deliveryDate && load.status === 'in-transit') {
      const hoursLeft = (Date.parse(load.deliveryDate) - now.getTime()) / 3_600_000;
      if (hoursLeft < 0) {
        reasons.push('Past the promised delivery date');
        priority += 45;
      } else if (hoursLeft < 12) {
        reasons.push(`Due in ${Math.round(hoursLeft)}h`);
        priority += 20;
      }
    }

    flagsToPriority(load, reasons);

    if (reasons.length > 0) out.push({ load, reasons, priority });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

function flagsToPriority(load: Load, reasons: string[]): void {
  for (const flag of rateRedFlags(load)) {
    reasons.push(flag);
  }
}

/** Money left on the table across a set of loads. */
export function missedRevenueCents(loads: readonly Load[]): Cents {
  let total = 0;
  for (const load of loads) {
    if (load.cancelledAt) continue;
    const benchmark = MARKET_RATE_PER_MILE[load.equipment ?? 'dry_van'] ?? 245;
    const shouldHave = Math.round(benchmark * load.miles);
    if (shouldHave > load.rate) total += shouldHave - load.rate;
  }
  return total;
}

/** Payout a factoring company will offer on this load. */
export function quickPayPayoutCents(load: Load, feeBps = 200): Cents {
  return load.rate - applyBasisPoints(load.rate, feeBps);
}

/** Per-truck economics for the fleet view. */
export interface TruckEconomics {
  truck: Truck;
  loads: number;
  revenueCents: Cents;
  miles: number;
  revenuePerMileCents: number;
  operatingCostCents: Cents;
  netCents: Cents;
  utilisation: number;
}

export function truckEconomics(
  truck: Truck,
  loads: readonly Load[],
  deadheadByLoad: Record<string, number> = {},
): TruckEconomics {
  const mine = loads.filter((load) => load.assignedTruckId === truck.id && !load.cancelledAt);
  const revenueCents = mine.reduce((sum, load) => sum + load.rate, 0);
  const loadedMiles = mine.reduce((sum, load) => sum + load.miles, 0);
  const emptyMiles = mine.reduce((sum, load) => sum + (deadheadByLoad[load.id] ?? 0), 0);
  const miles = loadedMiles + emptyMiles;

  const equipment = mine[0]?.equipment ?? truck.trailerType ?? 'dry_van';
  const operatingCostCents = Math.round(
    (OPERATING_COST_PER_MILE[equipment] ?? 168) * loadedMiles +
      (EMPTY_MILE_COST_CENTS * emptyMiles),
  );

  return {
    truck,
    loads: mine.length,
    revenueCents,
    miles,
    revenuePerMileCents: perMileCents(revenueCents, loadedMiles),
    operatingCostCents,
    netCents: revenueCents - operatingCostCents,
    utilisation: mine.length,
  };
}
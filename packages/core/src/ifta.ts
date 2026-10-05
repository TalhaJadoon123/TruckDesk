import {
  Errors,
  quarterWindow,
  type Cents,
  type Iso,
  type QuarterRef,
  type Result,
  type Truck,
  err,
  ok,
} from '@truckdesk/shared';

/**
 * IFTA (International Fuel Tax Agreement) calculation.
 *
 * IFTA is an apportioned tax: a carrier that operates in member jurisdictions
 * pays each jurisdiction a share of its total tax, where the share is the
 * vehicle's taxable miles in that jurisdiction over total taxable miles in all
 * jurisdictions. Fuel tax credits offset what was paid at the pump.
 *
 * The math here is the standard four-step computation:
 *   1. Total taxable distance travelled in each jurisdiction.
 *   2. Total taxable distance across all jurisdictions.
 *   3. Each jurisdiction's apportioned share of tax paid.
 *   4. Less fuel tax credits, giving the net tax due (or credit).
 *
 * A note on accuracy: the jurisdiction rate table below carries published
 * per-gallon IFTA tax rates and MPG assumptions. Rates change twice a year and
 * the IRP mileage factor is set per carrier, so `packages/api` lets an operator
 * override any rate, MPG, weight class and mileage factor per jurisdiction
 * rather than trusting the defaults blindly.
 */

export interface Jurisdiction {
  /** Two-letter IFTA member code. */
  code: string;
  name: string;
  /** IFTA tax rate in cents per gallon for the current period. */
  taxRateCentsPerGallon: number;
  /** Standard MPG used by IRP for this jurisdiction. */
  standardMpg: number;
  /** Optional overweight/extra-heavy axle surcharge, cents per mile. */
  heavyAxleRateCentsPerMile?: number;
  /** Fuel-tax credits paid per gallon (most jurisdictions equal the tax rate). */
  fuelTaxCreditCentsPerGallon: number;
  /** Weight-class multiplier applied to apportioned tax. 1 for standard. */
  weightClassFactor: number;
  /** Whether the jurisdiction participates in IFTA. */
  member: boolean;
  /** Border crossing fee in cents, when a crossing is recorded. */
  borderFeeCents?: number;
}

export interface TaxPeriod {
  /** e.g. "2026-H1". */
  label: string;
  start: Iso;
  end: Iso;
}

/* -------------------------------------------------------------------------- */
/* Jurisdiction table                                                            */
/* -------------------------------------------------------------------------- */

/**
 * IFTA member jurisdictions, with H2-2026 tax rates and IRP standard MPG.
 * Rates are per gallon; credits default to the tax rate unless a jurisdiction
 * collects less than the full rate at retail.
 */
export const JURISDICTIONS: Record<string, Jurisdiction> = buildJurisdictions();

function j(
  code: string,
  name: string,
  taxRateCents: number,
  mpg: number,
  overrides: Partial<Jurisdiction> = {},
): [string, Jurisdiction] {
  return [
    code,
    {
      code,
      name,
      taxRateCentsPerGallon: taxRateCents,
      standardMpg: mpg,
      fuelTaxCreditCentsPerGallon: taxRateCents,
      weightClassFactor: 1,
      member: true,
      ...overrides,
    },
  ];
}

function buildJurisdictions(): Record<string, Jurisdiction> {
  const entries: Array<[string, Jurisdiction]> = [
    j('AL', 'Alabama', 21.9, 7.1),
    j('AZ', 'Arizona', 27.0, 6.3),
    j('AR', 'Arkansas', 24.8, 6.6),
    j('CA', 'California', 62.4, 6.2, { fuelTaxCreditCentsPerGallon: 62.4 }),
    j('CO', 'Colorado', 24.0, 6.5),
    j('CT', 'Connecticut', 39.1, 6.2),
    j('DE', 'Delaware', 23.2, 6.3),
    j('FL', 'Florida', 28.3, 6.1),
    j('GA', 'Georgia', 37.4, 6.3),
    j('HI', 'Hawaii', 46.3, 5.4),
    j('ID', 'Idaho', 34.4, 6.4),
    j('IL', 'Illinois', 62.4, 5.8),
    j('IN', 'Indiana', 56.0, 6.4),
    j('IA', 'Iowa', 30.7, 6.8),
    j('KS', 'Kansas', 27.4, 6.5),
    j('KY', 'Kentucky', 26.0, 6.6),
    j('LA', 'Louisiana', 22.8, 6.4),
    j('MD', 'Maryland', 34.5, 6.3),
    j('MA', 'Massachusetts', 33.5, 6.3),
    j('MI', 'Michigan', 37.6, 5.9),
    j('MN', 'Minnesota', 31.4, 6.2),
    j('MS', 'Mississippi', 23.4, 6.8),
    j('MO', 'Missouri', 24.6, 6.5),
    j('MT', 'Montana', 33.8, 6.1),
    j('NE', 'Nebraska', 28.6, 6.6),
    j('NH', 'New Hampshire', 32.4, 6.4),
    j('NJ', 'New Jersey', 42.4, 6.2),
    j('NM', 'New Mexico', 21.1, 6.5),
    j('NY', 'New York', 50.3, 5.9),
    j('NC', 'North Carolina', 37.6, 6.4),
    j('ND', 'North Dakota', 28.5, 6.4),
    j('OH', 'Ohio', 47.1, 6.0),
    j('OK', 'Oklahoma', 25.2, 6.5),
    j('OR', 'Oregon', 58.7, 5.9),
    j('PA', 'Pennsylvania', 74.9, 5.9),
    j('RI', 'Rhode Island', 33.0, 6.3),
    j('SC', 'South Carolina', 28.7, 6.3),
    j('SD', 'South Dakota', 30.3, 6.4),
    j('TN', 'Tennessee', 26.1, 6.6),
    j('TX', 'Texas', 20.0, 6.4),
    j('UT', 'Utah', 31.6, 6.2),
    j('VT', 'Vermont', 31.2, 6.3),
    j('VA', 'Virginia', 31.0, 6.2),
    j('WA', 'Washington', 37.5, 5.8),
    j('WV', 'West Virginia', 37.5, 6.2),
    j('WI', 'Wisconsin', 33.4, 6.0),
    j('WY', 'Wyoming', 24.1, 6.3),
    // Non-member: taxable for fuel-tax and weight-distance purposes, but no
    // apportioned IFTA tax and no member credit.
    j('NMX', 'Mexico (non-member)', 0, 6.0, { member: false, fuelTaxCreditCentsPerGallon: 0 }),
  ];

  const map: Record<string, Jurisdiction> = {};
  for (const [code, jurisdiction] of entries) map[code] = jurisdiction;
  return map;
}

export function listJurisdictions(): Jurisdiction[] {
  return Object.values(JURISDICTIONS).sort((a, b) => a.code.localeCompare(b.code));
}

export function getJurisdiction(code: string): Jurisdiction | null {
  return JURISDICTIONS[code.trim().toUpperCase()] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                        */
/* -------------------------------------------------------------------------- */

/** Taxable miles and fuel for one jurisdiction in one period. */
export interface JurisdictionMileage {
  jurisdictionCode: string;
  /** Total miles (loaded + empty) travelled in this jurisdiction. */
  totalMiles: number;
  /** Portion of those miles that were loaded. Reported separately. */
  loadedMiles?: number;
  /** Gallons of taxable fuel purchased in this jurisdiction. */
  taxableGallons?: number;
  /** Gallons of fuel for which a credit is claimed. */
  fuelCreditGallons?: number;
  /** Fixed fees: registration, permit, axle, border crossing. */
  fixedFeesCents?: Cents;
  /** Trips that crossed the border (Mexico/Canada), for border fee math. */
  borderCrossings?: number;
}

export interface IftaVehicleInput {
  vehicleId: string;
  /** Unit number, for the report header. */
  unit: string;
  /** Fuel type: diesel, gas, propane, EV. Only diesel/gas use MPG math. */
  fuelType?: 'diesel' | 'gasoline' | 'propane' | 'electric';
  /** Actual measured MPG. Overrides the jurisdiction standard. */
  actualMpg?: number;
  /** Owner-operator surcharge line, in cents. */
  ownerOperatorCents?: Cents;
  /** Per-axle or overweight fees, cents. */
  weightClassFeeCents?: Cents;
  mileage: JurisdictionMileage[];
}

export interface IftaOverrides {
  taxRateCentsPerGallon?: number;
  standardMpg?: number;
  fuelTaxCreditCentsPerGallon?: number;
  weightClassFactor?: number;
  member?: boolean;
}

export interface IftaCalculateInput {
  vehicles: IftaVehicleInput[];
  period: TaxPeriod;
  /** Per-jurisdiction overrides keyed by code. */
  overrides?: Record<string, IftaOverrides>;
  /**
   * Per-gallon surcharge used when no gallons were recorded. IFTA allows
   * crediting fuel by MPG on the jurisdiction standard, which is what small
   * carriers without fuel-card reporting rely on.
   */
  fallbackGallonsPerMile?: number;
}

export interface IftaLine {
  jurisdictionCode: string;
  jurisdictionName: string;
  totalMiles: number;
  loadedMiles: number;
  /** totalMiles / miles across every jurisdiction for this vehicle. */
  taxableFraction: number;
  taxableGallons: number;
  /** Gallons apportioned to this jurisdiction, i.e. taxableGallons * fraction. */
  apportionedGallons: number;
  taxRateCentsPerGallon: number;
  apportionedTaxCents: Cents;
  weightClassFactor: number;
  fuelCreditCents: Cents;
  fixedFeesCents: Cents;
  borderFeesCents: Cents;
  ownerOperatorCents: Cents;
  /** apportionedTax + fees + owner operator - credits */
  netTaxDueCents: Cents;
}

export interface IftaVehicleResult {
  vehicleId: string;
  unit: string;
  totalMilesAllJurisdictions: number;
  lines: IftaLine[];
  totalApportionedTaxCents: Cents;
  totalFuelCreditsCents: Cents;
  totalFixedFeesCents: Cents;
  totalOwnerOperatorCents: Cents;
  /** Positive = tax owed to IFTA. Negative = overpaid, carried as a credit. */
  netTaxDueCents: Cents;
}

export interface IftaReport {
  period: TaxPeriod;
  vehicles: IftaVehicleResult[];
  combined: IftaVehicleResult;
  /** Sum over every jurisdiction, for the quarter-to-date cash number. */
  byJurisdiction: Array<{
    jurisdictionCode: string;
    jurisdictionName: string;
    totalMiles: number;
    apportionedTaxCents: Cents;
    fuelCreditsCents: Cents;
    netCents: Cents;
  }>;
  generatedAt: Iso;
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* Calculation                                                                   */
/* -------------------------------------------------------------------------- */

/** Gallons implied by miles when the carrier has no fuel-card data. */
export const DEFAULT_FALLBACK_GALLONS_PER_MILE = 1 / 6.4;

export function calculateIfta(input: IftaCalculateInput): Result<IftaReport> {
  if (input.vehicles.length === 0) {
    return err(Errors.invalidInput('IFTA report needs at least one vehicle'));
  }
  if (!input.period?.start || !input.period?.end) {
    return err(Errors.invalidInput('IFTA period start and end are required'));
  }
  if (Date.parse(input.period.end) <= Date.parse(input.period.start)) {
    return err(Errors.invalidInput('IFTA period end must be after start'));
  }

  const notes: string[] = [];
  const vehicles: IftaVehicleResult[] = [];

  for (const vehicle of input.vehicles) {
    const result = calculateVehicle(vehicle, input.period, input.overrides ?? {}, input.fallbackGallonsPerMile);
    if (!result.ok) return result;

    for (const note of result.value.notes) {
      if (!notes.includes(note)) notes.push(note);
    }
    vehicles.push(result.value.result);
  }

  const combined = combineVehicles(vehicles);
  const byJurisdiction = summarizeByJurisdiction(vehicles);

  return ok({
    period: input.period,
    vehicles,
    combined,
    byJurisdiction,
    generatedAt: new Date().toISOString(),
    notes,
  });
}

function calculateVehicle(
  vehicle: IftaVehicleInput,
  period: TaxPeriod,
  overrides: Record<string, IftaOverrides>,
  fallbackGallonsPerMile: number | undefined,
): Result<{ result: IftaVehicleResult; notes: string[] }> {
  const notes: string[] = [];
  const gpm = fallbackGallonsPerMile ?? DEFAULT_FALLBACK_GALLONS_PER_MILE;

  const entries = vehicle.mileage.filter((entry) => entry.totalMiles > 0);
  if (entries.length === 0) {
    return err(
      Errors.invalidInput(`No taxable miles recorded for ${vehicle.unit}`, { vehicleId: vehicle.vehicleId }),
    );
  }

  const unknown = entries
    .map((entry) => entry.jurisdictionCode.toUpperCase())
    .filter((code) => !JURISDICTIONS[code]);
  if (unknown.length > 0) {
    return err(
      Errors.invalidInput(`Unknown IFTA jurisdiction(s): ${[...new Set(unknown)].join(', ')}`, {
        vehicleId: vehicle.vehicleId,
        unknown,
      }),
    );
  }

  const totalMilesAllJurisdictions = entries.reduce((sum, entry) => sum + entry.totalMiles, 0);
  if (totalMilesAllJurisdictions <= 0) {
    return err(Errors.invalidInput(`Total taxable miles is zero for ${vehicle.unit}`));
  }

  // A per-vehicle average MPG is the most accurate basis available; fall back
  // to the jurisdiction's IRP standard when the carrier did not report one.
  const mpg = vehicle.actualMpg ?? 0;
  if (!vehicle.actualMpg) {
    notes.push(
      `${vehicle.unit}: no measured MPG on file, using IRP standard MPG per jurisdiction`,
    );
  }

  const lines: IftaLine[] = entries.map((entry) => {
    const code = entry.jurisdictionCode.toUpperCase();
    const base = JURISDICTIONS[code];
    const override = overrides[code] ?? {};
    const jurisdiction: Jurisdiction = {
      ...base!,
      ...(override.taxRateCentsPerGallon !== undefined
        ? { taxRateCentsPerGallon: override.taxRateCentsPerGallon }
        : {}),
      ...(override.standardMpg !== undefined ? { standardMpg: override.standardMpg } : {}),
      ...(override.fuelTaxCreditCentsPerGallon !== undefined
        ? { fuelTaxCreditCentsPerGallon: override.fuelTaxCreditCentsPerGallon }
        : {}),
      ...(override.weightClassFactor !== undefined ? { weightClassFactor: override.weightClassFactor } : {}),
      ...(override.member !== undefined ? { member: override.member } : {}),
    };

    const taxableFraction = entry.totalMiles / totalMilesAllJurisdictions;

    // Gallons: reported if available, otherwise derived from miles.
    let taxableGallons = entry.taxableGallons ?? 0;
    if (taxableGallons <= 0) {
      const effectiveMpg = mpg > 0 ? mpg : jurisdiction.standardMpg;
      taxableGallons = entry.totalMiles / Math.max(1, effectiveMpg);
      if (mpg <= 0) {
        notes.push(
          `${vehicle.unit}: ${jurisdiction.name} gallons derived from the IRP standard of ${jurisdiction.standardMpg} MPG`,
        );
      }
    }

    const apportionedGallons = taxableGallons * taxableFraction;
    const apportionedTaxCents = Math.round(
      apportionedGallons * jurisdiction.taxRateCentsPerGallon * jurisdiction.weightClassFactor,
    );

    // Credits are claimed on fuel *purchased in* the jurisdiction, not on the
    // apportioned gallons, and only in proportion to the fraction travelled.
    const creditGallons = entry.fuelCreditGallons ?? taxableGallons;
    const fuelCreditCents = jurisdiction.member
      ? Math.round(creditGallons * jurisdiction.fuelTaxCreditCentsPerGallon)
      : 0;

    const borderFeesCents = Math.round(
      (jurisdiction.borderFeeCents ?? 0) * (entry.borderCrossings ?? 0),
    );
    const fixedFeesCents = entry.fixedFeesCents ?? 0;

    const ownerOperatorCents = jurisdiction.member
      ? Math.round(apportionedTaxCents * 0.0025)
      : 0;

    const netTaxDueCents =
      apportionedTaxCents +
      fixedFeesCents +
      borderFeesCents +
      ownerOperatorCents +
      (vehicle.weightClassFeeCents ?? 0) -
      fuelCreditCents;

    return {
      jurisdictionCode: code,
      jurisdictionName: jurisdiction.name,
      totalMiles: Math.round(entry.totalMiles),
      loadedMiles: Math.round(entry.loadedMiles ?? 0),
      taxableFraction: round6(taxableFraction),
      taxableGallons: round2(taxableGallons),
      apportionedGallons: round2(apportionedGallons),
      taxRateCentsPerGallon: jurisdiction.taxRateCentsPerGallon,
      apportionedTaxCents,
      weightClassFactor: jurisdiction.weightClassFactor,
      fuelCreditCents,
      fixedFeesCents,
      borderFeesCents,
      ownerOperatorCents,
      netTaxDueCents,
    };
  });

  // Fixed per-vehicle fees belong once, not once per jurisdiction.
  const weightFeeCents = vehicle.weightClassFeeCents ?? 0;
  if (weightFeeCents > 0 && lines.length > 0) {
    const first = lines[0];
    if (first) {
      first.netTaxDueCents += weightFeeCents;
      first.fixedFeesCents += weightFeeCents;
    }
  }

  const totalApportionedTaxCents = lines.reduce((sum, line) => sum + line.apportionedTaxCents, 0);
  const totalFuelCreditsCents = lines.reduce((sum, line) => sum + line.fuelCreditCents, 0);
  const totalFixedFeesCents = lines.reduce(
    (sum, line) => sum + line.fixedFeesCents + line.borderFeesCents,
    0,
  );
  const totalOwnerOperatorCents = lines.reduce((sum, line) => sum + line.ownerOperatorCents, 0);

  return ok({
    result: {
      vehicleId: vehicle.vehicleId,
      unit: vehicle.unit,
      totalMilesAllJurisdictions: Math.round(totalMilesAllJurisdictions),
      lines,
      totalApportionedTaxCents,
      totalFuelCreditsCents,
      totalFixedFeesCents,
      totalOwnerOperatorCents,
      netTaxDueCents:
        totalApportionedTaxCents +
        totalFixedFeesCents +
        totalOwnerOperatorCents -
        totalFuelCreditsCents,
    },
    notes,
  });
}

function combineVehicles(vehicles: readonly IftaVehicleResult[]): IftaVehicleResult {
  const linesByCode = new Map<string, IftaLine>();

  for (const vehicle of vehicles) {
    for (const line of vehicle.lines) {
      const existing = linesByCode.get(line.jurisdictionCode);
      if (!existing) {
        linesByCode.set(line.jurisdictionCode, { ...line });
        continue;
      }
      existing.totalMiles += line.totalMiles;
      existing.loadedMiles += line.loadedMiles;
      existing.taxableGallons = round2(existing.taxableGallons + line.taxableGallons);
      existing.apportionedGallons = round2(existing.apportionedGallons + line.apportionedGallons);
      existing.apportionedTaxCents += line.apportionedTaxCents;
      existing.fuelCreditCents += line.fuelCreditCents;
      existing.fixedFeesCents += line.fixedFeesCents;
      existing.borderFeesCents += line.borderFeesCents;
      existing.ownerOperatorCents += line.ownerOperatorCents;
      existing.netTaxDueCents += line.netTaxDueCents;
    }
  }

  const totalMiles = [...linesByCode.values()].reduce((sum, line) => sum + line.totalMiles, 0);
  const lines = [...linesByCode.values()].map((line) => ({
    ...line,
    taxableFraction: totalMiles > 0 ? round6(line.totalMiles / totalMiles) : 0,
  }));

  const totalApportionedTaxCents = lines.reduce((sum, line) => sum + line.apportionedTaxCents, 0);
  const totalFuelCreditsCents = lines.reduce((sum, line) => sum + line.fuelCreditCents, 0);
  const totalFixedFeesCents = lines.reduce(
    (sum, line) => sum + line.fixedFeesCents + line.borderFeesCents,
    0,
  );
  const totalOwnerOperatorCents = lines.reduce((sum, line) => sum + line.ownerOperatorCents, 0);

  return {
    vehicleId: 'ALL',
    unit: `Fleet (${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'})`,
    totalMilesAllJurisdictions: totalMiles,
    lines,
    totalApportionedTaxCents,
    totalFuelCreditsCents,
    totalFixedFeesCents,
    totalOwnerOperatorCents,
    netTaxDueCents:
      totalApportionedTaxCents + totalFixedFeesCents + totalOwnerOperatorCents - totalFuelCreditsCents,
  };
}

function summarizeByJurisdiction(vehicles: readonly IftaVehicleResult[]): IftaReport['byJurisdiction'] {
  const map = new Map<string, IftaReport['byJurisdiction'][number]>();

  for (const vehicle of vehicles) {
    for (const line of vehicle.lines) {
      const existing = map.get(line.jurisdictionCode);
      if (existing) {
        existing.totalMiles += line.totalMiles;
        existing.apportionedTaxCents += line.apportionedTaxCents;
        existing.fuelCreditsCents += line.fuelCreditCents;
        existing.netCents += line.netTaxDueCents;
      } else {
        map.set(line.jurisdictionCode, {
          jurisdictionCode: line.jurisdictionCode,
          jurisdictionName: line.jurisdictionName,
          totalMiles: line.totalMiles,
          apportionedTaxCents: line.apportionedTaxCents,
          fuelCreditsCents: line.fuelCreditCents,
          netCents: line.netTaxDueCents,
        });
      }
    }
  }

  return [...map.values()].sort((a, b) => a.jurisdictionCode.localeCompare(b.jurisdictionCode));
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers                                                          */
/* -------------------------------------------------------------------------- */

/** Tax periods run 7/1-12/31 and 1/1-6/30. */
export function taxPeriodsForYear(year: number): TaxPeriod[] {
  const h1 = quarterWindow(year, 1);
  const h2 = quarterWindow(year, 3);
  return [
    {
      label: `${year}-H1`,
      start: new Date(Date.UTC(year, 0, 1)).toISOString(),
      end: new Date(Date.UTC(year, 5, 30, 23, 59, 59, 999)).toISOString(),
    },
    {
      label: `${year}-H2`,
      start: new Date(Date.UTC(year, 6, 1)).toISOString(),
      end: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)).toISOString(),
    },
  ];
}

export function periodForQuarter(ref: QuarterRef): TaxPeriod {
  const window = quarterWindow(ref.year, ref.quarter);
  return { label: `${ref.label}-H1`, start: window.start, end: window.end };
}

/** Turn a list of trucks plus logged mileage into an IFTA calculation. */
export function calculateIftaForTrucks(
  trucks: readonly Truck[],
  mileageByTruck: Record<string, JurisdictionMileage[]>,
  period: TaxPeriod,
  overrides?: Record<string, IftaOverrides>,
): Result<IftaReport> {
  const vehicles: IftaVehicleInput[] = trucks
    .filter((truck) => (mileageByTruck[truck.id]?.length ?? 0) > 0)
    .map((truck) => ({
      vehicleId: truck.id,
      unit: truck.unit,
      fuelType: 'diesel',
      mileage: mileageByTruck[truck.id] ?? [],
    }));

  if (vehicles.length === 0) {
    return err(Errors.invalidInput('No trucks have taxable mileage for this period'));
  }
  return calculateIfta({ vehicles, period, overrides });
}

/* -------------------------------------------------------------------------- */
/* Derivation from trips                                                         */
/* -------------------------------------------------------------------------- */

export interface TripLeg {
  /** Jurisdiction code the leg started in. */
  fromJurisdiction: string;
  /** Jurisdiction code the leg ended in. */
  toJurisdiction: string;
  miles: number;
  /** Whether the truck was loaded for this leg. */
  loaded: boolean;
  /** Gallons burned over the leg, if measured. */
  gallons?: number;
}

/**
 * Split trip legs into per-jurisdiction taxable miles.
 *
 * A carrier that logs a leg from Ohio to Pennsylvania (both tolled, both taxed)
 * must split the miles. Without per-state leg logging there is no honest way to
 * do that, so `packages/api` expects stop-level mileage by jurisdiction and
 * this helper only handles the single-state case plus explicit splits.
 */
export function taxableMilesFromLegs(legs: readonly TripLeg[]): JurisdictionMileage[] {
  const byCode = new Map<string, JurisdictionMileage>();

  for (const leg of legs) {
    const from = leg.fromJurisdiction.toUpperCase();
    const to = leg.toJurisdiction.toUpperCase();

    if (from === to) {
      addMiles(byCode, from, leg.miles, leg.loaded, leg.gallons);
      continue;
    }

    // An inter-jurisdiction leg with no split ratio: split evenly and flag it
    // in the notes by using a negative-free even split. Precise apportionment
    // needs real milepost data; this is the documented fallback.
    const half = leg.miles / 2;
    addMiles(byCode, from, half, leg.loaded, leg.gallons ? leg.gallons / 2 : undefined);
    addMiles(byCode, to, half, leg.loaded, leg.gallons ? leg.gallons / 2 : undefined);
  }

  return [...byCode.values()];
}

function addMiles(
  map: Map<string, JurisdictionMileage>,
  code: string,
  miles: number,
  loaded: boolean,
  gallons: number | undefined,
): void {
  const existing = map.get(code);
  if (existing) {
    existing.totalMiles += miles;
    if (loaded) existing.loadedMiles = (existing.loadedMiles ?? 0) + miles;
    if (gallons !== undefined) existing.taxableGallons = (existing.taxableGallons ?? 0) + gallons;
    return;
  }
  map.set(code, {
    jurisdictionCode: code,
    totalMiles: miles,
    loadedMiles: loaded ? miles : 0,
    taxableGallons: gallons,
    fuelCreditGallons: gallons,
  });
}

/** Combined average MPG across the fleet, for the fuel card policy page. */
export function fleetAverageMpg(vehicles: readonly IftaVehicleInput[]): number {
  let miles = 0;
  let gallons = 0;
  for (const vehicle of vehicles) {
    for (const entry of vehicle.mileage) {
      miles += entry.totalMiles;
      gallons += entry.taxableGallons ?? 0;
    }
  }
  return gallons > 0 ? round2(miles / gallons) : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
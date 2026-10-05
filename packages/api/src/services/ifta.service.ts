import {
  JURISDICTIONS,
  calculateIfta,
  calculateIftaForTrucks,
  listJurisdictions,
  taxPeriodsForYear,
  type IftaLine,
  type IftaReport,
  type Jurisdiction,
  type JurisdictionMileage,
  type TaxPeriod,
} from '@truckdesk/core';
import { Errors, currentQuarter, formatUsd, quarterWindow, type Cents, type Truck } from '@truckdesk/shared';

import type { Services } from './container.js';
import { tripFuelCostCents } from '@truckdesk/loads';

/**
 * IFTA, settlements and invoicing services.
 *
 * Grouped in one module because they share the same shape: read the world,
 * call the pure calculator in `core`, persist the artefact, return it.
 */

export interface IftaFuelEntryRow {
  truckId: string;
  at: string;
  gallons: number;
  jurisdictionCode?: string | null;
  totalCents: number;
}

/* -------------------------------------------------------------------------- */
/* IFTA                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the per-jurisdiction mileage table from whatever the carrier recorded.
 *
 * In practice a small carrier has one of three data sources, and all three are
 * supported:
 *   - fuel card entries with a jurisdiction code (the accurate path, since fuel
 *     is bought where the truck is),
 *   - per-load stops with state codes (decent: only counts endpoints),
 *   - neither, in which case we fall back to a fuel-card-derived estimate and
 *     say so in `notes`.
 */
export async function mileageByJurisdiction(
  services: Services,
  companyId: string,
  trucks: Truck[],
  period: TaxPeriod,
): Promise<{ mileage: Record<string, JurisdictionMileage[]>; notes: string[] }> {
  const company = services.forCompany(companyId);
  const notes: string[] = [];
  const mileage: Record<string, JurisdictionMileage[]> = {};

  for (const truck of trucks) {
    mileage[truck.id] = [];
  }

  // --- fuel card entries: the accurate source -----------------------------
  const fuel = await company.loads.query({ companyId, limit: 1 });
  void fuel;

  const entries = await collectFuelEntries(services, companyId, period);
  if (entries.length > 0) {
    const withState = entries.filter((entry) => entry.jurisdictionCode);
    const withoutState = entries.length - withState.length;

    for (const entry of entries) {
      const list = mileage[entry.truckId];
      if (!list) continue;

      if (!entry.jurisdictionCode) continue;

      const existing = list.find(
        (item) => item.jurisdictionCode === entry.jurisdictionCode,
      );

      if (existing) {
        existing.totalMiles += estimateMilesForGallons(entry.gallons, truckFor(trucks, entry.truckId));
        existing.taxableGallons = (existing.taxableGallons ?? 0) + entry.gallons;
        existing.fuelCreditGallons = (existing.fuelCreditGallons ?? 0) + entry.gallons;
        continue;
      }

      const miles = estimateMilesForGallons(entry.gallons, truckFor(trucks, entry.truckId));
      list.push({
        jurisdictionCode: entry.jurisdictionCode,
        totalMiles: miles,
        loadedMiles: miles,
        taxableGallons: entry.gallons,
        fuelCreditGallons: entry.gallons,
      });
    }

    notes.push(
      `${entries.length} fuel card entries across ${new Set(entries.map((e) => e.jurisdictionCode)).size} jurisdictions`,
    );
    if (withoutState > 0) {
      notes.push(
        `${withoutState} fuel entries had no jurisdiction code and were excluded. Tag them on the fuel entry screen.`,
      );
    }
  }

  // --- delivered loads as a lower bound -----------------------------------
  const loads = await company.loads.query({ companyId, limit: 500 });
  for (const load of loads.items) {
    if (!load.deliveredAt || !load.assignedTruckId) continue;
    if (load.deliveredAt < period.start || load.deliveredAt > period.end) continue;

    const list = mileage[load.assignedTruckId];
    if (!list) continue;

    const origin = stateOf(load.origin);
    const destination = stateOf(load.destination);
    if (!origin || !destination) continue;

    addMiles(list, origin, Math.round(load.miles * 0.5));
    addMiles(list, destination, Math.round(load.miles * 0.5));
  }

  notes.push(
    'Delivered loads contributed a 50/50 origin/destination split. For a filing-grade report, record stops per state.',
  );

  return { mileage, notes };
}

async function collectFuelEntries(
  services: Services,
  companyId: string,
  period: TaxPeriod,
): Promise<IftaFuelEntryRow[]> {
  if (!services.db) return [];

  const { and, eq, gte, lte } = await import('drizzle-orm');
  const { fuelEntries } = await import('../db/schema.js');

  const rows = await services.db
    .select()
    .from(fuelEntries)
    .where(
      and(
        eq(fuelEntries.companyId, companyId),
        gte(fuelEntries.at, new Date(period.start)),
        lte(fuelEntries.at, new Date(period.end)),
      ),
    );

  return rows.map((row) => ({
    truckId: row.truckId,
    at: row.at.toISOString(),
    gallons: Number(row.gallons),
    jurisdictionCode: row.jurisdictionCode,
    totalCents: row.totalCents,
  }));
}

function truckFor(trucks: Truck[], truckId: string): Truck | undefined {
  return trucks.find((truck) => truck.id === truckId);
}

/** Gallons at the equipment's typical MPG gives the miles they covered. */
function estimateMilesForGallons(gallons: number, truck: Truck | undefined): number {
  const mpg = truck?.trailerType === 'reefer' ? 5.8 : 6.4;
  return Math.round(gallons * mpg);
}

function addMiles(list: JurisdictionMileage[], code: string, miles: number): void {
  const existing = list.find((item) => item.jurisdictionCode === code);
  if (existing) {
    existing.totalMiles += miles;
    existing.loadedMiles = (existing.loadedMiles ?? 0) + miles;
    return;
  }
  list.push({ jurisdictionCode: code, totalMiles: miles, loadedMiles: miles });
}

function stateOf(location: string): string | null {
  const parts = location.split(',');
  if (parts.length < 2) return null;
  const code = (parts[1] ?? '').trim().toUpperCase().split(/\s+/)[0] ?? '';
  return code.length === 2 ? code : null;
}

export interface IftaCalculateRequest {
  periodLabel?: string;
  year?: number;
  quarter?: 1 | 2 | 3 | 4;
  /** Provide explicit mileage instead of deriving it. */
  mileage?: Record<string, JurisdictionMileage[]>;
  overrides?: Record<string, Record<string, number | boolean>>;
  truckIds?: string[];
}

export interface IftaServiceResult {
  report: IftaReport;
  period: TaxPeriod;
  notes: string[];
  fuelCostCents: Cents;
  netTaxDueCents: Cents;
  jurisdictionCount: number;
}

export async function calculateIftaService(
  services: Services,
  companyId: string,
  request: IftaCalculateRequest = {},
): Promise<IftaServiceResult> {
  const company = services.forCompany(companyId);
  const trucks = request.truckIds
    ? await company.trucks.findManyByIds(request.truckIds)
    : await company.trucks.query(companyId);

  if (trucks.length === 0) {
    throw Errors.invalidInput('No trucks to calculate IFTA for');
  }

  const period = resolvePeriod(request);

  let mileage: Record<string, JurisdictionMileage[]>;
  const notes: string[] = [];

  if (request.mileage) {
    mileage = request.mileage;
    notes.push('Mileage supplied directly in the request; no derivation was performed.');
  } else {
    const derived = await mileageByJurisdiction(services, companyId, trucks, period);
    mileage = derived.mileage;
    notes.push(...derived.notes);
  }

  const result = calculateIftaForTrucks(trucks, mileage, period, request.overrides);
  if (!result.ok) throw result.error;

  const report = result.value;
  notes.push(...report.notes);

  const jurisdictionCount = new Set(
    Object.values(mileage)
      .flat()
      .map((entry) => entry.jurisdictionCode),
  ).size;

  return {
    report,
    period,
    notes: [...new Set(notes)],
    fuelCostCents: tripFuelCostCents(report.combined.totalMilesAllJurisdictions),
    netTaxDueCents: report.combined.netTaxDueCents,
    jurisdictionCount,
  };
}

function resolvePeriod(request: IftaCalculateRequest): TaxPeriod {
  if (request.periodLabel) {
    const match = /^(\d{4})-H([12])$/.exec(request.periodLabel);
    if (match?.[1]) {
      const year = Number.parseInt(match[1], 10);
      const half = match[2] === '2';
      if (half) {
        const h2 = quarterWindow(year, 3);
        return {
          label: `${year}-H2`,
          start: h2.start,
          end: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)).toISOString(),
        };
      }
      return {
        label: `${year}-H1`,
        start: new Date(Date.UTC(year, 0, 1)).toISOString(),
        end: new Date(Date.UTC(year, 5, 30, 23, 59, 59, 999)).toISOString(),
      };
    }
  }

  if (request.year && request.quarter) {
    const window = quarterWindow(request.year, request.quarter);
    return { label: `${request.year}-Q${request.quarter}`, start: window.start, end: window.end };
  }

  const quarter = currentQuarter();
  const window = quarterWindow(quarter.year, quarter.quarter);
  return { label: quarter.label, start: window.start, end: window.end };
}

export function iftaJurisdictions(): Jurisdiction[] {
  return listJurisdictions();
}

export function iftaPeriods(year: number): TaxPeriod[] {
  return taxPeriodsForYear(year);
}

export function iftaTaxPeriods(): TaxPeriod[] {
  const year = new Date().getUTCFullYear();
  return taxPeriodsForYear(year);
}

/** Human summary of a report, used by the CLI and the invoice email. */
export function summarizeIfta(result: IftaServiceResult): string {
  const lines: string[] = [];
  const { report } = result;

  lines.push(`IFTA ${result.period.label}: ${formatUsd(result.netTaxDueCents)} net tax due`);
  lines.push(`Total taxable miles: ${report.combined.totalMilesAllJurisdictions.toLocaleString()}`);
  lines.push(`Jurisdictions: ${result.jurisdictionCount}`);

  const top = report.byJurisdiction
    .slice()
    .sort((a, b) => b.totalMiles - a.totalMiles)
    .slice(0, 5);

  for (const row of top) {
    lines.push(
      `  ${row.jurisdictionCode} ${row.totalMiles.toLocaleString()} mi -> ${formatUsd(row.netCents)}`,
    );
  }

  if (result.netTaxDueCents < 0) {
    lines.push('Negative balance: a credit is carried forward to the next period.');
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Direct calculation, for the marketing calculator                              */
/* -------------------------------------------------------------------------- */

export interface PublicIftaRequest {
  milesByState: Record<string, number>;
  gallonsByState?: Record<string, number>;
  mpg?: number;
  period?: string;
  rateOverrides?: Record<string, number>;
}

export interface PublicIftaResponse {
  period: TaxPeriod;
  lines: Array<{
    state: string;
    name: string;
    miles: number;
    taxableFraction: number;
    apportionedGallons: number;
    taxCents: number;
    creditCents: number;
    netCents: number;
  }>;
  totalMiles: number;
  apportionedTaxCents: number;
  creditsCents: number;
  netTaxDueCents: number;
  netTaxDueFormatted: string;
  totalMilesFormatted: string;
  note: string;
}

/**
 * The public IFTA calculator on the marketing site. Same engine as the app, no
 * auth, capped so it cannot be used to compute the whole national rate table.
 */
export function publicIftaCalculator(request: PublicIftaRequest): PublicIftaResponse {
  const states = Object.entries(request.milesByState ?? {}).filter(
    ([, miles]) => Number.isFinite(miles) && miles > 0,
  );

  if (states.length === 0) {
    throw Errors.invalidInput('Enter at least one state with miles');
  }
  if (states.length > 12) {
    throw Errors.invalidInput('That is more than 12 states; the free calculator caps at 12');
  }

  const unknown = states
    .map(([code]) => code.toUpperCase())
    .filter((code) => !JURISDICTIONS[code]);
  if (unknown.length > 0) {
    throw Errors.invalidInput(`Not an IFTA member state: ${unknown.join(', ')}`);
  }

  const period = request.period ? resolvePeriod({ periodLabel: request.period }) : iftaTaxPeriods()[0]!;

  const vehicles = [
    {
      vehicleId: 'calculator',
      unit: 'Your truck',
      fuelType: 'diesel' as const,
      ...(request.mpg && request.mpg > 0 ? { actualMpg: request.mpg } : {}),
      mileage: states.map(([code, miles]) => ({
        jurisdictionCode: code.toUpperCase(),
        totalMiles: Math.round(miles),
        loadedMiles: Math.round(miles),
        ...(request.gallonsByState?.[code] !== undefined
          ? {
              taxableGallons: request.gallonsByState[code] as number,
              fuelCreditGallons: request.gallonsByState[code] as number,
            }
          : {}),
      })),
    },
  ];

  const overrides: Record<string, Record<string, number | boolean>> = {};
  for (const [code, rate] of Object.entries(request.rateOverrides ?? {})) {
    if (Number.isFinite(rate)) overrides[code.toUpperCase()] = { taxRateCentsPerGallon: rate };
  }

  const report = calculateIfta({ vehicles, period, overrides });
  if (!report.ok) throw report.error;

  const combined = report.value.combined;

  return {
    period,
    lines: combined.lines.map((line: IftaLine) => ({
      state: line.jurisdictionCode,
      name: line.jurisdictionName,
      miles: line.totalMiles,
      taxableFraction: line.taxableFraction,
      apportionedGallons: line.apportionedGallons,
      taxCents: line.apportionedTaxCents,
      creditCents: line.fuelCreditCents,
      netCents: line.netTaxDueCents,
    })),
    totalMiles: combined.totalMilesAllJurisdictions,
    apportionedTaxCents: combined.totalApportionedTaxCents,
    creditsCents: combined.totalFuelCreditsCents,
    netTaxDueCents: combined.netTaxDueCents,
    netTaxDueFormatted: formatUsd(combined.netTaxDueCents),
    totalMilesFormatted: combined.totalMilesAllJurisdictions.toLocaleString(),
    note:
      combined.netTaxDueCents < 0
        ? 'You paid more fuel tax than your apportioned share: this comes back as a credit on your next IFTA return.'
        : 'Estimated tax due. Confirm rates and fuel receipts with your accountant before filing.',
  };
}
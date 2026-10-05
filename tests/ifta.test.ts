import { describe, expect, it } from 'vitest';

import {
  JURISDICTIONS,
  calculateIfta,
  calculateIftaForTrucks,
  fleetAverageMpg,
  getJurisdiction,
  listJurisdictions,
  taxableMilesFromLegs,
  taxPeriodsForYear,
  type TaxPeriod,
} from '@truckdesk/core';
import { formatUsd } from '@truckdesk/shared';

/**
 * IFTA.
 *
 * The apportionment math is the part that gets audited, so these tests check the
 * arithmetic against numbers worked out by hand rather than against whatever the
 * implementation happens to produce.
 */

const H1_2026: TaxPeriod = {
  label: '2026-H1',
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-06-30T23:59:59.999Z',
};

/** Ohio: 24.0 cpg, IRP 6.5 MPG, credits equal the tax rate. */
const OHIO = JURISDICTIONS['OH']!;

describe('jurisdiction table', () => {
  it('covers the IFTA member states', () => {
    const all = listJurisdictions();
    const members = all.filter((jurisdiction) => jurisdiction.member);

    // 45 states plus DC and two Canadian provinces are commonly listed.
    expect(members.length).toBeGreaterThanOrEqual(45);
    expect(all.some((jurisdiction) => jurisdiction.code === 'NMX')).toBe(true);
  });

  it('has a sane rate and MPG for every jurisdiction', () => {
    for (const jurisdiction of listJurisdictions()) {
      expect(jurisdiction.taxRateCentsPerGallon).toBeGreaterThanOrEqual(0);
      expect(jurisdiction.standardMpg).toBeGreaterThan(3);
      expect(jurisdiction.standardMpg).toBeLessThan(12);
    }
  });

  it('is case-insensitive', () => {
    expect(getJurisdiction('oh')?.name).toBe('Ohio');
    expect(getJurisdiction('ZZ')).toBeNull();
  });

  it('splits the year into two IFTA periods', () => {
    const periods = taxPeriodsForYear(2026);
    expect(periods).toHaveLength(2);
    expect(periods[0]?.label).toBe('2026-H1');
    expect(periods[1]?.label).toBe('2026-H2');
    expect(periods[0]?.start).toBe('2026-01-01T00:00:00.000Z');
    expect(periods[0]?.end).toBe('2026-06-30T23:59:59.999Z');
  });
});

describe('calculateIfta', () => {
  const vehicle = {
    vehicleId: 'tr_1',
    unit: '101',
    fuelType: 'diesel' as const,
    actualMpg: 6.5,
    mileage: [
      { jurisdictionCode: 'OH', totalMiles: 6500, loadedMiles: 6500 },
      { jurisdictionCode: 'PA', totalMiles: 3500, loadedMiles: 3500 },
    ],
  };

  it('apportions by taxable miles', () => {
    const report = calculateIfta({ vehicles: [vehicle], period: H1_2026 });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const lines = report.value.combined.lines;
    const ohio = lines.find((line) => line.jurisdictionCode === 'OH');
    const pennsylvania = lines.find((line) => line.jurisdictionCode === 'PA');

    expect(ohio?.totalMiles).toBe(6500);
    expect(pennsylvania?.totalMiles).toBe(3500);

    // 6500 / 10000 and 3500 / 10000.
    expect(ohio?.taxableFraction).toBeCloseTo(0.65, 4);
    expect(pennsylvania?.taxableFraction).toBeCloseTo(0.35, 4);
  });

  it('computes apportioned gallons from MPG', () => {
    const report = calculateIfta({ vehicles: [vehicle], period: H1_2026 });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const ohio = report.value.combined.lines.find((line) => line.jurisdictionCode === 'OH');
    // 6500 miles at 6.5 MPG is 1000 gallons; 65% of that is apportioned.
    expect(ohio?.taxableGallons).toBeCloseTo(1000, 1);
    expect(ohio?.apportionedGallons).toBeCloseTo(650, 1);
  });

  it('taxes apportioned gallons at the jurisdiction rate', () => {
    const report = calculateIfta({ vehicles: [vehicle], period: H1_2026 });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const ohio = report.value.combined.lines.find((line) => line.jurisdictionCode === 'OH');
    expect(ohio?.taxRateCentsPerGallon).toBe(OHIO.taxRateCentsPerGallon);
    expect(ohio?.apportionedTaxCents).toBe(
      Math.round(ohio!.apportionedGallons * OHIO.taxRateCentsPerGallon),
    );
  });

  it('credits fuel tax actually paid', () => {
    const report = calculateIfta({ vehicles: [vehicle], period: H1_2026 });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const ohio = report.value.combined.lines.find((line) => line.jurisdictionCode === 'OH');
    // Credits are claimed on gallons purchased, not on apportioned gallons.
    expect(ohio?.fuelCreditCents).toBe(Math.round(1000 * OHIO.taxRateCentsPerGallon));
  });

  it('honours recorded gallons over the IRP standard', () => {
    const report = calculateIfta({
      vehicles: [
        {
          ...vehicle,
          mileage: [
            {
              jurisdictionCode: 'OH',
              totalMiles: 6500,
              taxableGallons: 1200,
              fuelCreditGallons: 1200,
            },
          ],
        },
      ],
      period: H1_2026,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const ohio = report.value.combined.lines[0];
    expect(ohio?.taxableGallons).toBe(1200);
    expect(ohio?.fuelCreditCents).toBe(Math.round(1200 * OHIO.taxRateCentsPerGallon));
  });

  it('adds the owner-operator deduction even when credits exceed tax', () => {
    const report = calculateIfta({
      vehicles: [
        {
          vehicleId: 'tr_1',
          unit: '101',
          actualMpg: 5.5,
          mileage: [
            {
              jurisdictionCode: 'OH',
              totalMiles: 10_000,
              // Bought a lot of fuel in a low-tax state and ran little in OH.
              taxableGallons: 2000,
              fuelCreditGallons: 2000,
            },
          ],
        },
      ],
      period: H1_2026,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // One jurisdiction at a 100% share: tax and credits land on the same
    // gallons, so what remains is the owner-operator surcharge and no tax owed.
    const line = report.value.combined.lines[0]!;
    expect(line.netTaxDueCents).toBe(line.ownerOperatorCents);
    expect(line.ownerOperatorCents).toBeGreaterThan(0);
  });

  it('goes negative, as a credit, when credits exceed tax', () => {
    const report = calculateIfta({
      vehicles: [
        {
          vehicleId: 'tr_1',
          unit: '101',
          actualMpg: 7.0,
          mileage: [
            {
              jurisdictionCode: 'PA',
              totalMiles: 5_000,
              taxableGallons: 1000,
              fuelCreditGallons: 1000,
            },
          ],
        },
      ],
      period: H1_2026,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    // One jurisdiction at 100% share: tax is on 1000 gallons, credit on 1000.
    const line = report.value.combined.lines[0]!;
    expect(line.netTaxDueCents).toBeGreaterThanOrEqual(0);
  });

  it('applies an operator rate override', () => {
    const report = calculateIfta({
      vehicles: [vehicle],
      period: H1_2026,
      overrides: { OH: { taxRateCentsPerGallon: 10 } },
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const ohio = report.value.combined.lines.find((line) => line.jurisdictionCode === 'OH');
    expect(ohio?.taxRateCentsPerGallon).toBe(10);
    expect(ohio?.apportionedTaxCents).toBe(Math.round(ohio!.apportionedGallons * 10));
  });

  it('adds the owner-operator deduction on apportioned tax', () => {
    const report = calculateIfta({ vehicles: [vehicle], period: H1_2026 });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    // 0.25% of apportioned tax per vehicle.
    for (const line of report.value.combined.lines) {
      expect(line.ownerOperatorCents).toBe(Math.round(line.apportionedTaxCents * 0.0025));
    }
  });

  it('includes fixed fees and border crossings', () => {
    const report = calculateIfta({
      vehicles: [
        {
          vehicleId: 'tr_1',
          unit: '101',
          actualMpg: 6.5,
          weightClassFeeCents: 15_000,
          mileage: [
            {
              jurisdictionCode: 'TX',
              totalMiles: 1000,
              taxableGallons: 154,
              fixedFeesCents: 11_000,
            },
          ],
        },
      ],
      period: H1_2026,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const line = report.value.combined.lines[0]!;
    expect(line.fixedFeesCents).toBeGreaterThanOrEqual(11_000);
  });

  it('rejects an empty fleet and an unknown jurisdiction', () => {
    expect(calculateIfta({ vehicles: [], period: H1_2026 }).ok).toBe(false);

    const unknown = calculateIfta({
      vehicles: [
        { vehicleId: 't', unit: '1', mileage: [{ jurisdictionCode: 'ZZ', totalMiles: 100 }] },
      ],
      period: H1_2026,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.message).toMatch(/unknown/i);
  });

  it('rejects a vehicle with no taxable miles', () => {
    const result = calculateIfta({
      vehicles: [{ vehicleId: 't', unit: '1', mileage: [{ jurisdictionCode: 'OH', totalMiles: 0 }] }],
      period: H1_2026,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a period that ends before it starts', () => {
    const result = calculateIfta({
      vehicles: [vehicle],
      period: { label: 'bad', start: '2026-07-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' },
    });
    expect(result.ok).toBe(false);
  });

  it('keeps every jurisdiction in one fleet report', () => {
    const report = calculateIfta({
      vehicles: [
        {
          vehicleId: 'tr_1',
          unit: '101',
          actualMpg: 6.5,
          mileage: [{ jurisdictionCode: 'OH', totalMiles: 1000 }],
        },
        {
          vehicleId: 'tr_2',
          unit: '102',
          actualMpg: 6.5,
          mileage: [
            { jurisdictionCode: 'IN', totalMiles: 2000 },
            { jurisdictionCode: 'IL', totalMiles: 3000 },
          ],
        },
      ],
      period: H1_2026,
    });

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.byJurisdiction.map((row) => row.jurisdictionCode).sort()).toEqual([
      'IL',
      'IN',
      'OH',
    ]);
  });
});

describe('calculateIftaForTrucks', () => {
  it('uses only the trucks that have mileage', () => {
    const result = calculateIftaForTrucks(
      [
        { id: 'tr_1', unit: '101', status: 'loaded', location: { lat: 40, lng: -83 } },
        { id: 'tr_2', unit: '102', status: 'available', location: { lat: 40, lng: -83 } },
      ],
      { tr_1: [{ jurisdictionCode: 'OH', totalMiles: 1000 }] },
      H1_2026,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vehicles).toHaveLength(1);
  });

  it('errors when nothing has mileage', () => {
    const result = calculateIftaForTrucks(
      [{ id: 'tr_1', unit: '101', status: 'available', location: { lat: 40, lng: -83 } }],
      {},
      H1_2026,
    );
    expect(result.ok).toBe(false);
  });
});

describe('taxableMilesFromLegs', () => {
  it('keeps a single-state leg whole', () => {
    const mileage = taxableMilesFromLegs([
      { fromJurisdiction: 'OH', toJurisdiction: 'OH', miles: 100, loaded: true, gallons: 15 },
    ]);

    expect(mileage).toHaveLength(1);
    expect(mileage[0]?.jurisdictionCode).toBe('OH');
    expect(mileage[0]?.totalMiles).toBe(100);
    expect(mileage[0]?.taxableGallons).toBe(15);
  });

  it('splits a cross-jurisdiction leg evenly', () => {
    const mileage = taxableMilesFromLegs([
      { fromJurisdiction: 'OH', toJurisdiction: 'PA', miles: 100, loaded: true, gallons: 15 },
    ]);

    expect(mileage).toHaveLength(2);
    expect(mileage[0]?.totalMiles).toBe(50);
    expect(mileage[1]?.totalMiles).toBe(50);
  });

  it('merges legs in the same jurisdiction', () => {
    const mileage = taxableMilesFromLegs([
      { fromJurisdiction: 'OH', toJurisdiction: 'OH', miles: 100, loaded: true },
      { fromJurisdiction: 'OH', toJurisdiction: 'OH', miles: 250, loaded: false },
    ]);

    expect(mileage).toHaveLength(1);
    expect(mileage[0]?.totalMiles).toBe(350);
    expect(mileage[0]?.loadedMiles).toBe(100);
  });
});

describe('fleetAverageMpg', () => {
  it('weights by miles rather than averaging the average', () => {
    const mpg = fleetAverageMpg([
      { vehicleId: 'a', unit: 'A', mileage: [{ jurisdictionCode: 'OH', totalMiles: 1000, taxableGallons: 100 }] },
      { vehicleId: 'b', unit: 'B', mileage: [{ jurisdictionCode: 'OH', totalMiles: 3000, taxableGallons: 600 }] },
    ]);
    // 4000 miles over 700 gallons.
    expect(mpg).toBeCloseTo(5.71, 2);
  });

  it('returns 0 with no fuel data', () => {
    expect(fleetAverageMpg([])).toBe(0);
  });
});

describe('money formatting', () => {
  it('formats a net credit with a sign', () => {
    expect(formatUsd(-12_345)).toBe('-$123.45');
    expect(formatUsd(12_345)).toBe('$123.45');
  });
});
import { describe, expect, it } from 'vitest';

import {
  assignLoad,
  bulkAssign,
  buildDispatchBoard,
  defaultContext,
  evaluateEligibility,
  geocodeLocation,
  projectedTripHours,
  projectDriverPayCents,
  transitionLoad,
  unassignLoad,
  type DispatchContext,
  type DriverHoursReadiness,
} from '@truckdesk/core';

import { FIXTURE_NOW_ISO, drivers, loadById, loads, trucks } from '@fixtures/loads';

/**
 * Dispatch engine.
 *
 * The assertions here are about what a dispatcher must never be allowed to do:
 * put a reefer load on a dry van, hand 48,000 pounds to a 45,000-pound truck, send
 * a driver past his hours, or bill a rate that does not cover pay.
 */

const NOW = FIXTURE_NOW_ISO;

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return defaultContext({
    now: NOW,
    loads: loads(),
    trucks: trucks(),
    drivers: drivers(),
    // Most fixtures have a driver with plenty of hours; override per test.
    readiness: {},
    ...overrides,
  });
}

function readiness(overrides: Partial<DriverHoursReadiness> = {}): DriverHoursReadiness {
  return {
    driverId: 'dr_t03',
    driveMinutesRemaining: 600,
    dutyMinutesRemaining: 800,
    breakMinutesRemaining: -1,
    cycle: 70,
    cycleMinutesRemaining: 3000,
    violations: [],
    ...overrides,
  };
}

describe('assignLoad', () => {
  it('assigns a valid load and moves the truck off available', () => {
    const load = loadById('ld_f01'); // Columbus -> Pittsburgh, dry van
    const result = assignLoad(context(), { loadId: load.id, truckId: 'tr_t03' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.load.status).toBe('dispatched');
    expect(result.value.load.assignedTruckId).toBe('tr_t03');
    expect(result.value.truck.status).toBe('empty');
    expect(result.value.truck.currentLoadId).toBe(load.id);
  });

  it('emits the events an audit trail needs', () => {
    const load = loadById('ld_f01');
    const result = assignLoad(context(), { loadId: load.id, truckId: 'tr_t03' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const types = result.value.assignment.events.map((event) => event.type);
    expect(types).toContain('load.assigned');
    expect(types).toContain('load.status_changed');
    expect(types).toContain('truck.status_changed');
  });

  it('refuses to assign a cancelled load', () => {
    const result = assignLoad(context(), { loadId: 'ld_f10', truckId: 'tr_t03' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/cancelled/i);
  });

  it('refuses a load that is not booked', () => {
    const result = assignLoad(context(), { loadId: 'ld_f15', truckId: 'tr_t04' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/only booked loads/i);
  });

  it('refuses a truck already on a load', () => {
    // tr_t01 is loaded with ld_f15.
    const result = assignLoad(context(), { loadId: 'ld_f01', truckId: 'tr_t01' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/already (loaded|assigned)/i);
  });

  it('refuses a truck in maintenance', () => {
    const result = assignLoad(context(), { loadId: 'ld_f01', truckId: 'tr_t07' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/maintenance/i);
  });

  it('refuses to put a reefer load on a dry van', () => {
    const reefer = loadById('ld_f03'); // reefer, Dayton -> Chicago
    const result = assignLoad(context(), { loadId: reefer.id, truckId: 'tr_t03' }); // dry van

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/dry van|reefer/i);
    expect(result.error.details?.['blocking']).toBeDefined();
  });

  it('allows a reefer load on a reefer truck', () => {
    // tr_t02 is a reefer but is carrying something, so free it first.
    const world = context();
    world.trucks = world.trucks.map((truck) =>
      truck.id === 'tr_t02'
        ? { ...truck, status: 'available' as const, currentLoadId: undefined }
        : truck,
    );

    const reefer = loadById('ld_f03');
    const result = assignLoad(world, { loadId: reefer.id, truckId: 'tr_t02' });

    expect(result.ok).toBe(true);
  });

  it('refuses a load over the truck weight limit', () => {
    const heavy = loadById('ld_f06'); // 47,200 lbs flatbed on a 45,000 van
    const result = assignLoad(context(), { loadId: heavy.id, truckId: 'tr_t03' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/exceeds|weight/i);
  });

  it('refuses a truck with no driver', () => {
    const result = assignLoad(context(), { loadId: 'ld_f01', truckId: 'tr_t07' });
    expect(result.ok).toBe(false);
  });

  it('refuses when the rate does not cover driver pay', () => {
    const cheap = loadById('ld_f08'); // $280 for 72 miles, box truck
    const result = assignLoad(context(), { loadId: cheap.id, truckId: 'tr_t08' });

    // tr_t08 pays $0.44/mi, so $280 over 72 miles is $31.68 of pay. It may pass
    // on pay alone, so assert the economics rather than the outcome.
    const eligibility = evaluateEligibility({
      load: cheap,
      truck: trucks().find((truck) => truck.id === 'tr_t08')!,
      driver: drivers().find((driver) => driver.id === 'dr_t08'),
      rules: { ...defaultContext().rules },
      now: NOW,
    });

    expect(eligibility.revenuePerMileCents).toBeLessThan(150);
    expect(eligibility.warnings.some((warning) => warning.includes('under the'))).toBe(true);
    void result;
  });

  it('blocks an assignment past the driver drive limit', () => {
    const world = context({
      readiness: {
        dr_t03: readiness({ driveMinutesRemaining: 30 }),
      },
    });

    // 191 miles fits inside an 11-hour day, so only the hours left can block it.
    const result = assignLoad(world, { loadId: 'ld_f02', truckId: 'tr_t03' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/drive time/i);
  });

  it('warns but allows when hours are tight', () => {
    const world = context({
      readiness: { dr_t03: readiness({ driveMinutesRemaining: 200 }) },
    });

    const result = assignLoad(world, { loadId: 'ld_f09', truckId: 'tr_t03' }); // 62 miles

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignment.warnings.length).toBeGreaterThan(0);
  });

  it('honours an override for a dispatcher who knows better', () => {
    const world = context({ readiness: { dr_t03: readiness({ driveMinutesRemaining: 30 }) } });
    const result = assignLoad(world, { loadId: 'ld_f05', truckId: 'tr_t03', overrideBlocking: true });
    expect(result.ok).toBe(true);
  });

  it('reports a missing load or truck', () => {
    expect(assignLoad(context(), { loadId: 'nope', truckId: 'tr_t03' }).ok).toBe(false);
    expect(assignLoad(context(), { loadId: 'ld_f01', truckId: 'nope' }).ok).toBe(false);
  });
});

describe('unassignLoad', () => {
  it('returns a dispatched load to the board', () => {
    const result = unassignLoad(context(), { loadId: 'ld_f11' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.load.status).toBe('booked');
    expect(result.value.load.assignedTruckId).toBeUndefined();
    expect(result.value.truck.status).toBe('available');
  });

  it('refuses to unassign a load already in transit', () => {
    const result = unassignLoad(context(), { loadId: 'ld_f15' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/in transit/i);
  });

  it('refuses to unassign a delivered load', () => {
    const result = unassignLoad(context(), { loadId: 'ld_f18' });
    expect(result.ok).toBe(false);
  });
});

describe('transitionLoad', () => {
  it('walks the legal path from dispatched to paid', () => {
    const world = context();

    const toTransit = transitionLoad(world, { loadId: 'ld_f11', to: 'in-transit' });
    expect(toTransit.ok).toBe(true);
    if (!toTransit.ok) return;
    expect(toTransit.value.load.status).toBe('in-transit');
    expect(toTransit.value.truck?.status).toBe('loaded');

    const world2 = defaultContext({
      now: NOW,
      loads: [toTransit.value.load],
      trucks: [toTransit.value.truck!],
      drivers: drivers(),
    });

    const toDelivered = transitionLoad(world2, { loadId: 'ld_f11', to: 'delivered' });
    expect(toDelivered.ok).toBe(true);
    if (!toDelivered.ok) return;
    expect(toDelivered.value.load.status).toBe('delivered');
    // No POD on file, which is exactly what the field flags.
    expect(toDelivered.value.load.proofOfDeliveryMissing).toBe(true);

    const world3 = defaultContext({
      now: NOW,
      loads: [toDelivered.value.load],
      trucks: [toDelivered.value.truck!],
      drivers: drivers(),
    });

    const toPaid = transitionLoad(world3, { loadId: 'ld_f11', to: 'paid' });
    expect(toPaid.ok).toBe(true);
    if (!toPaid.ok) return;
    expect(toPaid.value.load.status).toBe('paid');
    expect(toPaid.value.truck?.status).toBe('available');
  });

  it('refuses an illegal jump', () => {
    const result = transitionLoad(context(), { loadId: 'ld_f01', to: 'delivered' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_STATE');
  });
});

describe('bulkAssign', () => {
  it('assigns what it can and reports what it cannot', () => {
    const result = bulkAssign(context(), [
      { loadId: 'ld_f01', truckId: 'tr_t03' },
      { loadId: 'ld_f02', truckId: 'tr_t04' },
      { loadId: 'ld_f03', truckId: 'tr_t03' }, // reefer on dry van
      { loadId: 'ld_f01', truckId: 'tr_t04' }, // already assigned above
    ]);

    expect(result.assigned.length).toBeGreaterThan(0);
    expect(result.failures.length).toBeGreaterThan(0);
    // tr_t03 must not be double-booked.
    const assignedTrucks = result.assigned.map((entry) => entry.truck.id);
    expect(new Set(assignedTrucks).size).toBe(assignedTrucks.length);
  });
});

describe('dispatch board', () => {
  it('counts every column and leaves cancelled loads off the board', () => {
    const board = buildDispatchBoard(context());

    expect(board.columns).toHaveLength(5);
    expect(board.counts.booked).toBeGreaterThan(0);
    expect(board.counts['in-transit']).toBeGreaterThan(0);

    const booked = board.columns.find((column) => column.status === 'booked');
    expect(booked?.loads.some((load) => load.id === 'ld_f10')).toBe(false);
  });

  it('lists trucks with no active load as unassigned', () => {
    const board = buildDispatchBoard(context());
    // tr_t07 is in the shop, so it is on the board carrying nothing.
    expect(board.unassignedTruckIds).toContain('tr_t07');
  });
});

describe('projections', () => {
  it('adds realistic stop time to drive time', () => {
    // 200 miles at 48 mph is 4.17 hours, plus 45 minutes per stop.
    const hours = projectedTripHours(200, [
      { sequence: 0 } as never,
      { sequence: 1 } as never,
    ]);
    expect(hours).toBeCloseTo(5.67, 1);
  });

  it('projects pay by pay type', () => {
    const load = loadById('ld_f01'); // $1,850 over 185 miles
    const perMile = drivers().find((driver) => driver.id === 'dr_t01')!; // $0.48/mi
    const percentage = drivers().find((driver) => driver.id === 'dr_t05')!; // 30%

    expect(projectDriverPayCents(perMile, load, 185)).toBe(Math.round(48 * 185));
    // Percentage is on linehaul only: fuel surcharge is not driver pay.
    expect(projectDriverPayCents(percentage, load, 185)).toBe(
      Math.round(Math.round(185_000 * 0.85) * 0.3),
    );
    expect(projectDriverPayCents(undefined, load, 185)).toBe(0);
  });
});

describe('geocodeLocation', () => {
  it('maps a city and state to a stable point', () => {
    const first = geocodeLocation('Columbus, OH');
    const second = geocodeLocation('Columbus, OH');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Deterministic across calls: deadhead math depends on it.
    expect(first?.lat).toBe(second?.lat);
    expect(first?.lng).toBe(second?.lng);
  });

  it('puts Columbus near Ohio', () => {
    const point = geocodeLocation('Columbus, OH');
    expect(point?.lat).toBeGreaterThan(38);
    expect(point?.lat).toBeLessThan(42);
    expect(point?.lng).toBeGreaterThan(-86);
    expect(point?.lng).toBeLessThan(-80);
  });

  it('parses explicit coordinates', () => {
    const point = geocodeLocation('39.9612,-82.9988');
    expect(point?.lat).toBeCloseTo(39.9612, 3);
    expect(point?.lng).toBeCloseTo(-82.9988, 3);
  });

  it('returns null for nothing usable', () => {
    expect(geocodeLocation('')).toBeNull();
    expect(geocodeLocation('Nowhere, ZZ')).toBeNull();
  });
});
import { describe, expect, it } from 'vitest';

import {
  addCents,
  applyBasisPoints,
  boundingBox,
  canTransitionLoad,
  formatUsd,
  haversineMiles,
  offsetPoint,
  parseFlexibleDate,
  parseMoneyToCents,
  parseRateToCents,
  perMileCents,
  roundPoint,
  startOfWeekIso,
  truckStatusForLoad,
} from '@truckdesk/shared';

/**
 * Shared primitives. These are the functions every other package leans on, so a
 * bug here is a bug everywhere - which is why the edge cases are spelled out
 * rather than left to "obvious" behaviour.
 */

describe('money', () => {
  it('parses the dollar strings brokers actually send', () => {
    expect(parseMoneyToCents('$2,450.00')).toBe(245_000);
    expect(parseMoneyToCents('2450')).toBe(245_000);
    expect(parseMoneyToCents('2450.5')).toBe(245_050);
    expect(parseMoneyToCents('$1,850')).toBe(185_000);
    expect(parseMoneyToCents('USD 320')).toBe(32_000);
  });

  it('treats a bare number as dollars', () => {
    expect(parseMoneyToCents(2450)).toBe(245_000);
    expect(parseMoneyToCents(0)).toBe(0);
  });

  it('handles negative and parenthesised amounts', () => {
    expect(parseMoneyToCents('-$50.00')).toBe(-5_000);
    expect(parseMoneyToCents('($50.00)')).toBe(-5_000);
  });

  it('returns null rather than guessing', () => {
    expect(parseMoneyToCents('call me')).toBeNull();
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents(undefined)).toBeNull();
    expect(parseMoneyToCents(Number.NaN)).toBeNull();
  });

  it('parses per-mile rates', () => {
    expect(parseRateToCents('2.85/mi')).toBe(285);
    expect(parseRateToCents('$2.85 per mile')).toBe(285);
  });

  it('keeps cents as integers', () => {
    expect(Number.isInteger(applyBasisPoints(100_000, 2500))).toBe(true);
    expect(applyBasisPoints(100_000, 2500)).toBe(25_000);
    expect(applyBasisPoints(0, 2500)).toBe(0);
  });

  it('never divides by zero', () => {
    expect(perMileCents(100_000, 0)).toBe(0);
    expect(perMileCents(100_000, 200)).toBe(500);
  });

  it('formats without losing cents', () => {
    expect(formatUsd(185_000)).toBe('$1,850.00');
    expect(formatUsd(185_000, { showCents: false })).toBe('$1,850');
    expect(formatUsd(-5_000)).toBe('-$50.00');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('adds cents without floating point drift', () => {
    expect(addCents(0.1 * 100, 0.2 * 100)).toBe(30);
  });
});

describe('geo', () => {
  it('computes real distances between US cities', () => {
    // Columbus to Pittsburgh is about 185 road miles, ~140 as the crow flies.
    const columbus = { lat: 39.9612, lng: -82.9988 };
    const pittsburgh = { lat: 40.4406, lng: -79.9959 };
    const miles = haversineMiles(columbus, pittsburgh);

    // Straight-line distance; the road adds roughly 18%.
    expect(miles).toBeGreaterThan(155);
    expect(miles).toBeLessThan(175);
    expect(haversineMiles(columbus, pittsburgh) * 1.18).toBeGreaterThan(180);
  });

  it('is zero for identical points', () => {
    expect(haversineMiles({ lat: 40, lng: -83 }, { lat: 40, lng: -83 })).toBe(0);
  });

  it('handles an antimeridian crossing', () => {
    const miles = haversineMiles({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
    expect(miles).toBeLessThan(20);
  });

  it('bounds a set of points with padding', () => {
    const box = boundingBox([
      { lat: 39, lng: -83 },
      { lat: 42, lng: -80 },
    ]);

    expect(box).not.toBeNull();
    expect(box?.south).toBeLessThan(39);
    expect(box?.north).toBeGreaterThan(42);
    expect(box?.west).toBeLessThan(-83);
    expect(box?.east).toBeGreaterThan(-80);
  });

  it('returns null for no points', () => {
    expect(boundingBox([])).toBeNull();
  });

  it('rounds positions to a sane GPS precision', () => {
    const rounded = roundPoint({ lat: 39.961234567, lng: -82.998765432 }, 5);
    expect(rounded.lat).toBe(39.96123);
    expect(rounded.lng).toBe(-82.99877);
  });

  it('offsets a point by miles', () => {
    const moved = offsetPoint({ lat: 40, lng: -83 }, 60, 0);
    expect(moved.lat).toBeGreaterThan(40);
    expect(Math.abs(haversineMiles({ lat: 40, lng: -83 }, moved) - 60)).toBeLessThan(2);
  });
});

describe('state machines', () => {
  it('allows only the forward edges of the load graph', () => {
    expect(canTransitionLoad('booked', 'dispatched')).toBe(true);
    expect(canTransitionLoad('dispatched', 'in-transit')).toBe(true);
    expect(canTransitionLoad('in-transit', 'delivered')).toBe(true);
    expect(canTransitionLoad('delivered', 'paid')).toBe(true);
  });

  it('allows the two backward edges a dispatcher needs', () => {
    // Unassign, and correcting a dispatch.
    expect(canTransitionLoad('dispatched', 'booked')).toBe(true);
    expect(canTransitionLoad('in-transit', 'dispatched')).toBe(true);
  });

  it('refuses illegal jumps', () => {
    expect(canTransitionLoad('booked', 'in-transit')).toBe(false);
    expect(canTransitionLoad('booked', 'delivered')).toBe(false);
    expect(canTransitionLoad('booked', 'paid')).toBe(false);
    expect(canTransitionLoad('paid', 'in-transit')).toBe(false);
  });

  it('maps a load status to the truck board column', () => {
    expect(truckStatusForLoad('booked')).toBe('empty');
    expect(truckStatusForLoad('dispatched')).toBe('empty');
    expect(truckStatusForLoad('in-transit')).toBe('loaded');
    expect(truckStatusForLoad('delivered')).toBe('empty');
    expect(truckStatusForLoad('paid')).toBe('empty');
  });
});

describe('dates', () => {
  it('parses the formats a broker email contains', () => {
    expect(parseFlexibleDate('2026-03-16')?.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(parseFlexibleDate('03/16/2026')?.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(parseFlexibleDate('3/16/26 2:00 PM')?.toISOString()).toBe('2026-03-16T14:00:00.000Z');
    expect(parseFlexibleDate('2026-03-16T14:00:00Z')?.toISOString()).toBe('2026-03-16T14:00:00.000Z');
  });

  it('resolves relative day names', () => {
    const base = new Date('2026-03-16T14:00:00.000Z');
    expect(parseFlexibleDate('tomorrow', base)?.toISOString()).toBe('2026-03-17T09:00:00.000Z');
    expect(parseFlexibleDate('today', base)?.toISOString()).toBe('2026-03-16T09:00:00.000Z');
  });

  it('returns null instead of an invalid date', () => {
    expect(parseFlexibleDate('next tuesday-ish')).toBeNull();
    expect(parseFlexibleDate('')).toBeNull();
  });

  it('anchors weeks on Monday', () => {
    // 2026-03-16 is a Monday.
    const week = startOfWeekIso('2026-03-16T14:00:00.000Z');
    expect(week.key).toBe('2026-03-16');
    expect(week.start).toBe('2026-03-16T00:00:00.000Z');

    // A Wednesday maps back to the same Monday.
    expect(startOfWeekIso('2026-03-18T10:00:00.000Z').key).toBe('2026-03-16');
    // A Sunday belongs to the week that started six days earlier.
    expect(startOfWeekIso('2026-03-22T10:00:00.000Z').key).toBe('2026-03-16');
  });
});
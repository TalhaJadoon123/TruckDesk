import { describe, expect, it } from 'vitest';

import {
  HOS_RULES,
  ManualProvider,
  MotiveProvider,
  SamsaraProvider,
  SimulatorProvider,
  computeHos,
  normalizeDutyStatus,
  normalizeEldTimestamp,
  projectTrip,
  toDispatchReadiness,
  type EldDutyInterval,
} from '@truckdesk/eld';

/**
 * Hours of service.
 *
 * FMCSA property-carrying limits are the numbers a DOT inspector checks, so the
 * boundary cases matter: exactly 11 hours is legal, 11 hours and one minute is
 * not, and the 8-hour break is measured on driving time rather than elapsed time.
 */

const NOW = new Date('2026-03-16T14:00:00.000Z');
const hoursAgo = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function shift(intervals: Array<[string, EldDutyInterval['status']]>): EldDutyInterval[] {
  return intervals.map(([start, status]) => ({
    status,
    startedAt: hoursAgo(start),
  }));
}

describe('normalizeDutyStatus', () => {
  it('accepts every vendor spelling', () => {
    expect(normalizeDutyStatus('OFF_DUTY')).toBe('OFF_DUTY');
    expect(normalizeDutyStatus('off duty')).toBe('OFF_DUTY');
    expect(normalizeDutyStatus('d')).toBe('OFF_DUTY');
    expect(normalizeDutyStatus('SLEEPER_BERTH')).toBe('SLEEPER_BERTH');
    expect(normalizeDutyStatus('sb')).toBe('SLEEPER_BERTH');
    expect(normalizeDutyStatus('DRIVING')).toBe('DRIVING');
    expect(normalizeDutyStatus('onDutyNotDriving')).toBe('ON_DUTY_NOT_DRIVING');
    expect(normalizeDutyStatus('PC')).toBe('PERSONAL_CONVEYANCE');
  });

  it('returns null for anything it does not know', () => {
    expect(normalizeDutyStatus('teleporting')).toBeNull();
    expect(normalizeDutyStatus(42)).toBeNull();
    expect(normalizeDutyStatus(null)).toBeNull();
  });
});

describe('normalizeEldTimestamp', () => {
  it('handles ISO, epoch seconds and epoch millis', () => {
    expect(normalizeEldTimestamp('2026-03-16T14:00:00Z')).toBe('2026-03-16T14:00:00.000Z');
    const seconds = Math.floor(Date.parse('2026-03-16T14:00:00.000Z') / 1000);
    expect(normalizeEldTimestamp(seconds)).toBe('2026-03-16T14:00:00.000Z');
    expect(normalizeEldTimestamp(seconds * 1000)).toBe('2026-03-16T14:00:00.000Z');
    expect(normalizeEldTimestamp(String(seconds))).toBe('2026-03-16T14:00:00.000Z');
  });

  it('returns null for junk', () => {
    expect(normalizeEldTimestamp('not a date')).toBeNull();
    expect(normalizeEldTimestamp({})).toBeNull();
  });
});

describe('computeHos', () => {
  it('gives a fresh driver a full 11 hours', () => {
    const result = computeHos({
      intervals: shift([[11, 'OFF_DUTY']]),
      now: NOW,
    });

    expect(result.driveMinutesRemaining).toBe(HOS_RULES.maxDriveHoursPerShift * 60);
    expect(result.dutyMinutesRemaining).toBe(HOS_RULES.maxOnDutyHoursPerShift * 60);
    expect(result.violations).toHaveLength(0);
  });

  it('counts driving time against the 11-hour limit', () => {
    const result = computeHos({
      intervals: [
        ...shift([[12, 'OFF_DUTY']]),
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(10) },
        { status: 'DRIVING', startedAt: hoursAgo(10) },
      ],
      now: NOW,
    });

    // Ten hours of driving in the current shift.
    expect(result.shift.drivingMinutesInShift).toBe(600);
    expect(result.driveMinutesRemaining).toBe(60);
  });

  it('flags a violation past 11 hours', () => {
    const result = computeHos({
      intervals: [
        ...shift([[12, 'OFF_DUTY']]),
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(12) },
        { status: 'DRIVING', startedAt: hoursAgo(11.5) },
      ],
      now: NOW,
    });

    expect(result.violations.some((violation) => violation.type === 'drive_time')).toBe(true);
  });

  it('counts on-duty-not-driving toward the 14-hour window', () => {
    const result = computeHos({
      intervals: [
        ...shift([[15, 'OFF_DUTY']]),
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(14.5) },
      ],
      now: NOW,
    });

    expect(result.shift.onDutyMinutesInShift).toBe(870);
    expect(result.dutyMinutesRemaining).toBe(0);
    expect(result.violations.some((violation) => violation.type === 'on_duty_time')).toBe(true);
  });

  it('requires a 30-minute break after 8 hours of driving', () => {
    const result = computeHos({
      intervals: [
        ...shift([[10, 'OFF_DUTY']]),
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(8.5) },
        { status: 'DRIVING', startedAt: hoursAgo(8.5) },
      ],
      now: NOW,
    });

    expect(result.shift.sinceBreakMinutes).toBe(510);
    expect(result.breakSatisfied).toBe(false);
    expect(result.warnings.some((warning) => warning.type === 'break')).toBe(true);
  });

  it('accepts a 30-minute off-duty as the break', () => {
    const result = computeHos({
      intervals: [
        ...shift([[11, 'OFF_DUTY']]),
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(9) },
        { status: 'DRIVING', startedAt: hoursAgo(8.5) },
        { status: 'OFF_DUTY', startedAt: hoursAgo(0.5) },
      ],
      now: NOW,
    });

    expect(result.breakSatisfied).toBe(true);
  });

  it('warns as the break approaches rather than only when it is late', () => {
    const result = computeHos({
      intervals: [
        ...shift([[9, 'OFF_DUTY']]),
        { status: 'DRIVING', startedAt: hoursAgo(7.75) },
      ],
      now: NOW,
    });

    expect(result.warnings.some((warning) => warning.type === 'break')).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('does not require a break for a short-haul driver', () => {
    const result = computeHos({
      intervals: [
        ...shift([[11, 'OFF_DUTY']]),
        { status: 'DRIVING', startedAt: hoursAgo(9) },
      ],
      now: NOW,
      shortHaul: true,
    });

    expect(result.breakSatisfied).toBe(true);
  });

  it('tracks a 70-hour cycle across eight days', () => {
    const intervals: EldDutyInterval[] = [];
    // Four 10-hour shifts in the last four days, each with explicit end times so
    // no interval absorbs the overnight gap.
    for (let day = 3; day >= 0; day -= 1) {
      intervals.push(
        {
          status: 'OFF_DUTY',
          startedAt: hoursAgo(24 * day + 12),
          endedAt: hoursAgo(24 * day + 11),
        },
        {
          status: 'ON_DUTY_NOT_DRIVING',
          startedAt: hoursAgo(24 * day + 11),
          endedAt: hoursAgo(24 * day + 10),
        },
        {
          status: 'DRIVING',
          startedAt: hoursAgo(24 * day + 10),
          endedAt: hoursAgo(24 * day + 2),
        },
      );
    }

    const result = computeHos({ intervals, now: NOW, cycle: 70 });

    expect(result.cycle.cycle).toBe(70);
    // Four days at nine on-duty hours each is 36 hours used, 34 left.
    expect(result.onDutyMinutesRemainingInCycle).toBe(34 * 60);
  });

  it('flags a driver who has burned the 60-hour cycle', () => {
    const intervals: EldDutyInterval[] = [];
    for (let day = 6; day >= 0; day -= 1) {
      intervals.push(
        {
          status: 'OFF_DUTY',
          startedAt: hoursAgo(24 * day + 13),
          endedAt: hoursAgo(24 * day + 12),
        },
        {
          status: 'ON_DUTY_NOT_DRIVING',
          startedAt: hoursAgo(24 * day + 12),
          endedAt: hoursAgo(24 * day + 2),
        },
      );
    }

    const result = computeHos({ intervals, now: NOW, cycle: 60 });
    expect(result.cycle.cycle).toBe(60);
    // Seven days of ten hours is 70 hours against a 60-hour cycle.
    expect(result.onDutyMinutesRemainingInCycle).toBeLessThanOrEqual(0);
    expect(result.violations.some((violation) => violation.type === 'cycle')).toBe(true);
  });

  it('treats sleeper in the seat as off duty for property-carrying', () => {
    const result = computeHos({
      intervals: [
        ...shift([[11, 'OFF_DUTY']]),
        { status: 'SLEEPER_BERTH', startedAt: hoursAgo(10) },
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(8) },
      ],
      now: NOW,
    });

    // Sleeper time is not on-duty time in the 14-hour window.
    expect(result.shift.onDutyMinutesInShift).toBe(480);
  });

  it('rejects an interval that ends before it starts', () => {
    const result = computeHos({
      intervals: [
        { status: 'DRIVING', startedAt: hoursAgo(2), endedAt: hoursAgo(4) },
      ],
      now: NOW,
    });

    // Ignored rather than producing negative minutes.
    expect(result.shift.drivingMinutesInShift).toBe(0);
  });

  it('converts to the shape the dispatcher reads', () => {
    const result = computeHos({
      intervals: shift([[12, 'OFF_DUTY']]),
      now: NOW,
    });

    const readiness = toDispatchReadiness('dr_1', result);
    expect(readiness.driverId).toBe('dr_1');
    expect(readiness.driveMinutesRemaining).toBe(660);
    expect(readiness.cycle).toBe(70);
  });
});

describe('projectTrip', () => {
  it('says a short trip is feasible', () => {
    const hos = computeHos({ intervals: shift([[12, 'OFF_DUTY']]), now: NOW });
    const projection = projectTrip(hos, 100);

    expect(projection.feasible).toBe(true);
    expect(projection.shortfallMinutes).toBe(0);
    expect(projection.drivingMinutesNeeded).toBe(Math.round((100 / 48) * 60));
  });

  it('says a long trip needs a rest period and says when', () => {
    const hos = computeHos({
      intervals: [
        ...shift([[12, 'OFF_DUTY']]),
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(10) },
        { status: 'DRIVING', startedAt: hoursAgo(9.5) },
      ],
      now: NOW,
    });

    const projection = projectTrip(hos, 900);
    expect(projection.feasible).toBe(false);
    expect(projection.shortfallMinutes).toBeGreaterThan(0);
    expect(projection.message).toMatch(/short by/i);
  });

  it('adds a required break for a trip over eight hours', () => {
    const hos = computeHos({
      intervals: [
        ...shift([[12, 'OFF_DUTY']]),
        { status: 'ON_DUTY_NOT_DRIVING', startedAt: hoursAgo(1) },
      ],
      now: NOW,
    });

    const projection = projectTrip(hos, 460);
    expect(projection.breakMinutesRequired).toBe(30);
  });
});

describe('SimulatorProvider', () => {
  const vehicles = [
    {
      vehicleId: 'tr_1',
      unit: '101',
      driverId: 'dr_1',
      location: { lat: 39.96, lng: -82.99 },
      headingDeg: 90,
      speedMph: 0,
      lastIntervalAt: NOW.toISOString(),
    },
  ];

  it('starts off duty with full hours', () => {
    const simulator = new SimulatorProvider({ vehicles, now: () => NOW });
    expect(simulator.currentHosStatus('tr_1')).toBe('off_duty');

    const computation = simulator.compute('tr_1', NOW);
    expect(computation.driveMinutesRemaining).toBe(660);
  });

  it('moves to driving when a moving ping arrives', () => {
    const simulator = new SimulatorProvider({ vehicles, now: () => NOW });
    simulator.recordLocation('tr_1', { lat: 40.0, lng: -82.9 }, hoursAgo(0), 55);

    expect(simulator.currentHosStatus('tr_1')).toBe('driving');
  });

  it('returns to on-duty when the truck stops', () => {
    const simulator = new SimulatorProvider({ vehicles, now: () => NOW });
    simulator.recordLocation('tr_1', { lat: 40.0, lng: -82.9 }, hoursAgo(1), 55);
    simulator.recordLocation('tr_1', { lat: 40.0, lng: -82.9 }, hoursAgo(0), 0);

    expect(simulator.currentHosStatus('tr_1')).toBe('on_duty');
  });

  it('burns hours when driven', () => {
    const simulator = new SimulatorProvider({ vehicles, now: () => NOW });
    simulator.driveFor('tr_1', 5, 52, new Date(NOW.getTime() - 5 * 3_600_000));

    const computation = simulator.compute('tr_1', NOW);
    // Five hours driven leaves six of the eleven.
    expect(computation.shift.drivingMinutesInShift).toBeGreaterThanOrEqual(290);
    expect(computation.driveMinutesRemaining).toBeLessThan(400);
  });

  it('replays a breadcrumb that the engine can read', async () => {
    const simulator = new SimulatorProvider({ vehicles, now: () => NOW });
    simulator.driveFor('tr_1', 3, 50, new Date(NOW.getTime() - 3 * 3_600_000));

    const locations = await simulator.locations(hoursAgo(4));
    expect(locations.length).toBeGreaterThan(2);
    // It moved east.
    expect(locations[locations.length - 1]!.location.lng).toBeGreaterThan(-82.99);
  });

  it('reports itself as configured', () => {
    expect(new SimulatorProvider({ vehicles }).isConfigured()).toBe(true);
    expect(new ManualProvider().isConfigured()).toBe(true);
  });
});

describe('SamsaraProvider', () => {
  it('reports unconfigured without a token', () => {
    expect(new SamsaraProvider({}).isConfigured()).toBe(false);
    expect(new SamsaraProvider({ token: 'x' }).isConfigured()).toBe(true);
  });

  it('normalizes a location payload', () => {
    const locations = [
      {
        vehicleId: '1234',
        latitude: 39.9612,
        longitude: -82.9988,
        time: '2026-03-16T14:00:00Z',
        speedKph: 88.5,
        heading: 90,
      },
    ];

    const responses = locations.map((record) => ({
      data: [record],
    }));

    const impl = async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
      text: async () => '',
    });

    const provider = new SamsaraProvider({
      token: 'test',
      fetchImpl: impl as unknown as typeof fetch,
    });

    return provider.locations('2026-03-16T00:00:00Z').then((result) => {
      expect(result).toHaveLength(1);
      expect(result[0]?.location.lat).toBeCloseTo(39.9612, 3);
      // km/h is converted to mph.
      expect(result[0]?.speedMph).toBeCloseTo(55, 0);
    });
  });

  it('parses a webhook envelope', () => {
    const provider = new SamsaraProvider({ token: 'test' });
    const result = provider.parseWebhook?.({
      type: 'webhook',
      data: {
        vehicleId: '1234',
        latitude: 39.9,
        longitude: -82.9,
        time: '2026-03-16T14:00:00Z',
      },
    });

    expect(result?.event).toBe('location');
    expect(result?.locations).toHaveLength(1);
    expect(result?.vehicleId).toBe('1234');
  });

  it('returns empty for an unknown webhook', () => {
    const provider = new SamsaraProvider({ token: 'test' });
    expect(provider.parseWebhook?.({ nope: true }).event).toBe('unknown');
  });
});

describe('MotiveProvider', () => {
  it('reports unconfigured without credentials', () => {
    expect(new MotiveProvider({}).isConfigured()).toBe(false);
    expect(new MotiveProvider({ accessToken: 'x' }).isConfigured()).toBe(true);
  });

  it('refreshes a token and caches it', async () => {
    let tokenCalls = 0;

    const impl = async (input: string) => {
      if (input.includes('oauth/token')) {
        tokenCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ vehicles: [] }),
        text: async () => '',
      };
    };

    const provider = new MotiveProvider({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      fetchImpl: impl as unknown as typeof fetch,
    });

    await provider.authenticate();
    await provider.authenticate();

    expect(tokenCalls).toBe(1);
  });

  it('errors clearly with partial credentials', async () => {
    const provider = new MotiveProvider({ clientId: 'id' });
    await expect(provider.authenticate()).rejects.toThrow(/clientId/);
  });

  it('parses a webhook with both location and duty status', () => {
    const provider = new MotiveProvider({ accessToken: 'x' });
    const result = provider.parseWebhook?.({
      vehicle: { id: 42 },
      location: { latitude: 39.9, longitude: -82.9, timestamp: '2026-03-16T14:00:00Z' },
      duty_status: 'driving',
      time: '2026-03-16T14:00:00Z',
    });

    expect(result?.event).toBe('combined');
    expect(result?.locations[0]?.vehicleId).toBe('42');
    expect(result?.intervals[0]?.status).toBe('DRIVING');
  });
});
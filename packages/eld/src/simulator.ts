import type { GeoPoint, HosStatus, Iso } from '@truckdesk/shared';

import { estimateRoadMiles } from '@truckdesk/shared';

import { computeHos, summarizeIntervals, type HosComputation } from './hos.js';
import type {
  EldDutyInterval,
  EldDutyStatus,
  EldHosLogs,
  EldProvider,
  EldVehicleLocation,
  EldWebhookResult,
} from './types.js';

/**
 * Synthetic ELD.
 *
 * This is what runs when a carrier has no ELD connected - which is most of the
 * ones TruckDesk is for. The driver app pushes duty-status changes, the truck
 * pushes GPS, and this provider reconstructs a compliant HOS graph from both.
 *
 * It is also what the seed script and the tests use, which means the demo
 * company exercises the same code path as a real ELD connection.
 */

export interface SimulatedTruck {
  vehicleId: string;
  unit: string;
  driverId: string;
  location: GeoPoint;
  headingDeg: number;
  speedMph: number;
  /** Miles from the last interval to the live position. */
  lastIntervalAt: Iso;
}

export interface SimulatorOptions {
  /** Trucks to simulate. */
  vehicles: SimulatedTruck[];
  now?: () => Date;
  /** Deterministic behaviour for tests: fixed timestamps, no clock reads. */
  deterministic?: boolean;
}

export class SimulatorProvider implements EldProvider {
  readonly name = 'simulator' as const;

  private readonly vehicles: SimulatedTruck[];
  private readonly nowFn: () => Date;
  private readonly intervals: Map<string, EldDutyInterval[]> = new Map();
  private readonly locationHistory: Map<string, EldVehicleLocation[]> = new Map();

  constructor(options: SimulatorOptions) {
    this.vehicles = options.vehicles ?? [];
    this.nowFn = options.now ?? (() => new Date());

    // Seed each vehicle with a plausible shift that starts off duty.
    for (const vehicle of this.vehicles) {
      this.intervals.set(vehicle.vehicleId, [
        { status: 'OFF_DUTY', startedAt: hoursAgo(10, this.nowFn()), endedAt: hoursAgo(8, this.nowFn()) },
      ]);
      this.locationHistory.set(vehicle.vehicleId, []);
    }
  }

  isConfigured(): boolean {
    return true;
  }

  /** Called by the driver app when duty status changes. */
  recordDutyChange(vehicleId: string, status: EldDutyStatus, at?: Iso, location?: GeoPoint): void {
    const now = at ?? this.nowFn().toISOString();
    const list = this.intervals.get(vehicleId) ?? [];
    const last = list[list.length - 1];

    if (last && !last.endedAt) {
      last.endedAt = now;
    } else if (last && last.status === status) {
      // No-op: identical consecutive interval.
      return;
    }

    list.push({
      status,
      startedAt: now,
      location,
      vehicleId,
    });
    this.intervals.set(vehicleId, list);
  }

  /** Called by the tracking loop when a position ping arrives. */
  recordLocation(vehicleId: string, location: GeoPoint, at?: Iso, speedMph?: number): void {
    const now = at ?? this.nowFn().toISOString();
    const list = this.locationHistory.get(vehicleId) ?? [];
    const last = list[list.length - 1];

    if (!last) {
      // The first ping has nothing to measure speed against. Assume moving if
      // the caller says so, otherwise the truck starts as on-duty-not-driving,
      // which is the safer default at a yard.
      this.recordDutyChange(vehicleId, (speedMph ?? 0) >= 3 ? 'DRIVING' : 'ON_DUTY_NOT_DRIVING', now, location);
    } else {
      const hours = (Date.parse(now) - Date.parse(last.at)) / 3_600_000;
      const implied = hours > 0 ? estimateRoadMiles(last.location, location) / hours : 0;
      // Prefer the measured speed; fall back to what the movement implies.
      const speed = speedMph ?? implied;
      const driving = speed >= 3;
      if (driving && this.currentStatus(vehicleId) !== 'DRIVING') {
        this.recordDutyChange(vehicleId, 'DRIVING', now, location);
      } else if (!driving && this.currentStatus(vehicleId) === 'DRIVING') {
        this.recordDutyChange(vehicleId, 'ON_DUTY_NOT_DRIVING', now, location);
      }
    }

    list.push({ vehicleId, location, at: now, speedMph });
    this.locationHistory.set(vehicleId, list);
  }

  private currentStatus(vehicleId: string): EldDutyStatus {
    const list = this.intervals.get(vehicleId) ?? [];
    return list[list.length - 1]?.status ?? 'OFF_DUTY';
  }

  currentHosStatus(vehicleId: string): HosStatus {
    const status = this.currentStatus(vehicleId);
    switch (status) {
      case 'DRIVING':
        return 'driving';
      case 'SLEEPER_BERTH':
        return 'sleeper';
      case 'ON_DUTY_NOT_DRIVING':
      case 'ON_DUTY_OTHER':
      case 'YARD_MOVE':
      case 'HOSTLING':
        return 'on_duty';
      default:
        return 'off_duty';
    }
  }

  async locations(since: Iso, until?: Iso): Promise<EldVehicleLocation[]> {
    const end = until ?? this.nowFn().toISOString();
    const out: EldVehicleLocation[] = [];

    for (const vehicle of this.vehicles) {
      const list = this.locationHistory.get(vehicle.vehicleId) ?? [];
      for (const location of list) {
        if (location.at >= since && location.at <= end) out.push(location);
      }

      // Always expose the live position, which is what a dispatcher wants.
      const live: EldVehicleLocation = {
        vehicleId: vehicle.vehicleId,
        location: vehicle.location,
        at: end,
        headingDeg: vehicle.headingDeg,
        speedMph: vehicle.speedMph,
      };
      if (live.at >= since && !list.some((item) => item.at === end)) out.push(live);
    }

    return out;
  }

  async hosLogs(vehicleId: string, forDate: Iso): Promise<EldHosLogs> {
    const intervals = this.intervals.get(vehicleId) ?? [];
    const vehicle = this.vehicles.find((candidate) => candidate.vehicleId === vehicleId);
    return summarizeIntervals(
      vehicleId,
      vehicle?.driverId ?? '',
      intervals,
      `${forDate.slice(0, 10)}T00:00:00Z`,
      this.nowFn().toISOString(),
    );
  }

  async dutyIntervals(
    vehicleId: string,
    since: Iso,
    until: Iso,
  ): Promise<EldDutyInterval[]> {
    return (this.intervals.get(vehicleId) ?? []).filter(
      (interval) => interval.startedAt >= since && interval.startedAt <= until,
    );
  }

  /** Full HOS computation for a vehicle, for the dispatcher eligibility check. */
  compute(vehicleId: string, now?: Date): HosComputation {
    return computeHos({
      intervals: this.intervals.get(vehicleId) ?? [],
      now: now ?? this.nowFn(),
    });
  }

  /**
   * Advance a vehicle along a heading for `hours`, generating duty intervals
   * and location pings. Used by the seed script to build a realistic board.
   */
  driveFor(vehicleId: string, hours: number, speedMph = 52, now?: Date): void {
    const vehicle = this.vehicles.find((candidate) => candidate.vehicleId === vehicleId);
    if (!vehicle) return;

    const start = now ?? this.nowFn();
    const steps = Math.max(1, Math.round(hours * 2));
    const stepMs = (hours * 3_600_000) / steps;

    this.recordDutyChange(vehicleId, 'DRIVING', start.toISOString(), vehicle.location);

    for (let i = 1; i <= steps; i += 1) {
      const at = new Date(start.getTime() + i * stepMs).toISOString();
      vehicle.location = advance(vehicle.location, vehicle.headingDeg, (speedMph * stepMs) / 3_600_000);
      this.recordLocation(vehicleId, vehicle.location, at, speedMph);
      // Push the truck record too, so the board reflects the movement.
      vehicle.speedMph = speedMph;
    }

    const endAt = new Date(start.getTime() + hours * 3_600_000).toISOString();
    this.recordDutyChange(vehicleId, 'ON_DUTY_NOT_DRIVING', endAt, vehicle.location);
  }

  /** Park a vehicle for `hours`, on duty but not driving. */
  sitFor(vehicleId: string, hours: number, now?: Date): void {
    const vehicle = this.vehicles.find((candidate) => candidate.vehicleId === vehicleId);
    if (!vehicle) return;
    const start = now ?? this.nowFn();
    const at = new Date(start.getTime() + hours * 3_600_000).toISOString();
    this.recordDutyChange(vehicleId, 'ON_DUTY_NOT_DRIVING', start.toISOString(), vehicle.location);
    this.recordLocation(vehicleId, vehicle.location, at, 0);
    vehicle.speedMph = 0;
  }

  /** Send a vehicle off duty for `hours`, which restarts the 11-hour window. */
  sleepFor(vehicleId: string, hours: number, now?: Date): void {
    const vehicle = this.vehicles.find((candidate) => candidate.vehicleId === vehicleId);
    if (!vehicle) return;
    const start = now ?? this.nowFn();
    const at = new Date(start.getTime() + hours * 3_600_000).toISOString();
    this.recordDutyChange(vehicleId, 'SLEEPER_BERTH', start.toISOString(), vehicle.location);
    this.recordDutyChange(vehicleId, 'OFF_DUTY', at, vehicle.location);
  }

  vehicle(vehicleId: string): SimulatedTruck | undefined {
    return this.vehicles.find((candidate) => candidate.vehicleId === vehicleId);
  }

  parseWebhook(_payload: unknown): EldWebhookResult {
    return { locations: [], intervals: [], event: 'unknown' };
  }
}

function advance(point: GeoPoint, headingDeg: number, miles: number): GeoPoint {
  const radians = (headingDeg * Math.PI) / 180;
  const milesPerDegreeLat = 69.0;
  const milesPerDegreeLng = Math.max(1e-6, 69.0 * Math.cos((point.lat * Math.PI) / 180));

  return {
    lat: round6(point.lat + (miles * Math.cos(radians)) / milesPerDegreeLat),
    lng: round6(point.lng + (miles * Math.sin(radians)) / milesPerDegreeLng),
  };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function hoursAgo(hours: number, now: Date): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/**
 * Build a provider with no ELD accounts attached, which is the default for
 * self-hosted TruckDesk and for the seeded demo company.
 */
export function createSimulator(
  vehicles: SimulatedTruck[],
  options: { now?: () => Date } = {},
): SimulatorProvider {
  return new SimulatorProvider({ vehicles, now: options.now });
}

/** An ELD that reports nothing, for carriers who track trucks by phone. */
export class ManualProvider implements EldProvider {
  readonly name = 'manual' as const;
  private readonly intervals = new Map<string, EldDutyInterval[]>();

  isConfigured(): boolean {
    return true;
  }

  recordDutyChange(vehicleId: string, status: EldDutyStatus, at: string): void {
    const list = this.intervals.get(vehicleId) ?? [];
    const last = list[list.length - 1];
    if (last && !last.endedAt) last.endedAt = at;
    list.push({ status, startedAt: at, vehicleId });
    this.intervals.set(vehicleId, list);
  }

  async locations(): Promise<EldVehicleLocation[]> {
    return [];
  }

  async hosLogs(vehicleId: string, forDate: Iso): Promise<EldHosLogs> {
    return summarizeIntervals(
      vehicleId,
      '',
      this.intervals.get(vehicleId) ?? [],
      `${forDate.slice(0, 10)}T00:00:00Z`,
      new Date().toISOString(),
    );
  }

  async dutyIntervals(
    vehicleId: string,
    since: Iso,
    until: Iso,
  ): Promise<EldDutyInterval[]> {
    return (this.intervals.get(vehicleId) ?? []).filter(
      (interval) => interval.startedAt >= since && interval.startedAt <= until,
    );
  }

  parseWebhook(_payload: unknown): EldWebhookResult {
    return { locations: [], intervals: [], event: 'unknown' };
  }
}
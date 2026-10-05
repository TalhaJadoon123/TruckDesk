import type { GeoPoint, HosStatus, Iso } from '@truckdesk/shared';

/**
 * ELD integration port.
 *
 * Samsara and Motive are both real products with paid tiers, so TruckDesk treats
 * them as optional: a carrier with no ELD connection still gets a synthetic
 * provider that reports duty status from the driver app. The interface below is
 * what `packages/api` depends on, so swapping a provider never touches a route.
 */

/** FMCSA duty status codes, in the vocabulary every ELD uses. */
export type EldDutyStatus =
  | 'OFF_DUTY'
  | 'SLEEPER_BERTH'
  | 'DRIVING'
  | 'ON_DUTY_NOT_DRIVING'
  | 'ON_DUTY_OTHER'
  | 'PERSONAL_CONVEYANCE'
  | 'YARD_MOVE'
  | 'HOSTLING';

export const HOS_DUTY_STATUS_MAP: Record<EldDutyStatus, HosStatus> = {
  OFF_DUTY: 'off_duty',
  SLEEPER_BERTH: 'sleeper',
  DRIVING: 'driving',
  ON_DUTY_NOT_DRIVING: 'on_duty',
  ON_DUTY_OTHER: 'on_duty',
  PERSONAL_CONVEYANCE: 'off_duty',
  YARD_MOVE: 'on_duty',
  HOSTLING: 'on_duty',
};

/** Property-carrying is what a straight truck or a driver hauling freight runs. */
export type HosCycle = 60 | 70;

export interface EldDutyInterval {
  status: EldDutyStatus;
  startedAt: Iso;
  endedAt?: Iso;
  location?: GeoPoint;
  vehicleId?: string;
  /** Metres. Some providers report it, most do not. */
  accuracyM?: number;
  annotation?: string;
  annotationCode?: string;
}

export interface EldHosLogs {
  vehicleId: string;
  driverId: string;
  dutyStatus: EldDutyStatus;
  /** Log period the ELD reports, usually a 24-hour graph. */
  periodStart: Iso;
  periodEnd: Iso;
  cycles: Array<{
    startedAt: Iso;
    endedAt?: Iso;
    drivingMinutes: number;
    onDutyMinutes: number;
    offDutyMinutes: number;
    sleeperMinutes: number;
    /** Minutes of driving remaining in the 11-hour window. */
    driveMinutesRemaining: number;
    /** Minutes of on-duty left before the 14-hour window closes. */
    dutyMinutesRemaining: number;
    /** Minutes of driving since the last 30-minute break. */
    sinceBreakMinutes: number;
  }>;
  violations: Array<{
    type: 'drive_time' | 'on_duty_time' | 'break' | 'cycle' | 'logging';
    message: string;
    at: Iso;
    severity: 'warning' | 'violation';
  }>;
}

export interface EldVehicleLocation {
  vehicleId: string;
  location: GeoPoint;
  at: Iso;
  headingDeg?: number;
  speedMph?: number;
  accuracyM?: number;
  odometerMiles?: number;
  ignitionOn?: boolean;
}

export interface EldAuthConfig {
  /** Provider base URL. Defaults to the vendor's public endpoint. */
  baseUrl?: string;
  /** Static token providers (Samsara-style API tokens, Motive tokens). */
  token?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export interface EldProvider {
  /** Stable identifier, stored on the truck record. */
  readonly name: 'samsara' | 'motive' | 'simulator' | 'manual';
  /** False when the provider has no credentials configured. */
  isConfigured(): boolean;

  locations(since: Iso, until?: Iso): Promise<EldVehicleLocation[]>;
  hosLogs(vehicleId: string, forDate: Iso): Promise<EldHosLogs>;
  dutyIntervals(vehicleId: string, since: Iso, until: Iso): Promise<EldDutyInterval[]>;

  /** Optional: push-based ELDs open a webhook. Returns the parsing helper. */
  parseWebhook?(payload: unknown): EldWebhookResult;
}

export interface EldWebhookResult {
  vehicleId?: string;
  driverId?: string;
  locations: EldVehicleLocation[];
  intervals: EldDutyInterval[];
  event: 'location' | 'hos' | 'combined' | 'unknown';
}

export interface EldFetchLike {
  (
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export class EldProviderError extends Error {
  readonly provider: string;
  readonly status: number;

  constructor(provider: string, status: number, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'EldProviderError';
    this.provider = provider;
    this.status = status;
  }
}

/** Coerce whatever an ELD calls a duty status into the FMCSA vocabulary. */
export function normalizeDutyStatus(value: unknown): EldDutyStatus | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');

  const table: Record<string, EldDutyStatus> = {
    OFF_DUTY: 'OFF_DUTY',
    OFFDUTY: 'OFF_DUTY',
    D: 'OFF_DUTY',
    SLEEPER_BERTH: 'SLEEPER_BERTH',
    SLEEPER_BERTH_1: 'SLEEPER_BERTH',
    SLEEPER: 'SLEEPER_BERTH',
    S: 'SLEEPER_BERTH',
    SB: 'SLEEPER_BERTH',
    DRIVING: 'DRIVING',
    DR: 'DRIVING',
    DRIVER_DRIVING: 'DRIVING',
    ON_DUTY_NOT_DRIVING: 'ON_DUTY_NOT_DRIVING',
    ONDUTYNOTDRIVING: 'ON_DUTY_NOT_DRIVING',
    ON: 'ON_DUTY_NOT_DRIVING',
    ON_DUTY_OTHER: 'ON_DUTY_OTHER',
    ONDUTYOTHER: 'ON_DUTY_OTHER',
    OD: 'ON_DUTY_OTHER',
    PERSONAL_CONVEYANCE: 'PERSONAL_CONVEYANCE',
    PC: 'PERSONAL_CONVEYANCE',
    YARD_MOVE: 'YARD_MOVE',
    YM: 'YARD_MOVE',
    HOSTLING: 'HOSTLING',
    HL: 'HOSTLING',
  };

  return table[key] ?? null;
}

/** Normalize a timestamp an ELD reports in one of its many formats. */
export function normalizeEldTimestamp(value: unknown): Iso | null {
  if (typeof value === 'number') {
    // ELDs report either seconds or milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const direct = new Date(value);
    if (!Number.isNaN(direct.getTime())) return direct.toISOString();
    // Bare epoch string, seconds.
    if (/^\d+$/.test(value)) {
      const num = Number.parseInt(value, 10);
      const ms = num < 1e12 ? num * 1000 : num;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

/** Meters per mile, for providers that report metric. */
export const METERS_PER_MILE = 1609.344;
export const KILOMETERS_PER_MILE = 1.609344;

export function metersToMiles(meters: number | undefined): number | undefined {
  if (meters === undefined || !Number.isFinite(meters)) return undefined;
  return Math.round((meters / METERS_PER_MILE) * 10) / 10;
}

export function kmphToMph(kmph: number | undefined): number | undefined {
  if (kmph === undefined || !Number.isFinite(kmph)) return undefined;
  return Math.round((kmph / KILOMETERS_PER_MILE) * 10) / 10;
}
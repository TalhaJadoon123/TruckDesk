import type { Iso } from '@truckdesk/shared';

import {
  EldProviderError,
  kmphToMph,
  normalizeDutyStatus,
  normalizeEldTimestamp,
  type EldAuthConfig,
  type EldDutyInterval,
  type EldDutyStatus,
  type EldFetchLike,
  type EldHosLogs,
  type EldProvider,
  type EldVehicleLocation,
  type EldWebhookResult,
} from './types.js';

/**
 * Samsara adapter.
 *
 * Samsara's developer platform is documented and reachable, but a live
 * connection needs an org token, and the free tier that most 8-truck carriers
 * are on is a Samsara subscription rather than an API plan. So this adapter is
 * built to be *testable without credentials*: the whole HTTP surface is one
 * injected `fetch`, and every response shape is normalised defensively.
 *
 * Docs: https://developers.samsara.com
 */

export const SAMSARA_BASE_URL = 'https://api.samsara.com/v1';

export interface SamsaraOptions extends EldAuthConfig {
  fetchImpl?: EldFetchLike;
  /** Seconds to wait before aborting. */
  timeoutMs?: number;
  /** Set false in tests to assert on the request without hitting the network. */
  dryRun?: boolean;
}

interface SamsaraLocationRecord {
  id?: string;
  vehicleId?: string;
  latitude?: number;
  longitude?: number;
  heading?: number;
  speedMph?: number;
  speedKph?: number;
  time?: string | number;
  locationTime?: string | number;
  odometerMiles?: number;
  ignitionOn?: boolean;
  /** Present on the duty-status-interval endpoint. */
  dutyStatus?: string;
}

interface SamsaraHosResponse {
  vehicleId?: string;
  driverId?: string;
  dutyStatus?: string;
  cycles?: Array<Record<string, unknown>>;
  violations?: Array<Record<string, unknown>>;
}

export class SamsaraProvider implements EldProvider {
  readonly name = 'samsara' as const;

  private readonly options: SamsaraOptions;
  private readonly fetchImpl: EldFetchLike;

  constructor(options: SamsaraOptions = {}) {
    this.options = options;
    const injected = options.fetchImpl;
    this.fetchImpl =
      injected ??
      ((input, init) =>
        fetch(input, init as RequestInit) as unknown as ReturnType<EldFetchLike>);
  }

  isConfigured(): boolean {
    return Boolean(this.options.token);
  }

  private headers(): Record<string, string> {
    if (!this.options.token) {
      throw new EldProviderError('samsara', 401, 'No Samsara API token configured');
    }
    return {
      Authorization: `Bearer ${this.options.token}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(path: string, search?: Record<string, string>): Promise<T> {
    const base = this.options.baseUrl || SAMSARA_BASE_URL;
    const url = new URL(path.startsWith('http') ? path : `${base}${path}`);
    for (const [key, value] of Object.entries(search ?? {})) {
      url.searchParams.set(key, value);
    }

    const controller = this.options.timeoutMs
      ? new AbortController()
      : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
      : null;

    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: this.headers(),
        signal: controller?.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new EldProviderError(
          'samsara',
          response.status,
          `GET ${path} failed (${response.status}): ${body.slice(0, 300)}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof EldProviderError) throw error;
      throw new EldProviderError(
        'samsara',
        0,
        error instanceof Error ? error.message : 'Unknown transport error',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Samsara exposes historical locations as a paginated list. We request the
   * window and let the caller slice; the adapter normalises each record.
   */
  async locations(since: Iso, until?: Iso): Promise<EldVehicleLocation[]> {
    const search: Record<string, string> = {
      startTs: since,
      endTs: until ?? new Date().toISOString(),
      limit: '500',
    };

    const response = await this.request<{ data?: SamsaraLocationRecord[] }>(
      '/fleet/locations',
      search,
    );

    const records = response.data ?? [];
    return records
      .map((record) => normalizeSamsaraLocation(record))
      .filter((location): location is EldVehicleLocation => location !== null);
  }

  async hosLogs(vehicleId: string, forDate: Iso): Promise<EldHosLogs> {
    const start = `${forDate.slice(0, 10)}T00:00:00Z`;
    const end = new Date(new Date(start).getTime() + 24 * 3_600_000).toISOString();

    const response = await this.request<SamsaraHosResponse>(
      `/eld/hos_logs`,
      { vehicleId, startTs: start, endTs: end },
    );

    return {
      vehicleId: response.vehicleId ?? vehicleId,
      driverId: response.driverId ?? '',
      dutyStatus: normalizeDutyStatus(response.dutyStatus) ?? 'OFF_DUTY',
      periodStart: start,
      periodEnd: end,
      cycles: (response.cycles ?? []).map((cycle) => ({
        startedAt: normalizeEldTimestamp(cycle['startTime']) ?? start,
        endedAt: normalizeEldTimestamp(cycle['endTime']) ?? end,
        drivingMinutes: numberFrom(cycle['driveMinutes'] ?? cycle['durationMs']),
        onDutyMinutes: numberFrom(cycle['onDutyMinutes'] ?? cycle['onDutyDurationMs']),
        offDutyMinutes: numberFrom(cycle['offDutyMinutes'] ?? cycle['offDutyDurationMs']),
        sleeperMinutes: numberFrom(cycle['sleeperMinutes'] ?? cycle['sleeperDurationMs']),
        driveMinutesRemaining: numberFrom(cycle['driveMinutesRemaining']),
        dutyMinutesRemaining: numberFrom(cycle['onDutyMinutesRemaining']),
        sinceBreakMinutes: numberFrom(cycle['driveMinutesSinceBreak']),
      })),
      violations: (response.violations ?? []).map((violation) => ({
        type: normalizeViolationType(violation['type']),
        message: String(violation['message'] ?? 'ELD reported a violation'),
        at: normalizeEldTimestamp(violation['startTs'] ?? violation['time']) ?? end,
        severity:
          String(violation['severity'] ?? 'violation').toLowerCase() === 'warning'
            ? 'warning'
            : 'violation',
      })),
    };
  }

  async dutyIntervals(
    vehicleId: string,
    since: Iso,
    until: Iso,
  ): Promise<EldDutyInterval[]> {
    const response = await this.request<{ data?: SamsaraLocationRecord[] }>(
      '/eld/duty_status_interval',
      { vehicleId, startTs: since, endTs: until, limit: '500' },
    );

    return (response.data ?? []).flatMap<EldDutyInterval>((record) => {
      const at = normalizeEldTimestamp(record.time ?? record.locationTime);
      const status = normalizeDutyStatus(record.dutyStatus);
      if (!at || !status) return [];
      return [
        {
          status,
          startedAt: at,
          location:
            typeof record.latitude === 'number' && typeof record.longitude === 'number'
              ? { lat: record.latitude, lng: record.longitude }
              : undefined,
          vehicleId: record.vehicleId ?? vehicleId,
        },
      ];
    });
  }

  /**
   * Samsara webhooks post a JSON envelope with `type` and `webhookUuid`. This
   * turns the location-published event into the same shape as a poll, so the
   * ingestion path is identical whether a carrier is on webhooks or not.
   */
  parseWebhook(payload: unknown): EldWebhookResult {
    const body = asRecord(payload);
    const data = asRecord(body['data']);

    if (!data) {
      return { locations: [], intervals: [], event: 'unknown' };
    }

    const locations = normalizeSamsaraLocations(data);
    const interval = data['dutyStatus'];

    if (locations.length > 0 && interval) {
      return {
        vehicleId: optionalString(data['vehicleId']),
        driverId: optionalString(data['driverId']),
        locations,
        intervals: [],
        event: 'combined',
      };
    }
    if (locations.length > 0) {
      return {
        vehicleId: optionalString(data['vehicleId']),
        driverId: optionalString(data['driverId']),
        locations,
        intervals: [],
        event: 'location',
      };
    }

    return { locations: [], intervals: [], event: 'unknown' };
  }
}

function normalizeSamsaraLocations(data: Record<string, unknown>): EldVehicleLocation[] {
  const raw = data['locations'];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => normalizeSamsaraLocation(asRecord(item)))
      .filter((item): item is EldVehicleLocation => item !== null);
  }
  const single = normalizeSamsaraLocation(data);
  return single ? [single] : [];
}

/**
 * Samsara reports some payloads with camelCase and some with snake_case, and
 * `speedMph` sometimes arrives as `speedKph`. Accept all of them.
 */
export function normalizeSamsaraLocation(
  record: SamsaraLocationRecord | Record<string, unknown>,
): EldVehicleLocation | null {
  const raw = record as Record<string, unknown>;

  const lat = firstNumber(raw, ['latitude', 'lat']);
  const lng = firstNumber(raw, ['longitude', 'lng', 'lon']);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const at = normalizeEldTimestamp(raw['time'] ?? raw['locationTime'] ?? raw['timestamp']);
  if (!at) return null;

  const speed =
    firstNumber(raw, ['speedMph']) ?? (kmphToMph(firstNumber(raw, ['speedKph']) ?? undefined) ?? undefined);

  return {
    vehicleId: optionalString(raw['vehicleId']) ?? optionalString(raw['vehicle_id']) ?? '',
    location: { lat, lng },
    at,
    headingDeg: firstNumber(raw, ['heading', 'headingDegrees']) ?? undefined,
    speedMph: speed ?? undefined,
    odometerMiles:
      firstNumber(raw, ['odometerMiles', 'odometer_miles']) ??
      kmphToMph(firstNumber(raw, ['odometerKm', 'odometer_km']) ?? undefined),
    ignitionOn: typeof raw['ignitionOn'] === 'boolean' ? raw['ignitionOn'] : undefined,
  };
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return 0;
}

function normalizeViolationType(value: unknown): 'drive_time' | 'on_duty_time' | 'break' | 'cycle' | 'logging' {
  const key = String(value ?? '').toLowerCase();
  if (key.includes('drive')) return 'drive_time';
  if (key.includes('on_duty') || key.includes('on duty') || key.includes('14')) return 'on_duty_time';
  if (key.includes('break')) return 'break';
  if (key.includes('cycle') || key.includes('60') || key.includes('70')) return 'cycle';
  return 'logging';
}

export type { EldDutyStatus };
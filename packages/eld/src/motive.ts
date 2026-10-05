import type { Iso } from '@truckdesk/shared';

import {
  EldProviderError,
  normalizeDutyStatus,
  normalizeEldTimestamp,
  type EldAuthConfig,
  type EldDutyInterval,
  type EldFetchLike,
  type EldHosLogs,
  type EldProvider,
  type EldVehicleLocation,
  type EldWebhookResult,
} from './types.js';

/**
 * Motive (formerly KeepTruckin) adapter.
 *
 * Motive's Driver Reassignment API is the standard integration path for
 * carriers that want their own ELD data in a third-party tool. Motive is
 * reachable through the KeepTruckin v1 API, which authenticates with a
 * client-id/client-secret pair and returns JWT access tokens.
 *
 * Like Samsara, this adapter is written to be exercised against a stub fetch so
 * the whole normalisation path is covered without an account.
 */

export const MOTIVE_BASE_URL = 'https://api.motive.com/v1';
export const MOTIVE_TOKEN_URL = 'https://api.motive.com/oauth/token';

export interface MotiveOptions extends EldAuthConfig {
  fetchImpl?: EldFetchLike;
  timeoutMs?: number;
  /** Pre-fetched access token, for Workers that cache one. */
  accessToken?: string;
  /** Set false to assert on request shape without performing I/O. */
  dryRun?: boolean;
}

export class MotiveProvider implements EldProvider {
  readonly name = 'motive' as const;

  private readonly options: MotiveOptions;
  private readonly fetchImpl: EldFetchLike;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(options: MotiveOptions = {}) {
    this.options = options;
    const injected = options.fetchImpl;
    this.fetchImpl =
      injected ??
      ((input, init) =>
        fetch(input, init as RequestInit) as unknown as ReturnType<EldFetchLike>);
  }

  isConfigured(): boolean {
    return Boolean(
      this.options.accessToken ||
        (this.options.clientId && this.options.clientSecret && this.options.refreshToken),
    );
  }

  /**
   * Motive exposes the KeepTruckin v1 API on a different host and requires a
   * bearer token obtained from the oauth endpoint. `authenticate` is exported
   * so a Worker can call it once at module scope.
   */
  async authenticate(): Promise<string> {
    if (this.options.accessToken) return this.options.accessToken;

    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 30_000) {
      return this.cachedToken.value;
    }

    const { clientId, clientSecret, refreshToken } = this.options;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new EldProviderError(
        'motive',
        401,
        'Motive needs clientId + clientSecret + refreshToken (or a pre-fetched accessToken)',
      );
    }

    const base = this.options.baseUrl || MOTIVE_BASE_URL;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });

    const response = await this.fetchImpl(base.replace('/v1', '/oauth/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new EldProviderError(
        'motive',
        response.status,
        `Token refresh failed: ${(await response.text().catch(() => '')).slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = payload['access_token'];
    if (typeof accessToken !== 'string') {
      throw new EldProviderError('motive', 502, 'Token response had no access_token');
    }

    const expiresIn = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : 3600;
    this.cachedToken = { value: accessToken, expiresAt: Date.now() + expiresIn * 1000 };
    return accessToken;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.authenticate();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(path: string, search?: Record<string, string>): Promise<T> {
    const base = this.options.baseUrl || MOTIVE_BASE_URL;
    const url = new URL(path.startsWith('http') ? path : `${base}${path}`);
    for (const [key, value] of Object.entries(search ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: await this.headers(),
    });

    if (!response.ok) {
      throw new EldProviderError(
        'motive',
        response.status,
        `GET ${path} failed (${response.status}): ${(await response.text().catch(() => '')).slice(0, 300)}`,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Motive has no single "locations" endpoint; position comes through
   * `/units/:id/stats` and duty status through the driver's HOS log. This
   * method accepts whatever the carrier's integration layer has already pulled
   * and normalizes it, which is how the shipped simulator and importer feed it.
   */
  async locations(since: Iso, until?: Iso): Promise<EldVehicleLocation[]> {
    const response = await this.request<{ vehicles?: unknown[] }>('/vehicles');
    const vehicles = response.vehicles ?? [];

    const out: EldVehicleLocation[] = [];
    for (const entry of vehicles) {
      const record = asRecord(entry);
      const stats = asRecord(record['locations'] ?? record['latest_location']);
      const location = normalizeMotiveLocation(record, stats, since, until ?? new Date().toISOString());
      if (location) out.push(location);
    }
    return out;
  }

  async hosLogs(vehicleId: string, forDate: Iso): Promise<EldHosLogs> {
    const start = `${forDate.slice(0, 10)}T00:00:00Z`;
    const end = new Date(new Date(start).getTime() + 24 * 3_600_000).toISOString();

    const response = await this.request<Record<string, unknown>>('/eld/duty_status_logs', {
      vehicleId,
      startTs: start,
      endTs: end,
    });

    const dutyStatus = normalizeDutyStatus(response['duty_status'] ?? response['dutyStatus']) ?? 'OFF_DUTY';

    return {
      vehicleId,
      driverId: typeof response['driver_id'] === 'string' ? response['driver_id'] : '',
      dutyStatus,
      periodStart: start,
      periodEnd: end,
      cycles: Array.isArray(response['cycles']) ? (response['cycles'] as Array<Record<string, unknown>>).map((cycle) => ({
        startedAt: normalizeEldTimestamp(cycle['start_time'] ?? cycle['startTime']) ?? start,
        endedAt: normalizeEldTimestamp(cycle['end_time'] ?? cycle['endTime']) ?? end,
        drivingMinutes: intFrom(cycle['drive_minutes'] ?? cycle['driving_minutes']),
        onDutyMinutes: intFrom(cycle['on_duty_minutes'] ?? cycle['onDutyMinutes']),
        offDutyMinutes: intFrom(cycle['off_duty_minutes']),
        sleeperMinutes: intFrom(cycle['sleeper_minutes']),
        driveMinutesRemaining: intFrom(cycle['drive_minutes_remaining']),
        dutyMinutesRemaining: intFrom(cycle['on_duty_minutes_remaining']),
        sinceBreakMinutes: intFrom(cycle['drive_minutes_since_break']),
      })) : [],
      violations: Array.isArray(response['violations'])
        ? (response['violations'] as Array<Record<string, unknown>>).map((violation) => ({
            type: 'logging' as const,
            message: String(violation['message'] ?? 'Motive reported a violation'),
            at: normalizeEldTimestamp(violation['time']) ?? end,
            severity: 'violation' as const,
          }))
        : [],
    };
  }

  async dutyIntervals(
    vehicleId: string,
    since: Iso,
    until: Iso,
  ): Promise<EldDutyInterval[]> {
    const response = await this.request<{ duty_status_intervals?: unknown[] }>(
      '/eld/duty_status_intervals',
      { vehicle_id: vehicleId, start_ts: since, end_ts: until },
    );

    const rows = response.duty_status_intervals ?? [];
    return rows.flatMap<EldDutyInterval>((row) => {
      const record = asRecord(row);
      const startedAt = normalizeEldTimestamp(record['start_time'] ?? record['started_at']);
      const status = normalizeDutyStatus(record['duty_status'] ?? record['status']);
      if (!startedAt || !status) return [];
      return [
        {
          status,
          startedAt,
          endedAt: normalizeEldTimestamp(record['end_time'] ?? record['ended_at']) ?? undefined,
          location: geoFrom(record),
          vehicleId: typeof record['vehicle_id'] === 'string' ? record['vehicle_id'] : vehicleId,
        },
      ];
    });
  }

  parseWebhook(payload: unknown): EldWebhookResult {
    const body = asRecord(payload);
    const data = asRecord(body['data'] ?? payload);

    const location = normalizeMotiveLocation(
      asRecord(data['vehicle'] ?? data),
      asRecord(data['location'] ?? data['last_location'] ?? data),
      '1970-01-01T00:00:00.000Z',
      '2999-01-01T00:00:00.000Z',
    );

    const status = normalizeDutyStatus(data['duty_status'] ?? data['dutyStatus']);
    const at = normalizeEldTimestamp(data['time'] ?? data['timestamp']);

    const intervals: EldDutyInterval[] =
      status && at ? [{ status, startedAt: at, vehicleId: location?.vehicleId }] : [];

    return {
      vehicleId: location?.vehicleId,
      driverId: typeof data['driver_id'] === 'string' ? data['driver_id'] : undefined,
      locations: location ? [location] : [],
      intervals,
      event: location && intervals.length > 0 ? 'combined' : location ? 'location' : intervals.length ? 'hos' : 'unknown',
    };
  }
}

export function normalizeMotiveLocation(
  vehicle: Record<string, unknown>,
  stats: Record<string, unknown>,
  since: Iso,
  until: Iso,
): EldVehicleLocation | null {
  const lat = numberFrom(stats['latitude'] ?? vehicle['latitude'] ?? stats['lat']);
  const lng = numberFrom(stats['longitude'] ?? vehicle['longitude'] ?? stats['lng']);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const at = normalizeEldTimestamp(
    stats['timestamp'] ?? stats['recorded_at'] ?? vehicle['updated_at'] ?? vehicle['timestamp'],
  );
  if (!at) return null;
  if (at < since || at > until) return null;

  return {
    vehicleId: typeof vehicle['id'] === 'number' ? String(vehicle['id']) : String(vehicle['id'] ?? ''),
    location: { lat, lng },
    at,
    headingDeg: numberFrom(stats['bearing'] ?? stats['heading']) ?? undefined,
    speedMph: numberFrom(stats['speed'] ?? stats['speed_mph']) ?? undefined,
    accuracyM: numberFrom(stats['accuracy'] ?? stats['accuracy_m']) ?? undefined,
  };
}

function geoFrom(record: Record<string, unknown>) {
  const lat = numberFrom(record['latitude'] ?? record['lat']);
  const lng = numberFrom(record['longitude'] ?? record['lng']);
  if (lat === null || lng === null) return undefined;
  return { lat, lng };
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function intFrom(value: unknown): number {
  const parsed = numberFrom(value);
  return parsed === null ? 0 : Math.round(parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
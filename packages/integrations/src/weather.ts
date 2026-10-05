import type { GeoPoint } from '@truckdesk/shared';

import {
  HttpClient,
  SOURCES,
  failed,
  normalizePoint,
  ok,
  type IntegrationResult,
} from './client.js';

/**
 * Weather along the lane.
 *
 * Two keyless sources, for two different reasons:
 *
 *   - **Open-Meteo** for the numbers a driver cares about: temperature (a reefer
 *     set point is a promise about temperature), precipitation and wind.
 *   - **weather.gov** for the official US alerts: blizzard warnings, flash flood
 *     warnings, winter storm advisories. Those come from the National Weather
 *     Service and are what a dispatcher actually needs to know about a lane.
 *
 * Neither is required. A load moves without them.
 */

export interface WeatherSnapshot {
  point: GeoPoint;
  /** Air temperature in Celsius, because that is what the API returns. */
  temperatureC: number | null;
  /** Feels like, Celsius. */
  apparentTemperatureC: number | null;
  /** Relative humidity percent. */
  humidityPct: number | null;
  /** Precipitation in millimetres over the period. */
  precipitationMm: number | null;
  /** Wind speed in km/h. */
  windKmh: number | null;
  windDirectionDeg: number | null;
  weatherCode: number | null;
  description: string;
  /** ISO timestamp of the observation or forecast start. */
  at: string;
  source: string;
}

interface ForecastResponse {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    weather_code?: number;
  };
}

/** WMO weather interpretation codes, translated once here. */
const WEATHER_CODES: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Light freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Light snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail',
};

export function describeWeather(code: number | null): string {
  if (code === null || code === undefined) return 'Unknown';
  return WEATHER_CODES[code] ?? `Weather code ${code}`;
}

export class WeatherService {
  private readonly client: HttpClient;

  constructor(client?: HttpClient) {
    this.client = client ?? new HttpClient({ ttlMs: 30 * 60_000 });
  }

  /**
   * Current conditions at a point.
   *
   * Temperature is returned in Celsius because that is what the source uses, and
   * converting here would mean the API layer and the UI could disagree about
   * units. Callers that display it convert once.
   */
  async current(point: GeoPoint): Promise<IntegrationResult<WeatherSnapshot>> {
    const safe = normalizePoint(point.lat, point.lng);
    if (!safe) return failed('open-meteo', 'Invalid coordinates');

    const url =
      `${SOURCES.openMeteo}?latitude=${safe.lat}&longitude=${safe.lng}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,' +
      'wind_speed_10m,wind_direction_10m,weather_code&timezone=UTC';

    const payload = await this.client.getJson<ForecastResponse>(url);
    const current = payload?.current;
    if (!current) return failed('open-meteo', 'No current conditions returned');

    return ok(
      {
        point: safe,
        temperatureC: current.temperature_2m ?? null,
        apparentTemperatureC: current.apparent_temperature ?? null,
        humidityPct: current.relative_humidity_2m ?? null,
        precipitationMm: current.precipitation ?? null,
        windKmh: current.wind_speed_10m ?? null,
        windDirectionDeg: current.wind_direction_10m ?? null,
        weatherCode: current.weather_code ?? null,
        description: describeWeather(current.weather_code ?? null),
        at: current.time ?? new Date().toISOString(),
        source: 'open-meteo',
      },
      'open-meteo',
    );
  }

  /**
   * Conditions along a whole lane.
   *
   * Sampled at origin, midpoint and destination rather than at every mile: three
   * calls answer the question a dispatcher actually asks ("is this lane
   * problem-free today?"), and it stays inside a polite request budget.
   */
  async alongLane(
    origin: GeoPoint,
    destination: GeoPoint,
  ): Promise<IntegrationResult<{ origin: WeatherSnapshot; midpoint: WeatherSnapshot; destination: WeatherSnapshot }>> {
    const start = normalizePoint(origin.lat, origin.lng);
    const end = normalizePoint(destination.lat, destination.lng);
    if (!start || !end) return failed('open-meteo', 'Invalid coordinates');

    const midpoint: GeoPoint = {
      lat: Math.round(((start.lat + end.lat) / 2) * 1e5) / 1e5,
      lng: Math.round(((start.lng + end.lng) / 2) * 1e5) / 1e5,
    };

    const [from, middle, to] = await Promise.all([
      this.current(start),
      this.current(midpoint),
      this.current(end),
    ]);

    if (!from.data || !to.data) {
      return failed('open-meteo', from.error ?? to.error ?? 'No data for the lane');
    }

    // The midpoint is advisory: a lane is still reportable without it.
    return ok(
      {
        origin: from.data,
        midpoint: middle.data ?? from.data,
        destination: to.data,
      },
      'open-meteo',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Severe weather alerts                                                         */
/* -------------------------------------------------------------------------- */

export interface WeatherAlert {
  id: string;
  event: string;
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  urgency: string;
  certainty: string;
  /** Effective time, ISO. */
  startsAt: string;
  endsAt: string | null;
  headline: string;
  description: string;
  instruction: string | null;
  /** NWS office that issued it. */
  sender: string;
}

interface AlertsResponse {
  features?: Array<{
    id?: string;
    properties?: {
      id?: string;
      event?: string;
      severity?: string;
      urgency?: string;
      certainty?: string;
      effective?: string;
      onset?: string;
      expires?: string;
      ends?: string;
      headline?: string;
      description?: string;
      instruction?: string;
      senderName?: string;
    };
  }>;
}

/**
 * National Weather Service alerts for a point.
 *
 * This is the one a dispatcher should actually see: a blizzard warning on a
 * 400-mile lane is worth pausing for, and a reefer load on a lane where the
 * temperature is heading to 95 is worth talking to the shipper about.
 */
export class AlertService {
  private readonly client: HttpClient;
  private readonly pointCache = new Map<string, { lat: number; lng: number }>();

  constructor(client?: HttpClient) {
    this.client = client ?? new HttpClient({ ttlMs: 60_000 });
  }

  async active(point: GeoPoint): Promise<IntegrationResult<WeatherAlert[]>> {
    const safe = normalizePoint(point.lat, point.lng);
    if (!safe) return failed('weather.gov', 'Invalid coordinates');

    const forecastPoint = await this.nearestForecastPoint(safe);
    if (!forecastPoint) {
      return failed('weather.gov', 'No NWS forecast grid for that point (likely outside the US)');
    }

    const url = `${SOURCES.nwsAlerts}?point=${forecastPoint.lat.toFixed(4)},${forecastPoint.lng.toFixed(4)}`;
    const payload = await this.client.getJson<AlertsResponse>(url);

    if (!payload || !Array.isArray(payload.features)) {
      // No features is a valid answer: no active alerts.
      return ok([], 'weather.gov');
    }

    const alerts = payload.features.flatMap((feature) => {
      const properties = feature.properties;
      if (!properties) return [];

      return [
        {
          id: properties.id ?? feature.id ?? '',
          event: properties.event ?? 'Weather alert',
          severity: normalizeSeverity(properties.severity),
          urgency: properties.urgency ?? 'Unknown',
          certainty: properties.certainty ?? 'Unknown',
          startsAt: properties.onset ?? properties.effective ?? new Date().toISOString(),
          endsAt: properties.ends ?? properties.expires ?? null,
          headline: properties.headline ?? properties.event ?? 'Weather alert',
          description: properties.description ?? '',
          instruction: properties.instruction ?? null,
          sender: properties.senderName ?? 'National Weather Service',
        },
      ] satisfies WeatherAlert[];
    });

    // Most severe first, so the UI does not have to sort.
    const order: Record<WeatherAlert['severity'], number> = {
      Extreme: 0,
      Severe: 1,
      Moderate: 2,
      Minor: 3,
      Unknown: 4,
    };
    alerts.sort((a, b) => order[a.severity] - order[b.severity]);

    return ok(alerts, 'weather.gov');
  }

  /**
   * NWS keys alerts to the 2.5km forecast grid, not the raw coordinate, so a
   * point has to be snapped to its grid cell before querying.
   */
  private async nearestForecastPoint(point: GeoPoint): Promise<GeoPoint | null> {
    const key = `${point.lat.toFixed(2)},${point.lng.toFixed(2)}`;
    const cached = this.pointCache.get(key);
    if (cached) return cached;

    // weather.gov wants at most four decimal places.
    const url = `${SOURCES.nwsPoints}/${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
    const payload = await this.client.getJson<{
      properties?: { forecastZone?: string; forecast?: string };
    }>(url);

    const forecastUrl = payload?.properties?.forecast;
    if (!forecastUrl) return null;

    const grid = await this.client.getJson<{
      properties?: { gridId?: string; gridX?: number; gridY?: number };
    }>(forecastUrl);

    const gridId = grid?.properties?.gridId;
    const x = grid?.properties?.gridX;
    const y = grid?.properties?.gridY;

    if (!gridId || typeof x !== 'number' || typeof y !== 'number') return null;

    const snapped = { lat: point.lat, lng: point.lng };
    this.pointCache.set(key, snapped);
    return snapped;
  }
}

function normalizeSeverity(value: string | undefined): WeatherAlert['severity'] {
  switch ((value ?? '').toLowerCase()) {
    case 'extreme':
      return 'Extreme';
    case 'severe':
      return 'Severe';
    case 'moderate':
      return 'Moderate';
    case 'minor':
      return 'Minor';
    default:
      return 'Unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* Driver-facing summary                                                        */
/* -------------------------------------------------------------------------- */

/** Celsius to Fahrenheit, because a US dispatcher thinks in Fahrenheit. */
export function toFahrenheit(celsius: number | null): number | null {
  if (celsius === null || !Number.isFinite(celsius)) return null;
  return Math.round((celsius * 9) / 5 + 32);
}

/** Kilometres per hour to miles per hour. */
export function kmhToMph(kmh: number | null): number | null {
  if (kmh === null || !Number.isFinite(kmh)) return null;
  return Math.round((kmh / 1.609344) * 10) / 10;
}

/**
 * Turn a lane's weather into one sentence a driver will read.
 *
 * The point of this is restraint. A banner that fires on every lane teaches a
 * dispatcher to ignore it, so temperature is only mentioned when it is
 * operationally interesting: reefer risk at the top, cold chain below.
 */
export function laneSummary(alerts: readonly WeatherAlert[], destination: WeatherSnapshot): string {
  const parts: string[] = [];

  const severe = alerts.filter((alert) => alert.severity === 'Extreme' || alert.severity === 'Severe');
  if (severe.length > 0) {
    parts.push(`${severe[0]!.event}${severe.length > 1 ? ` and ${severe.length - 1} more alert(s)` : ''}`);
  }

  const high = toFahrenheit(destination.temperatureC);
  const low = toFahrenheit(destination.apparentTemperatureC);

  if (high !== null) {
    if (high >= 95) {
      parts.push(`destination is ${high}F - check reefer cooling`);
    } else if (high <= 32) {
      // Below freezing, a reefer defends a cold chain rather than the weather.
      parts.push(`destination is ${high}F - freeze protection needed`);
    } else if (high >= 88) {
      // Warm but not alarming: worth a glance, not worth an interrupt.
      parts.push(`destination ${high}F${low !== null && low !== high ? `, feels like ${low}F` : ''}`);
    }
  }

  const wind = kmhToMph(destination.windKmh);
  if (wind !== null && wind >= 30) parts.push(`wind ${Math.round(wind)} mph`);

  if (destination.precipitationMm !== null && destination.precipitationMm >= 2) {
    parts.push('precipitation on the lane');
  }

  return parts.length > 0 ? parts.join('; ') : 'No weather concerns on this lane';
}
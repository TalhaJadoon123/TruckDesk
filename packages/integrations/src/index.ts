import type { GeoPoint } from '@truckdesk/shared';

import { HttpClient, SOURCES, type IntegrationResult } from './client.js';
import { Geocoder, type GeocodeResult } from './geocoding.js';
import {
  AlertService,
  WeatherService,
  describeWeather,
  kmhToMph,
  laneSummary,
  toFahrenheit,
  type WeatherAlert,
  type WeatherSnapshot,
} from './weather.js';
import { VinDecoder, type VinDetails } from './vin.js';

/**
 * @truckdesk/integrations - keyless public APIs.
 *
 * Every service here is optional and free. None is load-bearing: dispatch works
 * with all of them unreachable, and the capability report says so.
 *
 * | Source            | Used for                        | Terms          |
 * |-------------------|---------------------------------|----------------|
 * | US Census         | street address geocoding        | public domain  |
 * | Open-Meteo        | place search + weather          | CC BY 4.0      |
 * | OpenStreetMap     | reverse geocoding               | ODbL, 1 req/s  |
 * | NHTSA vPIC        | VIN decode                      | public domain  |
 * | weather.gov / NOAA| severe weather alerts           | public domain  |
 *
 * Nominatim's usage policy is the one real constraint, so reverse lookups go
 * through a rate limiter and are never called on a hot path.
 */

export * from './client.js';
export * from './geocoding.js';
export * from './weather.js';
export * from './vin.js';

export interface Integrations {
  geocoder: Geocoder;
  weather: WeatherService;
  alerts: AlertService;
  vin: VinDecoder;
}

export interface CreateIntegrationsOptions {
  fetchImpl?: typeof fetch;
  /** Default cache lifetime for every service. */
  ttlMs?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export function createIntegrations(options: CreateIntegrationsOptions = {}): Integrations {
  const client = new HttpClient({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });

  return {
    geocoder: new Geocoder(client),
    weather: new WeatherService(client),
    alerts: new AlertService(client),
    vin: new VinDecoder(client),
  };
}

/* -------------------------------------------------------------------------- */
/* Capability report                                                            */
/* -------------------------------------------------------------------------- */

export interface Capability {
  name: string;
  enabled: boolean;
  free: boolean;
  requiresKey: false;
  source: string;
  purpose: string;
  degradedBehaviour: string;
}

/**
 * What is wired, for `/capabilities`. Everything is `free: true` and
 * `requiresKey: false` by construction; that is the point of this package.
 */
export function capabilityCatalog(): Capability[] {
  return [
    {
      name: 'geocoding',
      enabled: true,
      free: true,
      requiresKey: false,
      source: 'US Census + Open-Meteo',
      purpose: 'Turn "Columbus, OH" into a real point for deadhead distance and map pins',
      degradedBehaviour: 'Falls back to the built-in state-centroid approximation',
    },
    {
      name: 'weather',
      enabled: true,
      free: true,
      requiresKey: false,
      source: 'Open-Meteo',
      purpose: 'Lane conditions: reefer temperature risk, wind, precipitation',
      degradedBehaviour: 'No weather shown; dispatch is unaffected',
    },
    {
      name: 'severe-alerts',
      enabled: true,
      free: true,
      requiresKey: false,
      source: 'weather.gov (NOAA/NWS)',
      purpose: 'Official US alerts on a lane: blizzards, flash floods, winter storms',
      degradedBehaviour: 'No alerts; the lane simply has no weather banner',
    },
    {
      name: 'vin-decode',
      enabled: true,
      free: true,
      requiresKey: false,
      source: 'NHTSA vPIC',
      purpose: 'Fill in a truck make, model, year and GVWR from the VIN',
      degradedBehaviour: 'The truck form stays manual',
    },
    {
      name: 'reverse-geocoding',
      enabled: true,
      free: true,
      requiresKey: false,
      source: 'OpenStreetMap Nominatim',
      purpose: 'Name a coordinate for geofences and driver location text',
      degradedBehaviour: 'Coordinates are shown without a place name',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Composite helpers for the API layer                                           */
/* -------------------------------------------------------------------------- */

export interface LoadWeatherReport {
  origin: WeatherSnapshot | null;
  destination: WeatherSnapshot | null;
  alerts: WeatherAlert[];
  summary: string;
  source: string;
}

/**
 * Everything a load needs in one call: conditions at both ends and any active
 * severe alerts at the destination, which is where a driver meets the problem.
 *
 * Every part is optional, so a partial report is a success with nulls rather
 * than an error.
 */
export async function weatherForLoad(
  integrations: Integrations,
  origin: GeoPoint,
  destination: GeoPoint,
): Promise<LoadWeatherReport> {
  const [lane, alerts] = await Promise.all([
    integrations.weather.alongLane(origin, destination),
    integrations.alerts.active(destination),
  ]);

  const originWeather = lane.data?.origin ?? null;
  const destinationWeather = lane.data?.destination ?? null;
  const activeAlerts = alerts.data ?? [];

  const summary =
    destinationWeather !== null
      ? laneSummary(activeAlerts, destinationWeather)
      : activeAlerts.length > 0
        ? `${activeAlerts[0]!.event} on this lane`
        : 'Weather unavailable';

  return {
    origin: originWeather,
    destination: destinationWeather,
    alerts: activeAlerts,
    summary,
    source: lane.source === 'open-meteo' || alerts.source === 'weather.gov' ? 'open-meteo+weather.gov' : 'none',
  };
}

/** Resolve a lane written as two strings and report its weather. */
export async function laneBrief(
  integrations: Integrations,
  from: string,
  to: string,
): Promise<IntegrationResult<{ from: GeocodeResult; to: GeocodeResult; weather: LoadWeatherReport }>> {
  const [a, b] = await Promise.all([
    integrations.geocoder.geocode(from),
    integrations.geocoder.geocode(to),
  ]);

  if (!a.data || !b.data) {
    return { ok: false, data: null, source: 'geocode', error: 'Could not resolve both ends of the lane' };
  }

  const weather = await weatherForLoad(integrations, a.data.point, b.data.point);
  return { ok: true, data: { from: a.data, to: b.data, weather }, source: 'geocode+weather' };
}

export { SOURCES };
export type { GeocodeResult, WeatherAlert, WeatherSnapshot, VinDetails, IntegrationResult };
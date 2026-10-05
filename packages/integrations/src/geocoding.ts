import type { GeoPoint } from '@truckdesk/shared';

import {
  HttpClient,
  RateLimiter,
  SOURCES,
  failed,
  normalizePoint,
  ok,
  type IntegrationResult,
} from './client.js';

/**
 * Geocoding.
 *
 * The dispatcher types "Columbus, OH" and TruckDesk needs a point for a deadhead
 * distance and a map pin. Two keyless sources are tried in order of accuracy:
 *
 *   1. **US Census geocoder** - public domain, calibrated for US street
 *      addresses, so it resolves a real facility address precisely.
 *   2. **Open-Meteo geocoding** - good at "City, ST" place names.
 *
 * Nominatim is exposed separately because its usage policy asks for a slow
 * request rate, so it is only used for reverse lookups.
 */

export interface GeocodeResult {
  point: GeoPoint;
  /** What the provider thought it matched. */
  displayName: string;
  /** 'address' is a real street address, 'place' is a city. */
  type: 'address' | 'place' | 'unknown';
  /** Roughness in metres, when the provider supplies it. */
  precisionMeters?: number;
  source: string;
}

interface CensusResponse {
  result?: {
    addressMatches?: Array<{
      matchedAddress: string;
      coordinates: { x: number; y: number };
    }>;
  };
  error?: string;
}

interface OpenMeteoGeocodeResponse {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country_code?: string;
    admin1?: string;
  }>;
}

export class Geocoder {
  private readonly client: HttpClient;
  private readonly nominatimLimiter = new RateLimiter(1100);

  constructor(client?: HttpClient) {
    this.client = client ?? new HttpClient({ ttlMs: 24 * 60 * 60_000 });
  }

  /** Turn free text into a point. Never throws. */
  async geocode(query: string): Promise<IntegrationResult<GeocodeResult>> {
    const text = query.trim();
    if (!text) return failed('geocode', 'Nothing to search for');

    // A coordinate pair needs no lookup at all.
    const coords = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(text);
    if (coords) {
      const point = normalizePoint(coords[1], coords[2]);
      if (point) {
        return ok({ point, displayName: text, type: 'address', source: 'literal' }, 'literal');
      }
    }

    const census = await this.viaCensus(text);
    if (census.ok && census.data) return census;

    const place = await this.viaOpenMeteo(text);
    if (place.ok && place.data) return place;

    return failed('geocode', 'No provider could resolve that location');
  }

  /** Street addresses resolve best in the Census geocoder. */
  private async viaCensus(query: string): Promise<IntegrationResult<GeocodeResult>> {
    const url = `${SOURCES.censusGeocoder}?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(query)}`;
    const payload = await this.client.getJson<CensusResponse>(url);

    const match = payload?.result?.addressMatches?.[0];
    if (!match) return failed('census', 'No address match');

    // Census returns { x: longitude, y: latitude }.
    const point = normalizePoint(match.coordinates.y, match.coordinates.x);
    if (!point) return failed('census', 'Coordinates out of range');

    return ok(
      { point, displayName: match.matchedAddress, type: 'address', source: 'census' },
      'census',
    );
  }

  /** "City, ST" resolves in the Open-Meteo place index. */
  private async viaOpenMeteo(query: string): Promise<IntegrationResult<GeocodeResult>> {
    const url = `${SOURCES.openMeteoGeocode}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const payload = await this.client.getJson<OpenMeteoGeocodeResponse>(url);

    const hit = payload?.results?.[0];
    if (!hit) return failed('open-meteo', 'No place match');

    const point = normalizePoint(hit.latitude, hit.longitude);
    if (!point) return failed('open-meteo', 'Coordinates out of range');

    const label = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ');

    return ok({ point, displayName: label, type: 'place', source: 'open-meteo' }, 'open-meteo');
  }

  /**
   * Turn a coordinate into a human label. Used to name a geofence or explain
   * where a driver actually is.
   *
   * Nominatim's policy allows one request per second, so this is rate limited
   * and cached; it is never called on a hot path.
   */
  async reverse(point: GeoPoint): Promise<IntegrationResult<{ label: string; source: string }>> {
    await this.nominatimLimiter.wait();

    const url =
      `${SOURCES.nominatimReverse}?format=json&zoom=10&lat=${point.lat}&lon=${point.lng}`;
    const payload = await this.client.getJson<{ display_name?: string }>(url);

    const label = payload?.display_name;
    if (!label) return failed('nominatim', 'No reverse geocode result');

    return ok({ label, source: 'nominatim' }, 'nominatim');
  }
}

/**
 * Distance between two free-text locations, used when a dispatcher asks
 * "how far is this really".
 */
export async function distanceBetween(
  geocoder: Geocoder,
  from: string,
  to: string,
): Promise<IntegrationResult<{ from: GeocodeResult; to: GeocodeResult; miles: number }>> {
  const [a, b] = await Promise.all([geocoder.geocode(from), geocoder.geocode(to)]);
  if (!a.data || !b.data) return failed('geocode', 'One of the locations could not be resolved');

  // Local import keeps the package boundary clean for consumers that only want
  // the weather integrations.
  const { haversineMiles } = await import('@truckdesk/shared');

  return ok(
    {
      from: a.data,
      to: b.data,
      miles: Math.round(haversineMiles(a.data.point, b.data.point) * 1.18),
    },
    'geocode',
  );
}
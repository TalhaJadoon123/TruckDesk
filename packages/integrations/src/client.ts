/**
 * Shared plumbing for the public-API integrations.
 *
 * Every integration in this package is:
 *   - keyless, so there is nothing to sign up for and nothing that can expire;
 *   - optional, so a carrier can run TruckDesk with no network at all;
 *   - cached, because a dispatch board can ask the same question 40 times in a
 *     row and these are all public endpoints we should not hammer.
 *
 * None of them are load-bearing. `dispatch` never blocks on a weather lookup.
 */

/** Every endpoint used here, with the licence or terms that matter. */
export const SOURCES = {
  /** Open-Meteo forecast. CC BY 4.0. No key. https://open-meteo.com */
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  /** Open-Meteo geocoding. CC BY 4.0. No key. */
  openMeteoGeocode: 'https://geocoding-api.open-meteo.com/v1/search',
  /** OSM Nominatim. ODbL, 1 request/second. No key. */
  nominatim: 'https://nominatim.openstreetmap.org/search',
  /** OpenStreetMap reverse geocode. ODbL. */
  nominatimReverse: 'https://nominatim.openstreetmap.org/reverse',
  /** US Census geocoder. Public domain. No key. */
  censusGeocoder: 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress',
  /** NHTSA vPIC VIN decode. Public domain. No key. */
  vpic: 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues',
  /** NWS/NOAA official US weather. Public domain. No key. */
  nwsPoints: 'https://api.weather.gov/points',
  nwsAlerts: 'https://api.weather.gov/alerts/active',
} as const;

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
  /** Cache lifetime. */
  ttlMs?: number;
  /** Overall request timeout. */
  timeoutMs?: number;
  /** Identifies the caller, as OSM's usage policy requires. */
  userAgent?: string;
  now?: () => number;
}

/**
 * A small TTL cache plus a deadline-aware fetch.
 *
 * `AbortSignal.timeout` exists on Node 18+ but not in every runtime this could
 * run in, so the timeout is implemented with an explicit controller.
 */
export class HttpClient {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly now: () => number;

  constructor(options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.userAgent = options.userAgent ?? 'TruckDesk/1.0 (dispatch platform; +https://truckdesk.pages.dev)';
    this.now = options.now ?? (() => Date.now());
  }

  get cached(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * GET returning parsed JSON.
   *
   * A failure is reported, never thrown: an integration that cannot be reached
   * returns `null` and the caller decides whether that matters.
   */
  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value as T;
    }

    // Collapse concurrent identical requests so a board render does not fan out
    // twenty identical calls.
    const existing = this.inflight.get(url);
    if (existing) return (await existing) as T;

    const request = this.perform<T>(url, headers);
    this.inflight.set(url, request as Promise<unknown>);

    try {
      const value = await request;
      if (value !== null) {
        this.cache.set(url, { value, expiresAt: this.now() + this.ttlMs });
      }
      return value;
    } finally {
      this.inflight.delete(url);
    }
  }

  private async perform<T>(url: string, headers: Record<string, string>): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      // Offline, DNS failure, timeout, malformed JSON: all the same to a caller.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface IntegrationResult<T> {
  ok: boolean;
  data: T | null;
  source: string;
  /** Set when `ok` is false. */
  error?: string;
  /** True when the answer came from the cache rather than the network. */
  cached?: boolean;
}

export function ok<T>(data: T, source: string): IntegrationResult<T> {
  return { ok: true, data, source };
}

export function failed<T>(source: string, error: string): IntegrationResult<T> {
  return { ok: false, data: null, source, error };
}

/** Clamp a latitude/longitude pair, returning null when it is not usable. */
export function normalizePoint(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const latitude = typeof lat === 'number' ? lat : Number.parseFloat(String(lat));
  const longitude = typeof lng === 'number' ? lng : Number.parseFloat(String(lng));

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  return { lat: Math.round(latitude * 1e5) / 1e5, lng: Math.round(longitude * 1e5) / 1e5 };
}

/**
 * Nominatim's usage policy caps a client at one request per second and
 * requires an identifying User-Agent. This serialises requests to one per
 * `minIntervalMs` rather than relying on the cache to stay polite.
 */
export class RateLimiter {
  private last = 0;

  constructor(private readonly minIntervalMs = 1100) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.last = Date.now();
  }
}
import { describe, expect, it, vi } from 'vitest';

import {
  AlertService,
  Geocoder,
  HttpClient,
  RateLimiter,
  SOURCES,
  VinDecoder,
  WeatherService,
  capabilityCatalog,
  createIntegrations,
  describeWeather,
  isValidVinFormat,
  kmhToMph,
  laneSummary,
  normalizePoint,
  toFahrenheit,
} from '@truckdesk/integrations';


/**
 * Public API integrations.
 *
 * Every transport is stubbed. These tests assert the parts that actually break
 * in production: unit conversion, vendor payload shapes, the fallback chain, and
 * the rule that a failed lookup returns null instead of throwing.
 */

function stubFetch(handler: (url: string) => { ok?: boolean; status?: number; body: unknown }) {
  const seen: string[] = [];

  const impl = vi.fn(async (url: string) => {
    seen.push(url);
    const result = handler(url);
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
    };
  });

  return { impl: impl as unknown as typeof fetch, seen };
}

const COLUMBUS = { lat: 39.9612, lng: -82.9988 };
const PITTSBURGH = { lat: 40.4406, lng: -79.9959 };

/* -------------------------------------------------------------------------- */
/* Units and helpers                                                             */
/* -------------------------------------------------------------------------- */

describe('helpers', () => {
  it('converts Celsius to Fahrenheit', () => {
    expect(toFahrenheit(0)).toBe(32);
    expect(toFahrenheit(100)).toBe(212);
    expect(toFahrenheit(37)).toBe(99);
    expect(toFahrenheit(null)).toBeNull();
    expect(toFahrenheit(Number.NaN)).toBeNull();
  });

  it('converts km/h to mph', () => {
    // Rounded to one decimal for a truck-speed readout.
    expect(kmhToMph(100)).toBe(62.1);
    expect(kmhToMph(0)).toBe(0);
    expect(kmhToMph(Number.NaN)).toBeNull();
    expect(kmhToMph(null)).toBeNull();
  });

  it('rejects impossible coordinates', () => {
    expect(normalizePoint(39.96, -83)).toEqual({ lat: 39.96, lng: -83 });
    expect(normalizePoint(91, 0)).toBeNull();
    expect(normalizePoint(0, 181)).toBeNull();
    expect(normalizePoint('abc', 0)).toBeNull();
    expect(normalizePoint(Number.NaN, 0)).toBeNull();
  });

  it('translates weather codes', () => {
    expect(describeWeather(0)).toBe('Clear');
    expect(describeWeather(95)).toBe('Thunderstorm');
    expect(describeWeather(null)).toBe('Unknown');
    expect(describeWeather(9999)).toContain('9999');
  });

  it('validates VIN format the way the DMV does', () => {
    expect(isValidVinFormat('1FUJBHHB5LLBE1234')).toBe(true);
    // I, O and Q are never used in a VIN.
    expect(isValidVinFormat('1FUJBHHB5ILBE1234')).toBe(false);
    expect(isValidVinFormat('1FUJBHHB5OLBE1234')).toBe(false);
    expect(isValidVinFormat('SHORT')).toBe(false);
  });

  it('rate limits to a minimum interval', async () => {
    const limiter = new RateLimiter(50);
    const started = Date.now();
    await limiter.wait();
    await limiter.wait();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('advertises only free, keyless sources', () => {
    for (const capability of capabilityCatalog()) {
      expect(capability.free).toBe(true);
      expect(capability.requiresKey).toBe(false);
      expect(capability.source).not.toMatch(/key|token|secret/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP client                                                                   */
/* -------------------------------------------------------------------------- */

describe('HttpClient', () => {
  it('caches a response instead of refetching', async () => {
    const stub = stubFetch(() => ({ body: { value: 1 } }));
    const client = new HttpClient({ fetchImpl: stub.impl, ttlMs: 60_000 });

    await client.getJson('https://example.test/a');
    await client.getJson('https://example.test/a');
    await client.getJson('https://example.test/a');

    expect(stub.seen).toHaveLength(1);
  });

  it('returns null on an HTTP error rather than throwing', async () => {
    const stub = stubFetch(() => ({ ok: false, status: 503, body: {} }));
    const client = new HttpClient({ fetchImpl: stub.impl });

    expect(await client.getJson('https://example.test/fail')).toBeNull();
  });

  it('returns null when the transport throws', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new HttpClient({ fetchImpl: impl as unknown as typeof fetch });
    expect(await client.getJson('https://example.test/dead')).toBeNull();
  });

  it('does not cache a failure', async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      return calls === 1 ? { ok: false, status: 500, body: {} } : { body: { ok: true } };
    });
    const client = new HttpClient({ fetchImpl: stub.impl, ttlMs: 60_000 });

    expect(await client.getJson('https://example.test/flaky')).toBeNull();
    expect(await client.getJson('https://example.test/flaky')).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Geocoding                                                                     */
/* -------------------------------------------------------------------------- */

describe('Geocoder', () => {
  it('passes a literal coordinate straight through', async () => {
    const geocoder = new Geocoder(new HttpClient({ fetchImpl: (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch }));

    const result = await geocoder.geocode('39.9612,-82.9988');
    expect(result.ok).toBe(true);
    expect(result.data?.point).toEqual({ lat: 39.9612, lng: -82.9988 });
    expect(result.data?.source).toBe('literal');
  });

  it('prefers the Census geocoder for a street address', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('census')) {
        return {
          body: {
            result: {
              addressMatches: [
                { matchedAddress: '1 Freight Way, Columbus, OH', coordinates: { x: -82.9988, y: 39.9612 } },
              ],
            },
          },
        };
      }
      return { body: { results: [] } };
    });

    const result = await new Geocoder(new HttpClient({ fetchImpl: stub.impl })).geocode(
      '1 Freight Way, Columbus, OH',
    );

    expect(result.ok).toBe(true);
    expect(result.data?.source).toBe('census');
    expect(result.data?.point.lat).toBeCloseTo(39.9612, 3);
    // Census returns x as longitude, which must not be swapped.
    expect(result.data?.point.lng).toBeCloseTo(-82.9988, 3);
    expect(result.data?.type).toBe('address');
  });

  it('falls back to Open-Meteo for a city name', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('census')) return { body: {} };
      return {
        body: {
          results: [
            {
              name: 'Columbus', latitude: 39.9612, longitude: -82.9988,
              admin1: 'Ohio', country_code: 'US',
            },
          ],
        },
      };
    });

    const result = await new Geocoder(new HttpClient({ fetchImpl: stub.impl })).geocode('Columbus, OH');

    expect(result.ok).toBe(true);
    expect(result.data?.source).toBe('open-meteo');
    expect(result.data?.type).toBe('place');
    expect(result.data?.displayName).toContain('Columbus');
  });

  it('reports failure when neither provider answers', async () => {
    const stub = stubFetch(() => ({ body: {} }));
    const result = await new Geocoder(new HttpClient({ fetchImpl: stub.impl })).geocode('Nowhere, ZZ');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/resolve/i);
  });

  it('rejects empty input without calling out', async () => {
    const stub = stubFetch(() => ({ body: {} }));
    const result = await new Geocoder(new HttpClient({ fetchImpl: stub.impl })).geocode('   ');
    expect(result.ok).toBe(false);
    expect(stub.seen).toHaveLength(0);
  });

  it('never points a public-API lookup at an arbitrary host', () => {
    // Every endpoint is hard-coded. If this ever fails, an SSRF crept in.
    const hosts = Object.values(SOURCES).map((url) => new URL(url).host);
    for (const host of hosts) {
      expect([
        'api.open-meteo.com',
        'geocoding-api.open-meteo.com',
        'nominatim.openstreetmap.org',
        'geocoding.geo.census.gov',
        'vpic.nhtsa.dot.gov',
        'api.weather.gov',
      ]).toContain(host);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Weather                                                                       */
/* -------------------------------------------------------------------------- */

describe('WeatherService', () => {
  const payload = {
    current: {
      time: '2026-03-16T14:00',
      temperature_2m: 21.5,
      apparent_temperature: 19.8,
      relative_humidity_2m: 63,
      precipitation: 0,
      wind_speed_10m: 24,
      wind_direction_10m: 220,
      weather_code: 3,
    },
  };

  it('reads current conditions', async () => {
    const stub = stubFetch(() => ({ body: payload }));
    const result = await new WeatherService(new HttpClient({ fetchImpl: stub.impl })).current(COLUMBUS);

    expect(result.ok).toBe(true);
    expect(result.data?.temperatureC).toBe(21.5);
    expect(result.data?.description).toBe('Overcast');
    expect(toFahrenheit(result.data?.temperatureC ?? null)).toBe(71);
    expect(kmhToMph(result.data?.windKmh ?? null)).toBe(14.9);
  });

  it('rejects invalid coordinates without calling out', async () => {
    const stub = stubFetch(() => ({ body: payload }));
    const result = await new WeatherService(new HttpClient({ fetchImpl: stub.impl })).current({
      lat: 200, lng: 400,
    });
    expect(result.ok).toBe(false);
    expect(stub.seen).toHaveLength(0);
  });

  it('samples a lane at origin, midpoint and destination', async () => {
    const stub = stubFetch(() => ({ body: payload }));
    const result = await new WeatherService(new HttpClient({ fetchImpl: stub.impl })).alongLane(
      COLUMBUS,
      PITTSBURGH,
    );

    expect(result.ok).toBe(true);
    expect(stub.seen).toHaveLength(3);

    // The midpoint must sit between the two ends.
    const midpointUrl = stub.seen[1] ?? '';
    const lat = Number.parseFloat(/latitude=([-\d.]+)/.exec(midpointUrl)?.[1] ?? 'NaN');
    expect(lat).toBeGreaterThan(Math.min(COLUMBUS.lat, PITTSBURGH.lat));
    expect(lat).toBeLessThan(Math.max(COLUMBUS.lat, PITTSBURGH.lat));
  });

  it('reports the lane even when the midpoint fails', async () => {
    let call = 0;
    const stub = stubFetch(() => {
      call += 1;
      return call === 2 ? { ok: false, status: 500, body: {} } : { body: payload };
    });

    const result = await new WeatherService(new HttpClient({ fetchImpl: stub.impl })).alongLane(
      COLUMBUS,
      PITTSBURGH,
    );

    expect(result.ok).toBe(true);
    // The midpoint degrades to the origin reading rather than failing the lane.
    expect(result.data?.midpoint).toBeDefined();
  });

  it('does not promise a lane it cannot measure', async () => {
    const stub = stubFetch(() => ({ ok: false, status: 503, body: {} }));
    const result = await new WeatherService(new HttpClient({ fetchImpl: stub.impl })).alongLane(
      COLUMBUS,
      PITTSBURGH,
    );
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Alerts                                                                        */
/* -------------------------------------------------------------------------- */

describe('AlertService', () => {
  const gridPayload = {
    properties: {
      forecastZone: 'https://api.weather.gov/zones/forecast/OHZ072',
      forecast: 'https://api.weather.gov/gridpoints/OHF/31,47/forecast',
    },
  };

  it('returns an empty list when there are no alerts', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/points/')) return { body: gridPayload };
      if (url.includes('/gridpoints/')) {
        return { body: { properties: { gridId: 'OHF', gridX: 31, gridY: 47 } } };
      }
      return { body: { features: [] } };
    });

    const result = await new AlertService(new HttpClient({ fetchImpl: stub.impl })).active(COLUMBUS);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('parses and severity-sorts an active alert', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/points/')) return { body: gridPayload };
      if (url.includes('/gridpoints/')) {
        return { body: { properties: { gridId: 'OHF', gridX: 31, gridY: 47 } } };
      }
      return {
        body: {
          features: [
            {
              id: 'minor',
              properties: {
                id: 'https://alerts/1', event: 'Dense Fog', severity: 'Minor',
                urgency: 'Normal', certainty: 'Likely',
                effective: '2026-03-16T12:00:00Z', expires: '2026-03-16T18:00:00Z',
                headline: 'Dense Fog Advisory', description: 'Visibility under a mile.',
                senderName: 'NWS Columbus OH',
              },
            },
            {
              id: 'severe',
              properties: {
                id: 'https://alerts/2', event: 'Winter Storm Warning', severity: 'Severe',
                urgency: 'Expected', certainty: 'Observed',
                effective: '2026-03-16T10:00:00Z', ends: '2026-03-17T06:00:00Z',
                headline: 'Winter Storm Warning', description: 'Heavy snow expected.',
                instruction: 'Delay travel if possible.',
                senderName: 'NWS Columbus OH',
              },
            },
          ],
        },
      };
    });

    const result = await new AlertService(new HttpClient({ fetchImpl: stub.impl })).active(COLUMBUS);

    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(2);
    // The severe one must come first without the UI sorting.
    expect(result.data?.[0]?.event).toBe('Winter Storm Warning');
    expect(result.data?.[0]?.severity).toBe('Severe');
    expect(result.data?.[0]?.instruction).toContain('Delay travel');
    expect(result.data?.[0]?.endsAt).toContain('2026-03-17');
  });

  it('maps an unknown severity rather than dropping the alert', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/points/')) return { body: gridPayload };
      if (url.includes('/gridpoints/')) {
        return { body: { properties: { gridId: 'OHF', gridX: 31, gridY: 47 } } };
      }
      return {
        body: {
          features: [{ properties: { event: 'Something', severity: 'who knows', description: 'x' } }],
        },
      };
    });

    const result = await new AlertService(new HttpClient({ fetchImpl: stub.impl })).active(COLUMBUS);
    expect(result.data?.[0]?.severity).toBe('Unknown');
  });

  it('reports a point outside the US rather than pretending there are no alerts', async () => {
    const stub = stubFetch(() => ({ body: {} }));
    const result = await new AlertService(new HttpClient({ fetchImpl: stub.impl })).active({
      lat: 51.5, lng: -0.12,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the US/i);
  });
});

/* -------------------------------------------------------------------------- */
/* VIN                                                                           */
/* -------------------------------------------------------------------------- */

describe('VinDecoder', () => {
  const payload = {
    Results: [
      {
        VIN: '1FUJBHHB5LLBE1234',
        Make: 'FREIGHTLINER',
        Model: 'Cascadia',
        ModelYear: '2021',
        TrimLevel: '126',
        BodyClass: 'Truck Tractor',
        DriveType: '6x2',
        EngineDisplacement: '12.9',
        EngineCylinders: '6',
        PlantCountry: 'US',
        PlantState: 'Texas',
        GVWR: '20000',
      },
    ],
  };

  it('decodes a valid VIN', async () => {
    const stub = stubFetch(() => ({ body: payload }));
    const result = await new VinDecoder(new HttpClient({ fetchImpl: stub.impl })).decode(
      '1FUJBHhb5llbe1234',
    );

    expect(result.ok).toBe(true);
    expect(result.data?.year).toBe(2021);
    expect(result.data?.make).toBe('FREIGHTLINER');
    expect(result.data?.description).toBe('2021 FREIGHTLINER Cascadia 126');
    // 20,000 kg is about 44,000 lbs.
    expect(result.data?.grossVehicleWeightLbs).toBe(44_092);
  });

  it('rejects a malformed VIN before touching the network', async () => {
    const stub = stubFetch(() => ({ body: payload }));
    const result = await new VinDecoder(new HttpClient({ fetchImpl: stub.impl })).decode('NOT-A-VIN');
    expect(result.ok).toBe(false);
    expect(stub.seen).toHaveLength(0);
  });

  it('surfaces a vPIC error code as a readable message', async () => {
    const stub = stubFetch(() => ({
      body: { Results: [{ VIN: 'x', ErrorCode: '14', ErrorText: 'Invalid VIN characters' }] },
    }));
    const result = await new VinDecoder(new HttpClient({ fetchImpl: stub.impl })).decode(
      '1FUJBH1HB5LLBE123',
    );
    // A vPIC error code is a failure, and its message must reach the caller.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid VIN/i);
  });

  it('does not convert a GVWR that is already pounds', async () => {
    const stub = stubFetch(() => ({
      // Above 36,300 kg-equivalent, so already pounds and passed through.
      body: { Results: [{ VIN: 'x', GVWR: '45000', Make: 'X', Model: 'Y', ModelYear: '2020' }] },
    }));
    const result = await new VinDecoder(new HttpClient({ fetchImpl: stub.impl })).decode(
      '1FUJBH1HB5LLBE123',
    );
    expect(result.data?.grossVehicleWeightLbs).toBe(45_000);
  });

  it('maps a decode straight onto truck form fields', async () => {
    const stub = stubFetch(() => ({ body: payload }));
    const fields = await new VinDecoder(new HttpClient({ fetchImpl: stub.impl })).toTruckFields(
      '1FUJBH1HB5LLBE123',
    );

    expect(fields.ok).toBe(true);
    expect(fields.data?.year).toBe(2021);
    expect(fields.data?.maxWeightLbs).toBeGreaterThan(40_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Composition                                                                   */
/* -------------------------------------------------------------------------- */

describe('createIntegrations', () => {
  it('wires every service against one shared cache', async () => {
    const integrations = createIntegrations({
      fetchImpl: stubFetch(() => ({ body: { results: [] } })).impl,
    });

    expect(integrations.geocoder).toBeDefined();
    expect(integrations.weather).toBeDefined();
    expect(integrations.alerts).toBeDefined();
    expect(integrations.vin).toBeDefined();
  });
});

describe('laneSummary', () => {
  const snapshot = {
    point: COLUMBUS,
    temperatureC: 20,
    apparentTemperatureC: 20,
    humidityPct: 50,
    precipitationMm: 0,
    windKmh: 10,
    windDirectionDeg: 0,
    weatherCode: 0,
    description: 'Clear',
    at: '',
    source: 'test',
  };

  it('stays quiet when nothing is wrong', () => {
    expect(laneSummary([], { ...snapshot, temperatureC: 21 })).toBe('No weather concerns on this lane');
  });

  it('flags reefer-critical heat', () => {
    expect(laneSummary([], { ...snapshot, temperatureC: 37 })).toMatch(/reefer/i);
  });

  it('flags freeze risk', () => {
    expect(laneSummary([], { ...snapshot, temperatureC: -5 })).toMatch(/freeze/i);
  });

  it('leads with a severe alert', () => {
    const alerts = [
      {
        id: '1', event: 'Tornado Warning', severity: 'Extreme' as const,
        urgency: 'Immediate', certainty: 'Observed', startsAt: '', endsAt: null,
        headline: 'Tornado Warning', description: '', instruction: null, sender: 'NWS',
      },
    ];
    expect(laneSummary(alerts, snapshot)).toMatch(/Tornado Warning/);
  });

  it('mentions strong wind and precipitation', () => {
    expect(laneSummary([], { ...snapshot, windKmh: 60 })).toMatch(/wind 37 mph/);
    expect(laneSummary([], { ...snapshot, precipitationMm: 8 })).toMatch(/precipitation/);
  });
});
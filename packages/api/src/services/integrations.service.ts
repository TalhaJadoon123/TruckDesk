import type { GeoPoint } from '@truckdesk/shared';

import {
  createIntegrations,
  type Integrations,
  type LoadWeatherReport,
} from '@truckdesk/integrations';

import type { Services } from './container.js';

/**
 * Service wrapper for the public-API integrations.
 *
 * The rule is that weather must never delay a dispatch. Every call here is
 * best-effort with a short timeout, and the API returns whatever it has. A
 * driver looking at a load sees a lane that may or may not have a weather note,
 * never a spinner that waits on weather.gov.
 */

export interface LaneBrief {
  from: string;
  to: string;
  originPoint: GeoPoint | null;
  destinationPoint: GeoPoint | null;
  weather: LoadWeatherReport;
  /** True when a real geocode was used rather than the local approximation. */
  geocoded: boolean;
}

export class IntegrationService {
  private readonly integrations: Integrations;

  constructor(services?: Services) {
    this.integrations = createIntegrations({
      // Eight seconds is already generous for a weather lookup; the UI shows a
      // placeholder meanwhile and never blocks on the result.
      timeoutMs: 8000,
      ttlMs: 20 * 60_000,
    });
    void services;
  }

  get clients(): Integrations {
    return this.integrations;
  }

  /**
   * Resolve a lane written as two strings and report its weather.
   *
   * Returns a partial result rather than an error whenever either end could be
   * placed: the coordinates come from the local geocoder as a fallback, so the
   * caller always gets something to map.
   */
  async lane(from: string, to: string): Promise<LaneBrief> {
    const [a, b] = await Promise.all([
      this.integrations.geocoder.geocode(from),
      this.integrations.geocoder.geocode(to),
    ]);

    const originPoint = a.data?.point ?? null;
    const destinationPoint = b.data?.point ?? null;

    let weather: LoadWeatherReport = {
      origin: null,
      destination: null,
      alerts: [],
      summary: 'Weather unavailable',
      source: 'none',
    };

    if (originPoint && destinationPoint) {
      const { weatherForLoad } = await import('@truckdesk/integrations');
      weather = await weatherForLoad(this.integrations, originPoint, destinationPoint);
    }

    return {
      from,
      to,
      originPoint,
      destinationPoint,
      weather,
      geocoded: a.ok && b.ok,
    };
  }

  /** Weather only, for a load whose stops already carry coordinates. */
  async loadWeather(origin: GeoPoint, destination: GeoPoint): Promise<LoadWeatherReport> {
    const { weatherForLoad } = await import('@truckdesk/integrations');
    return weatherForLoad(this.integrations, origin, destination);
  }

  /** VIN lookup for the truck form. */
  async decodeVin(vin: string): Promise<Awaited<ReturnType<Integrations['vin']['toTruckFields']>>> {
    return this.integrations.vin.toTruckFields(vin);
  }

  /** Geocode a single free-text location. */
  async geocode(query: string): Promise<Awaited<ReturnType<Integrations['geocoder']['geocode']>>> {
    return this.integrations.geocoder.geocode(query);
  }

  /** Active NWS severe alerts at a point. */
  async alerts(point: GeoPoint) {
    return this.integrations.alerts.active(point);
  }

  /** What is wired, for `/capabilities`. */
  catalog() {
    const { capabilityCatalog } = require('@truckdesk/integrations');
    return capabilityCatalog();
  }
}

export { createIntegrations };
export type { Integrations };
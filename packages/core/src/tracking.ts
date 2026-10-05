import {
  Errors,
  boundingBox,
  haversineMiles,
  estimateRoadMiles,
  positionAtTime,
  type BoundingBox,
  type DomainEvent,
  type GeoPoint,
  type Iso,
  type Load,
  type Result,
  type Truck,
  err,
  ok,
  uuid,
} from '@truckdesk/shared';

/**
 * Tracking engine.
 *
 * GPS ingestion, breadcrumb storage, ETA and geo-fence evaluation. The engine
 * itself is storage-agnostic: `TrackingStore` is a port, and `packages/api`
 * supplies a Supabase-Realtime-backed implementation plus an in-memory one used
 * by tests and by the Cloudflare Worker.
 */

export interface GpsPing {
  id: string;
  truckId: string;
  location: GeoPoint;
  at: Iso;
  /** Metres. ELD/telematics units vary; normalise on ingest. */
  accuracyM?: number;
  headingDeg?: number;
  speedMph?: number;
  /** "gps" | "eld" | "phone" | "manual" */
  source?: string;
  /** True when uploaded after a connectivity gap. */
  offline?: boolean;
}

export interface TrackingStore {
  append(pings: readonly GpsPing[]): Promise<void>;
  pingsForTruck(truckId: string, since?: Iso, until?: Iso): Promise<GpsPing[]>;
  latestForTrucks(truckIds: readonly string[]): Promise<GpsPing[]>;
  prune(before: Iso): Promise<number>;
}

/** In-memory store: tests, local dev, and the Worker's KV-less mode. */
export class MemoryTrackingStore implements TrackingStore {
  private readonly pings: GpsPing[] = [];

  async append(newPings: readonly GpsPing[]): Promise<void> {
    // Idempotent on replay: an offline queue re-sending the same ping must not
    // duplicate. Ids are device-generated, so this is a safe dedupe key.
    const seen = new Set(this.pings.map((ping) => ping.id));
    for (const ping of newPings) {
      if (!seen.has(ping.id)) {
        this.pings.push(ping);
        seen.add(ping.id);
      }
    }
    this.pings.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  async pingsForTruck(truckId: string, since?: Iso, until?: Iso): Promise<GpsPing[]> {
    return this.pings.filter((ping) => {
      if (ping.truckId !== truckId) return false;
      const at = Date.parse(ping.at);
      if (since && at < Date.parse(since)) return false;
      if (until && at > Date.parse(until)) return false;
      return true;
    });
  }

  async latestForTrucks(truckIds: readonly string[]): Promise<GpsPing[]> {
    const wanted = new Set(truckIds);
    const latest = new Map<string, GpsPing>();
    for (const ping of this.pings) {
      if (!wanted.has(ping.truckId)) continue;
      const current = latest.get(ping.truckId);
      if (!current || Date.parse(ping.at) >= Date.parse(current.at)) {
        latest.set(ping.truckId, ping);
      }
    }
    return [...latest.values()];
  }

  async prune(before: Iso): Promise<number> {
    const cutoff = Date.parse(before);
    const beforeCount = this.pings.length;
    const kept = this.pings.filter((ping) => Date.parse(ping.at) >= cutoff);
    this.pings.length = 0;
    this.pings.push(...kept);
    return beforeCount - kept.length;
  }
}

/* -------------------------------------------------------------------------- */
/* Geo-fencing                                                                  */
/* -------------------------------------------------------------------------- */

export interface GeoFence {
  id: string;
  companyId?: string;
  name: string;
  /** Circle fence. */
  center: GeoPoint;
  radiusMiles: number;
  loadId?: string;
  stopId?: string;
  /** What to do when a truck crosses the boundary. */
  trigger: 'arrival' | 'departure' | 'both';
  notifyDriver?: boolean;
  notifyDispatcher?: boolean;
}

export interface FenceEvent {
  id: string;
  fenceId: string;
  truckId: string;
  loadId?: string;
  type: 'arrival' | 'departure';
  at: Iso;
  location: GeoPoint;
  distanceFromCenterMiles: number;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Tracking results                                                             */
/* -------------------------------------------------------------------------- */

export interface TruckPosition {
  truckId: string;
  unit: string;
  status: Truck['status'];
  location: GeoPoint;
  at: Iso;
  headingDeg?: number;
  speedMph?: number;
  /** Minutes since the last ping. >15 means stale. */
  staleMinutes: number;
  isStale: boolean;
  loadId?: string;
}

export interface LoadProgress {
  loadId: string;
  truckId?: string;
  status: Load['status'];
  origin: GeoPoint | null;
  destination: GeoPoint | null;
  current: GeoPoint | null;
  totalMiles: number;
  milesCompleted: number;
  milesRemaining: number;
  percentComplete: number;
  etaIso: string | null;
  etaConfidence: 'high' | 'medium' | 'low' | 'unknown';
  lastPingAt: Iso | null;
  offRouteMiles: number;
  currentSpeedMph: number;
  breadcrumb: Array<{ location: GeoPoint; at: Iso }>;
}

export interface TrackSnapshot {
  positions: TruckPosition[];
  loads: LoadProgress[];
  bounds: BoundingBox | null;
  generatedAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

/** Below this speed a truck is treated as stopped, whatever the ELD reports. */
export const MOVING_SPEED_MPH = 3;
/** A ping older than this renders as "stale" on the map. */
export const STALE_AFTER_MINUTES = 15;
/** Below this, the ETA is noise and is reported as unknown. */
export const MIN_ETA_CONFIDENCE_SPEED_MPH = 8;
/** A ping that claims a >120mph jump is a bad fix, not a helicopter. */
export const IMPLAUSIBLE_SPEED_MPH = 120;

/** Fleet average including fuel, driver time and maintenance, for ETAs. */
export const ETA_AVERAGE_SPEED_MPH = 47;
/** Hours added at each stop for gate, paperwork and the walk-around. */
export const ETA_STOP_HOURS = 0.75;

/* -------------------------------------------------------------------------- */
/* Engine                                                                       */
/* -------------------------------------------------------------------------- */

export interface IngestInput {
  truckId: string;
  location: GeoPoint;
  at?: Iso;
  accuracyM?: number;
  headingDeg?: number;
  speedMph?: number;
  source?: string;
  offline?: boolean;
  /** Device-generated id. Replaying an offline queue re-sends the same id. */
  id?: string;
}

export class TrackingEngine {
  private readonly store: TrackingStore;
  private readonly fences: Map<string, GeoFence> = new Map();
  private readonly events: DomainEvent[] = [];

  constructor(store: TrackingStore) {
    this.store = store;
  }

  registerFence(fence: GeoFence): void {
    this.fences.set(fence.id, fence);
  }

  removeFence(fenceId: string): void {
    this.fences.delete(fenceId);
  }

  listFences(companyId?: string): GeoFence[] {
    const all = [...this.fences.values()];
    return companyId ? all.filter((fence) => fence.companyId === companyId) : all;
  }

  /** Drop a ping that is physically impossible rather than corrupt a trail. */
  static isPlausible(ping: GpsPing, previous?: GpsPing): boolean {
    if (!previous) return true;

    const dtHours = (Date.parse(ping.at) - Date.parse(previous.at)) / 3_600_000;
    if (dtHours <= 0) return false;

    const miles = estimateRoadMiles(previous.location, ping.location);
    const mph = miles / dtHours;
    if (mph > IMPLAUSIBLE_SPEED_MPH) return false;

    // More than 5 degrees of movement in under two seconds is a GPS jump.
    const seconds = dtHours * 3600;
    if (seconds < 2 && miles > 0.6) return false;

    return true;
  }

  /**
   * Accept a position report. Returns the stored ping plus any fence crossings
   * it triggered. Rejects out-of-order and implausible pings.
   */
  async ingest(input: IngestInput): Promise<Result<{ ping: GpsPing; fenceEvents: FenceEvent[] }>> {
    const at = input.at ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(at))) {
      return err(Errors.invalidInput('Ping timestamp is not a valid date'));
    }
    if (!Number.isFinite(input.location?.lat) || !Number.isFinite(input.location?.lng)) {
      return err(Errors.invalidInput('Ping location is not a valid coordinate'));
    }
    if (Math.abs(input.location.lat) > 90 || Math.abs(input.location.lng) > 180) {
      return err(Errors.invalidInput('Ping location is outside valid bounds'));
    }

    const history = await this.store.pingsForTruck(input.truckId);
    const previous = history[history.length - 1];

    if (previous && !TrackingEngine.isPlausible({ ...input, at } as GpsPing, previous)) {
      return err(
        Errors.invalidInput('Ping rejected: implies an implausible speed', {
          previousPingAt: previous.at,
          submittedAt: at,
        }),
      );
    }

    const ping: GpsPing = {
      id: input.id ?? uuid(),
      truckId: input.truckId,
      location: {
        lat: Math.round(input.location.lat * 1e5) / 1e5,
        lng: Math.round(input.location.lng * 1e5) / 1e5,
      },
      at,
      accuracyM: input.accuracyM,
      headingDeg: input.headingDeg,
      speedMph: input.speedMph,
      source: input.source ?? 'gps',
      offline: input.offline,
    };

    await this.store.append([ping]);

    const fenceEvents = this.evaluateFences(ping, previous);
    if (fenceEvents.length > 0) {
      this.events.push({
        id: uuid(),
        type: 'truck.ping',
        entityType: 'truck',
        entityId: ping.truckId,
        payload: { at: ping.at, fenceEvents },
        occurredAt: ping.at,
        offline: input.offline,
      });
    }

    return ok({ ping, fenceEvents });
  }

  /** Batch ingest for the offline queue flush. Stops at the first bad ping. */
  async ingestBatch(inputs: readonly IngestInput[]): Promise<
    Result<{ accepted: GpsPing[]; rejected: Array<{ input: IngestInput; reason: string }> }>
  > {
    const accepted: GpsPing[] = [];
    const rejected: Array<{ input: IngestInput; reason: string }> = [];

    for (const input of inputs) {
      const result = await this.ingest(input);
      if (result.ok) accepted.push(result.value.ping);
      else rejected.push({ input, reason: result.error.message });
    }

    if (rejected.length > 0 && accepted.length === 0) {
      return err(
        Errors.invalidInput('No pings accepted', { rejected: rejected.slice(0, 5) }),
      );
    }
    return ok({ accepted, rejected });
  }

  private evaluateFences(ping: GpsPing, previous?: GpsPing): FenceEvent[] {
    const events: FenceEvent[] = [];
    const inside = (point: GeoPoint, fence: GeoFence) =>
      haversineMiles(point, fence.center) <= fence.radiusMiles;

    for (const fence of this.fences.values()) {
      if (fence.loadId && !this.pingBelongsToFenceLoad(ping.truckId, fence)) continue;

      const now = inside(ping.location, fence);
      const before = previous ? inside(previous.location, fence) : false;

      if (now && !before && (fence.trigger === 'arrival' || fence.trigger === 'both')) {
        events.push(this.makeFenceEvent(fence, ping, 'arrival'));
      } else if (!now && before && (fence.trigger === 'departure' || fence.trigger === 'both')) {
        events.push(this.makeFenceEvent(fence, ping, 'departure'));
      }
    }
    return events;
  }

  /** A load-scoped fence only fires for the truck actually carrying that load. */
  private pingBelongsToFenceLoad(truckId: string, fence: GeoFence): boolean {
    if (!fence.loadId) return true;
    return this.fenceTruckLookup.get(fence.loadId) === truckId;
  }

  /** Set by the caller so a load-scoped fence knows which truck to watch. */
  readonly fenceTruckLookup: Map<string, string> = new Map();

  private makeFenceEvent(fence: GeoFence, ping: GpsPing, type: FenceEvent['type']): FenceEvent {
    const distance = haversineMiles(ping.location, fence.center);
    const verb = type === 'arrival' ? 'Arrived at' : 'Departed';
    return {
      id: uuid(),
      fenceId: fence.id,
      truckId: ping.truckId,
      loadId: fence.loadId,
      type,
      at: ping.at,
      location: ping.location,
      distanceFromCenterMiles: Math.round(distance * 10) / 10,
      message: `${verb} ${fence.name} (${distance.toFixed(1)} mi from center)`,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async positions(trucks: readonly Truck[], now: Date = new Date()): Promise<TruckPosition[]> {
    const latest = await this.store.latestForTrucks(trucks.map((truck) => truck.id));
    const byTruck = new Map(latest.map((ping) => [ping.truckId, ping]));
    const nowMs = now.getTime();

    return trucks.map((truck) => {
      const ping = byTruck.get(truck.id);
      if (!ping) {
        return {
          truckId: truck.id,
          unit: truck.unit,
          status: truck.status,
          location: truck.location,
          at: truck.lastKnownAt ?? new Date(nowMs).toISOString(),
          staleMinutes: 9999,
          isStale: true,
          loadId: truck.currentLoadId,
        };
      }

      const staleMinutes = Math.max(0, Math.round((nowMs - Date.parse(ping.at)) / 60_000));
      return {
        truckId: truck.id,
        unit: truck.unit,
        status: truck.status,
        location: ping.location,
        at: ping.at,
        headingDeg: ping.headingDeg,
        speedMph: ping.speedMph,
        staleMinutes,
        isStale: staleMinutes > STALE_AFTER_MINUTES,
        loadId: truck.currentLoadId,
      };
    });
  }

  /**
   * Progress for one load. `milesCompleted` is measured along the breadcrumb
   * rather than assumed linear, because a truck that detoured 60 miles should
   * not appear further along.
   */
  async loadProgress(
    load: Load,
    truck: Truck | undefined,
    now: Date = new Date(),
  ): Promise<LoadProgress> {
    const origin = stopPoint(load, 'pickup');
    const destination = stopPoint(load, 'delivery');
    const pings = truck ? await this.store.pingsForTruck(truck.id) : [];
    const current = pings.length > 0 ? pings[pings.length - 1]?.location ?? null : (truck?.location ?? null);

    const totalMiles = load.miles;
    const direct = origin && destination ? estimateRoadMiles(origin, destination) : totalMiles;
    const legMiles = direct > 0 ? direct : totalMiles;

    let milesCompleted = 0;
    if (origin && current) {
      const travelled = estimateRoadMiles(origin, current);
      milesCompleted = Math.min(travelled, legMiles);
    }

    const milesRemaining = Math.max(0, legMiles - milesCompleted);
    const percentComplete = legMiles > 0 ? Math.min(1, milesCompleted / legMiles) : 0;

    const speedMph = currentSpeed(pings);
    const remainingStops = remainingStopCount(load, milesCompleted, legMiles);

    let etaIso: string | null = null;
    let etaConfidence: LoadProgress['etaConfidence'] = 'unknown';

    if (destination && speedMph >= MIN_ETA_CONFIDENCE_SPEED_MPH && milesRemaining > 0) {
      const hours = milesRemaining / speedMph + remainingStops * ETA_STOP_HOURS;
      etaIso = new Date(now.getTime() + hours * 3_600_000).toISOString();
      etaConfidence = speedMph > 40 ? 'high' : 'medium';
    } else if (destination && milesRemaining === 0) {
      etaIso = now.toISOString();
      etaConfidence = 'high';
    } else if (destination && load.deliveryDate) {
      // Falling back to the promise date is better than showing nothing.
      etaIso = load.deliveryDate;
      etaConfidence = 'low';
    }

    const offRouteMiles = offRouteDistance(origin, destination, current);

    return {
      loadId: load.id,
      truckId: truck?.id ?? load.assignedTruckId,
      status: load.status,
      origin,
      destination,
      current,
      totalMiles,
      milesCompleted: Math.round(milesCompleted),
      milesRemaining: Math.round(milesRemaining),
      percentComplete: round4(percentComplete),
      etaIso,
      etaConfidence,
      lastPingAt: pings.length > 0 ? (pings[pings.length - 1]?.at ?? null) : null,
      offRouteMiles: Math.round(offRouteMiles),
      currentSpeedMph: round1(speedMph),
      breadcrumb: pings.slice(-500).map((ping) => ({ location: ping.location, at: ping.at })),
    };
  }

  async snapshot(
    trucks: readonly Truck[],
    loads: readonly Load[],
    now: Date = new Date(),
  ): Promise<TrackSnapshot> {
    const positions = await this.positions(trucks, now);

    const progresses: LoadProgress[] = [];
    for (const load of loads) {
      if (load.status === 'booked' || load.status === 'paid') continue;
      const truck = trucks.find((candidate) => candidate.id === load.assignedTruckId);
      progresses.push(await this.loadProgress(load, truck, now));
    }

    const points: GeoPoint[] = [
      ...positions.map((position) => position.location),
      ...progresses.flatMap((progress) =>
        [progress.origin, progress.destination, progress.current].filter(
          (point): point is GeoPoint => point !== null,
        ),
      ),
    ];

    return {
      positions,
      loads: progresses,
      bounds: boundingBox(points),
      generatedAt: now.toISOString(),
    };
  }

  /** Where was the truck at time `at`? Used by the driver's breadcrumb replay. */
  async positionAt(truckId: string, at: Iso): Promise<GeoPoint | null> {
    const pings = await this.store.pingsForTruck(truckId);
    return positionAtTime(
      pings.map((ping) => ({ location: ping.location, at: ping.at })),
      at,
    );
  }

  /** Simulate a completed trip so the demo dashboard is not static. */
  async seedSyntheticTrip(truck: Truck, load: Load, now: Date = new Date()): Promise<number> {
    const origin = stopPoint(load, 'pickup') ?? truck.location;
    const destination = stopPoint(load, 'delivery');
    if (!destination) return 0;

    const miles = Math.max(1, load.miles);
    const hours = miles / ETA_AVERAGE_SPEED_MPH;
    const steps = Math.min(60, Math.max(4, Math.round(hours)));
    const stepMs = (hours * 3_600_000) / steps;

    const pings: GpsPing[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const at = new Date(now.getTime() - (1 - t) * hours * 3_600_000);
      pings.push({
        id: uuid(),
        truckId: truck.id,
        location: lerpPoint(origin, destination, t),
        at: at.toISOString(),
        speedMph: ETA_AVERAGE_SPEED_MPH,
        headingDeg: bearingApprox(origin, destination),
        source: 'simulator',
      });
      void stepMs;
    }

    await this.store.append(pings);
    return pings.length;
  }

  drainEvents(): DomainEvent[] {
    const drained = [...this.events];
    this.events.length = 0;
    return drained;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

function stopPoint(load: Load, type: 'pickup' | 'delivery'): GeoPoint | null {
  const stops = (load.stops ?? []).filter((stop) => stop.type === type);
  const sorted = stops.sort((a, b) => a.sequence - b.sequence);
  const first = sorted[0];
  return first?.location ?? geocodeish(type === 'pickup' ? load.origin : load.destination);
}

/**
 * Last-resort geocode. `dispatch.geocodeLocation` owns the real logic; this
 * keeps `tracking` free of a circular import while still producing a usable
 * point for a "City, ST" string.
 */
function geocodeish(location: string): GeoPoint | null {
  const match = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(location);
  if (match) {
    return { lat: Number.parseFloat(match[1] ?? '0'), lng: Number.parseFloat(match[2] ?? '0') };
  }
  // Imported lazily to avoid a cycle: dispatch imports geo, not tracking.
  const parts = location.split(',');
  const state = (parts[1] ?? '').trim().toUpperCase().slice(0, 2);
  const centroids: Record<string, GeoPoint> = {
    AL: { lat: 32.78, lng: -86.83 }, AK: { lat: 63.33, lng: -152.83 }, AZ: { lat: 34.27, lng: -111.66 },
    AR: { lat: 34.89, lng: -92.44 }, CA: { lat: 37.18, lng: -119.47 }, CO: { lat: 39.0, lng: -105.55 },
    CT: { lat: 41.62, lng: -72.73 }, DE: { lat: 38.99, lng: -75.51 }, FL: { lat: 28.63, lng: -82.45 },
    GA: { lat: 32.64, lng: -83.44 }, IA: { lat: 42.08, lng: -93.5 }, ID: { lat: 44.35, lng: -114.61 },
    IL: { lat: 40.04, lng: -89.2 }, IN: { lat: 39.89, lng: -86.28 }, KS: { lat: 38.48, lng: -98.38 },
    KY: { lat: 37.53, lng: -85.3 }, LA: { lat: 31.07, lng: -92.0 }, MA: { lat: 42.26, lng: -71.81 },
    MD: { lat: 39.06, lng: -76.79 }, MI: { lat: 44.35, lng: -85.41 }, MN: { lat: 46.28, lng: -94.31 },
    MO: { lat: 38.36, lng: -92.46 }, MS: { lat: 32.74, lng: -89.67 }, MT: { lat: 47.05, lng: -109.63 },
    NC: { lat: 35.56, lng: -79.38 }, ND: { lat: 47.45, lng: -100.47 }, NE: { lat: 41.54, lng: -99.8 },
    NH: { lat: 43.68, lng: -71.58 }, NJ: { lat: 40.19, lng: -74.67 }, NM: { lat: 34.41, lng: -106.11 },
    NV: { lat: 39.33, lng: -116.63 }, NY: { lat: 42.95, lng: -75.53 }, OH: { lat: 40.29, lng: -82.79 },
    OK: { lat: 35.59, lng: -97.49 }, OR: { lat: 43.93, lng: -120.56 }, PA: { lat: 40.88, lng: -77.8 },
    RI: { lat: 41.68, lng: -71.56 }, SC: { lat: 33.92, lng: -80.9 }, SD: { lat: 44.44, lng: -100.23 },
    TN: { lat: 35.86, lng: -86.35 }, TX: { lat: 31.48, lng: -99.33 }, UT: { lat: 39.31, lng: -111.67 },
    VA: { lat: 37.52, lng: -78.85 }, VT: { lat: 44.07, lng: -72.67 }, WA: { lat: 47.38, lng: -120.45 },
    WI: { lat: 44.62, lng: -89.99 }, WV: { lat: 38.64, lng: -80.62 }, WY: { lat: 43.0, lng: -107.55 },
  };
  const centroid = centroids[state];
  if (!centroid) return null;
  const city = (parts[0] ?? '').trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < city.length; i += 1) {
    hash ^= city.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return {
    lat: Math.round((centroid.lat + (((hash & 0xff) - 128) / 128) * 1.1) * 1e6) / 1e6,
    lng: Math.round((centroid.lng + ((((hash >> 8) & 0xff) - 128) / 128) * 1.4) * 1e6) / 1e6,
  };
}

function currentSpeed(pings: readonly GpsPing[]): number {
  if (pings.length < 2) return 0;

  const last = pings[pings.length - 1];
  let distance = 0;
  const windowStart = Date.parse(last?.at ?? '') - 15 * 60_000;
  const recent = pings.filter((ping) => Date.parse(ping.at) >= windowStart);

  for (let i = 1; i < recent.length; i += 1) {
    const from = recent[i - 1];
    const to = recent[i];
    if (from && to) distance += haversineMiles(from.location, to.location);
  }

  const first = recent[0];
  if (!first || !last) return 0;
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3_600_000;
  if (hours <= 0) return 0;

  const roadMiles = distance * 1.18;
  return roadMiles < MOVING_SPEED_MPH ? 0 : roadMiles / hours;
}

function remainingStopCount(load: Load, milesCompleted: number, legMiles: number): number {
  const stops = load.stops ?? [];
  if (stops.length === 0) return 0;
  if (legMiles <= 0) return 1;
  const fraction = milesCompleted / legMiles;
  return Math.max(0, Math.round(stops.length * (1 - fraction)));
}

/** Distance from the straight origin->destination line, i.e. how far off-route. */
function offRouteDistance(
  origin: GeoPoint | null,
  destination: GeoPoint | null,
  current: GeoPoint | null,
): number {
  if (!origin || !destination || !current) return 0;

  const legMiles = haversineMiles(origin, destination);
  if (legMiles < 1) return 0;

  const t = clamp01(haversineMiles(origin, current) / legMiles);
  const projected = lerpPoint(origin, destination, t);
  return haversineMiles(projected, current);
}

function lerpPoint(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  const clamped = clamp01(t);
  return {
    lat: a.lat + (b.lat - a.lat) * clamped,
    lng: a.lng + (b.lng - a.lng) * clamped,
  };
}

function bearingApprox(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return Math.round((toDeg(Math.atan2(y, x)) + 360) % 360);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
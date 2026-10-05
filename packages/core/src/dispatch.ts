import {
  Errors,
  canTransitionLoad,
  canTransitionTruck,
  haversineMiles,
  isLoadActive,
  type Cents,
  type DomainEvent,
  type Driver,
  type GeoPoint,
  type Iso,
  type Load,
  type LoadStop,
  type Result,
  type TrailerType,
  type Truck,
  err,
  isoNow,
  ok,
  truckStatusForLoad,
  uuid,
} from '@truckdesk/shared';

/**
 * Dispatch engine.
 *
 * Assignment is the single most valuable action in a small carrier, so it is a
 * pure function over (loads, trucks, drivers, hos) returning a new world plus
 * the events to persist. Nothing here touches a database, which is why the same
 * code runs in the API, in a Worker, and in a unit test.
 */

/* -------------------------------------------------------------------------- */
/* Inputs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Minimal HOS read model the dispatcher needs. `eld` computes the real thing;
 * `core` only needs "how long can this driver legally drive".
 */
export interface DriverHoursReadiness {
  driverId: string;
  /** Minutes of driving remaining in the current 11-hour window. */
  driveMinutesRemaining: number;
  /** Minutes of on-duty remaining in the 14-hour window. */
  dutyMinutesRemaining: number;
  /** Minutes until the driver has a legal 10-hour break. */
  breakMinutesRemaining: number;
  /** Current cycle: 60 hours (7-day) or 70 hours (8-day). */
  cycle: 60 | 70;
  /** Minutes of on-duty left in the current cycle. */
  cycleMinutesRemaining: number;
  violations: string[];
}

export interface DispatchContext {
  now: Iso;
  trucks: Truck[];
  loads: Load[];
  drivers?: Driver[];
  /** Optional HOS readiness keyed by driverId. Missing means "unknown, assume legal". */
  readiness?: Record<string, DriverHoursReadiness>;
  /** Company operating rules. */
  rules?: DispatchRules;
}

export interface DispatchRules {
  /** Reject an assignment when the trip needs more drive minutes than remain. */
  enforceHos: boolean;
  /** Reject when projected revenue per mile is below this. Cents. */
  minRevenuePerMileCents?: number;
  /** Reject when deadhead to pickup exceeds this many miles. */
  maxDeadheadMiles?: number;
  /** Reject when the load is already past its delivery date. */
  allowLateBooking: boolean;
  /** Weight a driver may carry above the truck's max. */
  weightToleranceLbs?: number;
  /** Miles added to the direct distance for appointment/yard detours. */
  pickupDetourMiles?: number;
}

export const DEFAULT_DISPATCH_RULES: Required<DispatchRules> = {
  enforceHos: true,
  minRevenuePerMileCents: 150,
  maxDeadheadMiles: 250,
  allowLateBooking: true,
  weightToleranceLbs: 0,
  pickupDetourMiles: 0,
};

/* -------------------------------------------------------------------------- */
/* Results                                                                      */
/* -------------------------------------------------------------------------- */

export interface AssignmentCandidate {
  truckId: string;
  truckUnit: string;
  driverId?: string;
  driverName?: string;
  loadId: string;
  deadheadMiles: number;
  totalMiles: number;
  projectedHours: number;
  revenuePerMileCents: number;
  marginCents: Cents;
  score: number;
  warnings: string[];
  blocking: string[];
}

export interface Assignment {
  load: Load;
  truck: Truck;
  driver?: Driver;
  deadheadMiles: number;
  totalMiles: number;
  projectedHours: number;
  projectedDriverPayCents: Cents;
  marginCents: Cents;
  warnings: string[];
  events: DomainEvent[];
}

export interface DispatchBoardColumn {
  status: Load['status'];
  loads: Load[];
}

export interface DispatchBoard {
  columns: DispatchBoardColumn[];
  unassignedTruckIds: string[];
  counts: Record<Load['status'], number>;
  generatedAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Geocode a "City, ST" or "City, ST 12345" string to an approximate point. */
export function geocodeLocation(input: string): GeoPoint | null {
  const cleaned = input.trim();
  if (!cleaned) return null;

  // Already coordinates?
  const coords = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(cleaned);
  if (coords) {
    const lat = Number.parseFloat(coords[1] ?? '0');
    const lng = Number.parseFloat(coords[2] ?? '0');
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  const parts = cleaned.split(',');
  const city = (parts[0] ?? '').trim().toLowerCase();
  const state = (parts[1] ?? '').trim().toUpperCase().slice(0, 2);

  if (!city) return null;
  return stateCentroid(state, city) ?? US_STATE_CENTROIDS[state] ?? null;
}

/**
 * A deterministic per-city offset from the state centroid. Real geocoding needs
 * a paid API (Mapbox/Google) or a heavy local dataset, and for dispatch all
 * that matters is that the same city always maps to the same point and that
 * distances between different cities are roughly right. The jitter is derived
 * from a string hash so it is stable across processes and servers.
 */
function stateCentroid(state: string, city: string): GeoPoint | null {
  const centroid = US_STATE_CENTROIDS[state];
  if (!centroid) return null;

  const hash = fnv1a(city);
  const latJitter = (((hash & 0xff) - 128) / 128) * 1.1;
  const lngJitter = ((((hash >> 8) & 0xff) - 128) / 128) * 1.4;

  return {
    lat: round6(centroid.lat + latJitter),
    lng: round6(centroid.lng + lngJitter),
  };
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Approximate centroid per state, for offline geocoding of "City, ST". */
export const US_STATE_CENTROIDS: Record<string, GeoPoint> = {
  AL: { lat: 32.7794, lng: -86.8287 },
  AK: { lat: 63.3333, lng: -152.8333 },
  AZ: { lat: 34.2744, lng: -111.6602 },
  AR: { lat: 34.8938, lng: -92.4426 },
  CA: { lat: 37.1841, lng: -119.4696 },
  CO: { lat: 38.9972, lng: -105.5478 },
  CT: { lat: 41.6212, lng: -72.7273 },
  DE: { lat: 38.9896, lng: -75.505 },
  DC: { lat: 38.9072, lng: -77.0369 },
  FL: { lat: 28.6305, lng: -82.4497 },
  GA: { lat: 32.6415, lng: -83.4426 },
  HI: { lat: 20.2937, lng: -156.3738 },
  ID: { lat: 44.3509, lng: -114.613 },
  IL: { lat: 40.0417, lng: -89.1965 },
  IN: { lat: 39.8942, lng: -86.2816 },
  IA: { lat: 42.0751, lng: -93.496 },
  KS: { lat: 38.4844, lng: -98.3804 },
  KY: { lat: 37.5347, lng: -85.3021 },
  LA: { lat: 31.0689, lng: -91.9968 },
  ME: { lat: 45.3695, lng: -69.2428 },
  MD: { lat: 39.055, lng: -76.7908 },
  MA: { lat: 42.2596, lng: -71.8083 },
  MI: { lat: 44.3467, lng: -85.4102 },
  MN: { lat: 46.2807, lng: -94.3053 },
  MS: { lat: 32.7364, lng: -89.6678 },
  MO: { lat: 38.3566, lng: -92.458 },
  MT: { lat: 47.0527, lng: -109.6333 },
  NE: { lat: 41.5378, lng: -99.7951 },
  NV: { lat: 39.3289, lng: -116.6312 },
  NH: { lat: 43.6805, lng: -71.5811 },
  NJ: { lat: 40.1907, lng: -74.6728 },
  NM: { lat: 34.4071, lng: -106.1126 },
  NY: { lat: 42.9538, lng: -75.5268 },
  NC: { lat: 35.5557, lng: -79.3832 },
  ND: { lat: 47.4501, lng: -100.4659 },
  OH: { lat: 40.2862, lng: -82.7937 },
  OK: { lat: 35.5889, lng: -97.4943 },
  OR: { lat: 43.9336, lng: -120.5583 },
  PA: { lat: 40.8781, lng: -77.7996 },
  RI: { lat: 41.6762, lng: -71.5562 },
  SC: { lat: 33.9169, lng: -80.8964 },
  SD: { lat: 44.4443, lng: -100.2263 },
  TN: { lat: 35.858, lng: -86.3505 },
  TX: { lat: 31.4757, lng: -99.3312 },
  UT: { lat: 39.3055, lng: -111.6703 },
  VT: { lat: 44.0687, lng: -72.6658 },
  VA: { lat: 37.5215, lng: -78.8537 },
  WA: { lat: 47.3826, lng: -120.4472 },
  WV: { lat: 38.6409, lng: -80.6227 },
  WI: { lat: 44.6243, lng: -89.9941 },
  WY: { lat: 42.9957, lng: -107.5512 },
};

export function stopLocation(load: Load, type: LoadStop['type']): GeoPoint | null {
  const stops = load.stops ?? [];
  const relevant = stops
    .filter((stop) => (type === 'pickup' ? stop.type !== 'delivery' : stop.type !== 'pickup'))
    .sort((a, b) => a.sequence - b.sequence);
  const first = relevant[0];
  if (first?.location) return first.location;

  const address = type === 'pickup' ? load.origin : load.destination;
  return address ? geocodeLocation(address) : null;
}

export function deadheadMiles(truck: Truck, load: Load): number {
  const pickup = stopLocation(load, 'pickup');
  if (!pickup) return 0;
  return haversineMiles(truck.location, pickup);
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                  */
/* -------------------------------------------------------------------------- */

/** Average fleet speed including city time. 55mph highway is not the truth. */
export const EFFECTIVE_SPEED_MPH = 48;

export function projectedTripHours(miles: number, stops: LoadStop[] = []): number {
  const driveHours = miles / EFFECTIVE_SPEED_MPH;
  // 45 minutes per stop for a driver at a yard: gate, paperwork, spotter.
  const stopHours = stops.length * 0.75;
  return driveHours + stopHours;
}

/** Driver pay for a trip, honouring each pay type. */
export function projectDriverPayCents(
  driver: Driver | undefined,
  load: Load,
  miles: number,
): Cents {
  if (!driver) return 0;
  switch (driver.payType) {
    case 'percentage': {
      // Percentage is on linehaul only. The fuel surcharge is the broker paying
      // for fuel, not paying the driver, and `settlement.payForLoad` applies the
      // same rule - the two must agree or a settlement will not tie out.
      const base = load.linehaulCents ?? Math.round(load.rate * 0.85);
      return Math.round((base * (driver.payRateBps ?? 2500)) / 10_000);
    }
    case 'flat_per_mile':
      return Math.round((driver.payPerMileCents ?? 45) * miles);
    case 'flat_per_load':
      return driver.payPerMileCents ?? 0;
    case 'salary':
      return 0;
    default:
      return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                  */
/* -------------------------------------------------------------------------- */

export interface EligibilityInput {
  load: Load;
  truck: Truck;
  driver?: Driver;
  readiness?: DriverHoursReadiness;
  rules: Required<DispatchRules>;
  now: Iso;
}

export interface Eligibility {
  eligible: boolean;
  warnings: string[];
  blocking: string[];
  deadheadMiles: number;
  totalMiles: number;
  projectedHours: number;
  projectedDriverPayCents: Cents;
  marginCents: Cents;
  revenuePerMileCents: number;
}

export function evaluateEligibility(input: EligibilityInput): Eligibility {
  const { load, truck, driver, readiness, rules, now } = input;
  const warnings: string[] = [];
  const blocking: string[] = [];

  const emptyMiles = deadheadMiles(truck, load);
  const totalMiles = Math.round(emptyMiles + load.miles + rules.pickupDetourMiles);
  const projectedHours = projectedTripHours(load.miles, load.stops ?? []);
  const revenuePerMileCents = load.miles > 0 ? Math.round(load.rate / load.miles) : 0;
  const projectedDriverPayCents = projectDriverPayCents(driver, load, totalMiles);

  /* --- truck state ------------------------------------------------------- */

  if (truck.status === 'maintenance') {
    blocking.push(`${truck.unit} is in maintenance`);
  }

  // `currentLoadId` is only set on the truck once the office has written it, so
  // the board status is also checked: a truck showing as `loaded` is carrying
  // something even if the assignment row has not caught up.
  if (truck.status === 'loaded') {
    blocking.push(`${truck.unit} is already loaded`);
  }
  if (truck.currentLoadId && truck.currentLoadId !== load.id && isLoadActive(load.status)) {
    // Already hauling something else - only a dispatcher override can do this.
    blocking.push(`${truck.unit} is already assigned to load ${truck.currentLoadId}`);
  }

  /* --- equipment --------------------------------------------------------- */

  const loadEquipment = load.equipment as TrailerType | undefined;
  const truckEquipment = truck.trailerType as TrailerType | undefined;
  if (loadEquipment && truckEquipment && loadEquipment !== truckEquipment) {
    blocking.push(`${truck.unit} has a ${labelTrailer(truckEquipment)}, load needs ${labelTrailer(loadEquipment)}`);
  }

  /* --- weight ------------------------------------------------------------ */

  if (load.weightLbs && truck.maxWeightLbs) {
    const allowed = truck.maxWeightLbs + (rules.weightToleranceLbs || 0);
    if (load.weightLbs > allowed) {
      blocking.push(
        `Weight ${formatWeight(load.weightLbs)} exceeds ${truck.unit} capacity ${formatWeight(truck.maxWeightLbs)}`,
      );
    } else if (load.weightLbs > allowed * 0.95) {
      warnings.push(`Weight is within 5% of ${truck.unit} capacity`);
    }
  }

  /* --- driver ------------------------------------------------------------ */

  if (!truck.driverId && !driver) {
    blocking.push(`${truck.unit} has no driver`);
  }

  if (driver) {
    if (driver.status !== 'active') {
      blocking.push(`${driver.name} is ${driver.status.replace('_', ' ')}`);
    }
    if (driver.doNotAssign) {
      blocking.push(`${driver.name} is flagged do-not-assign`);
    }
    if (load.weightLbs && load.weightLbs > 45_000 && !driver.hazmatEndorsed) {
      warnings.push(`${driver.name} is not hazmat endorsed`);
    }
    if (loadEquipment === 'tanker' && !driver.tankerEndorsed) {
      warnings.push(`${driver.name} is not tanker endorsed`);
    }

    const maxHours = driver.maxDailyDriveHours ?? 11;
    if (projectedHours > maxHours + 1) {
      blocking.push(
        `Trip needs ${projectedHours.toFixed(1)}h, ${driver.name} is capped at ${maxHours}h/day`,
      );
    }
  }

  /* --- hours of service -------------------------------------------------- */

  const driveMinutesNeeded = Math.round(projectedHours * 60);
  if (rules.enforceHos && readiness) {
    // Under an hour of legal drive time is "out of hours" for dispatch
    // purposes: nobody hands a load to a driver with 30 minutes left and expects
    // it moved. Anything more than that is a warning, because a dispatcher
    // legitimately assigns a short pickup knowing the driver rests first.
    if (readiness.driveMinutesRemaining <= 0) {
      blocking.push(`${driver?.name ?? 'Driver'} has no drive time left today`);
    } else if (readiness.driveMinutesRemaining < 60) {
      blocking.push(
        `${driver?.name ?? 'Driver'} has only ${(readiness.driveMinutesRemaining / 60).toFixed(1)}h of drive time left`,
      );
    } else if (readiness.driveMinutesRemaining < driveMinutesNeeded) {
      warnings.push(
        `Only ${(readiness.driveMinutesRemaining / 60).toFixed(1)}h drive time left; trip needs ${(driveMinutesNeeded / 60).toFixed(1)}h`,
      );
    }

    if (readiness.dutyMinutesRemaining <= 0) {
      blocking.push(`${driver?.name ?? 'Driver'} is out of on-duty hours for the day`);
    } else if (readiness.dutyMinutesRemaining < driveMinutesNeeded) {
      warnings.push(`${driver?.name ?? 'Driver'} will blow the 14-hour on-duty window`);
    }

    if (readiness.breakMinutesRemaining <= 0) {
      warnings.push(`${driver?.name ?? 'Driver'} is due a 30-minute break`);
    } else if (readiness.breakMinutesRemaining < 30) {
      warnings.push(`30-minute break due in ${readiness.breakMinutesRemaining} minutes`);
    }

    if (readiness.cycleMinutesRemaining > 0 && readiness.cycleMinutesRemaining < driveMinutesNeeded) {
      warnings.push(
        `Under ${(readiness.cycleMinutesRemaining / 60).toFixed(1)}h left in the ${readiness.cycle}-hour cycle`,
      );
    }
  }

  /* --- economics --------------------------------------------------------- */

  const marginCents = load.rate - projectedDriverPayCents;
  if (rules.minRevenuePerMileCents > 0 && revenuePerMileCents < rules.minRevenuePerMileCents) {
    warnings.push(
      `$${(revenuePerMileCents / 100).toFixed(2)}/mi is under the $${(
        rules.minRevenuePerMileCents / 100
      ).toFixed(2)} floor`,
    );
  }
  if (marginCents <= 0) {
    blocking.push('Rate does not cover driver pay');
  }

  if (rules.maxDeadheadMiles > 0 && emptyMiles > rules.maxDeadheadMiles) {
    warnings.push(`${Math.round(emptyMiles)} mi deadhead to pickup`);
  }

  /* --- schedule ---------------------------------------------------------- */

  if (load.deliveryDate && !rules.allowLateBooking) {
    if (Date.parse(load.deliveryDate) < Date.parse(now)) {
      blocking.push('Delivery date has passed');
    }
  } else if (load.deliveryDate && Date.parse(load.deliveryDate) < Date.parse(now)) {
    warnings.push('Delivery date has already passed');
  }

  return {
    eligible: blocking.length === 0,
    warnings,
    blocking,
    deadheadMiles: Math.round(emptyMiles),
    totalMiles,
    projectedHours: Math.round(projectedHours * 100) / 100,
    projectedDriverPayCents,
    marginCents,
    revenuePerMileCents,
  };
}

export function labelTrailer(type: TrailerType): string {
  switch (type) {
    case 'dry_van':
      return 'dry van';
    case 'reefer':
      return 'reefer';
    case 'flatbed':
      return 'flatbed';
    case 'step_deck':
      return 'step deck';
    case 'tanker':
      return 'tanker';
    case 'box_truck':
      return 'box truck';
    case 'power_only':
      return 'power only';
    default:
      return String(type);
  }
}

function formatWeight(lbs: number): string {
  if (lbs >= 10_000) return `${Math.round(lbs / 1000)}k lbs`;
  return `${lbs} lbs`;
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                   */
/* -------------------------------------------------------------------------- */

export interface AssignInput {
  loadId: string;
  truckId: string;
  /** Force the assignment past HOS / margin soft warnings. */
  overrideWarnings?: boolean;
  /** Bypass even the blocking checks. Audit-logged, never automatic. */
  overrideBlocking?: boolean;
  actorId?: string;
  /** Pre-supplied id, used when replaying an offline-queued assignment. */
  loadIdOverride?: string;
}

export interface AssignResult {
  load: Load;
  truck: Truck;
  driver?: Driver;
  assignment: Assignment;
}

/**
 * Assign one load to one truck. Returns a new load and a new truck; callers
 * persist both plus the emitted events in a single transaction.
 */
export function assignLoad(context: DispatchContext, input: AssignInput): Result<AssignResult> {
  const rules = { ...DEFAULT_DISPATCH_RULES, ...(context.rules ?? {}) };
  const load = context.loads.find((candidate) => candidate.id === input.loadId);
  if (!load) {
    return err(Errors.notFound('Load', input.loadId));
  }

  const truck = context.trucks.find((candidate) => candidate.id === input.truckId);
  if (!truck) {
    return err(Errors.notFound('Truck', input.truckId));
  }

  if (load.cancelledAt) {
    return err(Errors.invalidState('Load was cancelled and cannot be dispatched'));
  }
  if (load.status !== 'booked') {
    return err(
      Errors.invalidState(`Load is ${load.status}; only booked loads can be dispatched`, {
        loadId: load.id,
        status: load.status,
      }),
    );
  }
  if (!canTransitionLoad(load.status, 'dispatched')) {
    return err(Errors.invalidState(`Cannot move load from ${load.status} to dispatched`));
  }

  const driver = context.drivers?.find((candidate) => {
    const wantedDriverId = truck.driverId ?? truck.currentDriverId;
    return candidate.id === wantedDriverId;
  });

  const readiness = driver
    ? context.readiness?.[driver.id]
    : undefined;

  const eligibility = evaluateEligibility({
    load,
    truck,
    driver,
    readiness,
    rules,
    now: context.now,
  });

  if (eligibility.blocking.length > 0 && !input.overrideBlocking) {
    return err(
      Errors.invalidState(
        `${truck.unit} cannot take load ${load.id}: ${eligibility.blocking.join('; ')}`,
        {
          loadId: load.id,
          truckId: truck.id,
          blocking: eligibility.blocking,
          warnings: eligibility.warnings,
        },
      ),
    );
  }

  const now = context.now;
  const nextLoad: Load = {
    ...load,
    id: input.loadIdOverride ?? load.id,
    status: 'dispatched',
    assignedTruckId: truck.id,
    assignedDriverId: driver?.id ?? truck.driverId ?? truck.currentDriverId,
    dispatchedAt: now,
  };

  const nextTruck: Truck = {
    ...truck,
    status: truckStatusForLoad(nextLoad.status),
    currentLoadId: nextLoad.id,
    currentDriverId: nextLoad.assignedDriverId,
    currentDriverName: driver?.name,
  };

  if (!canTransitionTruck(truck.status, nextTruck.status) && truck.status !== nextTruck.status) {
    return err(
      Errors.invalidState(`Illegal truck transition ${truck.status} -> ${nextTruck.status}`),
    );
  }

  const events: DomainEvent[] = [
    {
      id: uuid(),
      type: 'load.assigned',
      entityType: 'load',
      entityId: nextLoad.id,
      payload: { truckId: truck.id, truckUnit: truck.unit, driverId: nextLoad.assignedDriverId },
      actorId: input.actorId,
      occurredAt: now,
    },
    {
      id: uuid(),
      type: 'load.status_changed',
      entityType: 'load',
      entityId: nextLoad.id,
      payload: { from: load.status, to: nextLoad.status },
      actorId: input.actorId,
      occurredAt: now,
    },
    {
      id: uuid(),
      type: 'truck.status_changed',
      entityType: 'truck',
      entityId: truck.id,
      payload: { from: truck.status, to: nextTruck.status, loadId: nextLoad.id },
      actorId: input.actorId,
      occurredAt: now,
    },
  ];

  const assignment: Assignment = {
    load: nextLoad,
    truck: nextTruck,
    driver,
    deadheadMiles: eligibility.deadheadMiles,
    totalMiles: eligibility.totalMiles,
    projectedHours: eligibility.projectedHours,
    projectedDriverPayCents: eligibility.projectedDriverPayCents,
    marginCents: eligibility.marginCents,
    warnings: eligibility.warnings,
    events,
  };

  return ok({ load: nextLoad, truck: nextTruck, driver, assignment });
}

export interface UnassignResult {
  load: Load;
  truck: Truck;
  events: DomainEvent[];
}

/** Pull a load off a truck. Back to `booked`, truck back to `available`. */
export function unassignLoad(
  context: DispatchContext,
  input: { loadId: string; actorId?: string },
): Result<UnassignResult> {
  const load = context.loads.find((candidate) => candidate.id === input.loadId);
  if (!load) return err(Errors.notFound('Load', input.loadId));

  if (!load.assignedTruckId) {
    return err(Errors.invalidState('Load is not assigned to any truck'));
  }
  if (load.status === 'in-transit') {
    return err(
      Errors.invalidState('Cannot unassign a load that is already in transit; cancel it instead', {
        loadId: load.id,
      }),
    );
  }
  if (load.status === 'delivered' || load.status === 'paid') {
    return err(Errors.invalidState(`Load is ${load.status} and cannot be unassigned`));
  }

  const truck = context.trucks.find((candidate) => candidate.id === load.assignedTruckId);
  if (!truck) return err(Errors.notFound('Truck', load.assignedTruckId));

  if (!canTransitionLoad(load.status, 'booked')) {
    return err(Errors.invalidState(`Cannot move load from ${load.status} to booked`));
  }

  const now = context.now;
  const nextLoad: Load = {
    ...load,
    status: 'booked',
    assignedTruckId: undefined,
    assignedDriverId: undefined,
    dispatchedAt: undefined,
  };
  const nextTruck: Truck = {
    ...truck,
    status: 'available',
    currentLoadId: undefined,
    currentDriverId: truck.driverId ?? truck.currentDriverId,
    currentDriverName: truck.driverId
      ? context.drivers?.find((d) => d.id === truck.driverId)?.name
      : truck.currentDriverName,
  };

  const events: DomainEvent[] = [
    {
      id: uuid(),
      type: 'load.unassigned',
      entityType: 'load',
      entityId: load.id,
      payload: { previousTruckId: truck.id, previousTruckUnit: truck.unit },
      actorId: input.actorId,
      occurredAt: now,
    },
    {
      id: uuid(),
      type: 'truck.status_changed',
      entityType: 'truck',
      entityId: truck.id,
      payload: { from: truck.status, to: nextTruck.status },
      actorId: input.actorId,
      occurredAt: now,
    },
  ];

  return ok({ load: nextLoad, truck: nextTruck, events });
}

/* -------------------------------------------------------------------------- */
/* Board                                                                        */
/* -------------------------------------------------------------------------- */

export function buildDispatchBoard(context: DispatchContext): DispatchBoard {
  const live = context.loads.filter((load) => !load.cancelledAt);
  const columns: DispatchBoardColumn[] = [
    { status: 'booked', loads: live.filter((load) => load.status === 'booked') },
    { status: 'dispatched', loads: live.filter((load) => load.status === 'dispatched') },
    { status: 'in-transit', loads: live.filter((load) => load.status === 'in-transit') },
    { status: 'delivered', loads: live.filter((load) => load.status === 'delivered') },
    { status: 'paid', loads: live.filter((load) => load.status === 'paid') },
  ];

  const assignedTruckIds = new Set(
    live
      .filter((load) => isLoadActive(load.status))
      .map((load) => load.assignedTruckId)
      .filter((id): id is string => Boolean(id)),
  );

  return {
    columns,
    unassignedTruckIds: context.trucks
      .filter((truck) => !assignedTruckIds.has(truck.id))
      .map((truck) => truck.id),
    counts: {
      booked: columns[0]?.loads.length ?? 0,
      dispatched: columns[1]?.loads.length ?? 0,
      'in-transit': columns[2]?.loads.length ?? 0,
      delivered: columns[3]?.loads.length ?? 0,
      paid: columns[4]?.loads.length ?? 0,
    },
    generatedAt: context.now,
  };
}

/* -------------------------------------------------------------------------- */
/* Bulk operations                                                              */
/* -------------------------------------------------------------------------- */

export interface BulkAssignItem {
  loadId: string;
  truckId: string;
}

/**
 * Assign many pairs in order, skipping any pair that fails validation. Returns
 * what succeeded and why the rest did not, so the UI can toast "3 assigned,
 * 2 need attention" instead of failing the whole board on one bad row.
 */
export function bulkAssign(
  context: DispatchContext,
  items: BulkAssignItem[],
  actorId?: string,
): { assigned: Assignment[]; failures: Array<{ item: BulkAssignItem; reason: string }> } {
  const trucks = [...context.trucks];
  const loads = [...context.loads];
  const assigned: Assignment[] = [];
  const failures: Array<{ item: BulkAssignItem; reason: string }> = [];

  for (const item of items) {
    const staged: DispatchContext = { ...context, trucks, loads };
    const result = assignLoad(staged, { ...item, actorId });
    if (!result.ok) {
      failures.push({ item, reason: result.error.message });
      continue;
    }
    const value = result.value;
    replaceById(trucks, value.truck);
    replaceById(loads, value.load);
    assigned.push(value.assignment);
  }

  return { assigned, failures };
}

function replaceById<T extends { id: string }>(list: T[], next: T): void {
  const index = list.findIndex((item) => item.id === next.id);
  if (index >= 0) list[index] = next;
}

/* -------------------------------------------------------------------------- */
/* Status transitions driven by the field                                       */
/* -------------------------------------------------------------------------- */

export interface TransitionResult {
  load: Load;
  truck?: Truck;
  events: DomainEvent[];
}

/**
 * The single entry point the driver app calls: "I picked this up", "I delivered",
 * "I dropped the trailer". Keeps the load, truck and event stream consistent.
 */
export function transitionLoad(
  context: DispatchContext,
  input: { loadId: string; to: Load['status']; actorId?: string; note?: string },
): Result<TransitionResult> {
  const rules = { ...DEFAULT_DISPATCH_RULES, ...(context.rules ?? {}) };
  const load = context.loads.find((candidate) => candidate.id === input.loadId);
  if (!load) return err(Errors.notFound('Load', input.loadId));

  if (load.cancelledAt) {
    return err(Errors.invalidState('Load was cancelled'));
  }
  if (!canTransitionLoad(load.status, input.to)) {
    return err(
      Errors.invalidState(`Illegal load transition ${load.status} -> ${input.to}`, {
        loadId: load.id,
        from: load.status,
        to: input.to,
      }),
    );
  }

  const now = context.now;
  const truck = context.trucks.find((candidate) => candidate.id === load.assignedTruckId);
  const next: Load = { ...load, status: input.to };

  switch (input.to) {
    case 'in-transit':
      next.pickedUpAt = now;
      break;
    case 'delivered':
      next.deliveredAt = now;
      // Delivery without a POD on file is a money problem three weeks out.
      next.proofOfDeliveryMissing = !(load.documents ?? []).some(
        (doc) => doc.type === 'pod' || doc.type === 'bol',
      );
      break;
    case 'paid':
      next.paidAt = now;
      break;
    default:
      break;
  }

  const events: DomainEvent[] = [
    {
      id: uuid(),
      type: 'load.status_changed',
      entityType: 'load',
      entityId: load.id,
      payload: { from: load.status, to: input.to, note: input.note },
      actorId: input.actorId,
      occurredAt: now,
    },
  ];

  if (input.to === 'delivered') {
    events.push({
      id: uuid(),
      type: 'load.delivered',
      entityType: 'load',
      entityId: load.id,
      payload: { proofOfDeliveryMissing: next.proofOfDeliveryMissing, miles: load.miles },
      actorId: input.actorId,
      occurredAt: now,
    });
  }
  if (input.to === 'paid') {
    events.push({
      id: uuid(),
      type: 'load.paid',
      entityType: 'load',
      entityId: load.id,
      payload: { rate: load.rate, miles: load.miles },
      actorId: input.actorId,
      occurredAt: now,
    });
  }

  if (!truck) {
    return ok({ load: next, events });
  }

  const nextTruckStatus = input.to === 'paid' ? 'available' : truckStatusForLoad(input.to);
  const nextTruck: Truck = {
    ...truck,
    status: nextTruckStatus,
    currentLoadId: input.to === 'paid' ? undefined : truck.currentLoadId,
  };
  events.push({
    id: uuid(),
    type: 'truck.status_changed',
    entityType: 'truck',
    entityId: truck.id,
    payload: { from: truck.status, to: nextTruckStatus },
    actorId: input.actorId,
    occurredAt: now,
  });

  return ok({ load: next, truck: nextTruck, events });
}

/**
 * POD gate. The driver app calls this before letting POD upload finish, because
 * a signed POD is the only thing the broker will pay for.
 */
export function requiresProofOfDelivery(load: Load): boolean {
  return load.status === 'in-transit' || load.status === 'delivered';
}

export function canDispatchNow(context: DispatchContext, loadId: string): Result<true> {
  const load = context.loads.find((candidate) => candidate.id === loadId);
  if (!load) return err(Errors.notFound('Load', loadId));
  if (load.cancelledAt) return err(Errors.invalidState('Load was cancelled'));
  if (load.status !== 'booked') {
    return err(Errors.invalidState(`Load is ${load.status}, not booked`));
  }
  if (!load.origin || !load.destination) {
    return err(Errors.invalidState('Load needs both an origin and a destination'));
  }
  if (load.miles <= 0) {
    return err(Errors.invalidState('Load has no miles; a rate cannot be evaluated per mile'));
  }
  if (load.rate <= 0) {
    return err(Errors.invalidState('Load has no rate'));
  }
  return ok(true);
}

export function defaultContext(partial: Partial<DispatchContext> = {}): DispatchContext {
  return {
    now: partial.now ?? isoNow(),
    trucks: partial.trucks ?? [],
    loads: partial.loads ?? [],
    drivers: partial.drivers,
    readiness: partial.readiness,
    rules: { ...DEFAULT_DISPATCH_RULES, ...(partial.rules ?? {}) },
  };
}
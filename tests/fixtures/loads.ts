import type { Cents, Driver, Load, LoadStop, Truck } from '@truckdesk/shared';

/**
 * Fixture loads.
 *
 * 24 loads that span the awkward cases a real board contains: every status, every
 * trailer type, cross-border and multi-stop freight, a load below the fuel-only
 * cost, a load above market, a delivery that is already late, and one with no
 * stop list at all. Tests assert on behaviour, so the fixtures have to contain
 * the failures, not just the happy path.
 */

export interface LoadFixtureSpec {
  id: string;
  broker: string;
  origin: string;
  destination: string;
  status: Load['status'];
  /** Cents. */
  rate: Cents;
  miles: number;
  commodity: string;
  weightLbs: number;
  equipment: Load['equipment'];
  driverIndex?: number;
  truckIndex?: number;
  daysAgo?: number;
  /** Hours until pickup, relative to the fixture `now`. Negative means past. */
  pickupInHours?: number;
  deliveryInHours?: number;
  stops?: number;
  accessorialCents?: Cents;
  cancelled?: boolean;
  missingPod?: boolean;
  quickPay?: boolean;
  notes?: string;
}

/** Fixed clock for every fixture. 2026-03-16T14:00:00Z, a Monday afternoon. */
export const FIXTURE_NOW = new Date('2026-03-16T14:00:00.000Z');
export const FIXTURE_NOW_ISO = FIXTURE_NOW.toISOString();

const daysAgo = (days: number): string =>
  new Date(FIXTURE_NOW.getTime() - days * 86_400_000).toISOString();

const hoursFromNow = (hours: number): string =>
  new Date(FIXTURE_NOW.getTime() + hours * 3_600_000).toISOString();

export const LOAD_FIXTURES: LoadFixtureSpec[] = [
  /* ------------------------------------------------------------ booked */
  {
    id: 'ld_f01', broker: 'Midwest Freight', origin: 'Columbus, OH', destination: 'Pittsburgh, PA',
    status: 'booked', rate: 185_000, miles: 185, commodity: 'Steel coil', weightLbs: 38_400,
    equipment: 'dry_van', truckIndex: 2, pickupInHours: 9, deliveryInHours: 22, stops: 2,
  },
  {
    id: 'ld_f02', broker: 'Atlantic Logistics', origin: 'Cleveland, OH', destination: 'Buffalo, NY',
    status: 'booked', rate: 92_500, miles: 191, commodity: 'Auto parts', weightLbs: 21_000,
    equipment: 'dry_van', truckIndex: 2, pickupInHours: 26, deliveryInHours: 44, stops: 2,
  },
  {
    id: 'ld_f03', broker: 'Heartland Produce', origin: 'Dayton, OH', destination: 'Chicago, IL',
    status: 'booked', rate: 268_000, miles: 296, commodity: 'Fresh produce 34F', weightLbs: 41_200,
    equipment: 'reefer', truckIndex: 1, pickupInHours: 4, deliveryInHours: 20, stops: 2,
    accessorialCents: 18_500,
  },
  {
    id: 'ld_f04', broker: 'Great Lakes Chemical', origin: 'Toledo, OH', destination: 'Indianapolis, IN',
    status: 'booked', rate: 143_000, miles: 218, commodity: 'Industrial solvent', weightLbs: 42_800,
    equipment: 'dry_van', truckIndex: 3, pickupInHours: 20, deliveryInHours: 38, stops: 2,
  },
  {
    id: 'ld_f05', broker: 'Summit Supply', origin: 'Akron, OH', destination: 'Nashville, TN',
    status: 'booked', rate: 312_000, miles: 512, commodity: 'Lumber', weightLbs: 44_600,
    equipment: 'dry_van', truckIndex: 5, pickupInHours: 30, deliveryInHours: 58, stops: 2,
  },
  {
    id: 'ld_f06', broker: 'Keystone Flatbed', origin: 'Columbus, OH', destination: 'Charleston, WV',
    status: 'booked', rate: 224_000, miles: 226, commodity: 'Steel plate', weightLbs: 47_200,
    equipment: 'flatbed', truckIndex: 4, pickupInHours: 14, deliveryInHours: 30, stops: 2,
  },
  {
    // Three-stop multi-pickup: the driver must photograph each load separately.
    id: 'ld_f07', broker: 'Crossdock Partners', origin: 'Columbus, OH', destination: 'Charlotte, NC',
    status: 'booked', rate: 415_000, miles: 486, commodity: 'Mixed retail', weightLbs: 39_100,
    equipment: 'dry_van', truckIndex: 5, pickupInHours: 6, deliveryInHours: 30, stops: 3,
  },
  {
    // Below fuel cost: must be flagged by rate analysis.
    id: 'ld_f08', broker: 'Cheap Freight LLC', origin: 'Columbus, OH', destination: 'Dayton, OH',
    status: 'booked', rate: 7_000, miles: 72, commodity: 'Documents', weightLbs: 900,
    equipment: 'box_truck', truckIndex: 7, pickupInHours: 12, deliveryInHours: 15, stops: 2,
  },
  {
    // No stop list at all: the builder must synthesise one.
    id: 'ld_f09', broker: 'Quick Haul', origin: 'Cleveland, OH', destination: 'Akron, OH',
    status: 'booked', rate: 48_000, miles: 62, commodity: 'Fasteners', weightLbs: 12_000,
    equipment: 'dry_van', truckIndex: 3, pickupInHours: 5, deliveryInHours: 9, stops: 0,
  },
  {
    // Cancelled: must never appear on a board or an invoice.
    id: 'ld_f10', broker: 'Midwest Freight', origin: 'Columbus, OH', destination: 'Detroit, MI',
    status: 'booked', rate: 198_000, miles: 218, commodity: 'Machinery', weightLbs: 36_000,
    equipment: 'flatbed', cancelled: true,
  },

  /* -------------------------------------------------------- dispatched */
  {
    id: 'ld_f11', broker: 'Midwest Freight', origin: 'Columbus, OH', destination: 'Fort Wayne, IN',
    status: 'dispatched', rate: 128_000, miles: 178, commodity: 'Fasteners', weightLbs: 33_100,
    equipment: 'dry_van', driverIndex: 2, truckIndex: 2, daysAgo: 0.1,
    pickupInHours: 2, deliveryInHours: 9, stops: 2,
  },
  {
    id: 'ld_f12', broker: 'Blue Ridge', origin: 'Cincinnati, OH', destination: 'Greenville, SC',
    status: 'dispatched', rate: 246_000, miles: 487, commodity: 'Retail', weightLbs: 36_800,
    equipment: 'dry_van', driverIndex: 5, truckIndex: 5, daysAgo: 0.2,
    pickupInHours: 6, deliveryInHours: 26, stops: 2,
  },
  {
    id: 'ld_f13', broker: 'Heartland Produce', origin: 'Dayton, OH', destination: 'Detroit, MI',
    status: 'dispatched', rate: 158_000, miles: 233, commodity: 'Frozen foods', weightLbs: 39_900,
    equipment: 'reefer', driverIndex: 1, truckIndex: 1, daysAgo: 0.1,
    pickupInHours: 1, deliveryInHours: 11, stops: 2,
  },
  {
    id: 'ld_f14', broker: 'Iron Ridge', origin: 'Columbus, OH', destination: 'Louisville, KY',
    status: 'dispatched', rate: 132_000, miles: 205, commodity: 'Steel coils', weightLbs: 46_900,
    equipment: 'flatbed', driverIndex: 4, truckIndex: 4, daysAgo: 0.05,
    pickupInHours: 8, deliveryInHours: 20, stops: 2,
  },

  /* ------------------------------------------------------ in transit */
  {
    id: 'ld_f15', broker: 'Atlantic Logistics', origin: 'Cleveland, OH', destination: 'Pittsburgh, PA',
    status: 'in-transit', rate: 86_000, miles: 132, commodity: 'Aluminum', weightLbs: 28_400,
    equipment: 'dry_van', driverIndex: 0, truckIndex: 0, daysAgo: 0.3,
    pickupInHours: -6, deliveryInHours: 3, stops: 2,
  },
  {
    id: 'ld_f16', broker: 'Heartland Produce', origin: 'Dayton, OH', destination: 'Indianapolis, IN',
    status: 'in-transit', rate: 118_000, miles: 118, commodity: 'Dairy 38F', weightLbs: 37_500,
    equipment: 'reefer', driverIndex: 1, truckIndex: 1, daysAgo: 0.4,
    pickupInHours: -8, deliveryInHours: -1, stops: 2,
  },
  {
    // Delivery window already passed: must show as late.
    id: 'ld_f17', broker: 'Keystone Flatbed', origin: 'Toledo, OH', destination: 'Columbus, OH',
    status: 'in-transit', rate: 64_000, miles: 152, commodity: 'Components', weightLbs: 41_800,
    equipment: 'flatbed', driverIndex: 4, truckIndex: 4, daysAgo: 0.3,
    pickupInHours: -5, deliveryInHours: -4, stops: 2,
  },

  /* ------------------------------------------------------- delivered */
  {
    id: 'ld_f18', broker: 'Midwest Freight', origin: 'Columbus, OH', destination: 'Cleveland, OH',
    status: 'delivered', rate: 74_000, miles: 142, commodity: 'Beverages', weightLbs: 34_200,
    equipment: 'dry_van', driverIndex: 0, truckIndex: 0, daysAgo: 2,
    pickupInHours: -50, deliveryInHours: -44, stops: 2,
  },
  {
    id: 'ld_f19', broker: 'Summit Supply', origin: 'Akron, OH', destination: 'Columbus, OH',
    status: 'delivered', rate: 52_000, miles: 62, commodity: 'Masonry', weightLbs: 39_000,
    equipment: 'dry_van', driverIndex: 7, truckIndex: 7, daysAgo: 3,
    pickupInHours: -70, deliveryInHours: -68, stops: 2,
  },
  {
    id: 'ld_f20', broker: 'Great Lakes Chemical', origin: 'Toledo, OH', destination: 'Akron, OH',
    status: 'delivered', rate: 96_000, miles: 194, commodity: 'Solvent', weightLbs: 43_100,
    equipment: 'dry_van', driverIndex: 3, truckIndex: 3, daysAgo: 4,
    pickupInHours: -92, deliveryInHours: -86, stops: 2,
  },
  {
    // Delivered, no POD: the exception the dispatcher has to chase.
    id: 'ld_f21', broker: 'Blue Ridge', origin: 'Cincinnati, OH', destination: 'Columbus, OH',
    status: 'delivered', rate: 78_000, miles: 108, commodity: 'General', weightLbs: 26_800,
    equipment: 'dry_van', driverIndex: 5, truckIndex: 5, daysAgo: 5,
    pickupInHours: -110, deliveryInHours: -104, stops: 2, missingPod: true,
  },
  {
    id: 'ld_f22', broker: 'Heartland Produce', origin: 'Dayton, OH', destination: 'Columbus, OH',
    status: 'delivered', rate: 68_000, miles: 72, commodity: 'Produce 36F', weightLbs: 38_900,
    equipment: 'reefer', driverIndex: 1, truckIndex: 1, daysAgo: 6,
    pickupInHours: -156, deliveryInHours: -152, stops: 2,
  },

  /* ------------------------------------------------------------- paid */
  {
    id: 'ld_f23', broker: 'Midwest Freight', origin: 'Columbus, OH', destination: 'Fort Wayne, IN',
    status: 'paid', rate: 126_000, miles: 178, commodity: 'Fasteners', weightLbs: 35_700,
    equipment: 'dry_van', driverIndex: 0, truckIndex: 0, daysAgo: 14,
    pickupInHours: -300, deliveryInHours: -294, stops: 2,
  },
  {
    id: 'ld_f24', broker: 'Iron Ridge', origin: 'Columbus, OH', destination: 'Pittsburgh, PA',
    status: 'paid', rate: 182_000, miles: 185, commodity: 'Steel plate', weightLbs: 45_100,
    equipment: 'flatbed', driverIndex: 4, truckIndex: 4, daysAgo: 16,
    pickupInHours: -320, deliveryInHours: -312, stops: 2,
  },
];

export const DRIVER_FIXTURES: Driver[] = [
  {
    id: 'dr_t01', name: 'Marcus Bell', phone: '+16145550142', status: 'active',
    payType: 'flat_per_mile', payPerMileCents: 48, homeTerminal: 'Columbus, OH',
    licenseState: 'OH', preferredLanes: [{ originState: 'OH', destinationState: 'PA', weight: 3 }],
  },
  {
    id: 'dr_t02', name: 'Tanya Ruiz', phone: '+16145550157', status: 'active',
    payType: 'flat_per_mile', payPerMileCents: 52, hazmatEndorsed: true,
    homeTerminal: 'Columbus, OH', licenseState: 'OH',
    preferredLanes: [{ originState: 'OH', destinationState: 'IN', weight: 3 }],
  },
  {
    id: 'dr_t03', name: 'Devon Carter', phone: '+16145550163', status: 'active',
    payType: 'flat_per_mile', payPerMileCents: 46, tankerEndorsed: true,
    homeTerminal: 'Cleveland, OH', licenseState: 'OH',
  },
  {
    id: 'dr_t04', name: 'Priya Raman', phone: '+16145550179', status: 'active',
    payType: 'flat_per_mile', payPerMileCents: 50, homeTerminal: 'Columbus, OH',
  },
  {
    id: 'dr_t05', name: 'Cole Whitfield', phone: '+16145550184', status: 'active',
    payType: 'percentage', payRateBps: 3000, homeTerminal: 'Columbus, OH',
  },
  {
    id: 'dr_t06', name: 'Sam Okafor', phone: '+16145550196', status: 'active',
    payType: 'flat_per_mile', payPerMileCents: 49, homeTerminal: 'Columbus, OH',
  },
  {
    id: 'dr_t07', name: 'Rosa Delgado', phone: '+16145550203', status: 'on_leave',
    payType: 'flat_per_mile', payPerMileCents: 47, homeTerminal: 'Columbus, OH',
  },
  {
    id: 'dr_t08', name: 'Jim Brennan', phone: '+16145550217', status: 'active',
    payType: 'flat_per_mile', payPerMileCents: 44, homeTerminal: 'Columbus, OH',
  },
];

export const TRUCK_FIXTURES: Truck[] = [
  { id: 'tr_t01', unit: '101', status: 'loaded', location: { lat: 40.8, lng: -80.0 }, driverId: 'dr_t01', trailerType: 'dry_van', maxWeightLbs: 45_000, homeTerminal: 'Columbus, OH' },
  { id: 'tr_t02', unit: '102', status: 'loaded', location: { lat: 39.96, lng: -84.1 }, driverId: 'dr_t02', trailerType: 'reefer', maxWeightLbs: 43_500, homeTerminal: 'Columbus, OH' },
  { id: 'tr_t03', unit: '103', status: 'empty', location: { lat: 39.99, lng: -82.99 }, driverId: 'dr_t03', trailerType: 'dry_van', maxWeightLbs: 45_000, homeTerminal: 'Columbus, OH' },
  { id: 'tr_t04', unit: '104', status: 'available', location: { lat: 39.94, lng: -83.05 }, driverId: 'dr_t04', trailerType: 'dry_van', maxWeightLbs: 45_000, homeTerminal: 'Columbus, OH' },
  { id: 'tr_t05', unit: '105', status: 'loaded', location: { lat: 38.6, lng: -84.5 }, driverId: 'dr_t05', trailerType: 'flatbed', maxWeightLbs: 48_000, homeTerminal: 'Cincinnati, OH' },
  { id: 'tr_t06', unit: '106', status: 'available', location: { lat: 41.65, lng: -83.54 }, driverId: 'dr_t06', trailerType: 'dry_van', maxWeightLbs: 45_000, homeTerminal: 'Toledo, OH' },
  { id: 'tr_t07', unit: '107', status: 'maintenance', location: { lat: 39.99, lng: -82.99 }, trailerType: 'reefer', maxWeightLbs: 43_500, homeTerminal: 'Columbus, OH' },
  { id: 'tr_t08', unit: '108', status: 'empty', location: { lat: 40.1, lng: -82.9 }, driverId: 'dr_t08', trailerType: 'dry_van', maxWeightLbs: 45_000, homeTerminal: 'Columbus, OH' },
];

/* -------------------------------------------------------------------------- */
/* Factories                                                                    */
/* -------------------------------------------------------------------------- */

function buildStops(spec: LoadFixtureSpec, loadId: string): LoadStop[] | undefined {
  const count = spec.stops ?? 2;
  if (count === 0) return undefined;

  const stops: LoadStop[] = [];

  for (let i = 0; i < count; i += 1) {
    const isPickup = i < Math.ceil(count / 2);
    const place = isPickup ? spec.origin : spec.destination;
    const at = isPickup
      ? hoursFromNow(spec.pickupInHours ?? 4)
      : hoursFromNow(spec.deliveryInHours ?? 20);

    stops.push({
      id: `${loadId}_s${i}`,
      loadId,
      type: isPickup ? 'pickup' : 'delivery',
      sequence: i,
      facilityName: place.split(',')[0] ?? place,
      address: place,
      city: (place.split(',')[0] ?? '').trim(),
      state: (place.split(',')[1] ?? '').trim().slice(0, 2).toUpperCase(),
      status:
        spec.status === 'delivered' || spec.status === 'paid'
          ? 'completed'
          : spec.status === 'booked'
            ? 'pending'
            : isPickup
              ? 'completed'
              : 'pending',
      arrivedAt: spec.status === 'booked' ? undefined : at,
      completedAt: spec.status === 'delivered' || spec.status === 'paid' ? at : undefined,
    });
  }

  return stops;
}

export function makeLoad(spec: LoadFixtureSpec): Load {
  const linehaulCents = Math.round(spec.rate * 0.85);
  const fuelSurchargeCents = spec.rate - linehaulCents;

  return {
    id: spec.id,
    broker: spec.broker,
    origin: spec.origin,
    destination: spec.destination,
    rate: spec.rate,
    miles: spec.miles,
    status: spec.status,
    reference: spec.id.toUpperCase(),
    commodity: spec.commodity,
    weightLbs: spec.weightLbs,
    equipment: spec.equipment,
    pickupDate: spec.pickupInHours !== undefined ? hoursFromNow(spec.pickupInHours) : undefined,
    deliveryDate: spec.deliveryInHours !== undefined ? hoursFromNow(spec.deliveryInHours) : undefined,
    bookedAt: daysAgo(spec.daysAgo ?? 0.05),
    dispatchedAt:
      spec.status === 'booked' ? undefined : daysAgo((spec.daysAgo ?? 0.05) - 0.02),
    pickedUpAt:
      spec.status === 'in-transit' || spec.status === 'delivered' || spec.status === 'paid'
        ? daysAgo(Math.abs(spec.pickupInHours ?? 8) / 24)
        : undefined,
    deliveredAt:
      spec.status === 'delivered' || spec.status === 'paid'
        ? daysAgo(Math.abs(spec.deliveryInHours ?? 4) / 24)
        : undefined,
    paidAt: spec.status === 'paid' ? daysAgo(3) : undefined,
    assignedTruckId: spec.status === 'booked' ? undefined : TRUCK_FIXTURES[spec.truckIndex ?? 0]?.id,
    assignedDriverId: spec.status === 'booked' ? undefined : DRIVER_FIXTURES[spec.driverIndex ?? 0]?.id,
    linehaulCents,
    fuelSurchargeCents,
    accessorialCents: spec.accessorialCents ?? 0,
    rateType: 'flat',
    quickPayEligible: spec.quickPay ?? true,
    source: 'email',
    cancelledAt: spec.cancelled ? daysAgo(0.02) : undefined,
    cancelReason: spec.cancelled ? 'Broker cancelled: tender pulled' : undefined,
    proofOfDeliveryMissing: spec.missingPod === true,
    notes: spec.notes,
    stops: buildStops(spec, spec.id),
  };
}

export const FIXTURE_LOADS: Load[] = LOAD_FIXTURES.map(makeLoad);

/** A copy, so a mutating test cannot poison the shared fixtures. */
export function loads(): Load[] {
  return structuredClone(FIXTURE_LOADS);
}

export function trucks(): Truck[] {
  return structuredClone(TRUCK_FIXTURES);
}

export function drivers(): Driver[] {
  return structuredClone(DRIVER_FIXTURES);
}

/** Loads only, for a focused test. */
export function loadsWithStatus(...statuses: Load['status'][]): Load[] {
  return loads().filter((load) => statuses.includes(load.status));
}

export function loadById(id: string): Load {
  const found = FIXTURE_LOADS.find((load) => load.id === id);
  if (!found) throw new Error(`No fixture load "${id}"`);
  return structuredClone(found);
}

export { daysAgo, hoursFromNow };
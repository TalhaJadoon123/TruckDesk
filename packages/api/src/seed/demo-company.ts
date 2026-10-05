import 'dotenv/config';

import { startOfWeekIso, type Driver, type GeoPoint, type Load, type Truck } from '@truckdesk/shared';
import { geocodeLocation } from '@truckdesk/core';
import { splitRate } from '@truckdesk/loads';
import { SimulatorProvider, type SimulatedTruck } from '@truckdesk/eld';
import { FLAGS } from './demo-data.js';

import { createServices } from '../services/container.js';

/**
 * Seed a realistic 8-truck carrier.
 *
 * The point is not to have rows in a table: it is to have a board a dispatcher
 * would recognise, so the dashboard, drag-drop dispatch, settlement, invoice and
 * IFTA screens all have something true to show. That means loads in every status,
 * an unpaid invoice that is genuinely overdue, one delivery missing its POD, and
 * a driver who is close to running out of hours.
 */

export const DEMO_COMPANY_ID = 'co_ridgeway';
export const DEMO_OWNER = { email: 'dispatcher@ridgewayfreight.com', name: 'Dana Reyes' };
export const DEMO_PASSWORD = 'truckdesk-demo';

const TERMINAL = 'Columbus, OH';
const TERMINAL_POINT: GeoPoint = geocodeLocation(TERMINAL) ?? { lat: 39.9612, lng: -82.9988 };

export interface SeedResult {
  companyId: string;
  trucks: string[];
  drivers: string[];
  loads: string[];
  simulatedPings: number;
  summary: string[];
}

export interface SeedOptions {
  /** Suppress the per-entity progress lines. */
  quiet?: boolean;
  /** Suppress the trailing sign-in summary, for callers that print their own. */
  printSummary?: boolean;
}

export async function seedDemoCompany(options: SeedOptions = {}): Promise<SeedResult> {
  const services = createServices();
  const log = (message: string) => {
    if (!options.quiet) console.log(message);
  };

  const company = services.forCompany(DEMO_COMPANY_ID);
  const now = new Date();
  const nowIso = now.toISOString();
  const week = startOfWeekIso(nowIso);

  log('\nSeeding Ridgeway Freight LLC (8 trucks)\n');

  /* ------------------------------------------------------------ drivers */

  const drivers: Driver[] = FLAGS.drivers.map((driver, index) => ({
    id: `dr_seed_${index + 1}`,
    companyId: DEMO_COMPANY_ID,
    name: driver.name,
    phone: driver.phone,
    email: driver.email,
    homeTerminal: TERMINAL,
    homeBase: geocodeLocation(TERMINAL) ?? undefined,
    licenseNumber: `OH${9000000 + index * 1117}`,
    licenseState: 'OH',
    licenseExpiresAt: new Date(now.getTime() + (420 + index * 30) * 86_400_000).toISOString(),
    hazmatEndorsed: driver.hazmat,
    tankerEndorsed: driver.tanker,
    status: 'active',
    hireDate: new Date(now.getTime() - (200 + index * 90) * 86_400_000).toISOString(),
    payType: driver.ownerOperator ? 'percentage' : 'flat_per_mile',
    payRateBps: driver.ownerOperator ? 3000 : undefined,
    payPerMileCents: driver.ownerOperator ? undefined : driver.cpm,
    maxDailyDriveHours: 11,
    preferredLanes: driver.lanes,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  for (const driver of drivers) {
    await company.drivers.upsertDriver(driver);
  }
  log(`  ${drivers.length} drivers`);

  /* ------------------------------------------------------------- trucks */

  const trucks: Truck[] = FLAGS.trucks.map((unit, index) => {
    const driver = drivers[index];
    const position = geocodeLocation(FLAGS.terminalPoints[index] ?? TERMINAL) ?? TERMINAL_POINT;

    return {
      id: `tr_seed_${index + 1}`,
      companyId: DEMO_COMPANY_ID,
      unit: unit.unit,
      status: unit.status,
      location: position,
      driverId: driver?.id,
      currentDriverId: driver?.id,
      currentDriverName: driver?.name,
      trailerType: unit.trailer,
      maxWeightLbs: unit.maxWeight,
      homeTerminal: TERMINAL,
      vin: `1FU${String(1000000 + index * 7919).slice(0, 8)}`,
      plate: `OH-ER${3100 + index}`,
      make: unit.trailer === 'reefer' ? 'Freightliner Cascadia' : 'Freightliner Cascadia',
      model: 'Cascadia 126',
      year: 2021 + (index % 4),
      lastKnownAt: nowIso,
      hosStatus: unit.hos,
      eldProvider: 'simulator',
      eldDeviceId: `sim-${index + 1}`,
      odometer: unit.odometer,
      createdAt: nowIso,
    };
  });

  for (const truck of trucks) {
    await company.trucks.upsertTruck(truck);
  }
  log(`  ${trucks.length} trucks`);

  /* -------------------------------------------------------------- loads */

  const loads: Load[] = [];
  let stopSequence = 0;

  for (const [index, spec] of FLAGS.loads.entries()) {
    const truck = trucks[spec.truckIndex];
    const driver = drivers[spec.truckIndex];
    const originPoint = geocodeLocation(spec.origin) ?? TERMINAL_POINT;
    const destinationPoint = geocodeLocation(spec.destination) ?? TERMINAL_POINT;

    const id = `ld_seed_${String(index + 1).padStart(2, '0')}`;
    const { linehaulCents, fuelSurchargeCents } = splitRate(spec.rate, spec.miles);
    const rateParts = Math.round(spec.rate * 0.02);

    const pickupStopId = `${id}_s0`;
    const deliveryStopId = `${id}_s1`;

    const bookedAt = new Date(
      now.getTime() - spec.bookedHoursAgo * 3_600_000,
    ).toISOString();

    const load: Load = {
      id,
      companyId: DEMO_COMPANY_ID,
      broker: spec.broker,
      reference: spec.reference,
      origin: spec.origin,
      destination: spec.destination,
      rate: spec.rate,
      miles: spec.miles,
      status: spec.status,
      commodity: spec.commodity,
      weightLbs: spec.weightLbs,
      equipment: spec.equipment,
      pickupDate: new Date(now.getTime() + spec.pickupOffsetHours * 3_600_000).toISOString(),
      deliveryDate: new Date(now.getTime() + spec.deliveryOffsetHours * 3_600_000).toISOString(),
      pickupWindow: {
        start: new Date(now.getTime() + spec.pickupOffsetHours * 3_600_000).toISOString(),
        end: new Date(now.getTime() + (spec.pickupOffsetHours + 2) * 3_600_000).toISOString(),
      },
      bookedAt,
      linehaulCents,
      fuelSurchargeCents,
      accessorialCents: spec.accessorials ?? 0,
      rateType: spec.rateType ?? 'flat',
      quickPayEligible: spec.quickPay !== false,
      source: spec.source ?? 'email',
      assignedTruckId: spec.status === 'booked' ? undefined : truck?.id,
      assignedDriverId: spec.status === 'booked' ? undefined : driver?.id,
      dispatchedAt:
        spec.status === 'booked'
          ? undefined
          : new Date(now.getTime() - (spec.bookedHoursAgo - 1) * 3_600_000).toISOString(),
      pickedUpAt:
        spec.status === 'in-transit' || spec.status === 'delivered' || spec.status === 'paid'
          ? new Date(now.getTime() - (spec.pickedUpHoursAgo ?? 0) * 3_600_000).toISOString()
          : undefined,
      deliveredAt:
        spec.status === 'delivered' || spec.status === 'paid'
          ? new Date(now.getTime() - (spec.deliveredHoursAgo ?? 0) * 3_600_000).toISOString()
          : undefined,
      paidAt:
        spec.status === 'paid'
          ? new Date(now.getTime() - (spec.paidHoursAgo ?? 0) * 3_600_000).toISOString()
          : undefined,
      // The one delivery a dispatcher would actually be chasing.
      proofOfDeliveryMissing: spec.status === 'delivered' && spec.missingPod === true,
      stops: [
        {
          id: pickupStopId,
          loadId: id,
          type: 'pickup',
          sequence: 0,
          facilityName: spec.originFacility,
          address: spec.origin,
          city: (spec.origin.split(',')[0] ?? '').trim(),
          state: stateOf(spec.origin),
          location: originPoint,
          window: {
            start: new Date(now.getTime() + spec.pickupOffsetHours * 3_600_000).toISOString(),
            end: new Date(now.getTime() + (spec.pickupOffsetHours + 2) * 3_600_000).toISOString(),
          },
          status:
            spec.status === 'booked'
              ? 'pending'
              : spec.status === 'dispatched'
                ? 'completed'
                : 'completed',
        },
        {
          id: deliveryStopId,
          loadId: id,
          type: 'delivery',
          sequence: 1,
          facilityName: spec.destinationFacility,
          address: spec.destination,
          city: (spec.destination.split(',')[0] ?? '').trim(),
          state: stateOf(spec.destination),
          location: destinationPoint,
          status:
            spec.status === 'delivered' || spec.status === 'paid'
              ? 'completed'
              : spec.status === 'in-transit'
                ? 'pending'
                : 'pending',
        },
      ],
    };

    loads.push(load);
    stopSequence += 2;
  }

  for (const load of loads) {
    await company.loads.upsertLoad(load);
  }
  log(`  ${loads.length} loads across every status`);

  /* ------------------------------------------------------------ tracking */

  // Replay plausible movement for each truck so the map and the ETA are real.
  const simulated: SimulatedTruck[] = trucks.map((truck) => ({
    vehicleId: truck.id,
    unit: truck.unit,
    driverId: truck.driverId ?? '',
    location: truck.location,
    headingDeg: 0,
    speedMph: truck.status === 'loaded' ? 54 : 0,
    lastIntervalAt: nowIso,
  }));

  const simulator = new SimulatorProvider({ vehicles: simulated });
  const activeLoad = loads.find(
    (load) => load.status === 'in-transit' && load.assignedTruckId,
  );

  if (activeLoad) {
    simulator.driveFor(activeLoad.assignedTruckId ?? '', 4.5, 52, new Date(now.getTime() - 4.5 * 3_600_000));
  }

  let simulatedPings = 0;
  for (const truck of trucks) {
    if (truck.id === activeLoad?.assignedTruckId) continue;
    if (truck.status === 'loaded') {
      simulator.driveFor(truck.id, 3, 50, new Date(now.getTime() - 3 * 3_600_000));
      simulatedPings += 1;
    } else if (truck.status === 'maintenance') {
      simulator.sitFor(truck.id, 6, new Date(now.getTime() - 6 * 3_600_000));
    } else {
      simulator.sleepFor(truck.id, 9, new Date(now.getTime() - 9 * 3_600_000));
    }
  }

  const locations = await simulator.locations(new Date(now.getTime() - 12 * 3_600_000).toISOString());
  const result = await company.tracking.ingestBatch(
    locations.map((location) => ({
      truckId: location.vehicleId,
      location: location.location,
      at: location.at,
      speedMph: location.speedMph,
      headingDeg: location.headingDeg,
      source: 'simulator',
      offline: false,
    })),
  );
  simulatedPings = result.ok ? result.value.accepted.length : 0;
  log(`  ${simulatedPings} GPS pings replayed`);

  /* ----------------------------------------------------------- documents */

  const companyId = DEMO_COMPANY_ID;
  let documents = 0;
  for (const [index, load] of loads.entries()) {
    if (load.status === 'booked' || load.status === 'dispatched') continue;

    await company.documents.upsertDocument({
      id: `dc_seed_${load.id}_bol`,
      loadId: load.id,
      type: 'bol',
      fileName: `BOL-${load.reference ?? load.id}.jpg`,
      storageKey: `${companyId}/${load.id}/bol.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 412_000,
      uploadedBy: load.assignedDriverId ?? 'seed',
      uploadedAt: load.pickedUpAt ?? nowIso,
      capturedAt: load.pickedUpAt ?? nowIso,
      geo: load.stops?.[0]?.location,
      status: 'uploaded',
    });
    documents += 1;

    const missingPod = load.status === 'delivered' && load.proofOfDeliveryMissing === true;
    if ((load.status === 'delivered' || load.status === 'paid') && !missingPod) {
      await company.documents.upsertDocument({
        id: `dc_seed_${load.id}_pod`,
        loadId: load.id,
        type: 'pod',
        fileName: `POD-${load.reference ?? load.id}.jpg`,
        storageKey: `${companyId}/${load.id}/pod.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 356_000,
        uploadedBy: load.assignedDriverId ?? 'seed',
        uploadedAt: load.deliveredAt ?? nowIso,
        capturedAt: load.deliveredAt ?? nowIso,
        geo: load.stops?.[1]?.location,
        signatureName: FLAGS.receivers[index % FLAGS.receivers.length] ?? 'Receiving',
        status: 'uploaded',
      });
      documents += 1;
    }
  }
  log(`  ${documents} documents attached`);

  /* --------------------------------------------------------------- fuel */

  const fuelEntries = FLAGS.fuel.map((fuel, index) => ({
    id: `fe_seed_${index + 1}`,
    companyId,
    truckId: trucks[fuel.truckIndex]?.id ?? 'tr_seed_1',
    driverId: drivers[fuel.truckIndex]?.id,
    loadId: loads[index]?.id,
    gallons: fuel.gallons,
    priceCentsPerGallon: fuel.priceCents,
    totalCents: Math.round(fuel.gallons * fuel.priceCents),
    odometerMiles: fuel.odometer,
    jurisdictionCode: fuel.state,
    at: new Date(now.getTime() - fuel.hoursAgo * 3_600_000).toISOString(),
    cardLast4: fuel.card,
    isPrepaid: true,
  }));

  for (const entry of fuelEntries) {
    await company.fuel.upsertFuel(entry);
  }
  log(`  ${fuelEntries.length} fuel entries (IFTA credits)`);

  /* ---------------------------------------------------------------- done */

  const summary = [
    `Company:  ${DEMO_COMPANY_ID}  (${FLAGS.companyName})`,
    `Sign in:  ${DEMO_OWNER.email} / ${DEMO_PASSWORD}`,
    `Week:     ${week.label}`,
    '',
    'Open a second terminal and run the API to click through it:',
    `  curl -s localhost:4000/health`,
  ];

  if (options.printSummary === false) {
    return {
      companyId: DEMO_COMPANY_ID,
      trucks: trucks.map((truck) => truck.id),
      drivers: drivers.map((driver) => driver.id),
      loads: loads.map((load) => load.id),
      simulatedPings,
      summary,
    };
  }

  log('');
  log('');
  for (const line of summary) log(line);

  return {
    companyId: DEMO_COMPANY_ID,
    trucks: trucks.map((truck) => truck.id),
    drivers: drivers.map((driver) => driver.id),
    loads: loads.map((load) => load.id),
    simulatedPings,
    summary,
  };
}

function stateOf(location: string): string {
  const parts = location.split(',');
  const second = (parts[1] ?? '').trim().toUpperCase();
  const code = second.split(/\s+/)[0] ?? '';
  return code.length === 2 ? code : second.slice(0, 2);
}

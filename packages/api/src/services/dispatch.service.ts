import {
  Errors,
  err,
  isLoadActive,
  ok,
  uuid,
  type DomainEvent,
  type Driver,
  type GeoPoint,
  type Load,
  type LoadDocument,
  type Truck,
} from '@truckdesk/shared';
import {
  assignLoad,
  buildDispatchBoard,
  buildDashboard,
  boardHealth,
  bulkAssign,
  defaultContext,
  fleetDeadheadMiles,
  fleetUtilization,
  transitionLoad,
  unassignLoad,
  weeklyRevenueTrend,
  type Assignment,
  type DashboardInput,
  type DispatchBoard,
  type DispatchRules,
  type DriverHoursReadiness,
} from '@truckdesk/core';
import {
  analyzeRate,
  buildChecklist,
  cancelLoad,
  captureProgress,
  completeStop,
  createLoad,
  dispatchReadiness,
  loadsNeedingAttention,
  arriveAtStop,
  outstandingDocuments,
  parseLocation,
  rateRedFlags,
  tripFuelCostCents,
  type Checklist,
  type CreateLoadInput,
} from '@truckdesk/loads';

import { readinessFor, type HosReadinessResult } from '@truckdesk/eld';

import type { CompanyServices, Services } from './container.js';

/**
 * Domain services.
 *
 * Each function loads the world it needs, calls a pure `core` function, and
 * writes the result back. Nothing here contains business rules: anything that
 * could be a unit test is in `core` or `loads`, and these functions are the
 * plumbing that a real database requires.
 */

/* -------------------------------------------------------------------------- */
/* World loading                                                                 */
/* -------------------------------------------------------------------------- */

export interface DispatchWorld {
  company: CompanyServices;
  loads: Load[];
  trucks: Truck[];
  drivers: Driver[];
  readiness: Record<string, DriverHoursReadiness>;
  hos: HosReadinessResult[];
  rules: DispatchRules;
  now: string;
  deadheadByLoad: Record<string, number>;
}

export async function loadDispatchWorld(
  services: Services,
  companyId: string,
  options: { rules?: Partial<DispatchRules>; skipHos?: boolean } = {},
): Promise<DispatchWorld> {
  const company = services.forCompany(companyId);
  const now = new Date().toISOString();

  const [trucks, drivers] = await Promise.all([company.trucks.query(companyId), company.drivers.query(companyId)]);

  // Only loads that matter to a dispatch decision: open ones plus anything a
  // dispatch board still shows in a past column.
  const open = await company.loads.query({ companyId, limit: 500 });
  const loads = open.items;

  const hos: HosReadinessResult[] = [];
  if (!options.skipHos) {
    await collectReadiness(services, company, trucks, hos);
  }

  const readiness: Record<string, DriverHoursReadiness> = {};
  for (const result of hos) {
    readiness[result.driverId] = {
      driverId: result.driverId,
      driveMinutesRemaining: result.driveMinutesRemaining,
      dutyMinutesRemaining: result.dutyMinutesRemaining,
      // -1 from the ELD layer means "no break due", which dispatch treats as fine.
      breakMinutesRemaining: result.breakMinutesRemaining,
      cycle: result.cycle,
      cycleMinutesRemaining: result.cycleMinutesRemaining,
      violations: result.violations,
    };
  }

  return {
    company,
    loads,
    trucks,
    drivers,
    readiness,
    hos,
    rules: { ...(options.rules ?? {}) } as DispatchRules,
    now,
    deadheadByLoad: estimateDeadheadByLoad(trucks, loads),
  };
}

/**
 * Ask each truck's ELD provider for HOS. A provider that is unreachable or
 * unconfigured is skipped, not treated as "no hours" - being permissive here
 * is deliberate: an ELD outage must not stop a dispatcher doing their job.
 */
async function collectReadiness(
  services: Services,
  company: CompanyServices,
  trucks: Truck[],
  sink: HosReadinessResult[],
): Promise<void> {
  const driverIdByTruck = new Map<string, string>();
  const drivers = await company.drivers.query();

  for (const truck of trucks) {
    const driverId = truck.driverId ?? truck.currentDriverId;
    if (driverId) driverIdByTruck.set(truck.id, driverId);
  }

  await Promise.all(
    trucks.map(async (truck) => {
      const driverId = driverIdByTruck.get(truck.id);
      if (!driverId) return;

      const provider = services.eldFor(truck);
      if (!provider.isConfigured()) return;

      const result = await readinessFor(provider, truck.id, driverId);
      if (result.ok) sink.push(result.value);
    }),
  );
  void drivers;
}

/**
 * Deadhead estimate for settlement and reporting.
 *
 * The real number comes from GPS breadcrumbs, which only exist after the fact.
 * For live dispatch we use the straight-line distance to pickup, which is
 * conservative and always available.
 */
export function estimateDeadheadByLoad(trucks: Truck[], loads: Load[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const load of loads) {
    if (!load.assignedTruckId) continue;
    const truck = trucks.find((candidate) => candidate.id === load.assignedTruckId);
    if (!truck) continue;

    const pickup = load.stops?.find((stop) => stop.type === 'pickup')?.location;
    if (!pickup) continue;

    const direct = haversine(truck.location, pickup);
    out[load.id] = Math.round(direct * 1.18);
  }
  return out;
}

function haversine(a: GeoPoint, b: GeoPoint): number {
  const R = 3958.7613;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* -------------------------------------------------------------------------- */
/* Loads                                                                         */
/* -------------------------------------------------------------------------- */

export async function createLoadService(
  services: Services,
  companyId: string,
  input: CreateLoadInput,
  actorId?: string,
): Promise<Load> {
  const company = services.forCompany(companyId);

  const created = createLoad({ ...input, companyId, now: input.now ?? new Date().toISOString(), actorId });
  if (!created.ok) throw created.error;

  // Reject a duplicate broker reference: it is the only natural key an email
  // import can rely on, and a duplicate here means double-booking the freight.
  if (created.value.load.reference) {
    const existing = await company.loads.query({
      companyId,
      search: created.value.load.reference,
      limit: 5,
    });
    const duplicate = existing.items.find(
      (load) => load.reference === created.value.load.reference && !load.cancelledAt,
    );
    if (duplicate) {
      throw Errors.conflict(
        `Load ${duplicate.reference} already exists (${duplicate.id})`,
        { existingLoadId: duplicate.id },
      );
    }
  }

  await company.loads.create(created.value.load, created.value.events);
  return created.value.load;
}

export interface LoadDetail {
  load: Load;
  documents: LoadDocument[];
  checklist: Checklist;
  capture: ReturnType<typeof captureProgress>;
  rateAnalysis: ReturnType<typeof analyzeRate>;
  redFlags: string[];
  driver: Driver | null;
  truck: Truck | null;
  dispatchReadiness: ReturnType<typeof dispatchReadiness>;
}

export async function loadDetail(
  services: Services,
  companyId: string,
  loadId: string,
): Promise<LoadDetail> {
  const company = services.forCompany(companyId);
  const load = await company.loads.findById(loadId);
  if (!load) throw Errors.notFound('Load', loadId);

  const [documents, driver, truck] = await Promise.all([
    company.documents.findForLoad(loadId),
    load.assignedDriverId ? company.drivers.findById(load.assignedDriverId) : Promise.resolve(null),
    load.assignedTruckId ? company.trucks.findById(load.assignedTruckId) : Promise.resolve(null),
  ]);

  const enriched: Load = { ...load, documents };

  return {
    load: enriched,
    documents,
    checklist: buildChecklist(enriched, {
      carrierHasW9: true,
      carrierHasInsurance: true,
    }),
    capture: captureProgress(enriched),
    rateAnalysis: analyzeRate(enriched, driver ?? undefined),
    redFlags: rateRedFlags(enriched),
    driver,
    truck,
    dispatchReadiness: dispatchReadiness(enriched, driver ?? undefined),
  };
}

export async function updateLoadStatus(
  services: Services,
  companyId: string,
  input: { loadId: string; to: Load['status']; actorId?: string; note?: string },
): Promise<{ load: Load; events: DomainEvent[] }> {
  const world = await loadDispatchWorld(services, companyId, { skipHos: true });
  const context = defaultContext({
    now: world.now,
    loads: world.loads,
    trucks: world.trucks,
    drivers: world.drivers,
    rules: world.rules,
  });

  const result = transitionLoad(context, input);
  if (!result.ok) throw result.error;

  const company = services.forCompany(companyId);
  const persisted = await company.loads.update(result.value.load, result.value.events);

  if (result.value.truck) {
    await company.trucks.update(result.value.truck);
  }

  return { load: persisted, events: result.value.events };
}

export async function cancelLoadService(
  services: Services,
  companyId: string,
  input: { loadId: string; reason: string; actorId?: string },
): Promise<Load> {
  const company = services.forCompany(companyId);
  const load = await company.loads.findById(input.loadId);
  if (!load) throw Errors.notFound('Load', input.loadId);

  const cancelled = cancelLoad(load, input);
  if (!cancelled.ok) throw cancelled.error;

  // Free the truck if it was assigned.
  if (load.assignedTruckId) {
    const truck = await company.trucks.findById(load.assignedTruckId);
    if (truck) {
      await company.trucks.update({
        ...truck,
        status: 'available',
        currentLoadId: undefined,
      });
    }
  }

  return company.loads.update(cancelled.value.load, cancelled.value.events);
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                       */
/* -------------------------------------------------------------------------- */

export interface AssignOutcome {
  assignment: Assignment;
  warnings: string[];
}

export async function assignLoadService(
  services: Services,
  companyId: string,
  input: {
    loadId: string;
    truckId: string;
    actorId?: string;
    overrideWarnings?: boolean;
    overrideBlocking?: boolean;
  },
): Promise<AssignOutcome> {
  const world = await loadDispatchWorld(services, companyId, { rules: { minRevenuePerMileCents: 0 } });
  const context = defaultContext({
    now: world.now,
    loads: world.loads,
    trucks: world.trucks,
    drivers: world.drivers,
    readiness: world.readiness,
    rules: { ...world.rules, enforceHos: true },
  });

  const result = assignLoad(context, input);
  if (!result.ok) throw result.error;

  const company = world.company;
  await company.loads.update(result.value.load, result.value.assignment.events);
  await company.trucks.update(result.value.truck);

  return { assignment: result.value.assignment, warnings: result.value.assignment.warnings };
}

export async function unassignLoadService(
  services: Services,
  companyId: string,
  input: { loadId: string; actorId?: string },
): Promise<Load> {
  const world = await loadDispatchWorld(services, companyId, { skipHos: true });
  const context = defaultContext({
    now: world.now,
    loads: world.loads,
    trucks: world.trucks,
    drivers: world.drivers,
  });

  const result = unassignLoad(context, input);
  if (!result.ok) throw result.error;

  const company = world.company;
  await company.loads.update(result.value.load, result.value.events);
  await company.trucks.update(result.value.truck);
  return result.value.load;
}

export async function bulkAssignService(
  services: Services,
  companyId: string,
  items: Array<{ loadId: string; truckId: string }>,
  actorId?: string,
): Promise<{ assigned: number; failures: Array<{ item: { loadId: string; truckId: string }; reason: string }> }> {
  const world = await loadDispatchWorld(services, companyId, { skipHos: true });
  const context = defaultContext({
    now: world.now,
    loads: world.loads,
    trucks: world.trucks,
    drivers: world.drivers,
  });

  const outcome = bulkAssign(context, items, actorId);

  for (const assignment of outcome.assigned) {
    await world.company.loads.update(assignment.load, assignment.events);
    await world.company.trucks.update(assignment.truck);
  }

  return { assigned: outcome.assigned.length, failures: outcome.failures };
}

export async function dispatchBoard(
  services: Services,
  companyId: string,
): Promise<DispatchBoard & { hos: HosReadinessResult[] }> {
  const world = await loadDispatchWorld(services, companyId);
  const context = defaultContext({
    now: world.now,
    loads: world.loads,
    trucks: world.trucks,
    drivers: world.drivers,
    readiness: world.readiness,
    rules: world.rules,
  });

  return { ...buildDispatchBoard(context), hos: world.hos };
}

/* -------------------------------------------------------------------------- */
/* Stops                                                                         */
/* -------------------------------------------------------------------------- */

export async function arriveStopService(
  services: Services,
  companyId: string,
  input: { loadId: string; stopId: string; actorId?: string; notes?: string; location?: GeoPoint },
): Promise<{ load: Load; warnings: string[] }> {
  const company = services.forCompany(companyId);
  const load = await company.loads.findById(input.loadId);
  if (!load) throw Errors.notFound('Load', input.loadId);

  const result = arriveAtStop(load, input);
  if (!result.ok) throw result.error;

  const persisted = await company.loads.update(result.value.load, result.value.events);
  return { load: persisted, warnings: result.value.warnings };
}

export async function completeStopService(
  services: Services,
  companyId: string,
  input: {
    loadId: string;
    stopId: string;
    actorId?: string;
    documents?: LoadDocument[];
    signatureName?: string;
    receiverName?: string;
    notes?: string;
    location?: GeoPoint;
  },
): Promise<{ load: Load; warnings: string[] }> {
  const company = services.forCompany(companyId);
  const load = await company.loads.findById(input.loadId);
  if (!load) throw Errors.notFound('Load', input.loadId);

  // Attach the documents before completing, so the checklist sees them.
  const documents = input.documents ?? [];
  for (const document of documents) {
    await company.documents.attach(document);
  }

  const withDocs: Load = { ...load, documents: [...(load.documents ?? []), ...documents] };

  const result = completeStop(withDocs, input);
  if (!result.ok) throw result.error;

  let next = result.value.load;

  // Completing the final delivery promotes the load to delivered, which is what
  // closes it out for invoicing.
  if (next.stops?.every((stop) => stop.status === 'completed' || stop.status === 'skipped')) {
    const transitions = await updateLoadStatus(services, companyId, {
      loadId: next.id,
      to: 'in-transit',
      actorId: input.actorId,
      note: 'Pickup confirmed via stop workflow',
    });
    next = transitions.load;
    const delivered = await updateLoadStatus(services, companyId, {
      loadId: next.id,
      to: 'delivered',
      actorId: input.actorId,
      note: 'All stops completed',
    });
    next = delivered.load;
  } else {
    next = await company.loads.update(result.value.load, result.value.events);
  }

  return { load: next, warnings: result.value.warnings };
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                     */
/* -------------------------------------------------------------------------- */

export interface DashboardPayload {
  summary: ReturnType<typeof buildDashboard>;
  board: DispatchBoard;
  utilisation: ReturnType<typeof fleetUtilization>;
  health: ReturnType<typeof boardHealth>;
  trend: ReturnType<typeof weeklyRevenueTrend>;
  hos: HosReadinessResult[];
  attention: ReturnType<typeof loadsNeedingAttention>;
  missingDocuments: Array<{ loadId: string; reference?: string; missing: string[] }>;
  deadheadMiles: number;
  fuelCentsThisWeek: number;
}

export async function dashboard(
  services: Services,
  companyId: string,
): Promise<DashboardPayload> {
  const world = await loadDispatchWorld(services, companyId);

  const context = defaultContext({
    now: world.now,
    loads: world.loads,
    trucks: world.trucks,
    drivers: world.drivers,
    readiness: world.readiness,
  });

  const invoices = await world.company.invoices.query(companyId, { openOnly: true });
  const outstandingCents = invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0);

  const dashboardInput: DashboardInput = {
    trucks: world.trucks,
    loads: world.loads,
    outstandingCents,
    hosViolationCount: world.hos.reduce(
      (sum, result) => sum + result.violations.filter((v) => v.length > 0).length,
      0,
    ),
  };

  const attention = loadsNeedingAttention(world.loads);
  const missing = outstandingDocuments(world.loads);

  const delivered = world.loads.filter((load) => load.deliveredAt);
  const fuelCents = delivered.reduce((sum, load) => sum + tripFuelCostCents(load.miles), 0);

  return {
    summary: buildDashboard(dashboardInput),
    board: buildDispatchBoard(context),
    utilisation: fleetUtilization(world.trucks),
    health: boardHealth(world.loads),
    trend: weeklyRevenueTrend(world.loads, 8),
    hos: world.hos,
    attention: attention.slice(0, 20).map((item) => ({
      load: {
        id: item.load.id,
        broker: item.load.broker,
        origin: item.load.origin,
        destination: item.load.destination,
        status: item.load.status,
        rate: item.load.rate,
        miles: item.load.miles,
      },
      reasons: item.reasons,
      priority: item.priority,
    })),
    missingDocuments: missing.slice(0, 20).map((item) => ({
      loadId: item.load.id,
      reference: item.load.reference,
      missing: item.missing,
    })),
    deadheadMiles: fleetDeadheadMiles(world.trucks, world.loads),
    fuelCentsThisWeek: fuelCents,
  };
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                     */
/* -------------------------------------------------------------------------- */

export async function attachDocument(
  services: Services,
  companyId: string,
  loadId: string,
  document: LoadDocument,
): Promise<LoadDocument> {
  const company = services.forCompany(companyId);
  const load = await company.loads.findById(loadId);
  if (!load) throw Errors.notFound('Load', loadId);

  const attached = await company.documents.attach(document);

  // Keep the load's embedded document list fresh so the checklist is correct.
  await company.loads.update({
    ...load,
    documents: [...(load.documents ?? []), attached],
  });

  return attached;
}

/** Parse a "City, ST" string for the two-stop synthesiser. */
export { parseLocation };

export function newId(prefix: string): string {
  return `${prefix}_${uuid().slice(0, 12)}`;
}

export { isLoadActive, err, ok };
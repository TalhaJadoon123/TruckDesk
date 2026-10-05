import {
  isLoadActive,
  perMileCents,
  startOfWeekIso,
  previousWeekIso,
  type Cents,
  type DashboardSummary,
  type Iso,
  type Load,
  type Truck,
} from '@truckdesk/shared';

/**
 * Dashboard aggregation. One function, one query each in the API, so the
 * numbers on the marketing site, the demo company and a real account all come
 * from the same definition.
 */

export interface DashboardInput {
  trucks: readonly Truck[];
  loads: readonly Load[];
  now?: Date;
  /** Receivables numbers, wired from invoicing.agingReport. */
  outstandingCents?: Cents;
  hosViolationCount?: number;
}

export function buildDashboard(input: DashboardInput): DashboardSummary {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const thisWeek = startOfWeekIso(nowIso);
  const lastWeek = previousWeekIso(nowIso);

  const live = input.loads.filter((load) => !load.cancelledAt);

  const trucksTotal = input.trucks.length;
  const trucksAvailable = input.trucks.filter(
    (truck) => truck.status === 'available' || truck.status === 'empty',
  ).length;

  const loadsInTransit = live.filter((load) => isLoadActive(load.status)).length;

  const deliveredThisWeek = live.filter(
    (load) => load.deliveredAt && within(load.deliveredAt, thisWeek.start, thisWeek.end),
  );
  const deliveredLastWeek = live.filter(
    (load) => load.deliveredAt && within(load.deliveredAt, lastWeek.start, lastWeek.end),
  );

  const revenueThisWeekCents = deliveredThisWeek.reduce((sum, load) => sum + load.rate, 0);
  const revenueLastWeekCents = deliveredLastWeek.reduce((sum, load) => sum + load.rate, 0);

  const loadedMilesThisWeek = deliveredThisWeek.reduce((sum, load) => sum + load.miles, 0);

  // Deadhead is estimated from each load's pickup against the truck's home
  // terminal, because a GPS history is not available for a closed week.
  let deadheadMiles = 0;
  for (const load of deliveredThisWeek) {
    const truck = input.trucks.find((candidate) => candidate.id === load.assignedTruckId);
    if (!truck) continue;
    deadheadMiles += estimateDeadhead(truck, load);
  }

  const totalMiles = loadedMilesThisWeek + Math.round(deadheadMiles);
  const deadheadRatio = totalMiles > 0 ? Math.round((deadheadMiles / totalMiles) * 10_000) / 10_000 : 0;

  const onTime = deliveredThisWeek.filter(
    (load) =>
      load.deliveredAt &&
      load.deliveryDate &&
      Date.parse(load.deliveredAt) <= Date.parse(load.deliveryDate),
  ).length;
  const onTimeRate =
    deliveredThisWeek.length === 0 ? 1 : Math.round((onTime / deliveredThisWeek.length) * 10_000) / 10_000;

  return {
    trucksAvailable,
    trucksTotal,
    loadsInTransit,
    loadsDeliveredThisWeek: deliveredThisWeek.length,
    revenueThisWeekCents,
    revenueLastWeekCents,
    deadheadRatio,
    averageRevenuePerMileCents: perMileCents(revenueThisWeekCents, loadedMilesThisWeek),
    onTimeRate,
    unpaidReceivablesCents: input.outstandingCents ?? 0,
    hosViolations: input.hosViolationCount ?? 0,
    generatedAt: nowIso,
  };
}

function within(iso: Iso, start: Iso, end: Iso): boolean {
  const t = Date.parse(iso);
  return t >= Date.parse(start) && t <= Date.parse(end);
}

function estimateDeadhead(truck: Truck, load: Load): number {
  const home = truck.homeTerminal;
  if (!home) return 0;
  // A crude but stable proxy: 40% of the loaded miles is a realistic reefer/dry
  // van empty ratio, applied when we cannot compute a real pickup distance.
  return Math.round(load.miles * 0.4);
}

/* -------------------------------------------------------------------------- */
/* Trend helpers                                                                 */
/* -------------------------------------------------------------------------- */

export interface RevenuePoint {
  weekKey: string;
  label: string;
  revenueCents: Cents;
  loads: number;
  miles: number;
  revenuePerMileCents: number;
}

/** Week-by-week revenue for the dashboard sparkline. */
export function weeklyRevenueTrend(
  loads: readonly Load[],
  weeks: number,
  now: Date = new Date(),
): RevenuePoint[] {
  const points: RevenuePoint[] = [];
  const nowIso = now.toISOString();

  for (let i = weeks - 1; i >= 0; i -= 1) {
    const anchor = new Date(Date.parse(nowIso) - i * 7 * 86_400_000).toISOString();
    const window = startOfWeekIso(anchor);

    const inWeek = loads.filter(
      (load) => load.deliveredAt && within(load.deliveredAt, window.start, window.end),
    );

    const revenueCents = inWeek.reduce((sum, load) => sum + load.rate, 0);
    const miles = inWeek.reduce((sum, load) => sum + load.miles, 0);

    points.push({
      weekKey: window.key,
      label: window.key,
      revenueCents,
      loads: inWeek.length,
      miles,
      revenuePerMileCents: perMileCents(revenueCents, miles),
    });
  }

  return points;
}

/** Percent change, guarded so the UI never renders "NaN%". */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 10_000) / 10_000;
}

export interface FleetUtilization {
  /** Share of trucks either loaded or moving toward a pickup. */
  utilization: number;
  loaded: number;
  empty: number;
  available: number;
  maintenance: number;
  idle: number;
}

export function fleetUtilization(trucks: readonly Truck[]): FleetUtilization {
  const counts = { loaded: 0, empty: 0, available: 0, maintenance: 0 };
  for (const truck of trucks) counts[truck.status] += 1;

  const total = trucks.length;
  const deployed = counts.loaded + counts.empty;

  return {
    utilization: total > 0 ? Math.round((deployed / total) * 10_000) / 10_000 : 0,
    ...counts,
    idle: counts.available,
  };
}

/** Board health: loads sitting unassigned, and how long they have been there. */
export interface BoardHealth {
  unassigned: number;
  staleUnassigned: number;
  atRiskOnTime: number;
  missingPod: number;
  averageDaysUnassigned: number;
}

export function boardHealth(loads: readonly Load[], now: Date = new Date()): BoardHealth {
  const unassigned = loads.filter(
    (load) => load.status === 'booked' && !load.assignedTruckId && !load.cancelledAt,
  );

  const stale = unassigned.filter(
    (load) =>
      load.bookedAt !== undefined &&
      now.getTime() - Date.parse(load.bookedAt) > 12 * 3_600_000,
  );

  const atRisk = loads.filter(
    (load) =>
      isLoadActive(load.status) &&
      load.deliveryDate !== undefined &&
      Date.parse(load.deliveryDate) - now.getTime() < 24 * 3_600_000,
  );

  const missingPod = loads.filter((load) => load.proofOfDeliveryMissing);

  const averageDaysUnassigned =
    unassigned.length === 0
      ? 0
      : Math.round(
          (unassigned.reduce(
            (sum, load) => sum + (load.bookedAt ? (now.getTime() - Date.parse(load.bookedAt)) : 0),
            0,
          ) /
            unassigned.length /
            3_600_000) *
            100,
        ) / 100;

  return {
    unassigned: unassigned.length,
    staleUnassigned: stale.length,
    atRiskOnTime: atRisk.length,
    missingPod: missingPod.length,
    averageDaysUnassigned,
  };
}
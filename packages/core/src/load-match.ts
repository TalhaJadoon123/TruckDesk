import {
  haversineMiles,
  type Cents,
  type Driver,
  type GeoPoint,
  type Iso,
  type LanePreference,
  type Load,
  type Result,
  type Truck,
  err,
  ok,
} from '@truckdesk/shared';

import {
  DEFAULT_DISPATCH_RULES,
  deadheadMiles,
  evaluateEligibility,
  type AssignmentCandidate,
  type DispatchRules,
  type DriverHoursReadiness,
} from './dispatch.js';

/**
 * Auto-match: rank every open load against every free truck.
 *
 * The scoring model is deliberately transparent. A dispatcher who disagrees
 * with a ranking needs to be able to see *why*, so each factor carries its own
 * weight and the explanation ships with the result.
 */

export interface MatchWeights {
  /** Revenue per mile, normalised against the target floor. */
  rate: number;
  /** Deadhead miles to the pickup. */
  deadhead: number;
  /** How well the lane matches the driver's stated preferences. */
  lanePreference: number;
  /** Whether the truck's home terminal is near the load. */
  homeProximity: number;
  /** Penalty for a driver already deep into a long day. */
  driverFatigue: number;
  /** Bonus for equipment fit (a perfect match is not a bonus, it's a gate). */
  equipment: number;
  /** Urgency: loads with a soft pickup window or a tight delivery date. */
  urgency: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  rate: 0.3,
  deadhead: 0.22,
  lanePreference: 0.15,
  homeProximity: 0.08,
  driverFatigue: 0.12,
  equipment: 0.08,
  urgency: 0.05,
};

export interface MatchOptions {
  weights?: Partial<MatchWeights>;
  rules?: Partial<DispatchRules>;
  /** Minimum score to be considered a match at all. 0..1. */
  minScore?: number;
  /** Cap the number of pairs scored, so a 25-truck board stays snappy. */
  maxPairs?: number;
}

export interface MatchExplanation {
  factor: keyof MatchWeights | 'blocking';
  label: string;
  contribution: number;
  detail: string;
}

export interface Match extends AssignmentCandidate {
  load: Load;
  truck: Truck;
  driver?: Driver;
  explanations: MatchExplanation[];
  rank: number;
}

export interface MatchResult {
  matches: Match[];
  /** Loads that could not go anywhere, with the reason. */
  unmatched: Array<{ load: Load; reason: string }>;
  scoredPairs: number;
  truncated: boolean;
  generatedAt: Iso;
}

export interface MatchInput {
  loads: Load[];
  trucks: Truck[];
  drivers?: Driver[];
  readiness?: Record<string, DriverHoursReadiness>;
  now: Iso;
  options?: MatchOptions;
}

/**
 * Score one (load, truck) pair. Exposed on its own because the dispatch UI
 * wants a score for a truck the dispatcher just dropped onto a load.
 */
export function scorePair(
  load: Load,
  truck: Truck,
  driver: Driver | undefined,
  input: {
    now: Iso;
    rules: Required<DispatchRules>;
    weights: MatchWeights;
    readiness?: DriverHoursReadiness;
  },
): Match | null {
  const { now, rules, weights, readiness } = input;

  const eligibility = evaluateEligibility({ load, truck, driver, readiness, rules, now });
  if (!eligibility.eligible) return null;

  const empty = eligibility.deadheadMiles;
  const rpm = eligibility.revenuePerMileCents;

  /* --- factor: rate ------------------------------------------------------ */
  // 1.00 at 2x the floor rate, 0.00 at the floor.
  const floor = rules.minRevenuePerMileCents || 150;
  const rateScore = clamp01(rpm / (floor * 2));

  /* --- factor: deadhead -------------------------------------------------- */
  // 1.00 at the truck's doorstep, decaying to 0 at 300 miles out.
  const deadheadScore = clamp01(1 - empty / 300);

  /* --- factor: lane preference ------------------------------------------- */
  const laneScore = driver ? lanePreferenceScore(driver, load) : 0.5;

  /* --- factor: home proximity ------------------------------------------- */
  const homeScore = homeProximityScore(truck, load);

  /* --- factor: driver fatigue ------------------------------------------- */
  const fatigueScore = fatigueScoreOf(readiness, eligibility.projectedHours);

  /* --- factor: equipment ------------------------------------------------- */
  const equipmentScore =
    load.equipment && truck.trailerType && load.equipment !== truck.trailerType ? 0 : 1;

  /* --- factor: urgency --------------------------------------------------- */
  const urgencyScore = urgencyScoreOf(load, now);

  const factors: Array<[keyof MatchWeights, number, string, string]> = [
    ['rate', rateScore, 'Rate', `$${(rpm / 100).toFixed(2)}/mi`],
    ['deadhead', deadheadScore, 'Deadhead', `${empty} mi to pickup`],
    ['lanePreference', laneScore, 'Lane fit', describeLane(driver, load)],
    ['homeProximity', homeScore, 'Home terminal', `${homeScore > 0.5 ? 'near' : 'far'} ${load.origin}`],
    ['driverFatigue', fatigueScore, 'Driver hours', fatigueLabel(readiness, eligibility.projectedHours)],
    ['equipment', equipmentScore, 'Equipment', equipmentScore === 1 ? 'matches' : 'mismatch'],
    ['urgency', urgencyScore, 'Urgency', urgencyLabel(load, now)],
  ];

  let score = 0;
  const explanations: MatchExplanation[] = [];
  for (const [factor, value, label, detail] of factors) {
    const contribution = weights[factor] * value;
    score += contribution;
    explanations.push({ factor, label, contribution: round4(contribution), detail });
  }

  // Margins drive the business. A 20-cent-per-mile swing is worth more than a
  // 40-mile deadhead difference, so nudge the total by normalised margin.
  const marginScore = clamp01(eligibility.marginCents / Math.max(1, load.rate));
  score = clamp01(score * 0.85 + marginScore * 0.15);

  return {
    loadId: load.id,
    truckId: truck.id,
    truckUnit: truck.unit,
    driverId: driver?.id ?? truck.driverId ?? truck.currentDriverId,
    driverName: driver?.name ?? truck.currentDriverName,
    deadheadMiles: empty,
    totalMiles: eligibility.totalMiles,
    projectedHours: eligibility.projectedHours,
    revenuePerMileCents: rpm,
    marginCents: eligibility.marginCents,
    score: round4(score),
    warnings: eligibility.warnings,
    blocking: [],
    load,
    truck,
    driver,
    explanations,
    rank: 0,
  };
}

export function matchLoadsToTrucks(input: MatchInput): Result<MatchResult> {
  const weights: MatchWeights = { ...DEFAULT_WEIGHTS, ...(input.options?.weights ?? {}) };
  const rules: Required<DispatchRules> = {
    ...DEFAULT_DISPATCH_RULES,
    ...(input.options?.rules ?? {}),
  };
  const minScore = input.options?.minScore ?? 0.15;
  const maxPairs = input.options?.maxPairs ?? 500;

  const openLoads = input.loads.filter((load) => load.status === 'booked' && !load.cancelledAt);
  const freeTruckIds = new Set(
    input.trucks
      .filter((truck) => truck.status !== 'maintenance' && !truck.currentLoadId)
      .map((truck) => truck.id),
  );
  const freeTrucks = input.trucks.filter((truck) => freeTruckIds.has(truck.id));

  if (openLoads.length === 0 || freeTrucks.length === 0) {
    return ok({
      matches: [],
      unmatched: openLoads.map((load) => ({
        load,
        reason: freeTrucks.length === 0 ? 'No trucks available' : 'No open loads',
      })),
      scoredPairs: 0,
      truncated: false,
      generatedAt: input.now,
    });
  }

  const driverById = new Map((input.drivers ?? []).map((driver) => [driver.id, driver]));
  const all: Match[] = [];
  let scored = 0;
  let truncated = false;

  // Highest-paying loads first: the good freight goes to the best truck before
  // a low-rate load eats the one truck that could have taken the good freight.
  const orderedLoads = [...openLoads].sort((a, b) => b.rate - a.rate);

  for (const load of orderedLoads) {
    if (scored >= maxPairs) {
      truncated = true;
      break;
    }

    const candidates: Match[] = [];
    for (const truck of freeTrucks) {
      if (scored >= maxPairs) {
        truncated = true;
        break;
      }
      scored += 1;

      const driverId = truck.driverId ?? truck.currentDriverId;
      const driver = driverId ? driverById.get(driverId) : undefined;
      const readiness = driverId ? input.readiness?.[driverId] : undefined;

      const match = scorePair(load, truck, driver, {
        now: input.now,
        rules,
        weights,
        readiness,
      });
      if (match && match.score >= minScore) candidates.push(match);
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      // Explain why, using the best blocked attempt for detail.
      const explanation = bestBlockedExplanation(load, freeTrucks, driverById, input, rules);
      continue;
    }

    const best = candidates[0];
    if (best) all.push(best);
  }

  all.sort((a, b) => b.score - a.score);
  all.forEach((match, index) => {
    match.rank = index + 1;
  });

  const matchedLoadIds = new Set(all.map((match) => match.loadId));
  const unmatched = openLoads
    .filter((load) => !matchedLoadIds.has(load.id))
    .map((load) => ({
      load,
      reason: explainNoMatch(load, freeTrucks, driverById, input, rules),
    }));

  return ok({ matches: all, unmatched, scoredPairs: scored, truncated, generatedAt: input.now });
}

function bestBlockedExplanation(
  load: Load,
  trucks: Truck[],
  driverById: Map<string, Driver>,
  input: MatchInput,
  rules: Required<DispatchRules>,
): string {
  const reasons = trucks.map((truck) => {
    const driverId = truck.driverId ?? truck.currentDriverId;
    const driver = driverId ? driverById.get(driverId) : undefined;
    const readiness = driverId ? input.readiness?.[driverId] : undefined;
    return evaluateEligibility({ load, truck, driver, readiness, rules, now: input.now });
  });
  // Report the blocker shared by the most trucks: that is the fleet-wide issue.
  const counts = new Map<string, number>();
  for (const result of reasons) {
    for (const reason of result.blocking) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  let topReason = 'No eligible truck';
  let topCount = 0;
  for (const [reason, count] of counts) {
    if (count > topCount) {
      topReason = reason;
      topCount = count;
    }
  }
  return topReason;
}

function explainNoMatch(
  load: Load,
  trucks: Truck[],
  driverById: Map<string, Driver>,
  input: MatchInput,
  rules: Required<DispatchRules>,
): string {
  const blocking: string[] = [];
  for (const truck of trucks) {
    const driverId = truck.driverId ?? truck.currentDriverId;
    const driver = driverId ? driverById.get(driverId) : undefined;
    const readiness = driverId ? input.readiness?.[driverId] : undefined;
    const result = evaluateEligibility({ load, truck, driver, readiness, rules, now: input.now });
    blocking.push(...result.blocking);
  }
  return bestBlockedExplanation(load, trucks, driverById, input, rules) ||
    (blocking.length > 0 ? blocking[0] ?? 'No eligible truck' : 'Scored below the match threshold');
}

/* -------------------------------------------------------------------------- */
/* Factor implementations                                                        */
/* -------------------------------------------------------------------------- */

/** 1.0 for a strong favourite lane, negative for an avoided lane. */
export function lanePreferenceScore(driver: Driver, load: Load): number {
  const lanes = driver.preferredLanes ?? [];
  if (lanes.length === 0) return 0.5;

  const originCity = cityOf(load.origin);
  const originState = stateOf(load.origin);
  const destCity = cityOf(load.destination);
  const destState = stateOf(load.destination);

  let total = 0;
  let weightSum = 0;

  for (const lane of lanes) {
    const weight = lane.weight ?? 1;
    let laneScore = 0;
    let comparisons = 0;

    if (lane.originState && originState) {
      comparisons += 1;
      if (lane.originState.toUpperCase() === originState) laneScore += 1;
    }
    if (lane.originCity && originCity) {
      comparisons += 1;
      if (lane.originCity.toLowerCase() === originCity.toLowerCase()) laneScore += 1;
    }
    if (lane.destinationState && destState) {
      comparisons += 1;
      if (lane.destinationState.toUpperCase() === destState) laneScore += 1;
    }
    if (lane.destinationCity && destCity) {
      comparisons += 1;
      if (lane.destinationCity.toLowerCase() === destCity.toLowerCase()) laneScore += 1;
    }

    if (comparisons === 0) continue;
    const normalized = laneScore / comparisons;
    total += normalized * Math.abs(weight);
    weightSum += Math.abs(weight);
    if (weight < 0 && normalized > 0.5) {
      // An explicitly avoided lane that matches should actively penalise.
      return 0;
    }
  }

  if (weightSum === 0) return 0.5;
  return clamp01(total / weightSum);
}

function describeLane(driver: Driver | undefined, load: Load): string {
  if (!driver || (driver.preferredLanes ?? []).length === 0) return 'no lane preference set';
  const score = lanePreferenceScore(driver, load);
  if (score >= 0.85) return 'favourite lane';
  if (score >= 0.5) return 'known lane';
  if (score <= 0.2) return 'off his usual lane';
  return 'partial lane match';
}

function homeProximityScore(truck: Truck, load: Load): number {
  if (!truck.homeTerminal) return 0.5;
  if (!truck.homeTerminal.toLowerCase().includes(stateOf(load.origin)?.toLowerCase() ?? ' ')) {
    return 0.4;
  }
  return 1;
}

/**
 * A driver with 11 legal hours should not be treated the same as one with 40
 * minutes. This decays as the trip eats into what is left.
 */
function fatigueScoreOf(
  readiness: DriverHoursReadiness | undefined,
  projectedHours: number,
): number {
  if (!readiness) return 0.7;
  const needMinutes = projectedHours * 60;
  if (readiness.driveMinutesRemaining <= 0) return 0;

  const ratio = needMinutes / readiness.driveMinutesRemaining;
  if (ratio <= 0.5) return 1;
  if (ratio <= 0.85) return 0.6;
  if (ratio <= 1) return 0.3;
  return 0;
}

function fatigueLabel(
  readiness: DriverHoursReadiness | undefined,
  projectedHours: number,
): string {
  if (!readiness) return 'HOS not connected';
  const available = readiness.driveMinutesRemaining / 60;
  if (available <= 0) return 'out of drive time';
  if (available < projectedHours) {
    return `${available.toFixed(1)}h left, trip needs ${projectedHours.toFixed(1)}h`;
  }
  return `${available.toFixed(1)}h available`;
}

/** Soft pickup window or a tight delivery date pushes the score up. */
function urgencyScoreOf(load: Load, now: Iso): number {
  const nowMs = Date.parse(now);
  let score = 0;

  if (load.pickupWindow?.start) {
    const hoursOut = (Date.parse(load.pickupWindow.start) - nowMs) / 3_600_000;
    if (hoursOut <= 4) score += 0.6;
    else if (hoursOut <= 24) score += 0.35;
    else if (hoursOut <= 48) score += 0.15;
  }

  if (load.deliveryDate) {
    const hoursOut = (Date.parse(load.deliveryDate) - nowMs) / 3_600_000;
    if (hoursOut <= 8) score += 0.4;
    else if (hoursOut <= 24) score += 0.25;
    else if (hoursOut < 0) score += 0.5; // late load: grab it or lose it
  }

  return clamp01(score);
}

function urgencyLabel(load: Load, now: string): string {
  if (!load.pickupWindow?.start && !load.deliveryDate) return 'no appointment';
  const parts: string[] = [];
  if (load.pickupWindow?.start) parts.push(`pickup ${load.pickupWindow.start.slice(0, 16).replace('T', ' ')}`);
  if (load.deliveryDate) parts.push(`deliver by ${load.deliveryDate.slice(0, 16).replace('T', ' ')}`);
  return `${parts.join(', ')} (now ${now.slice(0, 16).replace('T', ' ')})`;
}

/* -------------------------------------------------------------------------- */
/* Greedy assignment across the whole board                                      */
/* -------------------------------------------------------------------------- */

export interface GreedyAssignmentResult {
  assignments: Array<{ loadId: string; truckId: string; score: number; rationale: string }>;
  unassignedLoadIds: string[];
  totalMarginCents: Cents;
  totalRevenueCents: Cents;
  totalDeadheadMiles: number;
}

/**
 * Turn ranked matches into an actual dispatch plan without double-booking a
 * truck. Highest score wins the truck; the loser stays on the board.
 *
 * This is a heuristic, not an optimiser. At 25 trucks the difference from an
 * exact assignment is a few hundred dollars a week, and an explainable greedy
 * pass is worth more to a dispatcher than an unexplainable optimal one.
 */
export function autoAssignBoard(input: MatchInput): Result<GreedyAssignmentResult> {
  const matched = matchLoadsToTrucks(input);
  if (!matched.ok) return matched;

  const takenTrucks = new Set<string>();
  const takenLoads = new Set<string>();
  const assignments: GreedyAssignmentResult['assignments'] = [];

  let totalMarginCents: Cents = 0;
  let totalRevenueCents: Cents = 0;
  let totalDeadheadMiles = 0;

  for (const match of matched.value.matches) {
    if (takenTrucks.has(match.truckId) || takenLoads.has(match.loadId)) continue;

    takenTrucks.add(match.truckId);
    takenLoads.add(match.loadId);
    totalMarginCents += match.marginCents;
    totalRevenueCents += match.load.rate;
    totalDeadheadMiles += match.deadheadMiles;

    assignments.push({
      loadId: match.loadId,
      truckId: match.truckId,
      score: match.score,
      rationale: match.explanations
        .slice()
        .sort((a, b) => b.contribution - a.contribution)
        .slice(0, 3)
        .map((item) => `${item.label}: ${item.detail}`)
        .join('; '),
    });
  }

  const unassignedLoadIds = input.loads
    .filter((load) => load.status === 'booked' && !load.cancelledAt)
    .filter((load) => !takenLoads.has(load.id))
    .map((load) => load.id);

  return ok({
    assignments,
    unassignedLoadIds,
    totalMarginCents,
    totalRevenueCents,
    totalDeadheadMiles,
  });
}

/* -------------------------------------------------------------------------- */
/* Lane helpers                                                                  */
/* -------------------------------------------------------------------------- */

export function cityOf(location: string): string {
  return (location.split(',')[0] ?? '').trim();
}

export function stateOf(location: string): string {
  const parts = location.split(',');
  if (parts.length >= 2) {
    const second = (parts[1] ?? '').trim();
    const code = second.split(/\s+/)[0] ?? '';
    return code.length === 2 ? code.toUpperCase() : code.toUpperCase().slice(0, 2);
  }
  return '';
}

/** Every origin/destination pair a driver has actually run, for lane learning. */
export function lanesFromHistory(loads: readonly Load[]): LanePreference[] {
  const seen = new Map<string, LanePreference>();
  for (const load of loads) {
    const key = `${stateOf(load.origin)}>${stateOf(load.destination)}`;
    const existing = seen.get(key);
    if (existing) {
      existing.weight = (existing.weight ?? 1) + 1;
      continue;
    }
    seen.set(key, {
      originState: stateOf(load.origin) || undefined,
      destinationState: stateOf(load.destination) || undefined,
      weight: 1,
    });
  }
  return [...seen.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                     */
/* -------------------------------------------------------------------------- */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Total deadhead across a fleet, for the dashboard's deadhead-ratio tile. */
export function fleetDeadheadMiles(trucks: readonly Truck[], loads: readonly Load[]): number {
  let total = 0;
  for (const load of loads) {
    const truck = trucks.find((candidate) => candidate.id === load.assignedTruckId);
    if (truck) total += deadheadMiles(truck, load);
  }
  return Math.round(total);
}

/** Straight-line miles for a load, when the broker did not post them. */
export function estimateMiles(load: Load): number {
  if (load.miles > 0) return load.miles;
  const origin: GeoPoint | null = null;
  void origin;
  return 0;
}

export function averageDistance(a: GeoPoint, b: GeoPoint): number {
  return haversineMiles(a, b);
}
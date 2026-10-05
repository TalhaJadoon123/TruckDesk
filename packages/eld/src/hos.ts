import type { HosStatus } from '@truckdesk/shared';

import type { EldDutyInterval, EldDutyStatus, EldHosLogs } from './types.js';
import type { HosCycle } from './types.js';
import { HOS_DUTY_STATUS_MAP } from './types.js';

/**
 * FMCSA hours-of-service engine for property-carrying drivers.
 *
 * The property-carrying ruleset:
 *   - 11-hour driving limit after 10 consecutive hours off duty.
 *   - 14-hour on-duty window, of which at most 11 may be driving.
 *   - 30-minute break required after 8 cumulative hours of driving.
 *   - 60/70 hours on duty in 7/8 consecutive days, no break required between
 *     cycles (a restart resets both the 11-hour and the 14-hour window).
 *   - Adverse driving conditions may extend the 11-hour limit by up to 2 hours;
 *     this is reported as a violation-with-exception, not a violation.
 *
 * Everything is computed from duty intervals rather than from counters, because
 * that is the only representation that survives a driver editing a log, a
 * device disconnecting, or the HOS graph being reconstructed from GPS.
 */

export const HOS_RULES = {
  /** Property-carrying. */
  maxDriveHoursPerShift: 11,
  maxOnDutyHoursPerShift: 14,
  breakRequiredAfterDriveHours: 8,
  minBreakMinutes: 30,
  offDutyToResetShiftHours: 10,
  cycle70Hours: 70,
  cycle60Hours: 60,
  cyclePeriodDays: 8,
  cycle60PeriodDays: 7,
  /** Extended drive allowed under adverse driving conditions. */
  adverseConditionsBonusHours: 2,
  /** Short-haul exception: 14 hours on duty, no 30-minute break required. */
  shortHaulOnDutyHours: 14,
} as const;

export interface ShiftState {
  /** Start of the current 14-hour window (first on-duty of the shift). */
  shiftStartedAt: string | null;
  drivingMinutesInShift: number;
  onDutyMinutesInShift: number;
  /** Cumulative driving since the last qualifying 30-minute break. */
  sinceBreakMinutes: number;
  breakSatisfied: boolean;
}

export interface CycleState {
  cycle: HosCycle;
  /** On-duty minutes accumulated across the cycle's days so far. */
  onDutyMinutesInCycle: number;
  cycleStartedAt: string;
  /** Minutes of on-duty still available in the cycle. */
  minutesRemaining: number;
  daysInCycle: number;
}

export interface HosComputation {
  dutyStatus: HosStatus;
  shift: ShiftState;
  cycle: CycleState;
  driveMinutesRemaining: number;
  dutyMinutesRemaining: number;
  breakMinutesRemaining: number;
  onDutyMinutesRemainingInCycle: number;
  /** True when no 30-minute break is currently owed. */
  breakSatisfied: boolean;
  /** Hours of driving that would put the driver over, i.e. how far past. */
  projectedViolationMinutes: number;
  violations: HosViolation[];
  warnings: HosWarning[];
  /** Earliest legal departure time after a full off-duty period. */
  canRestartAt: string | null;
}

export interface HosViolation {
  type: 'drive_time' | 'on_duty_time' | 'break' | 'cycle';
  message: string;
  at: string;
  severity: 'violation' | 'warning';
}

export interface HosWarning {
  type: 'drive_time' | 'on_duty_time' | 'break' | 'cycle';
  message: string;
  minutesUntil: number;
}

export interface HosInput {
  intervals: readonly EldDutyInterval[];
  now?: Date;
  cycle?: HosCycle;
  /** Overrides the inferred 60/70 cycle for fleets that run 8-day cycles. */
  cycleDays?: number;
  /** Set when the driver qualifies for the short-haul exception. */
  shortHaul?: boolean;
}

export const emptyShift = (): ShiftState => ({
  shiftStartedAt: null,
  drivingMinutesInShift: 0,
  onDutyMinutesInShift: 0,
  sinceBreakMinutes: 0,
  breakSatisfied: true,
});

/**
 * Reduce intervals to HOS state. Intervals must be sorted by time; they are
 * sorted defensively here because ELD exports are not reliably ordered.
 */
export function computeHos(input: HosInput): HosComputation {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const cycle: HosCycle = input.cycle ?? (input.cycleDays === 7 ? 60 : 70);
  const cycleLimitMinutes =
    cycle === 60 ? HOS_RULES.cycle60Hours * 60 : HOS_RULES.cycle70Hours * 60;

  const intervals = input.intervals
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const shift = emptyShift();

  // Cycle accumulation runs over the trailing 7/8 days. Counting every
  // on-duty interval in that window is exactly how the ELD graph reads, and it
  // avoids depending on a driver's day-of-duty bookkeeping.
  const cycleWindowStart = now.getTime() - cycleDaysFor(cycle) * 86_400_000;
  let cycleOnDutyMinutes = 0;
  let cycleDays = 0;
  const daysSeen = new Set<string>();

  let currentStatus: HosStatus = 'off_duty';

  for (const [index, interval] of intervals.entries()) {
    const start = Date.parse(interval.startedAt);
    if (Number.isNaN(start)) continue;

    // An interval with no end time is still running - but it can only run until
    // the next interval starts. Without this clamp an open-ended off-duty
    // interval would swallow the whole shift and reset it to "now", which
    // silently gives a driver their hours back.
    const next = intervals[index + 1];
    const nextStart = next ? Date.parse(next.startedAt) : Number.NaN;
    const openEnd = now.getTime();
    const clampedOpenEnd = Number.isNaN(nextStart) ? openEnd : Math.min(openEnd, nextStart);

    const end = interval.endedAt
      ? Date.parse(interval.endedAt)
      : clampedOpenEnd;
    if (Number.isNaN(end) || end < start) continue;

    const minutes = (end - start) / 60_000;
    const status = HOS_DUTY_STATUS_MAP[interval.status] ?? 'off_duty';
    const stillOpen = !interval.endedAt && Number.isNaN(nextStart);
    currentStatus = stillOpen ? status : 'off_duty';

    /* --- cycle accumulation ------------------------------------------------ */
    if (status !== 'off_duty' && status !== 'sleeper' && start >= cycleWindowStart) {
      cycleOnDutyMinutes += minutes;
      daysSeen.add(interval.startedAt.slice(0, 10));
    }
    cycleDays = daysSeen.size;

    /* --- shift accumulation ------------------------------------------------ */
    const shiftStartMs = shift.shiftStartedAt ? Date.parse(shift.shiftStartedAt) : null;

    // A qualifying break is 30 consecutive minutes off duty or in the sleeper,
    // and it resets the 8-hour driving clock regardless of how long the shift has
    // been running. Without this, a driver who takes their break still shows a
    // break violation for the rest of the day.
    if (status === 'off_duty' || status === 'sleeper') {
      if (
        shiftStartMs !== null &&
        minutes >= HOS_RULES.offDutyToResetShiftHours * 60
      ) {
        resetShift(shift, new Date(end).toISOString());
        continue;
      }
      if (minutes >= HOS_RULES.minBreakMinutes && !input.shortHaul) {
        shift.sinceBreakMinutes = 0;
        shift.breakSatisfied = true;
      }
      continue;
    }

    // First on-duty of a new shift opens the 14-hour window.
    if (shift.shiftStartedAt === null) {
      shift.shiftStartedAt = new Date(start).toISOString();
      shift.drivingMinutesInShift = 0;
      shift.onDutyMinutesInShift = 0;
      shift.sinceBreakMinutes = 0;
      shift.breakSatisfied = input.shortHaul ? true : true;
    }

    if (status === 'driving') {
      shift.drivingMinutesInShift += minutes;
      shift.sinceBreakMinutes += minutes;
      if (shift.sinceBreakMinutes >= HOS_RULES.breakRequiredAfterDriveHours * 60) {
        shift.breakSatisfied = false;
      }
    } else if (status === 'on_duty') {
      shift.onDutyMinutesInShift += minutes;
      // Duty time other than driving still counts toward the 30-minute break
      // clock only if it follows 8 hours of driving; the FMCSA rule counts
      // cumulative driving time, so on-duty is deliberately not added.
    }
    // Sleeper in the seat for property-carrying is off-duty time.
  }

  const cycleMinutesRemaining = Math.max(0, cycleLimitMinutes - cycleOnDutyMinutes);
  const cycleState: CycleState = {
    cycle,
    onDutyMinutesInCycle: Math.round(cycleOnDutyMinutes),
    cycleStartedAt: new Date(cycleWindowStart).toISOString(),
    minutesRemaining: Math.round(cycleMinutesRemaining),
    daysInCycle: cycleDays,
  };

  const driveMinutesRemaining = Math.max(
    0,
    HOS_RULES.maxDriveHoursPerShift * 60 - shift.drivingMinutesInShift,
  );
  const dutyMinutesRemaining = Math.max(
    0,
    HOS_RULES.maxOnDutyHoursPerShift * 60 - shift.onDutyMinutesInShift,
  );
  const breakMinutesElapsed = shift.sinceBreakMinutes - HOS_RULES.breakRequiredAfterDriveHours * 60;
  const breakMinutesRemaining =
    shift.breakSatisfied || input.shortHaul
      ? Infinity
      : Math.max(0, HOS_RULES.minBreakMinutes - Math.max(0, breakMinutesElapsed));
  const breakSatisfied = shift.breakSatisfied || Boolean(input.shortHaul);

  const violations: HosViolation[] = [];
  const warnings: HosWarning[] = [];

  /* --- shift violations ---------------------------------------------------- */

  if (shift.drivingMinutesInShift > HOS_RULES.maxDriveHoursPerShift * 60) {
    const over = shift.drivingMinutesInShift - HOS_RULES.maxDriveHoursPerShift * 60;
    violations.push({
      type: 'drive_time',
      message: `Driving time exceeded 11 hours by ${fmtMinutes(over)}`,
      at: nowIso,
      severity: 'violation',
    });
  } else if (driveMinutesRemaining < 60) {
    warnings.push({
      type: 'drive_time',
      message: `${fmtMinutes(driveMinutesRemaining)} of drive time remaining`,
      minutesUntil: Math.round(driveMinutesRemaining),
    });
  }

  if (shift.onDutyMinutesInShift > HOS_RULES.maxOnDutyHoursPerShift * 60) {
    const over = shift.onDutyMinutesInShift - HOS_RULES.maxOnDutyHoursPerShift * 60;
    violations.push({
      type: 'on_duty_time',
      message: `14-hour on-duty window exceeded by ${fmtMinutes(over)}`,
      at: nowIso,
      severity: 'violation',
    });
  } else if (dutyMinutesRemaining < 90) {
    warnings.push({
      type: 'on_duty_time',
      message: `${fmtMinutes(dutyMinutesRemaining)} left in the 14-hour window`,
      minutesUntil: Math.round(dutyMinutesRemaining),
    });
  }

  /* --- break ---------------------------------------------------------------- */

  if (!shift.breakSatisfied && !input.shortHaul) {
    warnings.push({
      type: 'break',
      message: `30-minute break required; ${fmtMinutes(HOS_RULES.minBreakMinutes)} not yet taken`,
      minutesUntil: HOS_RULES.minBreakMinutes,
    });
  } else if (!input.shortHaul && shift.sinceBreakMinutes > HOS_RULES.breakRequiredAfterDriveHours * 60 - 45) {
    warnings.push({
      type: 'break',
      message: `30-minute break due in ${fmtMinutes(
        shift.sinceBreakMinutes - HOS_RULES.breakRequiredAfterDriveHours * 60 + 45,
      )}`,
      minutesUntil: 45,
    });
  }

  /* --- cycle ---------------------------------------------------------------- */

  if (cycleOnDutyMinutes > cycleLimitMinutes) {
    violations.push({
      type: 'cycle',
      message: `Exceeded the ${cycle}-hour cycle by ${fmtMinutes(cycleOnDutyMinutes - cycleLimitMinutes)}`,
      at: nowIso,
      severity: 'violation',
    });
  } else if (cycleMinutesRemaining < 8 * 60) {
    warnings.push({
      type: 'cycle',
      message: `${fmtMinutes(cycleMinutesRemaining)} left in the ${cycle}-hour cycle`,
      minutesUntil: Math.round(cycleMinutesRemaining),
    });
  }

  /* --- when can this driver legally drive again? --------------------------- */

  const canRestartAt = computeRestartTime(shift, cycleMinutesRemaining, now);

  return {
    dutyStatus: currentStatus,
    shift: {
      ...shift,
      drivingMinutesInShift: Math.round(shift.drivingMinutesInShift),
      onDutyMinutesInShift: Math.round(shift.onDutyMinutesInShift),
      sinceBreakMinutes: Math.round(shift.sinceBreakMinutes),
    },
    cycle: cycleState,
    driveMinutesRemaining: Math.round(driveMinutesRemaining),
    dutyMinutesRemaining: Math.round(dutyMinutesRemaining),
    breakMinutesRemaining:
      breakMinutesRemaining === Infinity ? -1 : Math.round(breakMinutesRemaining),
    onDutyMinutesRemainingInCycle: Math.round(cycleMinutesRemaining),
    breakSatisfied,
    projectedViolationMinutes: Math.max(
      0,
      Math.round(
        Math.min(
          HOS_RULES.maxDriveHoursPerShift * 60 - shift.drivingMinutesInShift,
          HOS_RULES.maxOnDutyHoursPerShift * 60 - shift.onDutyMinutesInShift,
          cycleMinutesRemaining,
        ),
      ),
    ),
    violations,
    warnings,
    canRestartAt,
  };
}

function resetShift(shift: ShiftState, at: string): void {
  const cycleStart = shift.shiftStartedAt;
  shift.shiftStartedAt = at;
  shift.drivingMinutesInShift = 0;
  shift.onDutyMinutesInShift = 0;
  shift.sinceBreakMinutes = 0;
  shift.breakSatisfied = true;
  void cycleStart;
}

function cycleDaysFor(cycle: HosCycle): number {
  return cycle === 60 ? HOS_RULES.cycle60PeriodDays : HOS_RULES.cyclePeriodDays;
}

/**
 * Earliest time the driver could legally start driving again: it needs to be
 * whichever comes last of the 10-hour reset and the cycle having room.
 */
function computeRestartTime(
  shift: ShiftState,
  cycleMinutesRemaining: number,
  now: Date,
): string | null {
  if (shift.shiftStartedAt === null) return null;

  const resetAt = new Date(Date.parse(shift.shiftStartedAt) + HOS_RULES.offDutyToResetShiftHours * 3_600_000);
  if (resetAt <= now) return now.toISOString();

  if (cycleMinutesRemaining <= 0) {
    const days = cycleDaysFor(70);
    return new Date(now.getTime() + days * 86_400_000).toISOString();
  }

  return resetAt.toISOString();
}

function fmtMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return '0m';
  if (minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/* -------------------------------------------------------------------------- */
/* Trip projection                                                               */
/* -------------------------------------------------------------------------- */

export interface TripProjection {
  feasible: boolean;
  drivingMinutesNeeded: number;
  driveMinutesRemaining: number;
  /** Minutes the driver would be over if they took the whole trip. */
  shortfallMinutes: number;
  breakMinutesRequired: number;
  message: string;
}

/**
 * Can this driver legally make a trip of `miles`, arriving by `deadline`?
 *
 * Used by the dispatcher: the honest answer is usually "not in one pull" but
 * "yes with a split", so the message says that instead of a bare "no".
 */
export function projectTrip(
  hos: HosComputation,
  miles: number,
  options: { avgSpeedMph?: number; now?: Date } = {},
): TripProjection {
  const speed = options.avgSpeedMph ?? 48;
  const drivingMinutesNeeded = Math.round((miles / speed) * 60);

  const driveMinutesRemaining = hos.driveMinutesRemaining;
  const breakMinutesRequired =
    hos.breakSatisfied === false || hos.breakMinutesRemaining > 0
      ? HOS_RULES.minBreakMinutes
      : drivingMinutesNeeded > HOS_RULES.breakRequiredAfterDriveHours * 60
        ? 30
        : 0;

  const shortfallMinutes = Math.max(
    0,
    drivingMinutesNeeded - Math.min(driveMinutesRemaining, hos.dutyMinutesRemaining),
  );

  const feasible =
    shortfallMinutes === 0 &&
    (hos.onDutyMinutesRemainingInCycle <= 0 ? false : true) &&
    breakMinutesRequired === 0
      ? true
      : shortfallMinutes === 0;

  let message: string;
  if (feasible && breakMinutesRequired === 0) {
    message = `Feasible: ${fmtMinutes(drivingMinutesNeeded)} of driving needed, ${fmtMinutes(
      driveMinutesRemaining,
    )} available`;
  } else if (feasible && breakMinutesRequired > 0) {
    message = `Feasible with a ${breakMinutesRequired}-minute break on route`;
  } else if (shortfallMinutes > 0) {
    const restarts = hos.canRestartAt;
    message = restarts
      ? `Short by ${fmtMinutes(shortfallMinutes)} of legal driving. Earliest restart ${restarts.slice(0, 16).replace('T', ' ')} UTC.`
      : `Short by ${fmtMinutes(shortfallMinutes)} of legal driving. Split across a rest period.`;
  } else {
    message = 'Not feasible on current hours';
  }

  return {
    feasible,
    drivingMinutesNeeded,
    driveMinutesRemaining,
    shortfallMinutes,
    breakMinutesRequired,
    message,
  };
}

/* -------------------------------------------------------------------------- */
/* Conversion to the dispatch read model                                         */
/* -------------------------------------------------------------------------- */

/** Shape `core.dispatch` consumes for eligibility checks. */
export interface DispatchReadiness {
  driverId: string;
  driveMinutesRemaining: number;
  dutyMinutesRemaining: number;
  breakMinutesRemaining: number;
  cycle: HosCycle;
  cycleMinutesRemaining: number;
  violations: string[];
}

export function toDispatchReadiness(
  driverId: string,
  computation: HosComputation,
): DispatchReadiness {
  return {
    driverId,
    driveMinutesRemaining: computation.driveMinutesRemaining,
    dutyMinutesRemaining: computation.dutyMinutesRemaining,
    // -1 encodes "no break currently due"; dispatch treats that as satisfied.
    breakMinutesRemaining: computation.breakMinutesRemaining,
    cycle: computation.cycle.cycle,
    cycleMinutesRemaining: computation.onDutyMinutesRemainingInCycle,
    violations: computation.violations.map((violation) => violation.message),
  };
}

/** Build an ELD-shaped HOS log from intervals, for `EldProvider.hosLogs`. */
export function summarizeIntervals(
  vehicleId: string,
  driverId: string,
  intervals: readonly EldDutyInterval[],
  periodStart: string,
  periodEnd: string,
): EldHosLogs {
  const computation = computeHos({
    intervals,
    now: new Date(periodEnd),
    cycleDays: intervals.length > 0 ? 8 : 8,
  });

  return {
    vehicleId,
    driverId,
    dutyStatus: currentStatusOf(intervals),
    periodStart,
    periodEnd,
    cycles: [
      {
        startedAt: computation.cycle.cycleStartedAt,
        endedAt: periodEnd,
        drivingMinutes: computation.shift.drivingMinutesInShift,
        onDutyMinutes: computation.shift.onDutyMinutesInShift,
        offDutyMinutes: 0,
        sleeperMinutes: 0,
        driveMinutesRemaining: computation.driveMinutesRemaining,
        dutyMinutesRemaining: computation.dutyMinutesRemaining,
        sinceBreakMinutes: computation.shift.sinceBreakMinutes,
      },
    ],
    violations: computation.violations.map((violation) => ({
      type: violation.type,
      message: violation.message,
      at: violation.at,
      severity: violation.severity,
    })),
  };
}
function currentStatusOf(intervals: readonly EldDutyInterval[]): EldDutyStatus {
  const last = intervals[intervals.length - 1];
  return last?.status ?? 'OFF_DUTY';
}

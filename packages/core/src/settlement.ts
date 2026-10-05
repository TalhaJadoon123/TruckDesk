import {
  Errors,
  applyBasisPoints,
  isWithin,
  perMileCents,
  startOfWeekIso,
  type Cents,
  type Driver,
  type Iso,
  type Load,
  type Result,
  type WeekWindow,
  err,
  ok,
} from '@truckdesk/shared';

/**
 * Weekly driver settlement.
 *
 * Runs Sunday night and produces the statement a driver actually reads. The
 * arithmetic order matters for owner-operators, so it is spelled out:
 *
 *   gross revenue     = sum of delivered load rates in the week
 *   load pay          = per pay type, on loaded miles
 *   deadhead pay      = per pay type, on empty miles (owner-operators only)
 *   pre-tax           = load pay + deadhead pay + per diem
 *   reimbursement     = per diem + reimbursable expenses (tolls, fuel cards)
 *   gross             = pre-tax + reimbursement
 *   deductions        = advances, fuel-card charges, damage, other
 *   net               = gross - deductions
 */

export type SettlementStatus = 'draft' | 'approved' | 'paid' | 'void';

export interface SettlementLine {
  /** Sort order in the statement. */
  sequence: number;
  kind:
    | 'revenue'
    | 'load_pay'
    | 'deadhead_pay'
    | 'per_diem'
    | 'reimbursement'
    | 'advance'
    | 'deduction'
    | 'bonus';
  description: string;
  loadId?: string;
  miles?: number;
  rateCents?: number;
  amountCents: Cents;
  /**
   * Negative for deductions, so the statement sums straight down.
   *
   * Note that `revenue` lines are context, not pay: they record what the broker
   * paid so the driver can see the split. They are excluded from the sum that
   * produces the net, and `payable` marks that explicitly.
   */
  payable: boolean;
  meta?: Record<string, string | number | boolean>;
}

export interface SettlementSummary {
  grossRevenueCents: Cents;
  loadPayCents: Cents;
  deadheadPayCents: Cents;
  perDiemCents: Cents;
  reimbursementsCents: Cents;
  bonusCents: Cents;
  advancesCents: Cents;
  deductionsCents: Cents;
  grossCents: Cents;
  netCents: Cents;
  totalLoadedMiles: number;
  totalDeadheadMiles: number;
  totalEmptyMiles: number;
  loadsCompleted: number;
  revenuePerLoadedMileCents: number;
  effectiveCpmCents: number;
}

export interface Settlement {
  id: string;
  companyId?: string;
  driverId: string;
  driverName: string;
  week: WeekWindow;
  status: SettlementStatus;
  lines: SettlementLine[];
  summary: SettlementSummary;
  /** Signed by the driver in the app, captured as a signature data URL. */
  driverSignatureName?: string;
  driverSignedAt?: Iso;
  approvedBy?: string;
  approvedAt?: Iso;
  paidAt?: Iso;
  paymentMethod?: 'direct_deposit' | 'check' | 'fuel_card' | 'other';
  notes?: string;
  createdAt: Iso;
}

export interface SettlementInput {
  driver: Driver;
  week?: WeekWindow;
  loads: readonly Load[];
  deadheadByLoad?: Record<string, number>;
  advances?: Array<{ id: string; amountCents: Cents; date: Iso; note?: string }>;
  deductions?: Array<{
    id: string;
    amountCents: Cents;
    category: 'fuel_card' | 'damage' | 'toll_recovery' | 'uniform' | 'other';
    note?: string;
    date?: Iso;
  }>;
  reimbursements?: Array<{ id: string; amountCents: Cents; description: string; category: string }>;
  bonuses?: Array<{ id: string; amountCents: Cents; description: string }>;
  /** Per diem rate in cents. US carriers usually pay none. */
  perDiemCents?: number;
  perDiemDays?: number;
  /** Paid directly to the driver by the broker on their behalf. */
  ownerOperatorSurchargeCents?: Cents;
  id?: string;
  now?: Iso;
  notes?: string;
}

/**
 * Which loads count for a settlement week.
 *
 * Loads count when they were *delivered* in the week, not when they were
 * booked, because a driver earns on delivery. In-transit loads carry over to
 * next week's statement, which is why they appear in `carryoverLoadIds`.
 */
export function loadsForWeek(
  loads: readonly Load[],
  week: WeekWindow,
): { earned: Load[]; carryover: Load[] } {
  const earned: Load[] = [];
  const carryover: Load[] = [];

  for (const load of loads) {
    if (load.cancelledAt) continue;
    const deliveredAt = load.deliveredAt;
    if (deliveredAt && isWithin(deliveredAt, week.start, week.end)) {
      earned.push(load);
      continue;
    }
    if (load.status === 'in-transit' || load.status === 'dispatched') {
      carryover.push(load);
    }
  }

  return { earned, carryover };
}

export function calculateSettlement(input: SettlementInput): Result<Settlement> {
  const now = input.now ?? new Date().toISOString();
  const week = input.week ?? startOfWeekIso(now);
  const { driver } = input;

  const now1 = week.start ? Date.parse(week.start) : NaN;
  if (Number.isNaN(now1) || Number.isNaN(Date.parse(week.end))) {
    return err(Errors.invalidInput('Settlement week has an invalid window'));
  }

  const { earned, carryover } = loadsForWeek(input.loads, week);
  if (earned.length === 0) {
    return err(
      Errors.invalidState(
        `${driver.name} has no delivered loads in ${week.label}; nothing to settle`,
        { driverId: driver.id, week: week.key, carryoverLoadIds: carryover.map((load) => load.id) },
      ),
    );
  }

  const lines: SettlementLine[] = [];
  let sequence = 1;

  /* --- revenue ----------------------------------------------------------- */

  let grossRevenueCents: Cents = 0;
  for (const load of earned) {
    grossRevenueCents += load.rate;
    lines.push({
      sequence: sequence++,
      kind: 'revenue',
      description: `${load.broker} - ${load.origin} to ${load.destination}`,
      loadId: load.id,
      miles: load.miles,
      rateCents: perMileCents(load.rate, load.miles),
      amountCents: load.rate,
      // Context only: this is what the broker paid, not what the driver earns.
      payable: false,
      meta: {
        broker: load.broker,
        reference: load.reference ?? load.id,
        deliveredAt: load.deliveredAt ?? '',
      },
    });
  }

  if (input.ownerOperatorSurchargeCents) {
    lines.push({
      sequence: sequence++,
      kind: 'revenue',
      description: 'Broker-paid owner-operator surcharge',
      amountCents: input.ownerOperatorSurchargeCents,
      payable: false,
    });
    grossRevenueCents += input.ownerOperatorSurchargeCents;
  }

  /* --- driver pay -------------------------------------------------------- */

  let totalLoadedMiles = 0;
  let totalDeadheadMiles = 0;

  for (const load of earned) {
    totalLoadedMiles += load.miles;
    const empty = input.deadheadByLoad?.[load.id] ?? 0;
    totalDeadheadMiles += empty;
  }

  // Empty miles also include anything logged without a load attached, which is
  // the reality of spotting a trailer back and running local work.
  const totalEmptyMiles = totalDeadheadMiles;

  let loadPayCents: Cents = 0;
  let deadheadPayCents: Cents = 0;

  for (const load of earned) {
    const payCents = payForLoad(driver, load, load.miles, false);
    loadPayCents += payCents;
    if (payCents > 0) {
      lines.push({
        sequence: sequence++,
        kind: 'load_pay',
        description: `Load pay - ${load.broker}`,
        loadId: load.id,
        miles: load.miles,
        rateCents: perMileCents(payCents, load.miles),
        amountCents: payCents,
        payable: true,
        meta: { payType: driver.payType },
      });
    }

    const emptyMiles = input.deadheadByLoad?.[load.id] ?? 0;
    if (emptyMiles > 0) {
      // Owner-operators get paid empty miles; company drivers do not.
      const emptyPay = payForLoad(driver, load, emptyMiles, true);
      if (emptyPay > 0) {
        deadheadPayCents += emptyPay;
        lines.push({
          sequence: sequence++,
          kind: 'deadhead_pay',
          description: `Deadhead pay - ${load.broker}`,
          loadId: load.id,
          miles: emptyMiles,
          rateCents: perMileCents(emptyPay, emptyMiles),
          amountCents: emptyPay,
          payable: true,
        });
      }
    }
  }

  /* --- per diem and reimbursements --------------------------------------- */

  const perDiemDays = input.perDiemDays ?? 0;
  const perDiemCents = (input.perDiemCents ?? 0) * perDiemDays;
  if (perDiemCents > 0) {
    lines.push({
      sequence: sequence++,
      kind: 'per_diem',
      description: `Per diem - ${perDiemDays} day${perDiemDays === 1 ? '' : 's'}`,
      amountCents: perDiemCents,
      payable: true,
      meta: { ratePerDayCents: input.perDiemCents ?? 0, days: perDiemDays },
    });
  }

  let reimbursementsCents: Cents = 0;
  for (const item of input.reimbursements ?? []) {
    reimbursementsCents += item.amountCents;
    lines.push({
      sequence: sequence++,
      kind: 'reimbursement',
      description: item.description,
      amountCents: item.amountCents,
      payable: true,
      meta: { category: item.category, id: item.id },
    });
  }

  /* --- bonuses ----------------------------------------------------------- */

  let bonusCents: Cents = 0;
  for (const bonus of input.bonuses ?? []) {
    bonusCents += bonus.amountCents;
    lines.push({
      sequence: sequence++,
      kind: 'bonus',
      description: bonus.description,
      amountCents: bonus.amountCents,
      payable: true,
    });
  }

  /* --- advances and deductions ------------------------------------------ */

  let advancesCents: Cents = 0;
  for (const advance of input.advances ?? []) {
    advancesCents += advance.amountCents;
    lines.push({
      sequence: sequence++,
      kind: 'advance',
      description: advance.note ? `Advance - ${advance.note}` : 'Advance',
      amountCents: -advance.amountCents,
      payable: true,
      meta: { advanceId: advance.id, date: advance.date },
    });
  }

  let otherDeductionsCents: Cents = 0;
  for (const deduction of input.deductions ?? []) {
    otherDeductionsCents += deduction.amountCents;
    lines.push({
      sequence: sequence++,
      kind: 'deduction',
      description: labelDeduction(deduction.category, deduction.note),
      amountCents: -deduction.amountCents,
      payable: true,
      meta: { deductionId: deduction.id, category: deduction.category, date: deduction.date ?? '' },
    });
  }

  /* --- totals ------------------------------------------------------------ */

  const grossCents = loadPayCents + deadheadPayCents + perDiemCents + reimbursementsCents + bonusCents;
  const deductionsCents = advancesCents + otherDeductionsCents;
  const netCents = grossCents - deductionsCents;

  const totalMiles = totalLoadedMiles + totalEmptyMiles;
  const summary: SettlementSummary = {
    grossRevenueCents,
    loadPayCents,
    deadheadPayCents,
    perDiemCents,
    reimbursementsCents: reimbursementsCents + perDiemCents,
    bonusCents,
    advancesCents,
    deductionsCents: otherDeductionsCents,
    grossCents,
    netCents,
    totalLoadedMiles,
    totalDeadheadMiles: totalDeadheadMiles,
    totalEmptyMiles,
    loadsCompleted: earned.length,
    revenuePerLoadedMileCents: perMileCents(grossRevenueCents, totalLoadedMiles),
    effectiveCpmCents: perMileCents(grossCents, totalMiles),
  };

  const settlement: Settlement = {
    id: input.id ?? `se_${driver.id}_${week.key}`,
    driverId: driver.id,
    driverName: driver.name,
    week,
    status: 'draft',
    lines,
    summary,
    notes:
      input.notes ??
      (carryover.length > 0
        ? `${carryover.length} load${carryover.length === 1 ? '' : 's'} still in transit will settle next week.`
        : undefined),
    createdAt: now,
  };

  // Guard the invariant a driver will absolutely check by hand.
  //
  // Only the *payable* lines sum to net. The revenue lines are context - they
  // show what the broker paid, so the driver can see the split - and they are
  // deliberately excluded, because adding them would make the column disagree
  // with the bottom line by exactly the gross revenue.
  const payable = lines.filter((line) => line.kind !== 'revenue');
  const summed = payable.reduce((sum, line) => sum + line.amountCents, 0);
  if (summed !== netCents) {
    return err(
      Errors.internal(
        `Settlement arithmetic mismatch for ${driver.name}: payable lines sum to ${summed}, net is ${netCents}`,
        { driverId: driver.id, week: week.key },
      ),
    );
  }

  const revenueLines = lines.filter((line) => line.kind === 'revenue');
  const summedRevenue = revenueLines.reduce((sum, line) => sum + line.amountCents, 0);
  if (summedRevenue !== grossRevenueCents) {
    return err(
      Errors.internal(
        `Settlement revenue mismatch for ${driver.name}: revenue lines sum to ${summedRevenue}, gross revenue is ${grossRevenueCents}`,
        { driverId: driver.id, week: week.key },
      ),
    );
  }

  return ok(settlement);
}

/**
 * Pay for one load. Company drivers are paid on loaded miles only; owner-
 * operators are paid loaded + empty, which is the whole point of running their
 * own truck.
 */
export function payForLoad(
  driver: Driver,
  load: Load,
  miles: number,
  isEmpty: boolean,
): Cents {
  if (driver.status === 'inactive') return 0;

  switch (driver.payType) {
    case 'percentage': {
      // Percentage of the linehaul only: fuel surcharge is not driver pay.
      const base = load.linehaulCents ?? Math.round(load.rate * 0.85);
      const bps = driver.payRateBps ?? 2500;
      if (isEmpty) {
        // Empty miles are paid at half the percentage, the common split.
        return Math.round((base * bps) / 10_000 / 2 / 2);
      }
      return Math.round((base * bps) / 10_000);
    }
    case 'flat_per_mile': {
      const rate = driver.payPerMileCents ?? 45;
      return Math.round(rate * miles);
    }
    case 'flat_per_load':
      if (isEmpty) return 0;
      return driver.payPerMileCents ?? 0;
    case 'salary':
      // Salary is paid monthly, not per load. Excluded from the weekly total.
      return 0;
    default:
      return 0;
  }
}

/** Owner-operator vs company driver, decided by how they are paid. */
export function isOwnerOperator(driver: Driver): boolean {
  return driver.payType === 'percentage' || driver.payType === 'flat_per_mile';
}

/* -------------------------------------------------------------------------- */
/* Fleet-level rollup                                                            */
/* -------------------------------------------------------------------------- */

export interface FleetSettlementResult {
  week: WeekWindow;
  settlements: Settlement[];
  totalGrossCents: Cents;
  totalNetCents: Cents;
  totalAdvancesCents: Cents;
  totalDeductionsCents: Cents;
  totalRevenueCents: Cents;
  totalMarginCents: Cents;
  driversPaid: number;
  driversWithNothingToSettle: string[];
}

export function settleFleet(
  drivers: readonly Driver[],
  loads: readonly Load[],
  options: {
    week?: WeekWindow;
    deadheadByLoad?: Record<string, number>;
    advancesByDriver?: Record<string, SettlementInput['advances']>;
    deductionsByDriver?: Record<string, NonNullable<SettlementInput['deductions']>>;
    reimbursementsByDriver?: Record<string, NonNullable<SettlementInput['reimbursements']>>;
    bonusesByDriver?: Record<string, NonNullable<SettlementInput['bonuses']>>;
    perDiemCentsByDriver?: Record<string, number>;
    now?: Iso;
  } = {},
): Result<FleetSettlementResult> {
  const now = options.now ?? new Date().toISOString();
  const week = options.week ?? startOfWeekIso(now);

  const settlements: Settlement[] = [];
  const driversWithNothingToSettle: string[] = [];

  for (const driver of drivers) {
    const driverLoads = loads.filter(
      (load) =>
        !load.assignedDriverId ||
        load.assignedDriverId === driver.id ||
        load.cancelledAt === undefined,
    );

    const result = calculateSettlement({
      driver,
      week,
      loads: driverLoads,
      deadheadByLoad: options.deadheadByLoad,
      advances: options.advancesByDriver?.[driver.id],
      deductions: options.deductionsByDriver?.[driver.id],
      reimbursements: options.reimbursementsByDriver?.[driver.id],
      bonuses: options.bonusesByDriver?.[driver.id],
      perDiemCents: options.perDiemCentsByDriver?.[driver.id],
      now,
    });

    if (result.ok) settlements.push(result.value);
    else driversWithNothingToSettle.push(driver.name);
  }

  const totalGrossCents = settlements.reduce((sum, s) => sum + s.summary.grossCents, 0);
  const totalNetCents = settlements.reduce((sum, s) => sum + s.summary.netCents, 0);
  const totalAdvancesCents = settlements.reduce((sum, s) => sum + s.summary.advancesCents, 0);
  const totalDeductionsCents = settlements.reduce((sum, s) => sum + s.summary.deductionsCents, 0);
  const totalRevenueCents = settlements.reduce((sum, s) => sum + s.summary.grossRevenueCents, 0);

  return ok({
    week,
    settlements,
    totalGrossCents,
    totalNetCents,
    totalAdvancesCents,
    totalDeductionsCents,
    totalRevenueCents,
    totalMarginCents: totalRevenueCents - totalGrossCents,
    driversPaid: settlements.length,
    driversWithNothingToSettle,
  });
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                     */
/* -------------------------------------------------------------------------- */

export function approveSettlement(
  settlement: Settlement,
  actorId: string,
  now: Iso = new Date().toISOString(),
): Result<Settlement> {
  if (settlement.status !== 'draft') {
    return err(Errors.invalidState(`Settlement is ${settlement.status}; only drafts can be approved`));
  }
  if (settlement.summary.netCents < 0) {
    return err(
      Errors.invalidState('Settlement nets negative; resolve deductions before approving', {
        netCents: settlement.summary.netCents,
      }),
    );
  }
  return ok({ ...settlement, status: 'approved', approvedBy: actorId, approvedAt: now });
}

export function signSettlement(
  settlement: Settlement,
  signatureName: string,
  now: Iso = new Date().toISOString(),
): Result<Settlement> {
  if (settlement.status === 'void') {
    return err(Errors.invalidState('Settlement is void'));
  }
  if (settlement.status === 'paid') {
    return err(Errors.invalidState('Settlement is already paid'));
  }
  if (!signatureName.trim()) {
    return err(Errors.invalidInput('Signature name is required'));
  }
  return ok({ ...settlement, driverSignatureName: signatureName.trim(), driverSignedAt: now });
}

export function markSettlementPaid(
  settlement: Settlement,
  method: Settlement['paymentMethod'] = 'direct_deposit',
  now: Iso = new Date().toISOString(),
): Result<Settlement> {
  if (settlement.status !== 'approved' && settlement.status !== 'draft') {
    return err(Errors.invalidState(`Settlement is ${settlement.status} and cannot be marked paid`));
  }
  return ok({ ...settlement, status: 'paid', paidAt: now, paymentMethod: method });
}

/** YTD running totals, for the owner looking at the whole year. */
export interface YtdSummary {
  grossCents: Cents;
  netCents: Cents;
  revenueCents: Cents;
  weeks: number;
  loads: number;
  miles: number;
}

export function yearToDate(settlements: readonly Settlement[]): YtdSummary {
  return settlements.reduce<YtdSummary>(
    (acc, settlement) => {
      if (settlement.status === 'void') return acc;
      return {
        grossCents: acc.grossCents + settlement.summary.grossCents,
        netCents: acc.netCents + settlement.summary.netCents,
        revenueCents: acc.revenueCents + settlement.summary.grossRevenueCents,
        weeks: acc.weeks + 1,
        loads: acc.loads + settlement.summary.loadsCompleted,
        miles: acc.miles + settlement.summary.totalLoadedMiles + settlement.summary.totalEmptyMiles,
      };
    },
    { grossCents: 0, netCents: 0, revenueCents: 0, weeks: 0, loads: 0, miles: 0 },
  );
}

function labelDeduction(category: string, note?: string): string {
  const labels: Record<string, string> = {
    fuel_card: 'Fuel card charge',
    damage: 'Damage deduction',
    toll_recovery: 'Toll overage recovery',
    uniform: 'Uniform',
    other: 'Other deduction',
  };
  const base = labels[category] ?? 'Deduction';
  return note ? `${base} - ${note}` : base;
}

/** Apply a percentage bonus for on-time delivery, for fleets that run one. */
export function onTimeBonusCents(load: Load, loadedMiles: number, bonusRateBps = 100): Cents {
  if (!load.deliveredAt || !load.deliveryDate) return 0;
  if (Date.parse(load.deliveredAt) <= Date.parse(load.deliveryDate)) {
    return applyBasisPoints(Math.round(load.rate * 0.1), bonusRateBps * 10) + 0;
  }
  void loadedMiles;
  return 0;
}
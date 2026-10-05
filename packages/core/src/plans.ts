import {
  FEATURES,
  PLANS,
  getPlan,
  planAllows,
  type Cents,
  type Company,
  type Iso,
  type PlanDefinition,
  type PlanId,
  type Result,
  err,
  ok,
} from '@truckdesk/shared';

import { DomainError } from '@truckdesk/shared';

/**
 * Plan enforcement.
 *
 * One rule, enforced in one place: `enforceLimit` for countable resources and
 * `requireFeature` for capability gates. The API returns 402 with the plan that
 * unlocks the feature so the UI can render the upgrade prompt with no client
 * logic of its own.
 */

export const TRIAL_DAYS = 14;

export interface UsageSnapshot {
  trucks: number;
  drivers: number;
  activeLoads: number;
  emailParsesThisMonth: number;
}

export interface LimitCheck {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  /** The plan that raises the ceiling. */
  upgradeTo: PlanId | null;
  message: string;
}

export type LimitResource = 'trucks' | 'drivers' | 'activeLoads' | 'emailParsesThisMonth';

const UPGRADE_PATH: Record<LimitResource, PlanId | null> = {
  trucks: 'starter',
  drivers: 'starter',
  activeLoads: 'starter',
  emailParsesThisMonth: 'starter',
};

/**
 * Would adding one more of `resource` breach the plan?
 *
 * `pending` counts entities not yet committed: a dispatcher hovering over the
 * "add truck" button should not be allowed past the limit by one, and a trial
 * that just expired should stop new trucks without locking anyone out.
 */
export function checkLimit(
  planId: PlanId,
  usage: UsageSnapshot,
  resource: LimitResource,
  pending = 0,
): LimitCheck {
  const plan = getPlan(planId);
  const limit = limitFor(plan, resource);
  const current = usage[resource] + pending;

  // 0 means unlimited.
  if (limit === 0) {
    return {
      allowed: true,
      current: usage[resource],
      limit: 0,
      remaining: Number.POSITIVE_INFINITY,
      upgradeTo: null,
      message: 'Unlimited on this plan',
    };
  }

  const remaining = limit - usage[resource];
  const allowed = current <= limit;

  return {
    allowed,
    current,
    limit,
    remaining: Math.max(0, remaining),
    upgradeTo: UPGRADE_PATH[resource],
    message: allowed
      ? `${remaining - pending} remaining on the ${plan.name} plan`
      : `${plan.name} plan allows ${limit} ${labelFor(resource)}. Upgrade to add more.`,
  };
}

function limitFor(plan: PlanDefinition, resource: LimitResource): number {
  switch (resource) {
    case 'trucks':
      return plan.maxTrucks;
    case 'drivers':
      return plan.maxDrivers;
    case 'activeLoads':
      return plan.maxActiveLoads;
    case 'emailParsesThisMonth':
      return plan.emailParsesPerMonth;
    default:
      return 0;
  }
}

function labelFor(resource: LimitResource): string {
  switch (resource) {
    case 'trucks':
      return 'trucks';
    case 'drivers':
      return 'drivers';
    case 'activeLoads':
      return 'active loads';
    case 'emailParsesThisMonth':
      return 'broker emails per month';
    default:
      return resource;
  }
}

export function enforceLimit(
  planId: PlanId,
  usage: UsageSnapshot,
  resource: LimitResource,
  pending = 0,
): Result<true> {
  const check = checkLimit(planId, usage, resource, pending);
  if (check.allowed) return ok(true);

  return err(
    new DomainError('PLAN_LIMIT', check.message, {
      details: {
        resource,
        current: check.current,
        limit: check.limit,
        plan: planId,
        upgradeTo: check.upgradeTo,
      },
      status: 402,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Feature gates                                                                 */
/* -------------------------------------------------------------------------- */

export function hasFeature(planId: PlanId, featureKey: string): boolean {
  const feature = FEATURES[featureKey];
  if (!feature) return false;
  return planAllows(planId, feature.required);
}

export function requireFeature(planId: PlanId, featureKey: string): Result<true> {
  const feature = FEATURES[featureKey];
  if (!feature) {
    return err(
      new DomainError('INTERNAL', `Unknown feature flag "${featureKey}"`, { status: 500 }),
    );
  }

  if (hasFeature(planId, featureKey)) return ok(true);

  const required = getPlan(feature.required);
  return err(
    new DomainError(
      'PLAN_LIMIT',
      `${feature.label} requires the ${required.name} plan ($${(required.priceCents / 100).toFixed(0)}/mo).`,
      {
        details: {
          feature: featureKey,
          requiredPlan: feature.required,
          currentPlan: planId,
          upgradeTo: feature.required,
        },
        status: 402,
      },
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Trials and grace                                                              */
/* -------------------------------------------------------------------------- */

export interface AccessState {
  plan: PlanId;
  /** True when the company is inside its 14-day paid trial. */
  inTrial: boolean;
  trialEndsAt: Iso | null;
  trialDaysRemaining: number;
  /** True when a paid plan's payment failed and the grace period is running. */
  inGrace: boolean;
  /** What the UI should render. */
  banner: 'none' | 'trial' | 'trial_expiring' | 'past_due' | 'trial_expired';
  /** Read-only mode: data stays visible, writes are blocked. */
  readOnly: boolean;
}

const GRACE_DAYS = 7;

export function accessState(company: Company, now: Date = new Date()): AccessState {
  const plan = getPlan(company.plan);
  const trialEndsAt = company.trialEndsAt ?? null;

  let trialDaysRemaining = 0;
  let inTrial = false;
  if (trialEndsAt) {
    const remainingMs = Date.parse(trialEndsAt) - now.getTime();
    trialDaysRemaining = Math.max(0, Math.ceil(remainingMs / 86_400_000));
    inTrial = remainingMs > 0 && isPaidPlanId(company.plan);
  }

  const pastDue = company.subscriptionStatus === 'past_due';
  const inGrace =
    pastDue && company.subscriptionStatus !== 'canceled' && !isPaidPlanExpired(company, now);

  let banner: AccessState['banner'] = 'none';
  if (pastDue) banner = 'past_due';
  else if (inTrial && trialDaysRemaining <= 3) banner = 'trial_expiring';
  else if (inTrial) banner = 'trial';
  else if (isPaidPlanExpired(company, now)) banner = 'trial_expired';

  // Free stays read-write forever. A lapsed paid plan drops to read-only so the
  // owner can still see their data but cannot lose it.
  const readOnly = isPaidPlanId(company.plan) && !inTrial && !pastDue && isPaidPlanExpired(company, now);

  return {
    plan: plan.id,
    inTrial,
    trialEndsAt,
    trialDaysRemaining,
    inGrace,
    banner,
    readOnly,
  };
}

function isPaidPlanId(planId: PlanId): boolean {
  return planId !== 'free';
}

function isPaidPlanExpired(company: Company, now: Date): boolean {
  if (!isPaidPlanId(company.plan)) return false;
  if (company.subscriptionStatus === 'active' || company.subscriptionStatus === 'trialing') {
    return false;
  }
  if (company.subscriptionStatus === 'past_due') {
    const trialEnd = company.trialEndsAt ? Date.parse(company.trialEndsAt) : Number.POSITIVE_INFINITY;
    return now.getTime() - trialEnd > GRACE_DAYS * 86_400_000;
  }
  return company.subscriptionStatus === 'none' || company.subscriptionStatus === 'canceled';
}

/** Which plans a company could move to, for the billing screen. */
export function availableUpgrades(planId: PlanId): PlanDefinition[] {
  const order: PlanId[] = ['free', 'starter', 'business'];
  const index = order.indexOf(planId);
  return PLANS ? order.slice(index + 1).map((id) => PLANS[id]) : [];
}

/** Prorated credit or charge when switching mid-cycle. */
export function prorate(
  fromCents: Cents,
  toCents: Cents,
  daysUsedInCycle: number,
  daysInCycle = 30,
): Cents {
  const safeDays = Math.max(1, daysInCycle);
  const remainingFraction = 1 - Math.min(1, Math.max(0, daysUsedInCycle) / safeDays);
  const currentValue = (fromCents * Math.max(0, safeDays - daysUsedInCycle)) / safeDays;
  const nextValue = (toCents * Math.max(0, safeDays - daysUsedInCycle)) / safeDays;
  return Math.round(nextValue - currentValue);
}

/** Everything the pricing page and the billing screen need, in one shape. */
export function planCatalog(): {
  plans: PlanDefinition[];
  features: typeof FEATURES;
  prices: Record<PlanId, { monthlyCents: number; annualCents: number }>;
} {
  const plans = (Object.keys(PLANS) as PlanId[]).map((id) => PLANS[id]);
  const prices = {} as Record<PlanId, { monthlyCents: number; annualCents: number }>;
  for (const plan of plans) {
    prices[plan.id] = {
      monthlyCents: plan.priceCents,
      annualCents: Math.round(plan.priceCents * 12 * 0.8333),
    };
  }
  return { plans, features: FEATURES, prices };
}
import type { PlanId } from './types.js';

/**
 * Pricing and limits. `web` renders this on the marketing page and `core`
 * enforces it in `plans.ts`, so the number a prospect reads is the number the
 * API enforces - there is no second copy to drift.
 */
export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Monthly USD cents. Free tier is 0. */
  priceCents: number;
  tagline: string;
  maxTrucks: number;
  maxDrivers: number;
  maxActiveLoads: number;
  /** Loads parsed from broker email per month. 0 means unlimited. */
  emailParsesPerMonth: number;
  features: string[];
  limits: string[];
  highlight?: boolean;
  cta: string;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    priceCents: 0,
    tagline: 'For the owner-operator running one or two trucks.',
    maxTrucks: 2,
    maxDrivers: 2,
    maxActiveLoads: 10,
    emailParsesPerMonth: 25,
    cta: 'Start free',
    features: [
      'Load board and drag-drop dispatch',
      'Live truck map (GPS pings)',
      'Broker email parsing (25/month)',
      'IFTA quarterly calculator',
      'BOL / POD capture with signature',
      'Invoicing and aging report',
    ],
    limits: [
      '2 trucks',
      '2 drivers',
      '25 broker emails / month',
      'Community support',
    ],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceCents: 4900,
    tagline: 'For a real crew that has outgrown the whiteboard.',
    maxTrucks: 10,
    maxDrivers: 15,
    maxActiveLoads: 100,
    emailParsesPerMonth: 500,
    highlight: true,
    cta: 'Start 14-day trial',
    features: [
      'Everything in Free',
      'Weekly driver settlements',
      'Quick-pay factoring export',
      'HOS-aware dispatch (ELD connected)',
      'Auto-match: rank loads against trucks',
      'Unlimited broker email parsing',
    ],
    limits: [
      '10 trucks',
      '15 drivers',
      'Unlimited email parsing',
      'Email support, 1 business day',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    priceCents: 14900,
    tagline: 'For multi-truck operations running two shifts.',
    maxTrucks: 25,
    maxDrivers: 40,
    maxActiveLoads: 500,
    emailParsesPerMonth: 0,
    highlight: false,
    cta: 'Start 14-day trial',
    features: [
      'Everything in Starter',
      'Multi-user dispatcher seats',
      'Custom rate con + BOL PDFs',
      'QuickPay / factoring integration',
      'Fuel & maintenance cost tracking',
      'Priority support, same business day',
    ],
    limits: [
      '25 trucks',
      '40 drivers',
      'Unlimited everything',
      'Priority support',
    ],
  },
};

export const PLAN_ORDER: readonly PlanId[] = ['free', 'starter', 'business'];

export function getPlan(planId: PlanId | string | null | undefined): PlanDefinition {
  if (planId && planId in PLANS) {
    return PLANS[planId as PlanId];
  }
  return PLANS.free;
}

export function planPriceCents(planId: PlanId): number {
  return getPlan(planId).priceCents;
}

/** Annual billing: two months free, the way every other tool does it. */
export function annualPriceCents(planId: PlanId): number {
  const monthly = planPriceCents(planId);
  return monthly * 12 * 0.8333;
}

export function isPaidPlan(planId: PlanId): boolean {
  return planId !== 'free';
}

export interface FeatureFlag {
  key: string;
  label: string;
  /** Minimum plan required. */
  required: PlanId;
  description: string;
}

export const FEATURES: Record<string, FeatureFlag> = {
  settlements: {
    key: 'settlements',
    label: 'Weekly driver settlements',
    required: 'starter',
    description: 'Per-driver weekly statements with pay, advances and deductions',
  },
  autoMatch: {
    key: 'autoMatch',
    label: 'Auto-match loads to trucks',
    required: 'starter',
    description: 'Rank every open load against every available truck',
  },
  hosAwareDispatch: {
    key: 'hosAwareDispatch',
    label: 'HOS-aware dispatch',
    required: 'starter',
    description: 'Refuse assignments that would put a driver out of compliance',
  },
  multiUser: {
    key: 'multiUser',
    label: 'Multi-user dispatcher seats',
    required: 'business',
    description: 'Invite dispatchers with their own login',
  },
  customPdfs: {
    key: 'customPdfs',
    label: 'Custom rate con / BOL PDFs',
    required: 'business',
    description: 'Branded PDF generation for every load',
  },
  costTracking: {
    key: 'costTracking',
    label: 'Fuel and maintenance cost tracking',
    required: 'business',
    description: 'Per-load and per-truck operating cost rollups',
  },
};

/** Plan rank, so "at least Starter" is a numeric comparison. */
export function planRank(planId: PlanId): number {
  return PLAN_ORDER.indexOf(planId);
}

export function planAllows(planId: PlanId, required: PlanId): boolean {
  return planRank(planId) >= planRank(required);
}
import { formatUsd, type Load, type Truck } from '@truckdesk/shared';

/**
 * API client.
 *
 * Server-side fetch for the data the dashboard needs, plus a small typed client
 * for the interactive parts. Auth rides on an HMAC token minted by the API's
 * `/signup` or dev login, stored in a cookie, so the browser never handles a
 * password after sign-in.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** 402 is the plan limit; the UI turns it into an upgrade prompt. */
  get isPlanLimit(): boolean {
    return this.status === 402 || this.code === 'PLAN_LIMIT';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  /** Set false to skip the default 10s timeout, for long-running reports. */
  timeoutMs?: number;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'UNKNOWN',
        error?.message ?? `Request failed with ${response.status}`,
        error?.details,
      );
    }

    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

/* -------------------------------------------------------------------------- */
/* Response shapes (the subset the UI reads)                                     */
/* -------------------------------------------------------------------------- */

export interface DashboardResponse {
  summary: {
    trucksAvailable: number;
    trucksTotal: number;
    loadsInTransit: number;
    loadsDeliveredThisWeek: number;
    revenueThisWeekCents: number;
    revenueLastWeekCents: number;
    deadheadRatio: number;
    averageRevenuePerMileCents: number;
    onTimeRate: number;
    unpaidReceivablesCents: number;
    hosViolations: number;
  };
  formatted: {
    revenueThisWeek: string;
    revenueLastWeek: string;
    averageRevenuePerMile: string;
    unpaidReceivables: string;
    deadheadRatioPercent: string;
    onTimeRatePercent: string;
  };
  board: {
    columns: Array<{ status: Load['status']; loads: Load[] }>;
    counts: Record<Load['status'], number>;
  };
  utilisation: {
    utilisation: number;
    loaded: number;
    empty: number;
    available: number;
    maintenance: number;
  };
  health: {
    unassigned: number;
    staleUnassigned: number;
    atRiskOnTime: number;
    missingPod: number;
    averageDaysUnassigned: number;
  };
  trend: Array<{
    weekKey: string;
    label: string;
    revenueCents: number;
    loads: number;
    miles: number;
    revenuePerMileCents: number;
  }>;
  attention: Array<{
    load: {
      id: string;
      broker: string;
      origin: string;
      destination: string;
      status: Load['status'];
      rate: number;
      miles: number;
    };
    reasons: string[];
    priority: number;
  }>;
  missingDocuments: Array<{ loadId: string; reference?: string; missing: string[] }>;
  deadheadMiles: number;
  fuelCentsThisWeek: number;
  hos: Array<{
    driverId: string;
    unit: string;
    driverName?: string;
    driveMinutesRemaining: number;
    dutyMinutesRemaining: number;
    breakMinutesRemaining: number;
    cycle: 60 | 70;
    cycleMinutesRemaining: number;
    violations: string[];
    warnings: Array<{ message: string; minutesUntil: number }>;
  }>;
  mode: 'memory' | 'postgres';
}

export interface TrackResponse {
  positions: Array<{
    truckId: string;
    unit: string;
    status: Truck['status'];
    location: { lat: number; lng: number };
    at: string;
    headingDeg?: number;
    speedMph?: number;
    staleMinutes: number;
    isStale: boolean;
    loadId?: string;
  }>;
  loads: Array<{
    loadId: string;
    status: Load['status'];
    origin: { lat: number; lng: number } | null;
    destination: { lat: number; lng: number } | null;
    current: { lat: number; lng: number } | null;
    totalMiles: number;
    milesCompleted: number;
    milesRemaining: number;
    percentComplete: number;
    etaIso: string | null;
    etaConfidence: 'high' | 'medium' | 'low' | 'unknown';
    lastPingAt: string | null;
    offRouteMiles: number;
  }>;
  trucks: Array<{
    id: string;
    unit: string;
    status: Truck['status'];
    driverId?: string;
    loadId?: string;
    hosStatus?: string;
    eldProvider?: string;
  }>;
  generatedAt: string;
}

export interface AssignResponse {
  load: Load;
  truck: Truck;
  deadheadMiles: number;
  projectedHours: number;
  marginCents: number;
  marginFormatted: string;
  warnings: string[];
}

export interface MatchResponse {
  matches: Array<{
    loadId: string;
    truckId: string;
    truckUnit: string;
    driverId?: string;
    driverName?: string;
    deadheadMiles: number;
    totalMiles: number;
    projectedHours: number;
    revenuePerMileCents: number;
    marginCents: number;
    score: number;
    rank: number;
    warnings: string[];
    explanations: Array<{ factor: string; label: string; contribution: number; detail: string }>;
  }>;
  unmatched: Array<{ load: Load; reason: string }>;
  scoredPairs: number;
  generatedAt: string;
}

export interface ParseEmailResponse {
  parsed: {
    broker: string | null;
    origin: string | null;
    destination: string | null;
    commodity: string | null;
    rateDollars: number | null;
    rateCents: number | null;
    miles: number | null;
    weightLbs: number | null;
    pickupDate: string | null;
    deliveryDate: string | null;
  };
  confidence: Record<string, string>;
  overallConfidence: number;
  needsReview: Array<{ field: string; reason: string; value: unknown }>;
  warnings: string[];
  summary: string;
  createdLoadId: string | null;
  llmLive: boolean;
}

export interface IftaResponse {
  period: { label: string; start: string; end: string };
  lines: Array<{
    state: string;
    name: string;
    miles: number;
    taxableFraction: number;
    apportionedGallons: number;
    taxCents: number;
    creditCents: number;
    netCents: number;
  }>;
  totalMiles: number;
  apportionedTaxCents: number;
  creditsCents: number;
  netTaxDueCents: number;
  netTaxDueFormatted: string;
  totalMilesFormatted: string;
  note: string;
}

export interface PricingPlan {
  id: 'free' | 'starter' | 'business';
  name: string;
  tagline: string;
  priceFormatted: string;
  priceCents: number;
  maxTrucks: number;
  maxDrivers: number;
  features: string[];
  limits: string[];
  highlight: boolean;
  cta: string;
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                    */
/* -------------------------------------------------------------------------- */

export const endpoints = {
  health: () => apiFetch<{ status: string; mode: string }>('/health'),
  capabilities: () =>
    apiFetch<{ capabilities: Array<{ name: string; enabled: boolean; detail: string }> }>('/capabilities'),
  pricing: () => apiFetch<{ plans: PricingPlan[] }>('/public/plans'),

  publicIfta: (body: { milesByState: Record<string, number>; mpg?: number }) =>
    apiFetch<IftaResponse>('/public/ifta', { method: 'POST', body, timeoutMs: 20_000 }),

  signup: (body: { companyName: string; email: string; name: string; password: string }) =>
    apiFetch<{ companyId: string; userId: string; token: string | null; plan: string }>('/signup', {
      method: 'POST',
      body,
    }),

  dashboard: (token: string) => apiFetch<DashboardResponse>('/dashboard', { token }),
  track: (token: string) => apiFetch<TrackResponse>('/track', { token }),
  loads: (token: string, query = '') => apiFetch<{ loads: Load[]; total: number }>(`/loads${query}`, { token }),
  board: (token: string) =>
    apiFetch<DashboardResponse['board']>('/dispatch/board', { token }),
  match: (token: string) => apiFetch<MatchResponse>('/dispatch/match', { method: 'POST', body: {}, token }),

  assign: (token: string, loadId: string, truckId: string) =>
    apiFetch<AssignResponse>('/dispatch', { method: 'POST', body: { loadId, truckId }, token }),
  unassign: (token: string, loadId: string) =>
    apiFetch<{ load: Load }>('/dispatch/unassign', { method: 'POST', body: { loadId }, token }),

  createLoad: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ load: Load }>('/loads', { method: 'POST', body, token }),

  parseEmail: (token: string, body: Record<string, unknown>) =>
    apiFetch<ParseEmailResponse>('/loads/parse-email', { method: 'POST', body, token, timeoutMs: 30_000 }),

  advanceStatus: (token: string, loadId: string, to: Load['status']) =>
    apiFetch<{ load: Load }>(`/loads/${loadId}/status`, { method: 'POST', body: { to }, token }),

  calculateIfta: (token: string, body: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>('/ifta/calculate', { method: 'POST', body, token, timeoutMs: 20_000 }),

  aging: (token: string) => apiFetch<Record<string, unknown>>('/invoice/aging', { token }),
  settle: (token: string) => apiFetch<Record<string, unknown>>('/settle', { method: 'POST', body: {}, token }),
  bill: (token: string) => apiFetch<Record<string, unknown>>('/invoice', { method: 'POST', body: {}, token }),
};

/* -------------------------------------------------------------------------- */
/* Formatting helpers shared by the UI                                           */
/* -------------------------------------------------------------------------- */

export { formatUsd };

export function formatMiles(miles: number): string {
  return `${Math.round(miles).toLocaleString()} mi`;
}

export function formatCpm(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  if (minutes < 0) return 'no break due';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatEta(iso: string | null): string {
  if (!iso) return 'no ETA';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'no ETA';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
import {
  Errors,
  ageInDays,
  applyBasisPoints,
  isWithin,
  perMileCents,
  startOfWeekIso,
  type Cents,
  type Iso,
  type Load,
  type Result,
  type Truck,
  err,
  ok,
  sequenceKey,
} from '@truckdesk/shared';

/**
 * Broker invoicing and receivables aging.
 *
 * A small carrier lives or dies on collection, so the aging report is the point
 * of this module as much as the invoice is. Buckets follow the standard
 * 0 / 1-30 / 31-60 / 61-90 / 90+ convention that every factoring company and
 * every broker's credit department already understands.
 */

export type InvoiceStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'void' | 'overdue';

export type AgingBucket = 'current' | 'days_1_30' | 'days_31_60' | 'days_61_90' | 'days_90_plus';

export const AGING_BUCKETS: readonly AgingBucket[] = [
  'current',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'days_90_plus',
];

export interface InvoiceLine {
  id: string;
  loadId?: string;
  description: string;
  /** Type of charge, so a broker can match it to their own system. */
  kind: 'linehaul' | 'fuel_surcharge' | 'accessorial' | 'detention' | 'lumper' | 'toll' | 'other';
  miles: number;
  rateCents?: number;
  amountCents: Cents;
  taxCents?: Cents;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amountCents: Cents;
  at: Iso;
  method: 'ach' | 'check' | 'card' | 'wire' | 'quickpay' | 'offset' | 'other';
  reference?: string;
  note?: string;
  /** Set for a quick-pay discount; records the fee taken. */
  feeCents?: Cents;
}

export interface Invoice {
  id: string;
  companyId?: string;
  /** Human invoice number, e.g. INV-20261003-0007. */
  number: string;
  brokerName: string;
  /** The broker's account/credit reference. */
  brokerAccountRef?: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  /** Linehaul + surcharge + accessorials. */
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  payments: Payment[];
  amountPaidCents: Cents;
  balanceCents: Cents;
  /** Net-30 unless the carrier's broker agreement says otherwise. */
  termsDays: number;
  issuedAt: Iso;
  dueAt: Iso;
  deliveredAt?: Iso;
  paidAt?: Iso;
  /** The delivery date across all included loads; drives the aging clock. */
  loadIds: string[];
  notes?: string;
  /** Quick pay discount the broker was offered: bps off if paid within N days. */
  quickPayBps?: number;
  quickPayWindowDays?: number;
  createdAt: Iso;
}

export interface InvoiceInput {
  companyId?: string;
  brokerName: string;
  brokerAccountRef?: string;
  loads: readonly Load[];
  termsDays?: number;
  /** Extra charges not tied to a load. */
  extraLines?: InvoiceLine[];
  notes?: string;
  quickPayBps?: number;
  quickPayWindowDays?: number;
  issuedAt?: Iso;
  now?: Date;
  id?: string;
  sequence?: number;
}

export interface BuildInvoiceResult {
  invoice: Invoice;
  /** Loads skipped because they were already invoiced or not delivered. */
  skipped: Array<{ loadId: string; reason: string }>;
}

export function buildInvoice(
  input: InvoiceInput,
  alreadyInvoicedLoadIds: readonly string[] = [],
): Result<BuildInvoiceResult> {
  const now = input.now ?? new Date();
  const issuedAt = input.issuedAt ?? now.toISOString();

  if (!input.brokerName.trim()) {
    return err(Errors.invalidInput('Invoice needs a broker name'));
  }

  const termsDays = input.termsDays ?? 30;
  if (termsDays < 0 || termsDays > 120) {
    return err(Errors.invalidInput('Payment terms must be between 0 and 120 days'));
  }

  const invoiced = new Set(alreadyInvoicedLoadIds);
  const lines: InvoiceLine[] = [];
  const skipped: Array<{ loadId: string; reason: string }> = [];
  const loadIds: string[] = [];
  let deliveredAt: Iso | undefined;
  let sequence = 0;

  for (const load of input.loads) {
    if (load.broker !== input.brokerName) continue;

    if (load.cancelledAt) {
      skipped.push({ loadId: load.id, reason: 'Load was cancelled' });
      continue;
    }
    if (invoiced.has(load.id)) {
      skipped.push({ loadId: load.id, reason: 'Already invoiced' });
      continue;
    }
    if (load.status === 'booked' || load.status === 'dispatched') {
      skipped.push({ loadId: load.id, reason: `Load is ${load.status}; nothing delivered yet` });
      continue;
    }

    sequence += 1;
    const lineId = `il_${load.id}`;
    loadIds.push(load.id);

    // Split the all-in rate into its components when the load carries them,
    // because brokers reconcile by line, not by total.
    const linehaul = load.linehaulCents ?? Math.round(load.rate * 0.85);
    const fuel = load.fuelSurchargeCents ?? Math.max(0, load.rate - linehaul - (load.accessorialCents ?? 0));
    const accessorial = load.accessorialCents ?? 0;

    lines.push({
      id: `${lineId}_lh`,
      loadId: load.id,
      description: `Linehaul - ${load.origin} to ${load.destination}`,
      kind: 'linehaul',
      miles: load.miles,
      rateCents: perMileCents(linehaul, load.miles),
      amountCents: linehaul,
    });

    if (fuel > 0) {
      lines.push({
        id: `${lineId}_fs`,
        loadId: load.id,
        description: 'Fuel surcharge',
        kind: 'fuel_surcharge',
        miles: load.miles,
        rateCents: perMileCents(fuel, load.miles),
        amountCents: fuel,
      });
    }

    if (accessorial > 0) {
      lines.push({
        id: `${lineId}_ac`,
        loadId: load.id,
        description: 'Accessorials',
        kind: 'accessorial',
        miles: 0,
        amountCents: accessorial,
      });
    }

    if (load.proofOfDeliveryMissing) {
      lines.push({
        id: `${lineId}_note`,
        loadId: load.id,
        description: 'Note: POD not on file - broker may hold payment',
        kind: 'other',
        miles: 0,
        amountCents: 0,
      });
    }

    if (load.deliveredAt && (!deliveredAt || load.deliveredAt > deliveredAt)) {
      deliveredAt = load.deliveredAt;
    }
  }

  for (const extra of input.extraLines ?? []) {
    sequence += 1;
    lines.push({ ...extra, id: extra.id || `il_extra_${sequence}` });
  }

  if (lines.length === 0) {
    return err(
      Errors.invalidState(`No delivered loads found for ${input.brokerName}`, {
        broker: input.brokerName,
        skipped,
      }),
    );
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const taxCents = lines.reduce((sum, line) => sum + (line.taxCents ?? 0), 0);
  const totalCents = subtotalCents + taxCents;
  const dueAt = new Date(now.getTime() + termsDays * 86_400_000).toISOString();

  const invoice: Invoice = {
    id: input.id ?? `in_${sequenceKey('INV', now, input.sequence ?? sequence).toLowerCase()}`,
    companyId: input.companyId,
    number: sequenceKey('INV', now, input.sequence ?? sequence),
    brokerName: input.brokerName,
    brokerAccountRef: input.brokerAccountRef,
    status: 'draft',
    lines,
    subtotalCents,
    taxCents,
    totalCents,
    payments: [],
    amountPaidCents: 0,
    balanceCents: totalCents,
    termsDays,
    issuedAt,
    dueAt,
    deliveredAt,
    loadIds,
    notes: input.notes,
    quickPayBps: input.quickPayBps,
    quickPayWindowDays: input.quickPayWindowDays,
    createdAt: now.toISOString(),
  };

  return ok({ invoice, skipped });
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                      */
/* -------------------------------------------------------------------------- */

export function applyPayment(
  invoice: Invoice,
  payment: Omit<Payment, 'id'> & { id?: string },
  now: Date = new Date(),
): Result<Invoice> {
  if (invoice.status === 'void') {
    return err(Errors.invalidState('Cannot pay a void invoice'));
  }
  if (payment.amountCents <= 0) {
    return err(Errors.invalidInput('Payment amount must be positive'));
  }

  const maxPayable = invoice.balanceCents;
  if (payment.amountCents > maxPayable) {
    return err(
      Errors.invalidInput('Payment exceeds the invoice balance', {
        amountCents: payment.amountCents,
        balanceCents: maxPayable,
      }),
    );
  }

  const recorded: Payment = {
    ...payment,
    id: payment.id ?? `pm_${invoice.id}_${invoice.payments.length + 1}`,
  };

  const amountPaidCents = invoice.amountPaidCents + recorded.amountCents;
  const balanceCents = invoice.totalCents - amountPaidCents;
  const status: InvoiceStatus =
    balanceCents === 0 ? 'paid' : 'partially_paid';

  return ok({
    ...invoice,
    payments: [...invoice.payments, recorded],
    amountPaidCents,
    balanceCents,
    status,
    paidAt: status === 'paid' ? now.toISOString() : invoice.paidAt,
  });
}

/** Reverse a payment: a broker clawback or a chargeback. */
export function voidPayment(
  invoice: Invoice,
  paymentId: string,
): Result<Invoice> {
  const payment = invoice.payments.find((candidate) => candidate.id === paymentId);
  if (!payment) return err(Errors.notFound('Payment', paymentId));

  const payments = invoice.payments.filter((candidate) => candidate.id !== paymentId);
  const amountPaidCents = invoice.amountPaidCents - payment.amountCents;
  const balanceCents = invoice.totalCents - amountPaidCents;

  return ok({
    ...invoice,
    payments,
    amountPaidCents,
    balanceCents,
    status: balanceCents === 0 ? 'paid' : amountPaidCents > 0 ? 'partially_paid' : 'sent',
    paidAt: balanceCents === 0 ? invoice.paidAt : undefined,
  });
}

/**
 * Quick pay: broker pays early, we eat the fee.
 *
 * Brokers quote 85-95% of the rate for payment inside 2-3 days. The fee is a
 * real cost of capital, so it is reported separately rather than buried in
 * revenue.
 */
export function quickPayQuote(
  invoice: Invoice,
  opts: { bps?: number; windowDays?: number; now?: Date } = {},
): Result<QuickPayQuote> {
  const now = opts.now ?? new Date();
  const bps = opts.bps ?? invoice.quickPayBps ?? 0;
  const windowDays = opts.windowDays ?? invoice.quickPayWindowDays ?? 3;

  if (bps <= 0) {
    return err(Errors.invalidState('No quick-pay discount configured on this invoice'));
  }
  if (invoice.status === 'paid') {
    return err(Errors.invalidState('Invoice is already paid'));
  }

  const discountCents = applyBasisPoints(invoice.balanceCents, bps);
  const payoutCents = invoice.balanceCents - discountCents;
  const deadline = new Date(now.getTime() + windowDays * 86_400_000).toISOString();

  return ok({
    invoiceId: invoice.id,
    grossCents: invoice.balanceCents,
    discountBps: bps,
    discountCents,
    payoutCents,
    windowDays,
    deadline,
    annualizedFeeBps: annualizedFee(bps, windowDays),
  });
}

export interface QuickPayQuote {
  invoiceId: string;
  grossCents: Cents;
  discountBps: number;
  discountCents: Cents;
  payoutCents: Cents;
  windowDays: number;
  deadline: Iso;
  /** The implied cost of borrowing at that discount, for comparison to a card. */
  annualizedFeeBps: number;
}

function annualizedFee(bps: number, windowDays: number): number {
  if (windowDays <= 0) return 0;
  return Math.round((bps * 365) / windowDays);
}

export function markInvoiceSent(
  invoice: Invoice,
  now: Date = new Date(),
): Result<Invoice> {
  if (invoice.status !== 'draft') {
    return err(Errors.invalidState(`Invoice is ${invoice.status}; only drafts can be sent`));
  }
  const dueAt = new Date(now.getTime() + invoice.termsDays * 86_400_000).toISOString();
  return ok({ ...invoice, status: 'sent', issuedAt: now.toISOString(), dueAt });
}

/* -------------------------------------------------------------------------- */
/* Aging                                                                         */
/* -------------------------------------------------------------------------- */

export interface AgedInvoice {
  invoiceId: string;
  number: string;
  brokerName: string;
  totalCents: Cents;
  balanceCents: Cents;
  issuedAt: Iso;
  dueAt: Iso;
  ageDays: number;
  daysPastDue: number;
  bucket: AgingBucket;
  isOverdue: boolean;
  loadCount: number;
}

export interface AgingSummary {
  asOf: Iso;
  buckets: Record<AgingBucket, { count: number; balanceCents: Cents }>;
  totalOutstandingCents: Cents;
  totalOverdueCents: Cents;
  overdueCount: number;
  /** Weighted average days past due on overdue invoices. */
  averageDaysPastDue: number;
  /** Share of the book older than 60 days. */
  staleShare: number;
  topDelinquents: AgedInvoice[];
  invoices: AgedInvoice[];
}

export function agingReport(
  invoices: readonly Invoice[],
  now: Date = new Date(),
): AgingSummary {
  const buckets: AgingSummary['buckets'] = {
    current: { count: 0, balanceCents: 0 },
    days_1_30: { count: 0, balanceCents: 0 },
    days_31_60: { count: 0, balanceCents: 0 },
    days_61_90: { count: 0, balanceCents: 0 },
    days_90_plus: { count: 0, balanceCents: 0 },
  };

  const aged: AgedInvoice[] = [];

  for (const invoice of invoices) {
    if (invoice.status === 'paid' || invoice.status === 'void' || invoice.balanceCents <= 0) continue;

    const ageDays = ageInDays(invoice.issuedAt, now);
    const daysPastDue = Math.max(0, ageInDays(invoice.dueAt, now));
    const bucket = bucketFor(daysPastDue);

    const entry: AgedInvoice = {
      invoiceId: invoice.id,
      number: invoice.number,
      brokerName: invoice.brokerName,
      totalCents: invoice.totalCents,
      balanceCents: invoice.balanceCents,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      ageDays,
      daysPastDue,
      bucket,
      isOverdue: daysPastDue > 0,
      loadCount: invoice.loadIds.length,
    };
    aged.push(entry);

    buckets[bucket].count += 1;
    buckets[bucket].balanceCents += invoice.balanceCents;
  }

  const totalOutstandingCents = aged.reduce((sum, invoice) => sum + invoice.balanceCents, 0);
  const overdue = aged.filter((invoice) => invoice.isOverdue);
  const totalOverdueCents = overdue.reduce((sum, invoice) => sum + invoice.balanceCents, 0);

  const averageDaysPastDue =
    overdue.length === 0
      ? 0
      : Math.round(
          overdue.reduce((sum, invoice) => sum + invoice.daysPastDue, 0) / overdue.length,
        );

  const staleCents =
    buckets.days_61_90.balanceCents + buckets.days_90_plus.balanceCents;

  aged.sort((a, b) => b.daysPastDue - a.daysPastDue || b.balanceCents - a.balanceCents);

  return {
    asOf: now.toISOString(),
    buckets,
    totalOutstandingCents,
    totalOverdueCents,
    overdueCount: overdue.length,
    averageDaysPastDue,
    staleShare: totalOutstandingCents > 0 ? round4(staleCents / totalOutstandingCents) : 0,
    topDelinquents: aged.slice(0, 10),
    invoices: aged,
  };
}

export function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'days_1_30';
  if (daysPastDue <= 60) return 'days_31_60';
  if (daysPastDue <= 90) return 'days_61_90';
  return 'days_90_plus';
}

export function bucketLabel(bucket: AgingBucket): string {
  switch (bucket) {
    case 'current':
      return 'Current';
    case 'days_1_30':
      return '1-30 days';
    case 'days_31_60':
      return '31-60 days';
    case 'days_61_90':
      return '61-90 days';
    case 'days_90_plus':
      return '90+ days';
    default:
      return bucket;
  }
}

/** Flip any sent invoice whose due date has passed into `overdue`. */
export function refreshOverdue(invoices: readonly Invoice[], now: Date = new Date()): Invoice[] {
  return invoices.map((invoice) => {
    if (invoice.status !== 'sent' && invoice.status !== 'partially_paid' && invoice.status !== 'overdue') {
      return invoice;
    }
    const overdueBy = ageInDays(invoice.dueAt, now);
    if (overdueBy > 0) return { ...invoice, status: 'overdue' };
    // Back inside terms: fall back to whatever it was before it went overdue.
    return { ...invoice, status: invoice.amountPaidCents > 0 ? 'partially_paid' : 'sent' };
  });
}

/* -------------------------------------------------------------------------- */
/* Weekly billing run                                                            */
/* -------------------------------------------------------------------------- */

export interface WeeklyBillingInput {
  loads: readonly Load[];
  trucks?: readonly Truck[];
  alreadyInvoicedLoadIds?: readonly string[];
  /** Restrict the run to delivered loads inside this week. */
  week?: { start: Iso; end: Iso; label?: string };
  termsDays?: number;
  quickPayBps?: number;
  now?: Date;
  companyId?: string;
}

export interface WeeklyBillingResult {
  invoices: Invoice[];
  skipped: Array<{ loadId: string; broker: string; reason: string }>;
  totalInvoicedCents: Cents;
  byBroker: Array<{ broker: string; invoiceCount: number; totalCents: Cents; loadCount: number }>;
  week: { start: Iso; end: Iso; label?: string } | null;
}

/** Group delivered loads by broker and raise one invoice per broker. */
export function runWeeklyBilling(input: WeeklyBillingInput): Result<WeeklyBillingResult> {
  const now = input.now ?? new Date();
  const invoiced = new Set(input.alreadyInvoicedLoadIds ?? []);

  let eligible = input.loads.filter((load) => {
    if (load.cancelledAt) return false;
    if (invoiced.has(load.id)) return false;
    if (load.status === 'booked' || load.status === 'dispatched') return false;
    if (input.week && load.deliveredAt && !isWithin(load.deliveredAt, input.week.start, input.week.end)) {
      return false;
    }
    return true;
  });

  if (input.week && !input.week.label) {
    eligible = eligible.filter((load) => load.deliveredAt !== undefined);
  }

  if (eligible.length === 0) {
    return ok({
      invoices: [],
      skipped: [],
      totalInvoicedCents: 0,
      byBroker: [],
      week: input.week ?? null,
    });
  }

  const byBroker = new Map<string, Load[]>();
  for (const load of eligible) {
    const bucket = byBroker.get(load.broker);
    if (bucket) bucket.push(load);
    else byBroker.set(load.broker, [load]);
  }

  const invoices: Invoice[] = [];
  const skipped: WeeklyBillingResult['skipped'] = [];
  let sequence = 0;

  for (const [broker, loads] of [...byBroker.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    sequence += 1;
    const built = buildInvoice({
      companyId: input.companyId,
      brokerName: broker,
      loads,
      termsDays: input.termsDays ?? 30,
      quickPayBps: input.quickPayBps ?? 200,
      quickPayWindowDays: 3,
      now,
      sequence,
    });

    if (!built.ok) {
      // buildInvoice reports per-load reasons in `details.skipped` when it
      // refuses to raise an invoice at all; surface them on the run summary.
      const skippedDetail = built.error.details?.['skipped'];
      if (Array.isArray(skippedDetail)) {
        for (const item of skippedDetail) {
          if (item && typeof item === 'object') {
            const record = item as { loadId?: unknown; reason?: unknown };
            skipped.push({
              loadId: String(record.loadId ?? 'unknown'),
              broker,
              reason: String(record.reason ?? built.error.message),
            });
          }
        }
      }
      continue;
    }

    invoices.push(built.value.invoice);
    for (const item of built.value.skipped) {
      skipped.push({ loadId: item.loadId, broker, reason: item.reason });
    }
  }

  const totalInvoicedCents = invoices.reduce((sum, invoice) => sum + invoice.totalCents, 0);

  return ok({
    invoices,
    skipped,
    totalInvoicedCents,
    byBroker: invoices.map((invoice) => ({
      broker: invoice.brokerName,
      invoiceCount: 1,
      totalCents: invoice.totalCents,
      loadCount: invoice.loadIds.length,
    })),
    week: input.week ?? null,
  });
}

/**
 * Receivables KPI rollup for the dashboard tile. Compares this week to last so
 * the owner can see whether collection is improving.
 */
export function receivablesSummary(
  invoices: readonly Invoice[],
  now: Date = new Date(),
): {
  outstandingCents: Cents;
  overdueCents: Cents;
  collectedThisWeekCents: Cents;
  invoicedThisWeekCents: Cents;
  dso: number;
} {
  const currentWeek = startOfWeekIso(now.toISOString());
  const previousWeek = startOfWeekIso(
    new Date(Date.parse(currentWeek.start) - 7 * 86_400_000).toISOString(),
  );

  const aging = agingReport(invoices, now);

  let collectedThisWeekCents: Cents = 0;
  let invoicedThisWeekCents: Cents = 0;
  let collectedLastWeekCents: Cents = 0;

  for (const invoice of invoices) {
    if (isWithin(invoice.issuedAt, currentWeek.start, currentWeek.end)) {
      invoicedThisWeekCents += invoice.totalCents;
    }
    for (const payment of invoice.payments) {
      if (isWithin(payment.at, currentWeek.start, currentWeek.end)) {
        collectedThisWeekCents += payment.amountCents;
      }
      if (isWithin(payment.at, previousWeek.start, previousWeek.end)) {
        collectedLastWeekCents += payment.amountCents;
      }
    }
  }

  // DSO = (receivables / revenue) * days, the standard 30-day approximation.
  const revenueThisWeekCents = invoicedThisWeekCents || collectedLastWeekCents;
  const dso =
    revenueThisWeekCents > 0
      ? Math.round((aging.totalOutstandingCents / revenueThisWeekCents) * 7)
      : 0;

  return {
    outstandingCents: aging.totalOutstandingCents,
    overdueCents: aging.totalOverdueCents,
    collectedThisWeekCents,
    invoicedThisWeekCents,
    dso: Math.max(0, dso),
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
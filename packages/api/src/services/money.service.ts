import {
  applyPayment,
  approveSettlement,
  buildInvoice,
  calculateSettlement,
  markInvoiceSent,
  markSettlementPaid,
  quickPayQuote,
  receivablesSummary,
  refreshOverdue,
  runWeeklyBilling,
  agingReport,
  signSettlement,
  renderBol,
  renderInvoice,
  renderPod,
  renderRateConfirmation,
  type AgingSummary,
  type Invoice,
  type QuickPayQuote,
  type Settlement,
} from '@truckdesk/core';
import {
  Errors,
  formatUsd,
  startOfWeekIso,
  type Driver,
  type Load,
  type WeekWindow,
} from '@truckdesk/shared';
import { createLoad as createLoadRecord } from '@truckdesk/loads';

import type { Services } from './container.js';

/**
 * Money services: invoicing, settlements, and the documents that go out with
 * them (rate con, BOL, POD, invoice PDF).
 */

/* -------------------------------------------------------------------------- */
/* Invoicing                                                                     */
/* -------------------------------------------------------------------------- */

export interface BillingOptions {
  brokerName?: string;
  week?: WeekWindow;
  termsDays?: number;
  quickPayBps?: number;
  companyId?: string;
  companyName?: string;
  companyMcNumber?: string;
  companyAddress?: string;
  now?: Date;
}

export interface BillingOutcome {
  invoices: Invoice[];
  skipped: Array<{ loadId: string; broker: string; reason: string }>;
  totalCents: number;
  summary: string[];
}

export async function weeklyBilling(
  services: Services,
  companyId: string,
  options: BillingOptions = {},
): Promise<BillingOutcome> {
  const company = services.forCompany(companyId);
  const now = options.now ?? new Date();
  const week = options.week ?? startOfWeekIso(now.toISOString());

  const all = await company.loads.query({ companyId, limit: 1000 });
  const alreadyInvoiced = await company.invoices.invoicedLoadIds();

  const result = runWeeklyBilling({
    loads: all.items,
    alreadyInvoicedLoadIds: alreadyInvoiced,
    week: options.week ?? { start: week.start, end: week.end, label: week.label },
    termsDays: options.termsDays ?? 30,
    quickPayBps: options.quickPayBps ?? 200,
    now,
    companyId,
  });

  if (!result.ok) throw result.error;

  const persisted: Invoice[] = [];
  for (const invoice of result.value.invoices) {
    // Sequence the number off the count already stored, so two runs in one day
    // do not collide on INV-YYYYMMDD-0001.
    const existing = await company.invoices.query(companyId);
    const sequence = existing.length + persisted.length + 1;
    const numbered = reNumber(invoice, sequence, now);

    await company.invoices.create(numbered);
    await markLoadsInvoiced(services, companyId, numbered.loadIds);
    persisted.push(numbered);
  }

  const totalCents = persisted.reduce((sum, invoice) => sum + invoice.totalCents, 0);

  return {
    invoices: persisted,
    skipped: result.value.skipped,
    totalCents,
    summary: persisted.map(
      (invoice) => `${invoice.brokerName}: ${invoice.lines.length} lines, ${formatUsd(invoice.totalCents)}`,
    ),
  };
}

function reNumber(invoice: Invoice, sequence: number, now: Date): Invoice {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return { ...invoice, number: `INV-${yyyy}${mm}${dd}-${String(sequence).padStart(4, '0')}` };
}

async function markLoadsInvoiced(
  services: Services,
  companyId: string,
  loadIds: string[],
): Promise<void> {
  if (loadIds.length === 0) return;
  const company = services.forCompany(companyId);
  for (const id of loadIds) {
    const load = await company.loads.findById(id);
    if (load) await company.loads.update(load);
  }
}

export async function buildInvoiceForBroker(
  services: Services,
  companyId: string,
  brokerName: string,
  options: BillingOptions = {},
): Promise<Invoice> {
  const company = services.forCompany(companyId);
  const now = options.now ?? new Date();

  const loads = await company.loads.query({ companyId, broker: brokerName, limit: 500 });
  const alreadyInvoiced = await company.invoices.invoicedLoadIds();

  const result = buildInvoice({
    companyId,
    brokerName,
    loads: loads.items,
    termsDays: options.termsDays ?? 30,
    quickPayBps: options.quickPayBps ?? 200,
    quickPayWindowDays: 3,
    now,
  });

  if (!result.ok) throw result.error;

  const invoice = result.value.invoice;
  await company.invoices.create(invoice);
  await markLoadsInvoiced(services, companyId, invoice.loadIds);
  return invoice;
}

export async function sendInvoice(
  services: Services,
  companyId: string,
  invoiceId: string,
): Promise<Invoice> {
  const company = services.forCompany(companyId);
  const invoice = await company.invoices.findById(invoiceId);
  if (!invoice) throw Errors.notFound('Invoice', invoiceId);

  const sent = markInvoiceSent(invoice);
  if (!sent.ok) throw sent.error;

  return company.invoices.update(sent.value);
}

export async function recordPayment(
  services: Services,
  companyId: string,
  invoiceId: string,
  payment: { amountCents: number; method: Invoice['payments'][number]['method']; reference?: string; at?: string; note?: string },
): Promise<Invoice> {
  const company = services.forCompany(companyId);
  const invoice = await company.invoices.findById(invoiceId);
  if (!invoice) throw Errors.notFound('Invoice', invoiceId);

  const applied = applyPayment(invoice, {
    id: `pm_${invoice.id}_${invoice.payments.length + 1}`,
    invoiceId: invoice.id,
    amountCents: Math.round(payment.amountCents),
    method: payment.method,
    reference: payment.reference,
    note: payment.note,
    at: payment.at ?? new Date().toISOString(),
  });
  if (!applied.ok) throw applied.error;

  const updated = await company.invoices.update(applied.value);

  // Mark the loads paid when the invoice clears: this is what closes the load.
  if (updated.status === 'paid') {
    const company2 = services.forCompany(companyId);
    for (const loadId of updated.loadIds) {
      const load = await company2.loads.findById(loadId);
      if (load && load.status === 'delivered') {
        await company2.loads.update({ ...load, status: 'paid', paidAt: new Date().toISOString() });
      }
    }
  }

  return updated;
}

export async function aging(
  services: Services,
  companyId: string,
  now: Date = new Date(),
): Promise<AgingSummary & { receivables: ReturnType<typeof receivablesSummary> }> {
  const company = services.forCompany(companyId);
  const invoices = refreshOverdue(await company.invoices.query(companyId), now);
  const report = agingReport(invoices, now);
  return { ...report, receivables: receivablesSummary(invoices, now) };
}

export async function quickPayQuoteFor(
  services: Services,
  companyId: string,
  invoiceId: string,
  bps?: number,
): Promise<QuickPayQuote> {
  const company = services.forCompany(companyId);
  const invoice = await company.invoices.findById(invoiceId);
  if (!invoice) throw Errors.notFound('Invoice', invoiceId);

  const quote = quickPayQuote(invoice, bps ? { bps } : {});
  if (!quote.ok) throw quote.error;

  const value: QuickPayQuote = {
    invoiceId: quote.value.invoiceId,
    grossCents: quote.value.grossCents,
    discountBps: quote.value.discountBps,
    discountCents: quote.value.discountCents,
    payoutCents: quote.value.payoutCents,
    windowDays: quote.value.windowDays,
    deadline: quote.value.deadline,
    annualizedFeeBps: quote.value.annualizedFeeBps,
  };
  return value;
}

export async function invoicePdf(
  services: Services,
  companyId: string,
  invoiceId: string,
  company: { name: string; mcNumber?: string; address?: string },
): Promise<Uint8Array> {
  const repos = services.forCompany(companyId);
  const invoice = await repos.invoices.findById(invoiceId);
  if (!invoice) throw Errors.notFound('Invoice', invoiceId);

  const document = await renderInvoice({
    invoiceNumber: invoice.number,
    brokerName: invoice.brokerName,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    termsDays: invoice.termsDays,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      kind: line.kind,
      miles: line.miles,
      amountCents: line.amountCents,
    })),
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    balanceCents: invoice.balanceCents,
    companyName: company.name,
    companyMcNumber: company.mcNumber,
    companyAddress: company.address,
    notes: invoice.notes,
  });

  return document.bytes;
}

/* -------------------------------------------------------------------------- */
/* Settlements                                                                   */
/* -------------------------------------------------------------------------- */

export interface SettlementRunResult {
  settlements: Settlement[];
  skipped: string[];
  totalNetCents: number;
  totalMarginCents: number;
  week: WeekWindow;
}

export async function runSettlements(
  services: Services,
  companyId: string,
  options: {
    week?: WeekWindow;
    driverId?: string;
    persist?: boolean;
    deadheadByLoad?: Record<string, number>;
    now?: Date;
  } = {},
): Promise<SettlementRunResult> {
  const company = services.forCompany(companyId);
  const now = options.now ?? new Date();
  const week = options.week ?? startOfWeekIso(now.toISOString());

  const drivers = options.driverId
    ? [await company.drivers.findById(options.driverId)].filter((d): d is Driver => Boolean(d))
    : await company.drivers.query(companyId, { status: ['active'] });

  const loads = await company.loads.query({ companyId, limit: 1000 });

  const settlements: Settlement[] = [];
  const skipped: string[] = [];

  for (const driver of drivers) {
    const driverLoads = loads.items.filter(
      (load) => !load.assignedDriverId || load.assignedDriverId === driver.id,
    );

    const result = calculateSettlement({
      driver,
      week,
      loads: driverLoads,
      deadheadByLoad: options.deadheadByLoad,
      now: now.toISOString(),
    });

    if (!result.ok) {
      skipped.push(`${driver.name}: ${result.error.message}`);
      continue;
    }

    const settlement = result.value;

    if (options.persist !== false) {
      const existing = await company.settlements.findByDriverWeek(driver.id, week.key);
      if (existing) {
        // Re-running a week must not duplicate it; overwrite the draft.
        settlements.push(await company.settlements.update({ ...settlement, id: existing.id }));
        continue;
      }
      settlements.push(await company.settlements.create(settlement));
      continue;
    }

    settlements.push(settlement);
  }

  const totalNetCents = settlements.reduce((sum, settlement) => sum + settlement.summary.netCents, 0);
  const totalMarginCents = settlements.reduce(
    (sum, settlement) => sum + (settlement.summary.grossRevenueCents - settlement.summary.grossCents),
    0,
  );

  return { settlements, skipped, totalNetCents, totalMarginCents, week };
}

export async function approveSettlementService(
  services: Services,
  companyId: string,
  settlementId: string,
  actorId: string,
): Promise<Settlement> {
  const company = services.forCompany(companyId);
  const settlement = await company.settlements.findById(settlementId);
  if (!settlement) throw Errors.notFound('Settlement', settlementId);

  const approved = approveSettlement(settlement, actorId);
  if (!approved.ok) throw approved.error;

  return company.settlements.update(approved.value);
}

export async function signSettlementService(
  services: Services,
  companyId: string,
  settlementId: string,
  signatureName: string,
): Promise<Settlement> {
  const company = services.forCompany(companyId);
  const settlement = await company.settlements.findById(settlementId);
  if (!settlement) throw Errors.notFound('Settlement', settlementId);

  const signed = signSettlement(settlement, signatureName);
  if (!signed.ok) throw signed.error;

  return company.settlements.update(signed.value);
}

export async function paySettlementService(
  services: Services,
  companyId: string,
  settlementId: string,
  method: Settlement['paymentMethod'] = 'direct_deposit',
): Promise<Settlement> {
  const company = services.forCompany(companyId);
  const settlement = await company.settlements.findById(settlementId);
  if (!settlement) throw Errors.notFound('Settlement', settlementId);

  const paid = markSettlementPaid(settlement, method);
  if (!paid.ok) throw paid.error;

  return company.settlements.update(paid.value);
}

/* -------------------------------------------------------------------------- */
/* Load documents                                                                */
/* -------------------------------------------------------------------------- */

export interface LoadPdfOptions {
  companyName: string;
  companyMcNumber?: string;
  companyAddress?: string;
  driverName?: string;
  truckUnit?: string;
}

export async function loadDocument(
  services: Services,
  companyId: string,
  loadId: string,
  kind: 'rate_con' | 'bol' | 'pod',
  options: LoadPdfOptions,
): Promise<{ bytes: Uint8Array; fileName: string; renderer: string }> {
  const company = services.forCompany(companyId);
  const load = await company.loads.findById(loadId);
  if (!load) throw Errors.notFound('Load', loadId);

  const documents = await company.documents.findForLoad(loadId);
  const enriched: Load = { ...load, documents };

  const driverName =
    options.driverName ??
    (load.assignedDriverId ? (await company.drivers.findById(load.assignedDriverId))?.name : undefined);

  if (kind === 'rate_con') {
    const document = await renderRateConfirmation({
      load: enriched,
      companyName: options.companyName,
      companyMcNumber: options.companyMcNumber,
      companyAddress: options.companyAddress,
      driverName,
      truckUnit: options.truckUnit,
    });
    return { bytes: document.bytes, fileName: document.fileName, renderer: document.renderer };
  }

  if (kind === 'bol') {
    const document = await renderBol({
      load: enriched,
      companyName: options.companyName,
      companyMcNumber: options.companyMcNumber,
      driverName,
      truckUnit: options.truckUnit,
    });
    return { bytes: document.bytes, fileName: document.fileName, renderer: document.renderer };
  }

  const pod = documents.find((doc) => doc.type === 'pod');
  const document = await renderPod({
    load: enriched,
    companyName: options.companyName,
    driverName,
    signatureName: pod?.signatureName,
    signatureDataUrl: pod?.signatureDataUrl,
    exceptions: buildExceptions(enriched),
    photos: documents
      .filter((doc) => doc.type === 'damage_photo')
      .map((doc) => ({ fileName: doc.fileName, capturedAt: doc.capturedAt })),
  });
  return { bytes: document.bytes, fileName: document.fileName, renderer: document.renderer };
}

/** The exception notes a broker reads at the top of a POD. */
export function buildExceptions(load: Load): string[] {
  const exceptions: string[] = [];

  for (const stop of load.stops ?? []) {
    if (stop.status === 'skipped') {
      exceptions.push(`Stop skipped: ${stop.facilityName}, ${stop.city} ${stop.state} - ${stop.notes ?? 'no reason given'}`);
    }
    if (stop.status !== 'completed' && stop.status !== 'skipped') {
      exceptions.push(`Stop incomplete: ${stop.facilityName}, ${stop.city} ${stop.state}`);
    }
    if (stop.notes && stop.status === 'completed') {
      exceptions.push(`${stop.facilityName}: ${stop.notes}`);
    }
  }

  if (load.proofOfDeliveryMissing) {
    exceptions.push('No signed proof of delivery was captured at delivery');
  }
  if (load.notes) exceptions.push(load.notes);

  return exceptions;
}

/** Quick-pay quote for a load, for the factoring button in the app. */
export function loadQuickPay(load: Load, bps = 200): QuickPayQuote {
  const invoiceLike = {
    id: load.id,
    balanceCents: load.rate,
  } as unknown as Invoice;
  const quote = quickPayQuote(invoiceLike, { bps });
  if (!quote.ok) {
    return {
      invoiceId: load.id,
      grossCents: load.rate,
      discountBps: bps,
      discountCents: 0,
      payoutCents: load.rate,
      windowDays: 3,
      deadline: new Date().toISOString(),
      annualizedFeeBps: Math.round((bps * 365) / 3),
    };
  }
  return quote.value;
}

export { createLoadRecord };
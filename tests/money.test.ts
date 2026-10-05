import { describe, expect, it } from 'vitest';

import {
  agingReport,
  applyPayment,
  approveSettlement,
  buildInvoice,
  calculateSettlement,
  markInvoiceSent,
  markSettlementPaid,
  payForLoad,
  quickPayQuote,
  runWeeklyBilling,
  signSettlement,
  yearToDate,
  type Invoice,
  type Settlement,
} from '@truckdesk/core';
import { formatUsd, quarterWindow, startOfWeekIso } from '@truckdesk/shared';

import { FIXTURE_NOW_ISO, drivers, loadById, loads, loadsWithStatus } from '@fixtures/loads';

/**
 * Settlement and invoicing.
 *
 * Two invariants carry these tests. A settlement's lines must sum to its net, or
 * a driver will notice. And no load may be invoiced twice, because a broker that
 * finds a duplicate will stop paying the whole account.
 */

const NOW = FIXTURE_NOW_ISO;
// The fixture clock is Monday 14:00, so 'this week' is only 14 hours long.
// Settlement tests need a week that actually contains the delivered fixtures, so they
// anchor on the previous Monday.
const SETTLEMENT_ANCHOR = '2026-03-09T14:00:00.000Z';
const WEEK = startOfWeekIso(SETTLEMENT_ANCHOR);

describe('calculateSettlement', () => {
  const driver = drivers().find((d) => d.id === 'dr_t01')!; // $0.48/mi
  const ownerOperator = drivers().find((d) => d.id === 'dr_t05')!; // 30%

  it('pays only loads delivered in the week', () => {
    const result = calculateSettlement({
      driver,
      week: WEEK,
      loads: loads(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Delivered loads in this week; the booked ones and the in-transit ones
    // carry over.
    expect(result.value.summary.loadsCompleted).toBeGreaterThan(0);
    for (const line of result.value.lines.filter((entry) => entry.kind === 'revenue')) {
      const load = loadById(line.loadId!);
      expect(load.deliveredAt).toBeDefined();
      // String comparison works for ISO-8601, but be explicit about it.
      expect(Date.parse(load.deliveredAt!)).toBeGreaterThanOrEqual(Date.parse(WEEK.start));
      expect(Date.parse(load.deliveredAt!)).toBeLessThanOrEqual(Date.parse(WEEK.end));
    }
  });

  it('makes the payable lines sum exactly to the net', () => {
    const result = calculateSettlement({ driver, week: WEEK, loads: loads(), now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Revenue lines are context - what the broker paid - and are not driver pay,
    // so only the payable lines sum down to the bottom line.
    const payable = result.value.lines.filter((line) => line.kind !== 'revenue');
    const summed = payable.reduce((total, line) => total + line.amountCents, 0);
    expect(summed).toBe(result.value.summary.netCents);

    // The revenue lines sum to the gross revenue instead.
    const revenue = result.value.lines.filter((line) => line.kind === 'revenue');
    expect(revenue.reduce((total, line) => total + line.amountCents, 0)).toBe(
      result.value.summary.grossRevenueCents,
    );
  });

  it('pays per mile for a company driver', () => {
    const result = calculateSettlement({ driver, week: WEEK, loads: loads(), now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payLines = result.value.lines.filter((line) => line.kind === 'load_pay');
    for (const line of payLines) {
      const load = loadById(line.loadId!);
      expect(line.amountCents).toBe(Math.round(48 * load.miles));
    }
  });

  it('pays a percentage on linehaul only', () => {
    const load = loadById('ld_f18'); // $740, linehaul 85%
    const pay = payForLoad(ownerOperator, load, load.miles, false);

    expect(pay).toBe(Math.round(load.linehaulCents! * 0.3));
    // Fuel surcharge is not driver pay.
    expect(pay).toBeLessThan(Math.round(load.rate * 0.3));
  });

  it('halves percentage pay on empty miles', () => {
    const load = loadById('ld_f18');
    const loaded = payForLoad(ownerOperator, load, load.miles, false);
    const empty = payForLoad(ownerOperator, load, 100, true);

    expect(empty).toBe(Math.round((Math.round(load.linehaulCents! * 0.3) / 2 / 2)));
    expect(empty).toBeLessThan(loaded);
  });

  it('subtracts advances and deductions', () => {
    const result = calculateSettlement({
      driver,
      week: WEEK,
      loads: loads(),
      advances: [{ id: 'a1', amountCents: 20_000, date: NOW, note: 'Settle up' }],
      deductions: [{ id: 'd1', amountCents: 5_000, category: 'fuel_card' }],
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.advancesCents).toBe(20_000);
    expect(result.value.summary.deductionsCents).toBe(5_000);
    expect(result.value.summary.netCents).toBe(result.value.summary.grossCents - 25_000);
  });

  it('records deductions as negative lines so the column sums down', () => {
    const result = calculateSettlement({
      driver,
      week: WEEK,
      loads: loads(),
      deductions: [{ id: 'd1', amountCents: 5_000, category: 'damage', note: 'Trailer scrape' }],
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deduction = result.value.lines.find((line) => line.kind === 'deduction');
    expect(deduction?.amountCents).toBe(-5_000);
    expect(deduction?.description).toContain('Damage');
  });

  it('errors when the driver delivered nothing', () => {
    const result = calculateSettlement({
      driver,
      week: { key: '1999-01-04', start: '1999-01-04T00:00:00.000Z', end: '1999-01-10T23:59:59.999Z', label: 'old' },
      loads: loads(),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/nothing to settle/i);
  });

  it('excludes in-transit loads and says so', () => {
    const result = calculateSettlement({
      driver,
      week: WEEK,
      loads: loads(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inTransit = loadsWithStatus('in-transit');
    for (const load of inTransit) {
      expect(result.value.lines.some((line) => line.loadId === load.id)).toBe(false);
    }
  });
});

describe('settlement lifecycle', () => {
  function draft(): Settlement {
    const driver = drivers().find((d) => d.id === 'dr_t01')!;
    const result = calculateSettlement({ driver, week: WEEK, loads: loads(), now: NOW });
    if (!result.ok) throw result.error;
    return result.value;
  }

  it('approves a draft', () => {
    const approved = approveSettlement(draft(), 'us_owner', NOW);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.status).toBe('approved');
    expect(approved.value.approvedBy).toBe('us_owner');
  });

  it('will not approve a settlement that is already approved', () => {
    const first = approveSettlement(draft(), 'us_owner', NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = approveSettlement(first.value, 'us_owner', NOW);
    expect(second.ok).toBe(false);
  });

  it('will not approve a negative settlement', () => {
    const base = draft();
    const negative: Settlement = {
      ...base,
      status: 'draft',
      summary: { ...base.summary, netCents: -100 },
    };

    const result = approveSettlement(negative, 'us_owner', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/negative/i);
  });

  it('signs with a driver signature', () => {
    const signed = signSettlement(draft(), 'Marcus Bell', NOW);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.driverSignatureName).toBe('Marcus Bell');
    expect(signed.value.driverSignedAt).toBe(NOW);
  });

  it('requires a signature name', () => {
    expect(signSettlement(draft(), '   ', NOW).ok).toBe(false);
  });

  it('marks a settlement paid', () => {
    const paid = markSettlementPaid(draft(), 'direct_deposit', NOW);
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.value.status).toBe('paid');
    expect(paid.value.paidAt).toBe(NOW);
  });

  it('rolls up year to date', () => {
    const first = draft();
    const total = yearToDate([first, first]);
    expect(total.weeks).toBe(2);
    expect(total.grossCents).toBe(first.summary.grossCents * 2);
  });
});

describe('buildInvoice', () => {
  it('splits the rate into linehaul, fuel and accessorials', () => {
    const delivered = loadsWithStatus('delivered');
    const result = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: delivered,
      now: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const invoice = result.value.invoice;
    const kinds = invoice.lines.map((line) => line.kind);
    expect(kinds).toContain('linehaul');
    expect(kinds).toContain('fuel_surcharge');

    // The lines must add up to the subtotal, and the subtotal to the total.
    const summed = invoice.lines.reduce((sum, line) => sum + line.amountCents, 0);
    expect(summed).toBe(invoice.subtotalCents);
    expect(invoice.totalCents).toBe(invoice.subtotalCents + invoice.taxCents);
  });

  it('includes only delivered and paid loads', () => {
    const result = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loads(),
      now: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const skippedStatuses = result.value.skipped.map((item) => item.reason);
    for (const load of loads()) {
      if (load.status === 'booked' || load.status === 'dispatched') {
        expect(skippedStatuses.some((reason) => reason.includes(load.status))).toBe(true);
      }
    }
  });

  it('never invoices a cancelled load', () => {
    const result = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loads(),
      now: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoice.loadIds).not.toContain('ld_f10');
  });

  it('skips a load that is already invoiced', () => {
    const result = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loads(),
      now: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const firstId = result.value.invoice.loadIds[0];
    expect(firstId).toBeDefined();

    const second = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loads(),
      now: new Date(NOW),
    }, [firstId!]);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.invoice.loadIds).not.toContain(firstId);
  });

  it('notes a delivery with no POD on the invoice', () => {
    const delivered = loadsWithStatus('delivered');
    const missingPod = delivered.find((load) => load.proofOfDeliveryMissing);
    expect(missingPod).toBeDefined();

    const result = buildInvoice({
      brokerName: missingPod!.broker,
      loads: delivered,
      now: new Date(NOW),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.invoice.lines.some((line) => line.description.includes('POD not on file')),
    ).toBe(true);
  });

  it('errors when nothing is deliverable', () => {
    const result = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loadsWithStatus('booked'),
      now: new Date(NOW),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a broker-less invoice', () => {
    expect(buildInvoice({ brokerName: '', loads: loadsWithStatus('delivered') }).ok).toBe(false);
  });
});

describe('invoice payments', () => {
  function invoice(): Invoice {
    const result = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loadsWithStatus('delivered'),
      now: new Date(NOW),
    });
    if (!result.ok) throw result.error;
    return result.value.invoice;
  }

  it('applies a partial payment and keeps a balance', () => {
    const base = invoice();
    const paid = applyPayment(
      base,
      { amountCents: 50_000, method: 'ach', at: NOW },
      new Date(NOW),
    );

    expect(paid.ok).toBe(true);
    if (!paid.ok) return;

    expect(paid.value.status).toBe('partially_paid');
    expect(paid.value.amountPaidCents).toBe(50_000);
    expect(paid.value.balanceCents).toBe(base.totalCents - 50_000);
  });

  it('closes the invoice when paid in full', () => {
    const base = invoice();
    const paid = applyPayment(
      base,
      { amountCents: base.totalCents, method: 'ach', at: NOW },
      new Date(NOW),
    );

    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.value.status).toBe('paid');
    expect(paid.value.balanceCents).toBe(0);
  });

  it('refuses an overpayment', () => {
    const base = invoice();
    const over = applyPayment(base, { amountCents: base.totalCents + 1, method: 'ach', at: NOW });
    expect(over.ok).toBe(false);
  });

  it('refuses a negative payment', () => {
    expect(applyPayment(invoice(), { amountCents: -100, method: 'ach', at: NOW }).ok).toBe(false);
  });

  it('sends a draft and sets the due date', () => {
    const base = invoice();
    const sent = markInvoiceSent(base, new Date(NOW));
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.status).toBe('sent');
    expect(Date.parse(sent.value.dueAt)).toBeGreaterThan(Date.parse(NOW));
  });

  it('refuses to send twice', () => {
    const base = invoice();
    const sent = markInvoiceSent(base, new Date(NOW));
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(markInvoiceSent(sent.value, new Date(NOW)).ok).toBe(false);
  });
});

describe('quick pay', () => {
  it('quotes a discount and the resulting payout', () => {
    const base = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loadsWithStatus('delivered'),
      now: new Date(NOW),
    });
    if (!base.ok) throw base.error;

    const quote = quickPayQuote(base.value.invoice, { bps: 200, windowDays: 3 });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;

    expect(quote.value.discountCents).toBe(Math.round(base.value.invoice.balanceCents * 0.02));
    expect(quote.value.payoutCents).toBe(
      base.value.invoice.balanceCents - quote.value.discountCents,
    );
    // ~2% for 3 days is a ~243% annualised cost of capital.
    expect(quote.value.annualizedFeeBps).toBeGreaterThan(20_000);
  });

  it('refuses when no discount is configured', () => {
    const base = buildInvoice({
      brokerName: 'Midwest Freight',
      loads: loadsWithStatus('delivered'),
      now: new Date(NOW),
    });
    if (!base.ok) throw base.error;

    const quote = quickPayQuote(base.value.invoice, { bps: 0 });
    expect(quote.ok).toBe(false);
  });
});

describe('aging report', () => {
  function agedInvoice(daysPastDue: number, balanceCents: number): Invoice {
    const issuedAt = new Date(Date.parse(NOW) - (daysPastDue + 30) * 86_400_000).toISOString();
    return {
      id: `in_${daysPastDue}_${balanceCents}`,
      number: `INV-TEST-${daysPastDue}`,
      brokerName: 'Test Broker',
      status: daysPastDue > 0 ? 'overdue' : 'sent',
      lines: [],
      subtotalCents: balanceCents,
      taxCents: 0,
      totalCents: balanceCents,
      payments: [],
      amountPaidCents: 0,
      balanceCents,
      termsDays: 30,
      issuedAt,
      dueAt: new Date(Date.parse(issuedAt) + 30 * 86_400_000).toISOString(),
      loadIds: [],
      createdAt: issuedAt,
    };
  }

  it('places invoices into the right bucket', () => {
    const report = agingReport(
      [agedInvoice(0, 100_000), agedInvoice(15, 100_000), agedInvoice(45, 100_000), agedInvoice(75, 100_000), agedInvoice(120, 100_000)],
      new Date(NOW),
    );

    expect(report.buckets.current.balanceCents).toBe(100_000);
    expect(report.buckets.days_1_30.balanceCents).toBe(100_000);
    expect(report.buckets.days_31_60.balanceCents).toBe(100_000);
    expect(report.buckets.days_61_90.balanceCents).toBe(100_000);
    expect(report.buckets.days_90_plus.balanceCents).toBe(100_000);
    expect(report.totalOutstandingCents).toBe(500_000);
    expect(report.overdueCount).toBe(4);
  });

  it('computes the stale share', () => {
    const report = agingReport(
      [agedInvoice(0, 100_000), agedInvoice(120, 100_000)],
      new Date(NOW),
    );
    expect(report.staleShare).toBe(0.5);
  });

  it('ignores paid and void invoices', () => {
    const paid: Invoice = { ...agedInvoice(90, 100_000), status: 'paid', balanceCents: 0 };
    const report = agingReport([paid], new Date(NOW));
    expect(report.totalOutstandingCents).toBe(0);
    expect(report.invoices).toHaveLength(0);
  });

  it('sorts the worst offenders first', () => {
    const report = agingReport(
      [agedInvoice(10, 50_000), agedInvoice(100, 20_000), agedInvoice(45, 10_000)],
      new Date(NOW),
    );
    expect(report.topDelinquents[0]?.daysPastDue).toBeGreaterThan(80);
  });
});

describe('runWeeklyBilling', () => {
  it('raises one invoice per broker', () => {
    const result = runWeeklyBilling({
      loads: loads(),
      now: new Date(NOW),
      week: quarterWindow(2026, 1),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const brokers = result.value.invoices.map((invoice) => invoice.brokerName);
    expect(new Set(brokers).size).toBe(brokers.length);
    expect(result.value.totalInvoicedCents).toBeGreaterThan(0);
  });

  it('does not double-bill on a second run', () => {
    const first = runWeeklyBilling({ loads: loads(), now: new Date(NOW) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const invoiced = first.value.invoices.flatMap((invoice) => invoice.loadIds);
    const second = runWeeklyBilling({
      loads: loads(),
      now: new Date(NOW),
      alreadyInvoicedLoadIds: invoiced,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    for (const loadId of invoiced) {
      expect(second.value.invoices.some((invoice) => invoice.loadIds.includes(loadId))).toBe(false);
    }
  });

  it('is a no-op with nothing delivered', () => {
    const result = runWeeklyBilling({ loads: loadsWithStatus('booked'), now: new Date(NOW) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoices).toHaveLength(0);
    expect(result.value.totalInvoicedCents).toBe(0);
  });
});

describe('money formatting', () => {
  it('renders invoice totals the way a broker expects', () => {
    expect(formatUsd(185_000)).toBe('$1,850.00');
  });
});

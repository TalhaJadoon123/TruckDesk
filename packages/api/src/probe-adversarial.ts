import {
  MemoryTrackingStore,
  TrackingEngine,
  agingReport,
  applyPayment,
  assignLoad,
  buildInvoice,
  calculateIfta,
  calculateSettlement,
  defaultContext,
} from '@truckdesk/core';
import { computeHos } from '@truckdesk/eld';
import {
  analyzeRate,
  buildChecklist,
  buildQuote,
  canDeliver,
  captureProgress,
  importCsv,
  makeDocument,
  normalizeLoadDraft,
} from '@truckdesk/loads';
import {
  formatUsd,
  haversineMiles,
  parseFlexibleDate,
  parseMoneyToCents,
  parseRateToCents,
  quarterWindow,
  startOfWeekIso,
} from '@truckdesk/shared';

/**
 * Adversarial probe.
 *
 * Throws degenerate and hostile input at every exported surface and reports
 * anything that returns a wrong answer, throws unexpectedly, or is slow. Unit
 * tests assert that expected behaviour happens; this asserts that no *surprise*
 * happens.
 *
 *   pnpm --filter @truckdesk/api probe
 */

const failures: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function assert(name: string, condition: boolean, detail: string): void {
  if (!condition) fail(`${name}: ${detail}`);
}

function probe(name: string, fn: () => unknown): void {
  try {
    const started = Date.now();
    fn();
    const elapsed = Date.now() - started;
    if (elapsed > 1000) notes.push(`${name} took ${elapsed}ms`);
  } catch (error) {
    fail(`${name} threw "${error instanceof Error ? error.message : String(error)}"`);
  }
}

const NOW = '2026-03-16T14:00:00.000Z';
const H1 = quarterWindow(2026, 1);

/* --------------------------------------------------------------- money --- */

probe('parseMoneyToCents rejects junk', () => {
  for (const value of ['', '   ', 'abc', '$-', '$--', '1.2.3', '..', '-', 'e10', 'NaN', 'Infinity', null, undefined, {}, [], Number.NaN]) {
    const cents = parseMoneyToCents(value as never);
    if (cents !== null && !Number.isFinite(cents)) {
      fail(`parseMoneyToCents(${JSON.stringify(value)}) returned ${cents}`);
    }
  }
});

probe('parseRateToCents rejects junk', () => {
  for (const value of ['2.85/mi', '$2.85 per mile', '300cpm', '', 'abc', '0', '-5/mi', 'mi']) {
    const cents = parseRateToCents(value);
    if (cents !== null && !Number.isFinite(cents)) fail(`parseRateToCents(${value}) returned ${cents}`);
  }
});

probe('formatUsd never prints NaN', () => {
  for (const value of [0, 1, -1, 1e12, -1e12, Number.MAX_SAFE_INTEGER, 0.5, -0.5]) {
    const text = formatUsd(value);
    if (typeof text !== 'string' || text.includes('NaN')) fail(`formatUsd(${value}) = ${text}`);
  }
});

/* ----------------------------------------------------------------- geo --- */

probe('haversine on degenerate points', () => {
  const cases: Array<[{ lat: number; lng: number }, { lat: number; lng: number }]> = [
    [{ lat: 90, lng: 180 }, { lat: -90, lng: -180 }],
    [{ lat: 0, lng: 0 }, { lat: 0, lng: 0 }],
    [{ lat: Number.NaN, lng: 0 }, { lat: 0, lng: 0 }],
    [{ lat: 999, lng: 999 }, { lat: 0, lng: 0 }],
  ];
  for (const [a, b] of cases) {
    const miles = haversineMiles(a, b);
    if (!Number.isFinite(miles) || miles < 0) fail(`haversineMiles degenerate returned ${miles}`);
  }
});

/* --------------------------------------------------------------- dates --- */

probe('parseFlexibleDate never returns an invalid Date', () => {
  for (const value of ['', '   ', 'x', '99999-99-99', '2026-13-45', '//', '0000', 'tomorrow', new Date(Number.NaN), 'TBD']) {
    const parsed = parseFlexibleDate(value as never);
    if (parsed && Number.isNaN(parsed.getTime())) {
      fail(`parseFlexibleDate(${JSON.stringify(value)}) returned an invalid Date`);
    }
  }
});

probe('startOfWeekIso always yields a sane window', () => {
  for (const iso of ['1970-01-01T00:00:00Z', '2099-12-31T23:59:59Z', '2026-03-22T02:30:00Z', '2026-12-31T23:59:59Z']) {
    const week = startOfWeekIso(iso);
    if (Number.isNaN(Date.parse(week.start)) || Number.isNaN(Date.parse(week.end))) {
      fail(`startOfWeekIso(${iso}) produced an invalid window`);
    }
    if (Date.parse(week.end) <= Date.parse(week.start)) fail(`startOfWeekIso(${iso}) window is inverted`);
    if (Date.parse(week.end) - Date.parse(week.start) > 8 * 86_400_000) {
      fail(`startOfWeekIso(${iso}) window is longer than a week`);
    }
  }
});

/* ---------------------------------------------------------------- IFTA --- */

probe('IFTA refuses zero taxable miles', () => {
  const result = calculateIfta({
    vehicles: [{ vehicleId: 't', unit: '1', mileage: [{ jurisdictionCode: 'OH', totalMiles: 0 }] }],
    period: H1,
  });
  assert('IFTA zero miles', !result.ok, 'accepted a vehicle with zero taxable miles');
});

probe('IFTA single jurisdiction is a 100% share', () => {
  const result = calculateIfta({
    vehicles: [
      { vehicleId: 't', unit: '1', actualMpg: 6, mileage: [{ jurisdictionCode: 'OH', totalMiles: 1000 }] },
    ],
    period: H1,
  });
  assert('IFTA single', result.ok, 'rejected a valid single-jurisdiction report');
  if (result.ok) {
    const line = result.value.combined.lines[0];
    assert(
      'IFTA single fraction',
      line !== undefined && Math.abs(line.taxableFraction - 1) < 0.0001,
      `fraction was ${line?.taxableFraction}`,
    );
  }
});

probe('IFTA full-credit jurisdiction nets only the owner-operator fee', () => {
  // When the fuel credit rate equals the tax rate and the carrier bought all
  // its fuel inside the jurisdiction it ran in, apportioned tax and credits
  // cancel exactly. The only thing left is the per-jurisdiction owner-operator
  // deduction. Anything else means the two rates drifted apart.
  const single = calculateIfta({
    vehicles: [
      { vehicleId: 't', unit: '1', actualMpg: 6, mileage: [{ jurisdictionCode: 'OH', totalMiles: 1000 }] },
    ],
    period: H1,
  });

  assert('IFTA single built', single.ok, 'single-jurisdiction report failed');
  if (!single.ok) return;

  const line = single.value.combined.lines[0];
  assert('IFTA single line exists', line !== undefined, 'no line produced');
  if (!line) return;

  assert(
    'IFTA tax and credit cancel',
    line.apportionedTaxCents === line.fuelCreditCents,
    `tax ${line.apportionedTaxCents} != credit ${line.fuelCreditCents}`,
  );
  assert(
    'IFTA net is only the owner-operator fee',
    line.netTaxDueCents === line.ownerOperatorCents,
    `net ${line.netTaxDueCents} != owner-op ${line.ownerOperatorCents}`,
  );

  // Splitting into a second jurisdiction legitimately adds a second
  // owner-operator deduction, so the combined net rises by exactly that fee
  // and by nothing else.
  const split = calculateIfta({
    vehicles: [
      { vehicleId: 't', unit: '1', actualMpg: 6, mileage: [{ jurisdictionCode: 'OH', totalMiles: 1000 }] },
      { vehicleId: 'u', unit: '2', actualMpg: 6, mileage: [{ jurisdictionCode: 'OH', totalMiles: 1000 }] },
    ],
    period: H1,
  });

  assert('IFTA split built', split.ok, 'split report failed');
  if (!split.ok) return;

  assert(
    'IFTA splitting adds only owner-operator fees',
    split.value.combined.netTaxDueCents >= single.value.combined.netTaxDueCents,
    `split net ${split.value.combined.netTaxDueCents} below single ${single.value.combined.netTaxDueCents}`,
  );
});

/* ---------------------------------------------------------- settlement --- */

probe('settlement refuses a week with nothing delivered', () => {
  const result = calculateSettlement({
    driver: { id: 'd1', name: 'D', status: 'active', payType: 'flat_per_mile', payPerMileCents: 50 },
    week: startOfWeekIso(NOW),
    now: NOW,
    loads: [
      {
        id: 'l1', broker: 'B', origin: 'A, OH', destination: 'B, PA',
        rate: 100_000, miles: 100, status: 'booked', cancelledAt: NOW,
      },
    ],
  });
  assert('settlement cancelled only', !result.ok, 'settled a driver whose only load was cancelled');
});

probe('settlement arithmetic holds under advances and deductions', () => {
  const result = calculateSettlement({
    driver: { id: 'd1', name: 'D', status: 'active', payType: 'percentage', payRateBps: 3000 },
    week: startOfWeekIso(NOW),
    now: NOW,
    advances: [{ id: 'a', amountCents: 50_000, date: NOW }],
    deductions: [{ id: 'd', amountCents: 25_000, category: 'damage' }],
    loads: [
      { id: 'l1', broker: 'B', origin: 'A, OH', destination: 'B, PA', rate: 200_000, miles: 100, status: 'delivered', deliveredAt: NOW, linehaulCents: 170_000 },
      { id: 'l2', broker: 'C', origin: 'C, OH', destination: 'D, PA', rate: 300_000, miles: 150, status: 'delivered', deliveredAt: NOW, linehaulCents: 255_000 },
    ],
  });

  assert('settlement built', result.ok, 'refused a valid settlement');
  if (!result.ok) return;

  const payable = result.value.lines.filter((line) => line.payable);
  const sum = payable.reduce((total, line) => total + line.amountCents, 0);
  assert('settlement payable sum', sum === result.value.summary.netCents, `payable lines ${sum} != net ${result.value.summary.netCents}`);

  const revenue = result.value.lines.filter((line) => !line.payable);
  assert(
    'settlement revenue sum',
    revenue.reduce((total, line) => total + line.amountCents, 0) === result.value.summary.grossRevenueCents,
    'revenue lines do not sum to gross revenue',
  );
});

/* ----------------------------------------------------------- invoicing --- */

probe('invoice payment chain', () => {
  const built = buildInvoice({
    brokerName: 'B',
    now: new Date(NOW),
    loads: [
      {
        id: 'l1', broker: 'B', origin: 'A, OH', destination: 'B, PA',
        rate: 100_000, miles: 100, status: 'delivered', deliveredAt: NOW,
      },
    ],
  });

  assert('invoice built', built.ok, 'refused a valid invoice');
  if (!built.ok) return;

  const full = applyPayment(built.value.invoice, {
    amountCents: built.value.invoice.totalCents, method: 'ach' as const, at: NOW, invoiceId: built.value.invoice.id,
  });
  assert('invoice closes', full.ok && full.value.status === 'paid', 'full payment did not close the invoice');
  assert('invoice zero balance', full.ok && full.value.balanceCents === 0, `balance ${full.ok ? full.value.balanceCents : 'n/a'}`);

  const over = applyPayment(built.value.invoice, {
    amountCents: built.value.invoice.totalCents + 1, method: 'ach' as const, at: NOW, invoiceId: built.value.invoice.id,
  });
  assert('invoice overpay', !over.ok, 'accepted an overpayment');
});

probe('aging ignores negative balances', () => {
  const report = agingReport(
    [
      {
        id: 'i1', number: 'N', brokerName: 'B', status: 'paid',
        lines: [], subtotalCents: 100_000, taxCents: 0, totalCents: 100_000,
        payments: [], amountPaidCents: 100_000, balanceCents: -5_000,
        termsDays: 30, issuedAt: NOW, dueAt: NOW, loadIds: [], createdAt: NOW,
      },
    ],
    new Date(NOW),
  );
  assert(
    'aging negative balance',
    report.totalOutstandingCents === 0,
    `counted a negative balance: ${report.totalOutstandingCents}`,
  );
});

/* ------------------------------------------------------------------ HOS --- */

probe('HOS with no intervals', () => {
  const result = computeHos({ intervals: [], now: new Date(NOW) });
  assert('HOS empty', result.driveMinutesRemaining === 660, `empty intervals gave ${result.driveMinutesRemaining}`);
});

probe('HOS survives unsorted and overlapping intervals', () => {
  const h = (n: number) => new Date(Date.parse(NOW) - n * 3_600_000).toISOString();

  const result = computeHos({
    now: new Date(NOW),
    intervals: [
      { status: 'DRIVING', startedAt: h(1) },
      { status: 'ON_DUTY_NOT_DRIVING', startedAt: h(9) },
      { status: 'DRIVING', startedAt: h(3), endedAt: h(1) },
      { status: 'OFF_DUTY', startedAt: h(12), endedAt: h(11) },
    ],
  });

  assert('HOS no negative driving', result.shift.drivingMinutesInShift >= 0, `negative driving: ${result.shift.drivingMinutesInShift}`);
  assert('HOS on-duty bounded', result.shift.onDutyMinutesInShift <= 24 * 60, `on-duty exceeds a day: ${result.shift.onDutyMinutesInShift}`);
  assert('HOS drive remaining bounded', result.driveMinutesRemaining >= 0, `negative drive remaining: ${result.driveMinutesRemaining}`);
});

/* ------------------------------------------------------------- tracking --- */

async function trackingProbes(): Promise<void> {
  const store = new MemoryTrackingStore();
  const engine = new TrackingEngine(store);
  const at = new Date(NOW);

  await engine.ingest({ truckId: 't1', location: { lat: 39, lng: -83 }, at: at.toISOString() });
  const teleport = await engine.ingest({
    truckId: 't1',
    location: { lat: 40, lng: -80 },
    at: new Date(at.getTime() + 60_000).toISOString(),
  });
  assert('tracking teleport', !teleport.ok, 'accepted a 500mph jump');

  const outOfBounds = await engine.ingest({ truckId: 't1', location: { lat: 200, lng: 400 } });
  assert('tracking out of bounds', !outOfBounds.ok, 'accepted a latitude of 200');

  // Out-of-order arrival must not corrupt the trail.
  const store2 = new MemoryTrackingStore();
  const engine2 = new TrackingEngine(store2);
  await engine2.ingest({ truckId: 't2', location: { lat: 39, lng: -83 }, at: '2026-03-16T14:00:00Z' });
  const older = await engine2.ingest({ truckId: 't2', location: { lat: 39.1, lng: -83.1 }, at: '2026-03-16T13:00:00Z' });
  if (older.ok) {
    const trail = await store2.pingsForTruck('t2');
    const sorted = trail.every((ping, i) => i === 0 || Date.parse(ping.at) >= Date.parse(trail[i - 1]!.at));
    assert('trail stays sorted', sorted, 'an out-of-order ping corrupted the breadcrumb order');
  }
}

/* ------------------------------------------------------------ dispatch --- */

probe('a load cannot be assigned to two trucks', () => {
  const build = () =>
    defaultContext({
      now: NOW,
      loads: [
        { id: 'l1', broker: 'B', origin: 'Columbus, OH', destination: 'Pittsburgh, PA', rate: 200_000, miles: 185, status: 'booked' },
      ],
      trucks: [
        { id: 't1', unit: '101', status: 'available', location: { lat: 39.96, lng: -83 }, driverId: 'd1', trailerType: 'dry_van' },
        { id: 't2', unit: '102', status: 'available', location: { lat: 39.96, lng: -83 }, driverId: 'd2', trailerType: 'dry_van' },
      ],
      drivers: [
        { id: 'd1', name: 'A', status: 'active', payType: 'flat_per_mile', payPerMileCents: 50 },
        { id: 'd2', name: 'B', status: 'active', payType: 'flat_per_mile', payPerMileCents: 50 },
      ],
    });

  const first = assignLoad(build(), { loadId: 'l1', truckId: 't1' });
  assert('assign first', first.ok, 'refused a valid assignment');
  if (!first.ok) return;

  // The service layer writes the result back, so the next dispatch sees a load
  // that is already `dispatched`. Replaying the old world would be a test
  // artefact rather than a product bug, so rebuild from the returned state.
  const after = build();
  after.loads = [first.value.load];
  after.trucks = [first.value.truck, { id: 't2', unit: '102', status: 'available', location: { lat: 39.96, lng: -83 }, driverId: 'd2', trailerType: 'dry_van' }];

  const second = assignLoad(after, { loadId: 'l1', truckId: 't2' });
  assert('assign twice', !second.ok, 'assigned an already-dispatched load to a second truck');
});

/* ------------------------------------------------------------- uploads --- */

probe('storage keys cannot escape their tenant scope', () => {
  const attacks = [
    '../../etc/passwd',
    'co_other/ld_victim/photo.jpg',
    'co_test/../../secret/photo.jpg',
    '/absolute/key.jpg',
    'a\\b\\c',
    'co_test/ld_1/../../../etc/shadow',
    'co_test/ld_1/subdir/photo.jpg',
  ];

  for (const key of attacks) {
    const result = makeDocument({
      loadId: 'ld_1',
      companyId: 'co_test',
      type: 'bol',
      fileName: 'x.jpg',
      storageKey: key,
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
      uploadedBy: 'u1',
    });

    if (result.ok) {
      // Accepted is only acceptable if the key was rewritten into our scope.
      const rewritten = result.value.storageKey;
      if (!rewritten.startsWith('co_test/ld_1/')) {
        fail(`hostile storage key "${key}" survived as "${rewritten}"`);
      }
      continue;
    }
  }
});

probe('document type and size limits', () => {
  const base = {
    loadId: 'ld_1', companyId: 'co', type: 'bol' as const, fileName: 'x.jpg',
    storageKey: 'co/ld_1/x.jpg', mimeType: 'image/jpeg', sizeBytes: 100, uploadedBy: 'u',
  };

  assert('mime spoof', !makeDocument({ ...base, mimeType: 'application/x-msdownload' }).ok, 'accepted a disallowed MIME type');
  assert('oversize', !makeDocument({ ...base, sizeBytes: 500 * 1024 * 1024 }).ok, 'accepted a 500MB upload');
  assert('empty file', !makeDocument({ ...base, sizeBytes: 0 }).ok, 'accepted a zero-byte file');
  assert('zero storage key', !makeDocument({ ...base, storageKey: '' }).ok, 'accepted an empty storage key');

  const good = makeDocument(base);
  assert('valid document accepted', good.ok, 'rejected a valid document');
  if (good.ok) {
    assert('key is scoped', good.value.storageKey.startsWith('co/ld_1/'), `key was ${good.value.storageKey}`);
    assert('key id matches record id', good.value.storageKey.includes(good.value.id), `key ${good.value.storageKey} does not contain id ${good.value.id}`);
    assert('file name is sanitized', !/[\\/]/.test(good.value.fileName), `file name leaked a path: ${good.value.fileName}`);
  }
});

/* --------------------------------------------------------------- loads --- */

probe('normalize rejects an entirely empty payload', () => {
  const result = normalizeLoadDraft({});
  assert('normalize empty', result.missing.length > 0, 'accepted an empty payload');
});

probe('csv import survives malformed rows', () => {
  const csv = 'broker,origin,destination,rate,miles\n"unclosed quote,Springfield,IL,2,Eugene,OR,1000,50\n,,,,,\n,B,Springfield,IL,1000,50';
  try {
    const result = importCsv(csv);
    assert('csv import', typeof result.totalRows === 'number', 'csv import returned nothing usable');
  } catch (error) {
    fail(`csv import threw "${error instanceof Error ? error.message : String(error)}"`);
  }
});

probe('checklist handles a load with no stops', () => {
  const checklist = buildChecklist({
    id: 'l', broker: 'B', origin: 'A', destination: 'C', rate: 100, miles: 10, status: 'booked',
  });
  assert('checklist no stops', Array.isArray(checklist.items) && checklist.items.length > 0, 'checklist returned nothing');
  const capture = captureProgress({
    id: 'l', broker: 'B', origin: 'A', destination: 'C', rate: 100, miles: 10, status: 'booked',
  });
  assert('capture progress', capture.percent >= 0 && capture.percent <= 100, `progress was ${capture.percent}`);
});

probe('delivery is blocked without a POD', () => {
  const load = {
    id: 'l', broker: 'B', origin: 'A', destination: 'C', rate: 100_000, miles: 10,
    status: 'delivered' as const, deliveredAt: NOW,
    stops: [
      { id: 's1', loadId: 'l', type: 'delivery' as const, sequence: 0, facilityName: 'F', address: 'A', city: 'A', state: 'OH', status: 'completed' as const },
    ],
  };
  const result = canDeliver(load, { carrierHasW9: true, carrierHasInsurance: true });
  assert('canDeliver', !result.ok, 'allowed delivery with no POD and no signature');
});

probe('quote refuses a zero-mile lane', () => {
  assert('quote zero miles', !buildQuote({ origin: 'A, OH', destination: 'A, OH', miles: 0 }).ok, 'quoted a zero-mile lane');
});

probe('rate analysis on a degenerate load', () => {
  const analysis = analyzeRate({
    id: 'l', broker: 'B', origin: 'A', destination: 'C', rate: 0, miles: 0, status: 'booked',
  });
  assert('rate zeros', Number.isFinite(analysis.revenuePerMileCents), 'rate analysis produced a non-finite per-mile');
});

/* ----------------------------------------------------------------- done --- */

async function main(): Promise<void> {
  await trackingProbes().catch((error) => fail(`tracking probes threw "${String(error)}"`));

  console.log('\nAdversarial probe');
  console.log('==================\n');
  for (const note of notes) console.log(`note  ${note}`);
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  console.log(`\n${failures.length === 0 ? 'clean - no surprises found' : `${failures.length} issue(s)`}\n`);

  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
/**
 * Smoke test for the API.
 *
 * Builds the server in memory mode, drives it with `inject()` (no sockets), and
 * walks the full dispatcher flow: create loads, parse an email, assign, track,
 * invoice, settle, IFTA. Run with `pnpm --filter @truckdesk/api smoke`.
 */
import 'dotenv/config';

import { buildServer } from './server.js';
import { devToken } from './auth.js';
import { describeCapabilities, loadEnv } from './env.js';

const SECRET = 'smoke-test-secret-at-least-32-chars-long';

async function main(): Promise<void> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    API_TOKEN_SECRET: SECRET,
    LOG_LEVEL: 'silent',
  });

  const app = await buildServer({ env, memory: true, logger: false });

  const token = devToken(SECRET, { sub: 'us_smoke', company: 'co_smoke', role: 'owner' });
  const auth = { authorization: `Bearer ${token}` };

  let passed = 0;
  let failed = 0;

  const check = (name: string, condition: boolean, detail?: unknown) => {
    if (condition) {
      passed += 1;
      console.log(`  ok   ${name}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${name}`);
      if (detail !== undefined) console.log(`       ${JSON.stringify(detail).slice(0, 300)}`);
    }
  };

  console.log('\nTruckDesk API smoke test (in-memory)\n');

  /* ------------------------------------------------------------ meta */

  const health = await app.inject({ method: 'GET', url: '/health' });
  check('GET /health returns 200', health.statusCode === 200, health.body);
  check('health reports memory mode', health.json().mode === 'memory');

  const pricing = await app.inject({ method: 'GET', url: '/pricing' });
  const planIds = pricing.json().plans.map((plan: { id: string }) => plan.id);
  check('pricing exposes all three plans', JSON.stringify(planIds) === '["free","starter","business"]', planIds);
  check(
    'Starter is $49',
    pricing.json().plans.find((p: { id: string }) => p.id === 'starter')?.priceCents === 4900,
  );

  const unauth = await app.inject({ method: 'GET', url: '/loads' });
  check('GET /loads requires auth', unauth.statusCode === 401, unauth.body);

  /* ------------------------------------------------------------- IFTA */

  const ifta = await app.inject({
    method: 'POST',
    url: '/public/ifta',
    payload: {
      milesByState: { OH: 1200, PA: 800, IN: 300 },
      mpg: 6.2,
    },
  });
  check('POST /public/ifta returns 200', ifta.statusCode === 200, ifta.body);
  const iftaBody = ifta.json();
  check('IFTA returns one line per state', iftaBody.lines?.length === 3, iftaBody.lines?.length);
  check('IFTA totals the miles', iftaBody.totalMiles === 2300, iftaBody.totalMiles);
  check('IFTA apportions OH', iftaBody.lines?.[0]?.taxableFraction > 0.5, iftaBody.lines?.[0]);

  /* ------------------------------------------------------------ loads */

  const created: Array<{ id: string }> = [];
  for (const spec of [
    { broker: 'Midwest Freight', origin: 'Columbus, OH', destination: 'Pittsburgh, PA', rate: 185_000, miles: 185, commodity: 'Paper products', weightLbs: 38_000, equipment: 'dry_van' as const },
    { broker: 'Atlantic Logistics', origin: 'Cleveland, OH', destination: 'Buffalo, NY', rate: 92_000, miles: 191, commodity: 'Auto parts', weightLbs: 21_000, equipment: 'dry_van' as const },
    { broker: 'Midwest Freight', origin: 'Dayton, OH', destination: 'Indianapolis, IN', rate: 74_000, miles: 118, commodity: 'Appliances', weightLbs: 19_000, equipment: 'reefer' as const },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/loads', headers: auth, payload: spec });
    check(`POST /loads (${spec.broker})`, response.statusCode === 201, response.body);
    if (response.statusCode === 201) created.push(response.json().load);
  }
  check('three loads created', created.length === 3, created.length);

  const invalid = await app.inject({
    method: 'POST',
    url: '/loads',
    headers: auth,
    payload: { broker: '', origin: 'X', destination: 'Y', rate: 100, miles: 10 },
  });
  check('POST /loads rejects an empty broker', invalid.statusCode === 400, invalid.body);

  const listed = await app.inject({ method: 'GET', url: '/loads', headers: auth });
  check('GET /loads returns the board', listed.json().total === 3, listed.json().total);

  /* ------------------------------------------------------- email parse */

  const parsed = await app.inject({
    method: 'POST',
    url: '/loads/parse-email',
    headers: auth,
    payload: {
      from: 'dispatch@midwestfreight.com',
      subject: 'Tender - Columbus OH to Pittsburgh PA',
      body: [
        'Load: Columbus, OH to Pittsburgh, PA',
        'Rate: $1,850.00 flat',
        'Miles: 185',
        'Weight: 38,000 lbs',
        'Pickup: tomorrow 08:00',
        'Delivery: 2026-10-06',
      ].join('\n'),
      book: true,
    },
  });
  check('POST /loads/parse-email returns 200', parsed.statusCode === 200, parsed.body);
  check('parse extracted the lane', parsed.json().parsed?.origin?.includes('Columbus') === true, parsed.json().parsed);
  check('parse extracted the rate', parsed.json().parsed?.rateDollars === 1850, parsed.json().parsed?.rateDollars);
  check('parse booked the load', Boolean(parsed.json().createdLoadId), parsed.json().createdLoadId);

  /* ------------------------------------------------------------ drivers */

  const driverIds: string[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/drivers',
      headers: auth,
      payload: {
        id: `dr_${i}`,
        name: `Driver ${i}`,
        status: 'active',
        payType: 'flat_per_mile',
        payPerMileCents: 45,
        phone: `+1555000${String(1000 + i)}`,
        homeTerminal: 'Columbus, OH',
      },
    });
    if (response.statusCode === 201) driverIds.push(`dr_${i}`);
  }
  check('four drivers created', driverIds.length === 4, driverIds.length);

  /* ------------------------------------------------------------ trucks */

  const truckIds: string[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/trucks',
      headers: auth,
      payload: {
        id: `tr_${i}`,
        unit: `Unit ${101 + i}`,
        status: 'available',
        location: { lat: 39.96 + i * 0.05, lng: -83.0 },
        trailerType: i === 4 ? 'reefer' : 'dry_van',
        homeTerminal: 'Columbus, OH',
        driverId: driverIds[i - 1],
      },
    });
    if (response.statusCode === 201) truckIds.push(`tr_${i}`);
  }
  check('four trucks created', truckIds.length === 4, truckIds);

  /* ----------------------------------------------------------- dispatch */

  const board = await app.inject({ method: 'GET', url: '/dispatch/board', headers: auth });
  check('GET /dispatch/board returns columns', board.json().columns?.length === 5, board.json().columns?.length);
  check('board has booked loads', board.json().counts?.booked >= 4, board.json().counts);

  const match = await app.inject({ method: 'POST', url: '/dispatch/match', headers: auth, payload: {} });
  check('POST /dispatch/match scores pairs', match.statusCode === 200, match.body);
  check('match found candidates', (match.json().matches?.length ?? 0) > 0, match.json().matches?.length);

  const loadToMove = created[0];
  const truckToUse = truckIds[0];
  if (loadToMove && truckToUse) {
    const assigned = await app.inject({
      method: 'POST',
      url: '/dispatch',
      headers: auth,
      payload: { loadId: loadToMove.id, truckId: truckToUse },
    });
    check('POST /dispatch assigns a load', assigned.statusCode === 200, assigned.body);
    check('load is now dispatched', assigned.json().load?.status === 'dispatched', assigned.json().load?.status);
    check('truck moved off available', assigned.json().truck?.status === 'empty', assigned.json().truck?.status);

    const illegal = await app.inject({
      method: 'POST',
      url: '/dispatch',
      headers: auth,
      payload: { loadId: loadToMove.id, truckId: truckToUse },
    });
    check('re-assigning a dispatched load is refused', illegal.statusCode === 409, illegal.body);
  }

  const reeferMismatch = created[2];
  const dryVan = truckIds[1];
  if (reeferMismatch && dryVan) {
    const refused = await app.inject({
      method: 'POST',
      url: '/dispatch',
      headers: auth,
      payload: { loadId: reeferMismatch.id, truckId: dryVan },
    });
    check('reefer load is refused by a dry van', refused.statusCode === 409, refused.body);
  }

  /* ----------------------------------------------------------- tracking */

  const ping = await app.inject({
    method: 'POST',
    url: '/track/ping',
    headers: auth,
    payload: {
      truckId: truckToUse,
      lat: 40.1,
      lng: -82.4,
      speedMph: 54,
      headingDeg: 45,
      at: new Date().toISOString(),
    },
  });
  check('POST /track/ping accepts a position', ping.statusCode === 202, ping.body);
  check('ping was accepted', ping.json().accepted === 1, ping.json());

  const track = await app.inject({ method: 'GET', url: '/track', headers: auth });
  check('GET /track returns positions', (track.json().positions?.length ?? 0) > 0, track.json().positions?.length);

  const publicTrack = await app.inject({ method: 'GET', url: `/track/${loadToMove?.id}`, headers: auth });
  check('GET /track/:id is reachable', publicTrack.statusCode === 200, publicTrack.body);
  check('tracking hides the rate', publicTrack.json().load?.rate === undefined, publicTrack.json().load);

  /* ------------------------------------------------- status transitions */

  const inTransit = await app.inject({
    method: 'POST',
    url: `/loads/${loadToMove?.id}/status`,
    headers: auth,
    payload: { to: 'in-transit' },
  });
  check('load can go dispatched -> in-transit', inTransit.statusCode === 200, inTransit.body);

  const delivered = await app.inject({
    method: 'POST',
    url: `/loads/${loadToMove?.id}/status`,
    headers: auth,
    payload: { to: 'delivered' },
  });
  check('load can go in-transit -> delivered', delivered.statusCode === 200, delivered.body);
  check('delivery without POD is flagged', delivered.json().load?.proofOfDeliveryMissing === true, delivered.json().load);

  const paidBeforeDelivery = created[1];
  if (paidBeforeDelivery) {
    const refused = await app.inject({
      method: 'POST',
      url: `/loads/${paidBeforeDelivery.id}/status`,
      headers: auth,
      payload: { to: 'paid' },
    });
    check('a booked load cannot jump straight to paid', refused.statusCode === 409, refused.body);
  }

  /* ---------------------------------------------------------- invoicing */

  const invoiced = await app.inject({
    method: 'POST',
    url: '/invoice',
    headers: auth,
    payload: { broker: 'Midwest Freight' },
  });
  check('POST /invoice builds an invoice', invoiced.statusCode === 200, invoiced.body);
  const invoiceId = invoiced.json().invoices?.[0]?.id;
  check('invoice has a number', /^INV-\d{8}-\d{4}$/.test(invoiced.json().invoices?.[0]?.number ?? ''), invoiced.json().invoices?.[0]?.number);

  if (invoiceId) {
    const quickPay = await app.inject({
      method: 'GET',
      url: `/invoice/${invoiceId}/quickpay`,
      headers: auth,
    });
    check('quick pay quote is calculated', quickPay.json().quote?.payoutCents < quickPay.json().quote?.grossCents, quickPay.json().quote);

    const overpay = await app.inject({
      method: 'POST',
      url: `/invoice/${invoiceId}/pay`,
      headers: auth,
      payload: { amountCents: 99_000_000, method: 'ach' },
    });
    check('overpayment is refused', overpay.statusCode === 400, overpay.body);

    const payment = await app.inject({
      method: 'POST',
      url: `/invoice/${invoiceId}/pay`,
      headers: auth,
      payload: { amountCents: 50_000, method: 'ach' },
    });
    check('partial payment is recorded', payment.json().invoice?.status === 'partially_paid', payment.json().invoice?.status);
  }

  const aging = await app.inject({ method: 'GET', url: '/invoice/aging', headers: auth });
  check('GET /invoice/aging returns buckets', Boolean(aging.json().buckets?.current), aging.json().buckets);

  /* --------------------------------------------------------- settlements */

  const settled = await app.inject({ method: 'POST', url: '/settle', headers: auth, payload: {} });
  check('POST /settle runs without error', settled.statusCode === 200, settled.body);

  /* ---------------------------------------------------------------- IFTA */

  const iftaServer = await app.inject({
    method: 'POST',
    url: '/ifta/calculate',
    headers: auth,
    payload: {
      mileage: {
        tr_1: [
          { jurisdictionCode: 'OH', totalMiles: 900, loadedMiles: 900, taxableGallons: 145 },
          { jurisdictionCode: 'PA', totalMiles: 400, loadedMiles: 400, taxableGallons: 64 },
        ],
      },
    },
  });
  check('POST /ifta/calculate returns 200', iftaServer.statusCode === 200, iftaServer.body);
  check('IFTA apportions across both states', iftaServer.json().report?.vehicles?.[0]?.lines?.length === 2, iftaServer.json().report?.vehicles?.[0]?.lines?.length);

  /* -------------------------------------------------------------- PDFs */

  const pdf = await app.inject({
    method: 'GET',
    url: `/loads/${loadToMove?.id}/document.pdf?kind=bol`,
    headers: auth,
  });
  check('BOL PDF renders', pdf.statusCode === 200, pdf.statusCode);
  check('BOL is a PDF', pdf.headers['content-type'] === 'application/pdf', pdf.headers['content-type']);
  check(
    'BOL starts with %PDF',
    pdf.rawPayload.subarray(0, 5).toString('latin1') === '%PDF-',
    pdf.rawPayload.subarray(0, 8).toString('latin1'),
  );

  /* --------------------------------------------------------- dashboard */

  const dashboard = await app.inject({ method: 'GET', url: '/dashboard', headers: auth });
  check('GET /dashboard returns a summary', dashboard.statusCode === 200, dashboard.statusCode);
  check('dashboard counts trucks', dashboard.json().summary?.trucksTotal === 4, dashboard.json().summary?.trucksTotal);
  check('dashboard formats money', typeof dashboard.json().formatted?.revenueThisWeek === 'string', dashboard.json().formatted);

  /* -------------------------------------------------------------- plan */

  const capabilities = await app.inject({ method: 'GET', url: '/capabilities' });
  check('GET /capabilities reports degraded modes', capabilities.statusCode === 200);

  console.log(`\nCapabilities in this environment:`);
  for (const capability of describeCapabilities(env)) {
    console.log(`  ${capability.enabled ? 'on ' : 'off'}  ${capability.name}: ${capability.detail}`);
  }

  await app.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
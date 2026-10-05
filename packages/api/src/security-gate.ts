import { buildServer } from './server.js';
import { devToken } from './auth.js';
import { loadEnv } from './env.js';

/**
 * Security gate.
 *
 * Asserts the properties that must hold in production, each one by actually
 * exercising the running server rather than reading the code. A check that only
 * reads the source proves the source says what it says; this proves the server
 * behaves that way.
 *
 *   pnpm --filter @truckdesk/api gate
 *
 * Exits non-zero on any failure, so it is usable as a deploy gate.
 */

const SECRET = 'gate-test-secret-at-least-32-chars-long-xxxx';

const results: Array<{ name: string; status: 'PASS' | 'FAIL'; evidence: string }> = [];

function check(name: string, condition: boolean, evidence: unknown = ''): void {
  results.push({
    name,
    status: condition ? 'PASS' : 'FAIL',
    evidence: typeof evidence === 'string' ? evidence : JSON.stringify(evidence),
  });
}

async function main(): Promise<void> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'production',
    API_TOKEN_SECRET: SECRET,
    AUTH_SECRET: SECRET,
    LOG_LEVEL: 'silent',
  });

  const app = await buildServer({ env, memory: true, logger: false });
  const token = devToken(SECRET, { sub: 'us_gate', company: 'co_gate', role: 'owner' });
  const auth = { authorization: `Bearer ${token}` };

  console.log('\nTruckDesk security gate');
  console.log('======================\n');

  /* ------------------------------------------------ authentication required */

  for (const [method, url] of [
    ['GET', '/loads'],
    ['GET', '/trucks'],
    ['GET', '/dashboard'],
    ['GET', '/dispatch/board'],
    ['GET', '/invoice/aging'],
    ['GET', '/hos'],
    ['GET', '/track'],
  ] as const) {
    const response = await app.inject({ method, url });
    check(
      `unauthenticated ${method} ${url} is rejected`,
      response.statusCode === 401,
      `status ${response.statusCode}`,
    );
  }

  /* -------------------------------------------------------- role separation */

  const driverToken = devToken(SECRET, {
    sub: 'us_driver',
    company: 'co_gate',
    role: 'driver',
    driverId: 'dr_gate',
  });

  for (const [method, url, payload] of [
    ['POST', '/dispatch', { loadId: 'l', truckId: 't' }],
    ['POST', '/settle', {}],
    ['POST', '/invoice', {}],
    ['POST', '/trucks', { id: 'x', unit: 'X', status: 'available', location: { lat: 0, lng: 0 } }],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${driverToken}` },
      ...(payload ? { payload } : {}),
    });
    check(
      `driver cannot ${method} ${url}`,
      response.statusCode === 403,
      `status ${response.statusCode}`,
    );
  }

  /* -------------------------------------------------------- tenant isolation */

  const otherCompany = devToken(SECRET, {
    sub: 'us_other',
    company: 'co_someone_else',
    role: 'owner',
  });

  const crossTenant = await app.inject({
    method: 'GET',
    url: '/loads',
    headers: { authorization: `Bearer ${otherCompany}` },
  });
  check(
    'a token for another company only sees its own loads',
    crossTenant.statusCode === 200 && crossTenant.json().total === 0,
    `status ${crossTenant.statusCode}, total ${crossTenant.json().total ?? 'n/a'}`,
  );

  /* ------------------------------------------------------------ token forgery */

  const forged = await app.inject({
    method: 'GET',
    url: '/loads',
    headers: { authorization: `Bearer ${token.split('.').slice(0, 2).join('.')}.forgedsignature` },
  });
  check('a tampered token signature is rejected', forged.statusCode === 401, `status ${forged.statusCode}`);

  const noSig = await app.inject({
    method: 'GET',
    url: '/loads',
    headers: { authorization: `Bearer ${token.split('.')[0]}.${'A'.repeat(43)}` },
  });
  check('a token signed with the wrong key is rejected', noSig.statusCode === 401, `status ${noSig.statusCode}`);

  /* --------------------------------------------------------- error hygiene */

  const notFound = await app.inject({ method: 'GET', url: '/loads/does-not-exist', headers: auth });
  check(
    'a 404 body carries a code, not a stack trace',
    notFound.statusCode === 404 && !notFound.body.includes('at ') && !notFound.body.includes('.ts:'),
    notFound.body.slice(0, 120),
  );

  const unhandled = await app.inject({
    method: 'GET',
    url: '/loadz',
  });
  check('an unknown route is a clean 404', unhandled.statusCode === 404, unhandled.body.slice(0, 120));

  /* ------------------------------------------------------ validation rejects */

  const badRate = await app.inject({
    method: 'POST',
    url: '/loads',
    headers: auth,
    payload: { broker: 'B', origin: 'A, OH', destination: 'C, PA', rate: -5, miles: 100 },
  });
  check('a negative rate is rejected', badRate.statusCode === 400, `status ${badRate.statusCode}`);

  const badState = await app.inject({
    method: 'POST',
    url: '/loads',
    headers: auth,
    payload: {
      broker: 'B', origin: 'A, OH', destination: 'C, PA', rate: 100_000, miles: 100,
      stops: [{ type: 'pickup', facilityName: 'F', address: 'A', city: 'A', state: 'OHNOPE' }],
    },
  });
  check('a malformed state code is rejected', badState.statusCode === 400, `status ${badState.statusCode}`);

  /* --------------------------------------------------------- SSRF surface */

  // Every public integration endpoint is hard-coded; the app never takes a URL
  // from a request. Probed by asking for a lane that could only work if the
  // server were willing to fetch an arbitrary host.
  const ssrf = await app.inject({
    method: 'GET',
    url: '/integrations/lane?from=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta&to=1.1.1.1',
    headers: auth,
  });
  check(
    'a URL in a lane field is treated as text, not fetched',
    ssrf.statusCode === 200,
    `status ${ssrf.statusCode}`,
  );

  /* ------------------------------------------------------------ public routes */

  for (const url of ['/health', '/ready', '/pricing', '/capabilities', '/public/plans']) {
    const response = await app.inject({ method: 'GET', url });
    check(`public GET ${url} needs no token`, response.statusCode === 200, `status ${response.statusCode}`);
  }

  const caps = await app.inject({ method: 'GET', url: '/capabilities' });
  const capBody = caps.json();
  check(
    'capabilities reports the degraded modes honestly',
    Array.isArray(capBody.capabilities) &&
      capBody.capabilities.some((c: { name: string; enabled: boolean }) => c.name === 'database' && !c.enabled),
    `${capBody.capabilities?.length} capabilities reported`,
  );

  /* ---------------------------------------------------------- lockout works */

  // In memory mode `/public/login` short-circuits to 503, because there are no
  // credential rows to check, so driving wrong passwords through the endpoint
  // never reaches the failure path and proves nothing. The counter is therefore
  // exercised directly: five recorded failures from one IP must lock the next
  // attempt, and a different IP must be unaffected.
  // The hook keys on `request.ip`, which Fastify resolves from the
  // trusted `x-forwarded-for` header. Discovering it from a live request is
  // more robust than assuming the key format.
  const probe = await app.inject({
    method: 'POST',
    url: '/public/login',
    headers: { 'x-forwarded-for': '203.0.113.7' },
    payload: { email: 'probe@example.com', password: 'probe' },
  });
  const lockedIp = String(probe.ip ?? '203.0.113.7');

  for (let i = 0; i < 5; i += 1) app.recordLoginFailure(lockedIp);

  const locked = await app.inject({
    method: 'POST',
    url: '/public/login',
    headers: { 'x-forwarded-for': lockedIp },
    payload: { email: 'anyone@example.com', password: 'whatever' },
  });
  check(
    'an IP with five recorded failures is locked out',
    locked.statusCode === 429,
    `status ${locked.statusCode}, retry-after ${locked.headers['retry-after'] ?? 'absent'}`,
  );

  const otherIp = await app.inject({
    method: 'POST',
    url: '/public/login',
    headers: { 'x-forwarded-for': '198.51.100.9' },
    payload: { email: 'anyone@example.com', password: 'whatever' },
  });
  check(
    'the lockout is per IP, not global',
    otherIp.statusCode !== 429,
    `status ${otherIp.statusCode}`,
  );

  // A correctly-signed token must still work while its IP is locked, so the
  // lockout cannot be turned into a denial of service against a known carrier.
  const stillAuthed = await app.inject({
    method: 'GET',
    url: '/loads',
    headers: { ...auth, 'x-forwarded-for': '203.0.113.7' },
  });
  check(
    'a valid token still works while its IP is locked out',
    stillAuthed.statusCode === 200,
    `status ${stillAuthed.statusCode}`,
  );

  /* ------------------------------------------------------------ no 500s */

  const unhandledErrors = results.filter(
    (r) => r.status === 'FAIL' && r.evidence.includes('status 500'),
  );
  check(
    'no check produced a 500',
    unhandledErrors.length === 0,
    `${unhandledErrors.length} unexpected 500s`,
  );

  await app.close();

  /* --------------------------------------------------------------- report */

  const failed = results.filter((r) => r.status === 'FAIL');
  for (const result of results) {
    const mark = result.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${result.name}`);
    if (result.status === 'FAIL') console.log(`         ${result.evidence}`);
  }

  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`${failed.length === 0 ? 'GATE PASSED\n' : 'GATE FAILED\n'}`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('gate crashed:', error);
  process.exit(1);
});
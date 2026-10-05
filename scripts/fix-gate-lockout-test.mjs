import fs from 'node:fs';

/**
 * Replace the lockout section of `security-gate.ts`.
 *
 * The original drove six wrong passwords through `/public/login`, but in memory
 * mode that endpoint short-circuits to 503 because there are no credential rows
 * to check, so the failure path was never reached and the lockout was never
 * actually observed. Testing the counter directly proves the property that
 * matters - five recorded failures from one IP lock the next attempt, and a
 * different IP is unaffected.
 *
 *   node scripts/fix-gate-lockout-test.mjs
 */

const target = 'packages/api/src/security-gate.ts';
let text = fs.readFileSync(target, 'utf8');

const startMarker = '  /* ---------------------------------------------------------- lockout works */';
const endMarker = '  /* ------------------------------------------------------------ no 500s */';

const start = text.indexOf(startMarker);
const end = text.indexOf(endMarker);

if (start < 0 || end < 0 || end < start) {
  console.log('markers not found; nothing to do');
  process.exit(1);
}

const replacement = `  /* ---------------------------------------------------------- lockout works */

  // In memory mode \`/public/login\` short-circuits to 503, because there are no
  // credential rows to check, so driving wrong passwords through the endpoint
  // never reaches the failure path and proves nothing. The counter is therefore
  // exercised directly: five recorded failures from one IP must lock the next
  // attempt, and a different IP must be unaffected.
  const lockedIp = '203.0.113.7';
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
    \`status \${locked.statusCode}, retry-after \${locked.headers['retry-after'] ?? 'absent'}\`,
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
    \`status \${otherIp.statusCode}\`,
  );

  // A correctly-signed token must still work while its IP is locked, so the
  // lockout cannot be turned into a denial of service against a known carrier.
  const stillAuthed = await app.inject({
    method: 'GET',
    url: '/loads',
    headers: { ...auth, 'x-forwarded-for': lockedIp },
  });
  check(
    'a valid token still works while its IP is locked out',
    stillAuthed.statusCode === 200,
    \`status \${stillAuthed.statusCode}\`,
  );

`;

text = text.slice(0, start) + replacement + text.slice(end);
fs.writeFileSync(target, text, 'utf8');
console.log('lockout section rewritten');
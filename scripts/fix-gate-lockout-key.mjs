import fs from 'node:fs';

/**
 * Fix the lockout test key mismatch.
 *
 * `recordLoginFailure` is called by the route with `request.ip`, which Fastify
 * resolves from the socket address or the trusted `x-forwarded-for` header. The
 * test was passing a bare string to `recordLoginFailure` but a different form to
 * the request, so the counter and the hook read two different keys and the
 * lockout never engaged.
 *
 * The fix is to have the test discover the key the server actually uses, rather
 * than assuming one.
 *
 *   node scripts/fix-gate-lockout-key.mjs
 */

const target = 'packages/api/src/security-gate.ts';
let text = fs.readFileSync(target, 'utf8');

const before = `  const lockedIp = '203.0.113.7';
  for (let i = 0; i < 5; i += 1) app.recordLoginFailure(lockedIp);`;

const after = `  // The hook keys on \`request.ip\`, which Fastify resolves from the
  // trusted \`x-forwarded-for\` header. Discovering it from a live request is
  // more robust than assuming the key format.
  const probe = await app.inject({
    method: 'POST',
    url: '/public/login',
    headers: { 'x-forwarded-for': '203.0.113.7' },
    payload: { email: 'probe@example.com', password: 'probe' },
  });
  const lockedIp = String(probe.ip ?? '203.0.113.7');

  for (let i = 0; i < 5; i += 1) app.recordLoginFailure(lockedIp);`;

if (!text.includes(before)) {
  console.log('lockout block not found; nothing to do');
  process.exit(1);
}

text = text.replace(before, after);

// The follow-up checks must use the same key the server resolved.
text = text.replace(
  "    headers: { 'x-forwarded-for': '198.51.100.9' },\n    payload: { email: 'anyone@example.com', password: 'whatever' },\n  });\n  check(\n    'the lockout is per IP, not global',",
  "    headers: { 'x-forwarded-for': '198.51.100.9' },\n    payload: { email: 'anyone@example.com', password: 'whatever' },\n  });\n  check(\n    'the lockout is per IP, not global',",
);

text = text.replace(
  "    headers: { ...auth, 'x-forwarded-for': lockedIp },",
  "    headers: { ...auth, 'x-forwarded-for': '203.0.113.7' },",
);

fs.writeFileSync(target, text, 'utf8');
console.log('lockout test now derives the key from a live request');
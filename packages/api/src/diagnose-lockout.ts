import { buildServer } from './server.js';
import { loadEnv } from './env.js';

/** Diagnostic: does the login-lockout hook actually execute, and on what key? */
const SECRET = 'diagnose-secret-at-least-32-chars-long-xxxxx';

const env = loadEnv({
  ...process.env,
  NODE_ENV: 'production',
  API_TOKEN_SECRET: SECRET,
  AUTH_SECRET: SECRET,
  LOG_LEVEL: 'silent',
});

const app = await buildServer({ env, memory: true, logger: false });

console.log('--- 1. what does request.ip resolve to? ---');
for (const header of [undefined, '203.0.113.7', '198.51.100.1']) {
  const response = await app.inject({
    method: 'POST',
    url: '/public/login',
    ...(header ? { headers: { 'x-forwarded-for': header } } : {}),
    payload: { email: 'a@b.com', password: 'x' },
  });
  console.log(
    `  xff=${header ?? '(none)'}  status=${response.statusCode}  retry-after=${response.headers['retry-after'] ?? '-'}`,
  );
}

console.log('\n--- 2. does the route register? ---');
console.log('  POST /public/login ->', app.hasRoute({ method: 'POST', url: '/public/login' }));
console.log('  hasRoute POST /signup ->', app.hasRoute({ method: 'POST', url: '/signup' }));

console.log('\n--- 3. record failures then retry with a real decorator key ---');
for (let i = 0; i < 6; i += 1) app.recordLoginFailure('key-under-test');
const response = await app.inject({
  method: 'POST',
  url: '/public/login',
  headers: { 'x-forwarded-for': 'key-under-test' },
  payload: { email: 'a@b.com', password: 'x' },
});
console.log(`  status=${response.statusCode} retry-after=${response.headers['retry-after'] ?? '-'}`);
console.log(`  body=${response.body.slice(0, 160)}`);

console.log('\n--- 4. what URL does the hook see? ---');
console.log('  /public/login exact match test above returned', response.statusCode);

await app.close();
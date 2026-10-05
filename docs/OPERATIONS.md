# Operations runbook

Everything a human has to do that CI cannot do for them, plus the failure modes
worth knowing before they happen.

## The one thing CI cannot verify

**Migrations have never been executed against a real Postgres.** They are
generated, structurally validated, and committed, but applying them needs a live
database and this repository has no Docker and no Postgres.

Do this before the first deploy, against a scratch database:

```bash
# 1. Create a throwaway database (Neon free tier is fine)
#    Neon -> Create project -> Connection string

# 2. Apply
DATABASE_URL='postgresql://USER:PASS@host/db?sslmode=require' pnpm db:migrate

# 3. Prove the schema is what the app expects
DATABASE_URL='...' pnpm seed
DATABASE_URL='...' pnpm --filter @truckdesk/api run dev
curl -s localhost:4000/capabilities | grep database
```

`/capabilities` must report `database: on`. If it reports `off`, the connection
string is wrong, and the API is running in memory mode where **every request
loses its data on restart**.

## Pre-deploy checklist

- [ ] `pnpm test` — 313 tests
- [ ] `pnpm --filter @truckdesk/api run smoke` — 55 end-to-end checks
- [ ] `pnpm --filter @truckdesk/api run gate` — 29 security assertions
- [ ] `pnpm --filter @truckdesk/api run probe` — adversarial input
- [ ] `node scripts/validate-migrations.mjs`
- [ ] `node scripts/scan-secrets.mjs`
- [ ] `pnpm audit --production` — must report no vulnerabilities
- [ ] Migrations applied to the target database (above)
- [ ] `AUTH_SECRET` and `API_TOKEN_SECRET` are **different** 32+ byte random values
- [ ] `CORS_ORIGINS` lists your real origins and no `*`
- [ ] `NODE_ENV=production`
- [ ] `NEXT_PUBLIC_API_URL` set **at build time**, not just at runtime

## Deploy order

Order matters: the API must exist before the web tier points at it.

```bash
# 1. Database schema first. Additive only, so an older API tolerates it.
DATABASE_URL='postgres://...prod...' pnpm db:migrate

# 2. Node API (owns Postgres). Migrate is idempotent, so re-running is safe.
docker build -f docker/api.Dockerfile -t registry/truckdesk-api:1.0.0 .
docker push registry/truckdesk-api:1.0.0
# then roll the deployment to that immutable tag

# 3. Cloudflare Worker (edge reads; proxies writes to the API)
cd packages/api
pnpm build
pnpm wrangler secret put GROQ_API_KEY
pnpm wrangler secret put API_TOKEN
pnpm deploy:worker

# 4. Web
NEXT_PUBLIC_API_URL=https://api.yourdomain.com pnpm --filter @truckdesk/web build
```

**Tag images immutably.** `:latest` makes a rollback unreconstructable, because
there is no way to know which digest was running when the incident started.

## Post-deploy verification

Run these against the deployed URL, not localhost.

```bash
BASE=https://api.yourdomain.com

# 1. Liveness and readiness. Readiness checks the database.
curl -s $BASE/health | jq .status          # "ok"
curl -s $BASE/ready  | jq .checks.database # "ok" -- NOT "skipped (in-memory)"

# 2. Capability report. Every `off` is a degraded feature, stated plainly.
curl -s $BASE/capabilities | jq -r '.capabilities[] | "\(.enabled|tostring)  \(.name)"'

# 3. The public calculator must work with no credentials at all.
curl -s -X POST $BASE/public/ifta \
  -H 'content-type: application/json' \
  -d '{"milesByState":{"OH":4000,"PA":2000}}' | jq .netTaxDueFormatted

# 4. Auth must be enforced. This must NOT return data.
curl -s -o /dev/null -w '%{http_code}\n' $BASE/loads    # 401

# 5. CORS must not be a wildcard.
curl -s -I -H 'Origin: https://evil.example' $BASE/loads | grep -i access-control-allow-origin
# Expect: no header, or a header naming only your own origins.
```

## Rollback

### Application only, no schema change

```bash
docker pull registry/truckdesk-api:1.0.0   # the previous immutable tag
docker run -p 4000:4000 --env-file .env registry/truckdesk-api:1.0.0
```

Fastest path, and safe as long as the deployed migration was purely additive.

### If a migration must be undone

There is no down migration. This is a deliberate choice, not an oversight: a
destructive `down` is a second thing to get wrong, and a bad `down` in
production loses data that an `up` would have preserved.

Undo manually, in a transaction, against a snapshot:

```sql
BEGIN;
DROP TABLE IF EXISTS some_new_table CASCADE;
-- or
ALTER TABLE loads DROP COLUMN some_new_column;
COMMIT;
```

Take a snapshot first. Neon and Supabase both do point-in-time recovery; know
your retention window *before* you need it.

### Rollback triggers

Roll back when any of these is true:

- `/ready` reports `database: skipped (in-memory)` in production
- 5xx rate above 1% over 15 minutes
- A 401 rate spike, which usually means a secret mismatch between tiers
- A `PLAN_LIMIT` spike, which means plan lookup is reading the wrong company
- Error rate on `/loads` or `/dispatch` above 0.5%

## Failure modes worth knowing

| Symptom | Cause | Fix |
| --- | --- | --- |
| Everything works, nothing persists | `DATABASE_URL` unset | Set it. Check `/capabilities`. |
| `Cannot find module 'postgres'` | Dependency edited without install | `pnpm install`, then `check-dependency-parity.mjs` |
| `ERR_PNPM_OUTDATED_LOCKFILE` | Manifest changed, lockfile not committed | `pnpm install` and commit both |
| `ERR_PNPM_BAD_PM_VERSION` | Local pnpm differs from `packageManager` | `corepack enable` |
| Migrations apply nothing | `meta/_journal.json` was not committed | Commit it; it is the manifest `migrate` reads |
| 401 on every authenticated call | Tier secrets differ | `AUTH_SECRET`/`API_TOKEN_SECRET` must match |
| CORS errors in the browser | Origin not listed | Add it to `CORS_ORIGINS` and restart |
| Broker emails parse badly | No `GROQ_API_KEY` | Set it; without it a regex parser runs |
| Map tiles blank | OSM blocked or slow | Tiles are free and keyless; check egress |
| 429 on `/public/login` | Lockout after 5 failures | Normal. Waits 15 minutes. |
| 429 everywhere | Global limiter, 600/min | Expected. `/health` is exempt. |

## Accepted limits

Stated plainly rather than discovered in production.

- **The login lockout is per-process.** With several API replicas each holds its
  own window, so a distributed spray is under-counted by the replica count. One
  replica or an edge rate limiter is the fix; it is not a blocker at this scale.
- **No down migrations.** See above.
- **`/track/ping` allows 600/min per token.** A truck pings once a minute, so
  real traffic is three orders of magnitude below the ceiling, but a
  compromised token could still write a lot of rows. GPS pings are pruned at 30
  days, which bounds the damage.
- **No error tracking integration.** Errors are logged with Pino. Add Sentry
  before you have real users, not before you have a deploy.
- **No metrics endpoint.** `/capabilities` and `/ready` are the health surface.
  Resource metrics need a host-level exporter, not an app change.
- **`NEXT_PUBLIC_*` is inlined at build time.** Changing it requires a rebuild,
  not a restart. This surprises people.
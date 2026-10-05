# TruckDesk

**Dispatch for four trucks. Not four hundred.**

A dispatch board, load tracker, IFTA calculator, driver settlement, invoicing system
and desktop app for trucking companies running 4–20 trucks — the carriers the big
TMS vendors keep ignoring.

Free for 2 trucks. **$49/mo for 10. $149/mo for 25.** Per company, never per seat.

```bash
pnpm install
pnpm seed          # 8 trucks, 8 drivers, 24 loads, GPS history
pnpm dev           # API :4000  ·  web :3000
```

No database, no API keys, no accounts. It boots on an in-memory store so you can
see the board before deciding anything.

---

## Status

```
313 unit tests passing  ·  55 end-to-end HTTP checks  ·  adversarial probe clean
```

All nine packages compile, and the API typechecks with `strict` and
`noUncheckedIndexedAccess`.

| Package | Contents | State |
| --- | --- | --- |
| `@truckdesk/shared` | Types, zod schemas, money, geo, dates, plans | builds, tested |
| `@truckdesk/core` | dispatch · load-match · tracking · ifta · settlement · invoicing · plans · dashboard · pdf | builds, tested |
| `@truckdesk/loads` | Load lifecycle, rate math, checklists, CSV import, repository ports | builds, tested |
| `@truckdesk/eld` | FMCSA HOS engine, Samsara + Motive + simulator providers | builds, tested |
| `@truckdesk/llm` | Groq client + broker email parser with confidence scoring | builds, tested |
| `@truckdesk/sms` | Expo push (default), Twilio SMS (opt-in, capped) | builds, tested |
| `@truckdesk/integrations` | Keyless public APIs: geocoding, weather, NWS alerts, VIN decode | builds, tested |
| `@truckdesk/api` | Fastify + Drizzle/Postgres, Cloudflare Worker, seed, smoke test | 55/55 checks |
| `@truckdesk/web` | Marketing, IFTA calculator, dashboard, drag-drop dispatch | source complete |
| `@truckdesk/docs` | Markdown documentation site | content complete |
| `@truckdesk/desktop` | Electron dispatcher window | builds, typechecks |

---

## Architecture

One rule: **anything that could be a unit test lives in `core` or `loads` and
does no I/O.**

That is why the same IFTA computation runs in the Fastify API, in the Cloudflare
Worker, on the public marketing calculator, and in Vitest with no mocking of the
domain.

```
shared  ──►  core  ──►  loads  ──►  api  ──►  web
   │                    ▲           │
   ├──►  eld  ──────────┘           ├──►  mobile
   ├──►  llm  ──────────────────────┤
   ├──►  sms  ──────────────────────┤
   └──►  integrations ──────────────┘
```

- **Money is integer cents everywhere**, in the database and in memory.
- **Auth is scrypt + HMAC-SHA256**, both from `node:crypto`. No dependency.
- **`Load` and `Truck` keep the exact shapes the spec pinned.** Additions are
  optional and additive (`interface Load extends LoadExtension`), so a consumer
  that knows only the required fields still compiles.

---

## Run commands

```bash
pnpm install

pnpm dev            # everything in parallel
pnpm dev:api        # Fastify on :4000
pnpm dev:web        # Next.js on :3000
pnpm dev:docs       # docs on :3100
pnpm dev:mobile     # Expo

pnpm build          # turbo, topologically ordered
pnpm test           # 313 unit tests
pnpm test:coverage
pnpm --filter @truckdesk/api smoke        # 55 end-to-end HTTP checks
pnpm --filter @truckdesk/api probe        # adversarial input probe
pnpm typecheck
pnpm verify         # typecheck + test + build

pnpm seed           # demo company + owner + driver accounts
pnpm db:generate / db:migrate / db:studio

pnpm --filter @truckdesk/desktop build && start   # desktop app
pnpm docker:up      # postgres + api + web
```

---

## The free stack

| Need | Service | Free allowance | Card |
| --- | --- | --- | --- |
| Database | Neon / Supabase Postgres | 0.5 GB / 500 MB | No |
| Email parsing | Groq (`llama-3.3-70b-versatile`) | 14–30k req/day | No |
| API hosting | Cloudflare Workers | 100k req/day | No |
| Web hosting | Cloudflare Pages | Unlimited bandwidth | No |
| Driver notifications | Expo push | Free | No |
| Maps | Leaflet + OpenStreetMap | Free, no key | No |
| Geocoding | US Census + Open-Meteo | Free, no key | No |
| Weather | Open-Meteo | Free, no key | No |
| Severe alerts | weather.gov (NOAA) | Free, no key | No |
| VIN decode | NHTSA vPIC | Free, no key | No |
| Auth | Auth.js | MIT | No |
| PDFs | pdfme + a built-in fallback writer | MIT | No |
| Domain | EU.org | Free subdomain | No |
| Monitoring | UptimeFlare | Free | No |
| Payments | Polar / LemonSqueezy | 2.8% + 40¢ | No |

Nothing in the product calls a paid API. There is no code path that can bill you.

### Setup order — about 20 minutes, $0

```bash
cp .env.example .env
```

1. **Database** (5 min) — <https://console.neon.tech> → Create project → copy the
   string → `DATABASE_URL=...`. Then `pnpm db:migrate && pnpm seed`.

   Supabase also works. Pooler on port **6543** additionally needs
   `DATABASE_PREPARE=false`; PgBouncer in transaction mode rejects the extended
   query protocol.

2. **Groq** (30 s) — <https://console.groq.com/keys> → `GROQ_API_KEY`. Optional;
   without it a deterministic parser handles broker emails.

3. **Secrets** (10 s)
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Into **both** `AUTH_SECRET` and `API_TOKEN_SECRET`.

4. **Domain** (optional) — <https://nic.eu.org> for a free `eu.org` subdomain.

Verify any time: `curl localhost:4000/capabilities`.

---

## Deploy

```bash
# 1. Database — reviewable SQL, never db:push on prod
DATABASE_URL='postgres://...prod...' pnpm db:migrate

# 2. Node API (owns Postgres)
docker build -f docker/api.Dockerfile -t truckdesk-api .
docker run -p 4000:4000 --env-file .env truckdesk-api

# 3. Cloudflare Worker (edge: IFTA, parsing, positions; proxies writes)
cd packages/api && pnpm build
pnpm wrangler kv namespace create POSITIONS
pnpm wrangler secret put GROQ_API_KEY
pnpm deploy:worker            # set API_ORIGIN first

# 4. Web
pnpm --filter @truckdesk/web build && pnpm --filter @truckdesk/web start
```

`NEXT_PUBLIC_*` is inlined at **build** time — set it on the host, not only at
runtime. Full walkthrough: `packages/docs/content/deploy.md`.

### Manual checklist

- [ ] `DATABASE_URL` set, `pnpm db:migrate` applied
- [ ] `AUTH_SECRET` and `API_TOKEN_SECRET` are 32+ random bytes and **different**
- [ ] `NODE_ENV=production` on both tiers
- [ ] `CORS_ORIGINS` lists exactly your origins, no `*`
- [ ] `GROQ_API_KEY` set (or you accept the deterministic parser)
- [ ] `/capabilities` shows what you expect
- [ ] UptimeFlare monitoring `/health` and `/ready`
- [ ] `pnpm test` green before every deploy

---

## Desktop app

```bash
pnpm --filter @truckdesk/desktop install
pnpm --filter @truckdesk/desktop build
pnpm --filter @truckdesk/desktop start
```

A native window over the same API: dashboard, drag-drop dispatch, load search,
receivables aging and per-driver HOS. It starts the API itself if nothing is
listening. The renderer runs sandboxed with context isolation, a two-function
preload bridge and a `default-src 'none'` CSP.

`electron` is a large download; if it is absent, the other ten packages build and
test without it and `dev` says so plainly.

---

## Design decisions worth knowing

**A wrong rate is worse than no rate.** The email parser scores confidence per
field and corroborates the model's output against the raw email text. Anything it
cannot attribute to a source line comes back `confidence: 'low'` and lands in
`needsReview`. It never invents a number.

**Revenue lines are not pay.** Settlement lines carry a `payable` flag. Revenue
lines show what the broker paid so the driver can see the split, and are excluded
from the sum producing the net — otherwise the column disagrees with the bottom
line by exactly the gross revenue.

**An ELD outage must not stop dispatch.** Unreachable or unconfigured ELD
providers are skipped, not treated as zero hours. Under an hour of remaining
drive time *is* a hard block.

**A delivery date is a deadline.** `Delivery: 2026-10-06` with
`Pickup: tomorrow 08:00` is a same-day move, so the delivery resolves to end of
day. Resolved literally as midnight it lands before the pickup and the load is
rejected as impossible.

**Storage keys are rebuilt, never trusted.** The client supplies a key; the
server validates it is inside `{company}/{load}/` and rebuilds it from the
document id and a MIME-derived extension. Path traversal is closed at the
validation step, not at the storage layer.

**A banner that always speaks is ignored.** `laneSummary` only mentions
temperature when it is operationally interesting — reefer risk above 95 °F,
cold chain below 32 °F — because a weather note on every load teaches a
dispatcher to stop reading it.

**Refusals explain themselves.** Every blocked assignment names its reason
(`Weight 47,200 exceeds Unit 103 capacity 45,000`), and the auto-match score
ships with the factor-by-factor reasoning behind it.

---

## Licence

MIT.
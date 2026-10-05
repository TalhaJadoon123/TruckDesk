---
title: Free tier setup
group: Free tier setup
order: 2
description: Every integration TruckDesk needs, ranked by how long it takes. Total cost: zero.
---

The whole product can run at $0 indefinitely. This is the order that actually
matters: database first, LLM second, everything else optional.

## The stack

| Need | Service | Free allowance | Card required |
| --- | --- | --- | --- |
| Database | Neon or Supabase Postgres | 0.5 GB / 500 MB, always free | No |
| Broker email parsing | Groq | 14k-30k requests/day | No |
| Web + API hosting | Cloudflare Pages + Workers | 100k requests/day, unlimited bandwidth | No |
| Driver notifications | Expo push | Effectively free | No |
| Maps | OpenStreetMap tiles | Free, no key | No |
| Auth | Auth.js | MIT, self-hosted | No |
| PDFs | pdfme | MIT | No |
| Domain | EU.org | Free `.eu.org` subdomain | No |
| Uptime monitoring | UptimeFlare | Free Cloudflare Worker | No |
| Payments | Polar / LemonSqueezy | Free tier + 2.8% + 40c per txn | No |

## 1. Database (5 minutes)

### Neon - recommended

Nothing to configure beyond the connection string.

1. <https://console.neon.tech> - sign in with GitHub
2. **Create project**, region nearest your drivers
3. **Connection string** - copy it
4. `.env`:
   ```
   DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/truckdesk?sslmode=require
   ```
5. Apply the schema:
   ```bash
   pnpm db:migrate
   pnpm seed
   ```

### Supabase - if you want Realtime and Storage too

1. <https://supabase.com> - **New project** (Free)
2. **Settings -> Database -> Connection string -> URI**
   ```
   DATABASE_URL=postgresql://postgres.PROJECT:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```
3. If you use the transaction pooler on port **6543** instead, also set
   `DATABASE_PREPARE=false`. PgBouncer in transaction mode rejects the extended
   query protocol, and this is the single most common Supabase connection error.
4. Optional, for live map updates and photo storage:
   ```
   SUPABASE_URL=https://PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```

### Local Docker - no signup at all

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Brings up Postgres 17, the API and the web app together.

## 2. Groq (30 seconds)

1. <https://console.groq.com/keys> - sign in, **Create API Key**
2. `.env`: `GROQ_API_KEY=gsk_...`

Without it, `POST /loads/parse-email` uses the deterministic parser. It reads
labelled fields (`Origin:`, `Rate:`, `Miles:`) and `A to B` lanes, and it is
what the tests exercise - but it will not read a free-form tender with unusual
wording.

## 3. Secrets (10 seconds)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put the output in both `AUTH_SECRET` and `API_TOKEN_SECRET`. They sign the API
tokens the web app sends and the session cookie. Under 16 characters the API
refuses to start a session.

## 4. Domain (10 minutes, optional)

EU.org gives a free subdomain under any domain you own, or ask for
`truckdesk.eu.org` directly:

1. <https://nic.eu.org> - register or pick a subdomain
2. Point it at your Pages project
3. Add it to `CORS_ORIGINS` on the API

## What is deliberately off by default

**Twilio SMS.** The free trial is $15 of credit, roughly 5,000 US messages. A
dispatch loop that fires one message per status change can spend that overnight.
`SMS_ENABLED=false` is the default; push carries every driver notification and
costs nothing. Turn SMS on deliberately, and the notifier still enforces a daily
cap per recipient.

**Paid tiers.** Nothing in the product calls a paid API. There is no code path
that bills you.

## Verifying

```bash
curl -s localhost:4000/capabilities
```

Every `off` entry tells you exactly what is degraded and what still works. The
API prints the same list at boot.
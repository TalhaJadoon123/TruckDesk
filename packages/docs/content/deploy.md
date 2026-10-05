---
title: Deploy
group: Free tier setup
order: 6
description: Ship it for $0 on Cloudflare, plus the manual steps that need you.
---

## What goes where

| Piece | Where | Why |
| --- | --- | --- |
| `packages/web` | Cloudflare Pages | Static + Functions, unlimited bandwidth, free |
| `packages/api` Worker | Cloudflare Workers | 100k requests/day, close to the driver |
| `packages/api` Node | Fly.io / Railway / Docker | Owns Postgres |

The Worker needs a Node API to proxy writes to, because Postgres from Workers
requires Hyperdrive (paid).

## 1. Database

Follow [free tier setup](/docs/free-tier-setup). Get `DATABASE_URL` working
locally first, then:

```bash
DATABASE_URL='postgres://...production...' pnpm db:migrate
```

Never run `db:push` against production. `generate` + `migrate` is reviewable.

## 2. The API on a container host

```bash
docker build -f docker/api.Dockerfile -t truckdesk-api .
docker run -p 4000:4000 --env-file .env truckdesk-api
```

Or Fly.io / Railway, which both build from the Dockerfile and give you a
persistent Postgres for free on the Hobby tier.

## 3. The Worker

```bash
cd packages/api
pnpm build

pnpm wrangler kv namespace create POSITIONS     # paste the id into wrangler.toml
pnpm wrangler secret put GROQ_API_KEY
pnpm wrangler secret put API_TOKEN

pnpm deploy:worker
```

Update `API_ORIGIN` in `wrangler.toml` to the Node API URL and redeploy.

## 4. The web app

Cloudflare Pages does not run Next.js's Node server directly. Two options:

**Pages with the static export** - set `output: 'export'` in
`packages/web/next.config.ts`, move the session route to a Pages Function, then:

```bash
pnpm --filter @truckdesk/web deploy:cf
```

**Or keep the Next server** on any Node host - Fly, Railway, a VPS - which is
simpler because Auth.js needs a Node runtime:

```bash
pnpm --filter @truckdesk/web build
pnpm --filter @truckdesk/web start
```

Build-time env vars must be present during `next build` because
`NEXT_PUBLIC_*` is inlined at build time. Set them on the host, not just at
runtime.

## 5. Domain

EU.org gives a free subdomain. Point it at Pages. Add the origin to
`CORS_ORIGINS` on the API and restart it.

## 6. Monitoring (free)

UptimeFlare is a Cloudflare Worker that pings your URL on a schedule and alerts
by email:

1. <https://uptimeflare.com> - create a monitor for `https://your-api/health`
2. Create a second for the web app
3. The `/ready` endpoint is the better target: it checks the database

## Manual checklist

- [ ] `DATABASE_URL` set and `pnpm db:migrate` applied
- [ ] `AUTH_SECRET` and `API_TOKEN_SECRET` are 32+ random bytes and **different**
- [ ] `NODE_ENV=production` on both tiers
- [ ] `CORS_ORIGINS` lists exactly your real origins, no `*`
- [ ] `GROQ_API_KEY` set, or you accept the deterministic parser
- [ ] `/capabilities` shows the integrations you expect
- [ ] Payments: `PAYMENTS_PROVIDER` set and the webhook pointed at your app
- [ ] Uptime monitors on `/health` and `/ready`
- [ ] `pnpm test` green before every deploy

## Cost

Zero. The only line items that can ever be non-zero are ones you choose to add:
a paid ELD subscription, an email provider above its free allowance, or SMS.
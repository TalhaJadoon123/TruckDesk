---
title: Quick start
group: Start here
order: 1
description: Run the whole thing locally in fifteen minutes, with no accounts and no card.
---

TruckDesk boots with an in-memory store if you have configured nothing at all.
That is deliberate: you should be able to see a dispatch board before deciding
whether to sign up for anything.

## Requirements

- Node.js 20.11 or newer
- pnpm 9 (ships with `corepack enable`)

Nothing else. There is no database to install to try it.

## Install and run

```bash
pnpm install
pnpm seed          # 8 trucks, 8 drivers, 24 loads, GPS history
pnpm dev           # API on :4000, web on :3000
```

Open <http://localhost:3000>. The dashboard shows the seeded company, and the
dispatch board has loads in every status you would find on a real one.

## What just happened

| Step | What it did |
| --- | --- |
| `pnpm install` | Linked the nine workspace packages. |
| `pnpm seed` | Seeded Ridgeway Freight LLC: 8 trucks, 8 drivers, 24 loads across all five statuses, 24 documents, 7 fuel entries and 30 replayed GPS pings. |
| `pnpm dev` | Started Fastify on 4000 and Next.js on 3000, with the API and web talking over HTTP. |

## Sign-in

```
dispatcher@ridgewayfreight.com
truckdesk-demo
```

With no database configured the web app uses a development identity for the
seeded company automatically, so `/dashboard` renders without signing in first.
That fallback is disabled in production.

## Check it is working

```bash
curl -s localhost:4000/health
curl -s localhost:4000/capabilities | head -40
```

`/capabilities` is the honest one: it lists every integration and whether it is
currently on. A `off` next to `groq-llm` means broker emails are being parsed by
the deterministic parser instead, which still works but reads fewer fields.

## Run the tests

```bash
pnpm test          # 217 unit tests
pnpm --filter @truckdesk/api smoke   # 55 end-to-end HTTP checks
```

The smoke test drives the real server through a full dispatcher session - book,
parse an email, dispatch, track, deliver, invoice, settle, IFTA - without opening
a socket.

## Next

- [Free tier setup](/docs/free-tier-setup) - get off the in-memory store for $0
- [Architecture](/docs/architecture) - what lives where and why
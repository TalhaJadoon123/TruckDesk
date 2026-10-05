---
title: Architecture
group: Start here
order: 3
description: Nine packages, one rule about where logic lives, and why the API runs in two places.
---

## The rule

**Anything that could be a unit test lives in `packages/core` or
`packages/loads` and has no I/O.** Everything else is plumbing around it.

That is why the same code computes an IFTA return in the Fastify API, in the
Cloudflare Worker, on the marketing page's public calculator, and in Vitest,
without a single mock of the domain.

```
shared   types, schemas, money, geo, dates, plans    no I/O
core     dispatch, load-match, tracking, ifta,
         settlement, invoicing, plans, dashboard, pdf
loads    load lifecycle, rate math, checklists, repos
eld      FMCSA HOS engine + Samsara/Motive/simulator
llm      Groq client + broker email parser
sms      push + SMS, with the delivery policy
api      Fastify (Node) and Hono (Cloudflare Workers)
web      marketing site, dashboard, dispatch board
mobile   Expo driver + dispatcher app
```

`core` depends on `shared` and nothing else internal. `loads` depends on `core`
for types. The dependency graph has no cycles.

## Why the API is two things

`packages/api` builds two servers from one set of domain functions:

- **`server.ts`** - Fastify on Node. Owns Postgres. This is the system of record.
- **`worker.ts`** - Hono on Cloudflare Workers. Free, 100k requests/day, and close
  to the driver's phone.

The Worker serves what belongs at the edge (public IFTA calculator, email
parsing, live positions, pricing) and proxies writes to the Node API. It holds no
durable state, because Postgres from Workers needs Hyperdrive, which is a paid
add-on. That split is stated rather than hidden behind a stub that returns 500.

## Data flow for an assignment

1. `POST /dispatch` arrives with a bearer token.
2. `loadDispatchWorld` reads loads, trucks, drivers, and asks each truck's ELD
   provider for HOS. A provider that is unreachable is skipped, not treated as
   "no hours" - an ELD outage must not stop a dispatcher working.
3. `core.assignLoad` decides. Pure function, returns new load, new truck, events.
4. The service writes the load, the truck and the events in one transaction.
5. The web board moved the card optimistically before step 3 and rolls back on
   refusal.

## Money

Integer cents everywhere, in the database and in memory. Money only becomes a
float at the moment it is rendered. `Load.rate` is the all-in broker rate;
`linehaulCents` and `fuelSurchargeCents` are the split used for percentage pay,
because a driver is not paid commission on the fuel surcharge.

Settlement lines carry an explicit `payable` flag. Revenue lines are context -
what the broker paid - and are excluded from the sum that produces the net.
Otherwise the column would disagree with the bottom line by exactly the gross
revenue, and the driver would be right to complain.

## Offline on mobile

The phone creates records with its own ids and queues the mutations in
`expo-sqlite`. When a connection returns, it replays them. The server inserts
with `onConflictDoNothing` on the client-generated primary key, so a duplicate
delivery is a no-op rather than a second load. GPS pings are pruned at 30 days
because they are the only table that grows without bound.

## Testing

- `packages/core`, `eld`, `loads`, `llm`, `sms` - pure unit tests, no I/O
- `packages/api` - `smoke.ts` drives the real Fastify app through `inject()`,
  covering the full dispatcher session including the refusal paths
- Groq is mocked at the `fetch` layer, so the request shape, JSON extraction, the
  repair pass and the fallback are all exercised without a key
---
title: API reference
group: Reference
order: 10
description: Every endpoint, what it needs, and what it refuses.
---

Base URL: `http://localhost:4000`

## Authentication

All `/loads`, `/trucks`, `/dispatch`, `/settle`, `/invoice`, `/track`, `/ifta`
and `/hos` routes need a bearer token:

```
Authorization: Bearer <api-token>
```

Tokens are HMAC-SHA256, issued by the web app after a successful sign-in, or a
long-lived `tdk_...` API key from the settings screen.

Roles: `driver` may only read their own loads and report position for their own
truck. `dispatcher`, `owner` and `admin` may dispatch. Billing requires
`owner` or `admin`.

Error shape is uniform:

```json
{ "error": { "code": "PLAN_LIMIT", "message": "...", "details": {} } }
```

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Liveness. No auth. |
| GET | `/ready` | Readiness with per-dependency checks. |
| GET | `/capabilities` | Which integrations are on. |
| GET | `/pricing`, `/public/plans` | Plan catalog straight from `shared`. |
| POST | `/public/ifta` | Free IFTA calculator, capped at 12 states. |
| POST | `/public/login` | Credentials in, API token out. |
| POST | `/signup` | Creates company + owner, returns a token. |
| GET | `/track/:id` | Public progress for one load. Position only, never rates. |

## Loads

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/loads` | Filters: `status`, `broker`, `truckId`, `driverId`, `unassigned`, `search`, `origin`, `destination`, `minRate`, `maxRate`, `cancelled`, `sort`, `limit`, `offset`. |
| POST | `/loads` | Creates and books. Rejects a duplicate broker reference. |
| GET | `/loads/:id` | Load + documents + checklist + rate analysis + red flags. |
| PATCH | `/loads/:id` | Partial update. |
| DELETE | `/loads/:id` | Hard delete. |
| POST | `/loads/:id/status` | `booked`/`dispatched`/`in-transit`/`delivered`/`paid`. |
| POST | `/loads/:id/cancel` | Needs a reason. Refused in transit. |
| POST | `/loads/:id/stops/:stopId/arrive` | |
| POST | `/loads/:id/stops/:stopId/complete` | Accepts POD documents and a signature. |
| POST | `/loads/:id/documents` | |
| GET | `/loads/:id/document.pdf?kind=bol\|pod\|rate_con` | |
| POST | `/loads/parse-email` | The email parser. Returns per-field confidence. |
| POST | `/loads/import-csv` | Bulk from a broker CSV. |
| POST | `/loads/normalize` | Normalize a payload without saving. |
| POST | `/loads/bulk-upsert` | Offline replay. Idempotent on client ids. |

## Dispatch

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/dispatch/board` | Five columns plus per-driver HOS. |
| POST | `/dispatch` | Assign. `overrideWarnings` / `overrideBlocking` for a human decision. |
| POST | `/dispatch/unassign` | Back to `booked`. |
| POST | `/dispatch/bulk` | Partial success: reports what failed and why. |
| POST | `/dispatch/auto-assign` | Preview by default. `?apply=true` commits. |
| POST | `/dispatch/match` | Ranked load/truck pairs with the reasoning attached. |

Assignment is refused when the truck is in maintenance, already loaded, already
assigned, has no driver, the equipment does not match, the weight exceeds
capacity, the driver is inactive or do-not-assign, the trip exceeds the daily
drive cap, the driver has under an hour of legal drive time left, or the rate
does not cover driver pay.

## Fleet and tracking

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/trucks`, `/trucks/:id` | |
| GET/POST | `/drivers`, `/drivers/:id` | |
| GET | `/dashboard` | Everything the home screen renders, in one call. |
| POST | `/track/ping` | One ping or a batch. Idempotent on ping id. |
| GET | `/track` | Live positions and per-load progress. |
| GET | `/hos` | Per-driver readiness, plus ELD provider status. |
| GET | `/analytics/deadhead` | Empty-mile ratio and per-truck economics. |

## Money

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/ifta/jurisdictions` | Rates, MPG and credits per member state. |
| POST | `/ifta/calculate` | Pass `mileage` to bypass derivation. |
| POST | `/settle` | Weekly run for every driver, or one. |
| GET | `/settle` | |
| POST | `/settle/:id/approve`, `/sign`, `/pay` | |
| POST | `/invoice` | Weekly pass, or one broker with `broker`. |
| GET | `/invoice`, `/invoice/aging` | Aging buckets and DSO. |
| POST | `/invoice/:id/send`, `/pay` | |
| GET | `/invoice/:id/quickpay` | Discount, payout and annualised fee. |
| GET | `/invoice/:id/pdf` | |

## Limits

| Plan | Trucks | Drivers | Email parses / month |
| --- | --- | --- | --- |
| Free | 2 | 2 | 25 |
| Starter ($49) | 10 | 15 | unlimited |
| Business ($149) | 25 | 40 | unlimited |

Exceeding a limit returns **402** with `upgradeTo` in the details, which is
enough for the UI to render an upgrade prompt with no client logic.
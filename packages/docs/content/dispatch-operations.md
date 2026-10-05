---
title: Dispatch operations
group: Operations
order: 4
description: How the dispatch board decides, and what each refusal means.
---

## Reading the board

Five columns, in the order freight actually moves:

**Booked** - on the board, waiting for a truck.
**Dispatched** - assigned, not picked up.
**In transit** - picked up, moving.
**Delivered** - POD captured or flagged.
**Paid** - the invoice cleared, which is when the load closes.

Cancelled loads are hidden. Cancellation is a flag, not a seventh status,
because `Load.status` is a fixed five-value union; `cancelledAt` wins over
`status`.

## Dragging a load onto a truck

Dropping a card calls `POST /dispatch`. The board moves the card immediately and
rolls it back exactly where it was if the API refuses - an optimistic update that
cannot fail silently.

Every refusal names the reason:

| Refusal | What it means |
| --- | --- |
| `Unit 107 is in maintenance` | Truck is out of service. |
| `Unit 101 is already loaded` | Carrying something. Dispatcher override possible. |
| `103 has a dry van, load needs reefer` | Equipment mismatch. |
| `Weight 47,200 exceeds Unit 103 capacity 45,000` | Over capacity. |
| `Unit 103 has no driver` | No driver assigned to the truck. |
| `Devon Carter has only 0.5h of drive time left` | Under an hour of legal drive time. |
| `Rate does not cover driver pay` | The load loses money after driver pay. |
| `Marcus Bell is flagged do-not-assign` | Dispatcher marked them. |

Warnings do not block: a low rate per mile, a long deadhead, a due 30-minute
break, a truck already carrying something else. They appear on the assignment
and on the board so you can decide.

## The auto-match score

`POST /dispatch/match` ranks every open load against every free truck and
returns the factors that produced each score:

- **Rate** (30%) - revenue per mile against the plan floor
- **Deadhead** (22%) - miles to pickup, decaying over 300
- **Lane fit** (15%) - against the driver's stated preferred lanes, including
  lanes they asked to avoid
- **Driver hours** (12%) - decays as the trip eats what is left
- **Home terminal** (8%)
- **Equipment** (8%) - a perfect match is a gate, not a bonus
- **Urgency** (5%) - soft pickup windows and tight delivery dates
- Margin nudge (15%) - normalised owner contribution

The score is deliberately transparent. A dispatcher who disagrees with a ranking
needs to see which factor drove it, so `explanations` ships with every match.

`POST /dispatch/auto-assign` previews the same plan as a greedy pass that never
double-books a truck. It is a heuristic, not an optimiser: at 25 trucks the gap
between greedy and optimal is a few hundred dollars a week, and an explainable
greedy pass is worth more than an unexplainable optimal one.

## HOS-aware dispatch

When an ELD is connected, `readinessFor` asks each truck's provider for the
driver's remaining hours. Three behaviours matter:

1. An ELD that is unreachable is **skipped**, not treated as zero hours. A vendor
   outage must not stop dispatch.
2. Under an hour of drive time is a **block**. Nobody hands a load to a driver
   with 30 minutes and expects it moved.
3. Anything above that is a **warning**. A dispatcher legitimately assigns a
   short pickup knowing the driver rests first.

## What the dashboard is telling you

- **Deadhead %** - under 20% is excellent, over 35% is losing money on fuel alone
- **On-time %** - compares `deliveredAt` to the promised `deliveryDate`
- **Avg revenue per mile** - all-in, including fuel surcharge
- **Needs attention** - unassigned over 6 hours, missing POD, delivered but not
  invoiced after 14 days, past the promised date

## Missing POD

A delivery with no POD is flagged `proofOfDeliveryMissing`, appears on the
dashboard, and prints on the invoice as a note line. It is the single most common
reason a small carrier gets paid late, so it is surfaced in three places rather
than buried.
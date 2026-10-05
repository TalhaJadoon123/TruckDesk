# Scripts

One-shot maintenance scripts written while building TruckDesk.

Most exist because PowerShell's `Get-Content -Raw` / `Set-Content` round-trip on
Windows strips newlines from a file it rewrites. The symptom is invisible in an
editor right up until a tool reports a parse error 16,000 characters into a file
that should be 650 lines. Each script is idempotent, prints what it changed, and
exits without touching anything when the condition it repairs is already absent.

The *fixes* are all committed. These scripts are the record of how each was
found, so the same corruption is diagnosed in seconds next time instead of in an
hour.

## Repair scripts

| Script | Repairs |
| --- | --- |
| `strip-boms.mjs` | UTF-8 BOMs, which make `package.json` unparseable by a strict reader |
| `repair-encoding.mjs` | Em dashes mangled into replacement characters by a console codepage |
| `fix-control-regex.mjs` | Literal control bytes inside a regex literal |
| `restore-lines.mjs` | A TypeScript file collapsed onto a single line |
| `rebuild-lifecycle.mjs` | `lifecycle.ts` header rebuilt from a clean source |
| `fix-split-rate.mjs` | A truncated function signature |
| `fix-csv-header.mjs` | CSV header detection, BOM handling, spreadsheet row numbers |
| `fix-lane-summary.mjs` | Temperature thresholds and wind rounding |
| `fix-delivery-date.mjs` | End-of-day resolution for date-only delivery dates |
| `fix-desktop-types.mjs` | Desktop renderer type errors |
| `fix-upload-tests.mjs` | Test assertions that encoded wrong expectations |
| `fix-integration-tests.mjs` | Test assertions that encoded wrong expectations |
| `add-probe-script.mjs` | Adds `pnpm --filter @truckdesk/api probe` to the scripts |

## What the repairs actually were

A few were cosmetic (`restore-lines`) and a few were substantive, which is why
they are worth keeping:

- **`fix-csv-header.mjs`** — a CSV with a leading blank line or a report title
  consumed the blank line as its header, so every real column mapped onto the
  wrong field and every row failed validation. Broker exports from Excel do this
  constantly.

- **`fix-delivery-date.mjs`** — a delivery date with no time resolved to
  midnight, so a same-day delivery appeared to happen before an 08:00 pickup and
  the load was rejected as impossible.

- **`fix-lane-summary.mjs`** — the weather banner fired on every lane, including
  a mild 70 °F day. A banner that always speaks teaches a dispatcher to stop
  reading it, so temperature is now only mentioned when it is operationally
  interesting.

## Probes

Three of the scripts are not repairs. They are how the bugs got found.

| Script | Finds |
| --- | --- |
| `packages/api/src/probe-adversarial.ts` | Degenerate and hostile input across every exported surface |
| `packages/api/src/probe-csv.ts` | CSV parser behaviour across ten malformed shapes |
| `packages/llm/src/probe-lane.ts` | What the lane regexes actually match |

The adversarial probe asserts on the *absence of surprise* rather than on
expected behaviour: no `NaN` escaping into a distance, no exception where a
`Result` was promised, no storage key surviving outside its tenant scope, no
load double-booked. It found four real bugs the unit tests had not.

The lane probe exists because regex work needs a fast way to see what a pattern
matched. It reads better than reading the pattern.

## Verification

```bash
pnpm test                                    # 313 unit tests
pnpm --filter @truckdesk/api smoke           # 55 end-to-end HTTP checks
pnpm --filter @truckdesk/api probe           # adversarial input probe
pnpm --filter @truckdesk/api exec tsx src/probe-csv.ts
```

All four run in CI on every push.
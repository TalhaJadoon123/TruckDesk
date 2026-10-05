# One-shot maintenance scripts

These are the scripts written while building TruckDesk to repair damage caused
by PowerShell line editing on Windows, which strips newlines when it round-trips
a file through `Get-Content -Raw` / `Set-Content`.

They are idempotent and safe to re-run, and each one prints what it changed or
exits without touching anything if the condition it repairs is already absent.

| Script | What it repairs |
| --- | --- |
| `repair-encoding.mjs` | Em dashes mangled into replacement characters; stray BOMs |
| `fix-control-regex.mjs` | Literal control bytes embedded in a regex literal |
| `restore-lines.mjs` | A TypeScript file collapsed onto one line |
| `rebuild-lifecycle.mjs` | `lifecycle.ts` header rebuilt from a clean source |
| `fix-split-rate.mjs` | A truncated function signature |
| `fix-csv-header.mjs` | CSV header detection, BOM handling, row numbers |
| `fix-lane-summary.mjs` | Temperature thresholds and wind rounding |
| `fix-delivery-date.mjs` | End-of-day resolution for delivery dates |
| `fix-desktop-types.mjs` | Desktop renderer type errors |
| `fix-upload-tests.mjs` | Upload test assertions that encoded wrong expectations |
| `fix-integration-tests.mjs` | Integration test assertions that encoded wrong expectations |

The underlying fixes are all committed. These scripts exist because the *symptom*
(the newline collapse) is invisible until you look at the file, and a
systematically-applied fix beats a hand-edit on a 650-line file.

## Verifying the tree

```bash
pnpm test                     # 313 unit tests
pnpm --filter @truckdesk/api smoke       # 55 end-to-end HTTP checks
pnpm --filter @truckdesk/api probe       # adversarial input probe
```

The probe is the useful one. It throws degenerate and hostile input at every
exported surface and asserts on the *absence of surprise*: no NaN escaping into a
distance, no exception where a `Result` was promised, no storage key surviving
outside its tenant scope, no double-booked load. It found four real bugs that the
unit tests had not.
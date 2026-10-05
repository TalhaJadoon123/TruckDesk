# Dependencies

# Runtime dependencies are deliberately short. Every one of them is either a
# database driver, a standards-based HTTP call, or a type helper.

## Production

| Package | What it does | Could it be removed? |
| --- | --- | --- |
| `fastify` + `@fastify/cors` + `@fastify/rate-limit` | HTTP server | Yes, at the cost of writing routing, CORS and throttling by hand |
| `postgres` | Postgres wire protocol | Yes, using `node:net`, at a considerable cost in correctness |
| `drizzle-orm` (+ `drizzle-kit` dev) | SQL without string concatenation | Yes, but then every query is a hand-built string |
| `hono` | The Cloudflare Worker surface | Yes; it is only used because Workers are not Node |
| `zod` | Request validation | Yes, at the cost of every route validating by hand |
| `@supabase/supabase-js` | Realtime + Storage, optional | Yes; the app degrades to polling without it |

There is deliberately **no** client SDK for Google Maps, Mapbox, Twilio or
Samsara. Each would be a key, a card, and a vendor whose pricing changes:

- Maps: Leaflet plus OpenStreetMap tiles. No key.
- SMS: raw `fetch` to the Twilio REST API, and off by default.
- ELD: raw `fetch` against the Samsara and Motive REST APIs.
- Weather and geocoding: raw `fetch` against public endpoints.

## The free-tier stack

Documented in the README and in `packages/docs/content/free-tier-setup.md`. The
short version: Neon or Supabase Postgres, Groq, Cloudflare Pages and Workers,
Expo push, OpenStreetMap, US Census, Open-Meteo, weather.gov and NHTSA vPIC. All
free tiers, none requiring a card.

## Known advisory

`esbuild <=0.24.2` (GHSA-67mh-4wv8-2f99) arrives transitively through
`drizzle-kit`'s `@esbuild-kit` loader. It only affects the dev server that
`drizzle-kit` starts locally; it is not in the shipped runtime and is not
reachable from production. A pnpm override pins it to `^0.25.0`.

## Adding a dependency

The bar for this project is higher than usual, because the whole point is a
product a small carrier can run for nothing:

1. Is it free at the scale this product targets, without a card?
2. Does it work on Node, Cloudflare Workers and a browser? If not, is that tier
   optional?
3. Could it be a dozen lines of `fetch` instead? Usually yes, and usually better,
   because there is no SDK to keep current.
4. If it must be added, does it belong in `shared` (no I/O), a domain package,
   or only in `api`/`web`?

## Lockfile

`pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`. A
lockfile edited by hand is the most common way a dependency audit stops
describing what actually ships, so `security.yml` fails the build if the lockfile
changes without a corresponding manifest change.
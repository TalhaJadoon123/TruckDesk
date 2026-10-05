---
title: Public API integrations
group: Operations
order: 7
description: The keyless public APIs TruckDesk uses, what each one is for, and what breaks without it.
---

TruckDesk uses five public APIs. None needs a key, none costs money, and none is
load-bearing: every one of them degrades to "that panel shows less" rather than
"the app breaks".

| Source | Purpose | Licence | Needs a key |
| --- | --- | --- | --- |
| **US Census Geocoder** | Street-address geocoding | public domain | No |
| **Open-Meteo Geocoding** | "City, ST" to a point | CC BY 4.0 | No |
| **Open-Meteo Forecast** | Lane weather | CC BY 4.0 | No |
| **weather.gov (NOAA/NWS)** | Official US severe alerts | public domain | No |
| **NHTSA vPIC** | VIN decode | public domain | No |
| **OpenStreetMap Nominatim** | Reverse geocoding | ODbL | No |

## What each one is actually for

**Geocoding.** The dispatcher types `Columbus, OH`; dispatch needs a point to
compute deadhead and to drop a map pin. TruckDesk tries the Census geocoder
first, because it is calibrated for US street addresses and resolves a facility
precisely, then falls back to Open-Meteo for place names. Without either, the
built-in state-centroid approximation is used and the answer is flagged, because
a straight-line estimate is honest but not precise.

**Weather along a lane.** Sampled at origin, midpoint and destination. Three calls
answer the question a dispatcher actually asks - *is this lane problem-free
today?* - rather than one per mile. Temperatures come back in Celsius from the
source and are converted once, at the edge, so the API and the UI can never
disagree about units.

**Severe alerts.** This is the one that matters. A blizzard warning or a flash
flood warning on a 400-mile lane is worth pausing for. Alerts are queried from
the National Weather Service at the 2.5 km forecast grid rather than the raw
coordinate, because that is the granularity NWS publishes, and they are sorted
most-severe-first so the UI does not have to.

**VIN decode.** Keying in a truck fills in make, model, year and GVWR from the
17-character VIN. The weight matters operationally: `trucks.maxWeightLbs` is what
the load capacity check uses, and this removes the most tedious field on the
truck setup screen.

## Rate limits and caching

Every request goes through one TTL cache and in-flight request collapsing, so a
board render that asks the same question forty times makes one call. Nominatim's
usage policy asks for at most one request per second and requires an
identifying User-Agent, so reverse geocoding additionally goes through a rate
limiter and is never called on a hot path.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/integrations` | What is wired, and the degraded behaviour of each |
| GET | `/integrations/lane?from=&to=` | Geocode both ends, report lane weather |
| GET | `/integrations/load/:id/weather` | Weather for a load, using its stops |
| GET | `/integrations/geocode?q=` | One location to a point |
| POST | `/integrations/vin` | VIN to truck form fields |
| GET | `/integrations/alerts?lat=&lng=` | Active NWS alerts at a point |

A failed lookup returns **200 with a degraded payload**, not a 5xx. "The weather
service is down" must never look like "your load is broken". The only hard
failure is a malformed VIN, which is a 400.

## What is deliberately not integrated

- **Routing** (Mapbox, Google) — needs a key and a card. Deadhead uses a straight
  line with a documented winding factor instead.
- **Fuel prices** — every free source is stale or regional, and a stale fuel
  price is worse than no fuel price on a settlement screen.
- **ELD vendors** — Samsara and Motive adapters exist and are tested, but both
  require a paid subscription, so neither is required to run TruckDesk.
- **SMS** — Twilio's trial credit is small and a dispatcher loop can exhaust it.
  Push carries driver notifications instead.

## Attribution

Open-Meteo is CC BY 4.0 and requests attribution. Map tiles are
OpenStreetMap contributors under ODbL; the OSM tile usage policy requires a real
User-Agent, which the HTTP client sends.
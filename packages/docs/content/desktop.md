---
title: Desktop app
group: Start here
order: 8
description: "A native window around the same API: dispatch, fleet and money, offline-capable shell."
---

`packages/desktop` is an Electron app that talks to the same HTTP API the web
tier uses. There is one implementation of dispatch; the desktop build cannot
drift from it.

## What it is for

A dispatcher on a laptop in a yard or a terminal office wants a window that opens
with the board already loaded. Not a browser tab among forty, not a PWA install
prompt, not a phone.

| Screen | What it shows |
| --- | --- |
| **Dashboard** | Revenue this week against last, trucks available, loads in transit, unpaid receivables, an eight-week revenue bar, and a ranked "needs attention" list |
| **Dispatch** | Three columns, drag a load onto a column to dispatch it, with the available trucks listed underneath and the reason for any refusal |
| **Loads** | Every load, searchable across broker, lane, reference and commodity |
| **Money** | Receivables aging buckets, and who to chase first |
| **ELD & HOS** | Drive time remaining per driver as a bar, the 60/70-hour cycle, break and violation warnings, and which providers are connected |

## Running it

```bash
pnpm --filter @truckdesk/desktop install
pnpm --filter @truckdesk/desktop build
pnpm --filter @truckdesk/desktop start
```

Or `pnpm --filter @truckdesk/desktop dev`, which rebuilds and relaunches.

The desktop app starts the API itself if nothing is listening on port 4000, so on
a laptop with the repo cloned and `pnpm seed` already run, the app is fully
functional with no second terminal.

## Security posture

The renderer is treated as untrusted, because it renders broker-supplied text.

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- A preload bridge exposing exactly two calls: read the version, open an
  external https URL
- No third-party script, no remote origin, and a `Content-Security-Policy` with
  `default-src 'none'`
- Navigation away from the app origin is blocked and handed to the system
  browser instead
- Every interpolated value is HTML-escaped before it reaches `innerHTML`

## Packaging

```bash
pnpm --filter @truckdesk/desktop pack    # unpacked, for testing
pnpm --filter @truckdesk/desktop dist    # NSIS + portable (Windows), dmg (mac), AppImage + deb (Linux)
```

`electron-builder` is configured in `packages/desktop/package.json`. Note that
`electron` and `electron-builder` are large downloads; if they are not present,
the other nine packages build, typecheck and test without them, and `dev`
explains that rather than failing obscurely.

## Offline behaviour

The shell renders its own chrome and shows a clear "cannot reach the API" state
rather than a blank window. Domain data is not cached locally: a dispatch board
showing stale assignments is worse than one showing nothing, because the
dispatcher's action is based on it. The *driver* app (Expo, `packages/mobile`) is
the offline-first surface, because that is where the work happens without
signal.

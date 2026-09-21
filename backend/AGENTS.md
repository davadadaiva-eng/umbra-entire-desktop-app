# AGENTS.md

## Chrome Extension Development

- **Unpackaged extension won't load without icon files.** If `manifest.json` references `icons/icon16.png` etc. and those files don't exist, Chrome blocks the entire extension load with "Could not load icon" — no partial load, no fallback. Generate placeholder icons before first load attempt.

- **Manifest V3 service workers are non-persistent.** All in-memory state (event queues, tab maps, session IDs) is wiped when Chrome decides to kill the worker. Anything that must survive restarts must go into `chrome.storage.local`, which is async (unlike `localStorage`).

- **`chrome.storage.local` hard limit is ~5 MB.** When persisting event queues, enforce a byte-size cap by trimming oldest entries. Serializing a 50K-event queue can easily blow past 5 MB if events carry large payloads (cookie snapshots, tab details, page metadata).

- **`chrome.alarms` minimum is 30 seconds regardless of what you pass.** Setting `periodInMinutes: 0.083` (5 s) gets silently clamped to 0.5 min (30 s). For sub-30s intervals, use `setInterval` in the service worker instead — but note it won't survive worker restarts.

- **`chrome.management.getAll()` returns ALL extensions (enabled + disabled).** You must filter `.filter(e => e.enabled)` yourself. Also requires the `management` permission which is not in the default set.

- **`chrome.history.search({ maxResults })` returns at most what exists, not a count.** To get total history count, request `maxResults: 10000` and check `.length` — there's no dedicated count endpoint.

- **Content script `document_idle` means you miss early DOM events.** MutationObserver catches dynamic forms, but forms present in the initial HTML before script runs are only caught by the initial `checkForLoginForm()` call — not guaranteed to fire if the content script loads after the form.

## Build & Tooling

- **Generate PNG icons with pure Node.js + `zlib`.** No `canvas` or `pngjs` dependency needed. Build the IHDR/IDAT/IEND chunks manually with CRC32, compress raw RGBA rows with `zlib.deflateSync`. Works for any size.

## User Preferences

- Popup UI should be compact (260px wide, 14px padding) with circular/rounded elements (16px border-radius on cards).
- Remove server host input from popup — users don't need to configure it.
- Extension must always collect data even when Umbra server is offline, persisting to storage and flushing on reconnect.

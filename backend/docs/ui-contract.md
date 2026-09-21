# Umbra OS — UI Contract (read-only UI)

The React UI project is **read-only**: it consumes Umbra OS through this contract.
Base URL: `http://127.0.0.1:8787` (bound to loopback only). All routes return JSON.
CORS: `Access-Control-Allow-Origin: *` is set on every response.

## REST Endpoints

### Status & Health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness: `{ ok: true, uptimeMs }` |
| GET | `/api/status` | Full snapshot: consent, desktop2, agentDesktop, streamer, agent, swarm, models |

`GET /api/status` shape:

```json
{
  "initialized": true,
  "uptimeMs": 1234,
  "consent": {
    "granted": false,
    "denied": false,
    "askOncePerSession": true,
    "emergencyStopArmed": false
  },
  "desktop2": {
    "isRunning": true,
    "displayId": 1,
    "browserPid": 4421,
    "startedAt": "...",
    "taskCount": 3,
    "uptimeMs": 1234,
    "tabs": 1,
    "activeTabId": "...",
    "pageTitle": "Example Domain",
    "pageUrl": "https://example.com/"
  },
  "streamer": { "active": true, "clients": 1, "fps": 5, "port": 9090 },
  "agentDesktop": { "open": true },
  "agent": { "activeTasks": 1 },
  "swarm": { },
  "models": { "fast": "...", "vision": "...", "reasoning": "..." }
}
```

### Tasks

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| POST | `/api/task` | `{ "description": "...", "priority": 0 }` | Submit a task. Returns `{ "taskId": "uuid" }` |
| GET | `/api/task/:id` | — | Full task incl. `status`, `steps[]`, `result`, `error` |
| GET | `/api/tasks` | — | Active (pending/planning/executing) tasks: `{ "tasks": [] }` |

Task status values: `pending | planning | executing | healing | completed | failed | cancelled`.
Each step has `description`, `action`, `params`, `result`, `error`, `startedAt`, `completedAt`.
Step results for UI actions are enriched: `"<result> | Page state changed after action | Verification: OK — <vlm reason>"`.

### Desktop 2 control

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| POST | `/api/desktop2/action` | `{ "action": "...", "params": {} }` | Execute one action. Returns `{ "result": "..." }` |

Actions (params in parentheses):
- `launchBrowser` (url) — starts Edge/Chrome with CDP on port 9222
- `navigate` (url) — no scheme required; `https://` is prepended
- `newTab` (url) / `closeTab` (id) / `activateTab` (id) / `listTabs`
- `getInfo` — `{ title, url }`
- `click` (x, y) or `clickSelector` (selector)
- `type` (text) or `typeInto` (selector, text)
- `pressKey` (key) — Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp/Down, Arrows, Space, F1–F12
- `hotkey` (modifiers: string[], key) — ctrl/alt/shift/meta
- `scroll` (deltaX, deltaY, x?, y?)
- `screenshot` — returns confirmation with byte count
- `snapshot` — DOM accessibility snapshot (one `tag#id.class "text" @x,y,WxH` per line)
- `evaluate` (expression) — raw JS in the page
- `extract` (selector?) — innerText of element or whole page (privacy-filtered)
- `wait` (ms) — polls the emergency-stop file while waiting

Input actions (click/clickSelector/type/typeInto/pressKey/hotkey/scroll) are **consent-gated**:
they return HTTP 500 with `{ "error": "Consent denied: ..." }` until the session grant is given.
Every action also checks the emergency-stop file first.

### Consent & emergency stop

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| GET | `/api/consent` | — | `{ granted, denied, askOncePerSession, emergencyStopArmed }` |
| POST | `/api/consent` | `{ "action": "request", "reason": "..." }` | Triggers the interactive console prompt (y/n, 30s auto-deny). Returns `{ result: "granted" \| "denied" \| "timeout" }` |
| POST | `/api/consent` | `{ "action": "arm" }` | Writes `~/.umbra/emergency-stop` — all actions + running tasks abort at the next check |
| POST | `/api/consent` | `{ "action": "disarm" }` | Removes the file |

### Read-only data

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/knowledge/search?q=...` | Knowledge graph search: `{ results: [] }` |
| GET | `/api/macros` | Detected macros: `{ macros: [] }` |
| GET | `/api/sessions` | Activity sessions: `{ sessions: [] }` |
| GET | `/api/privacy/stats` | Privacy guard stats |
| GET | `/api/activity/summary` | Recall activity summary |
| GET | `/api/swarm` | Swarm status: `{ swarm: {} }` |
| GET | `/api/vault/stats` | Audit vault stats: `{ vault: {} }` |
| POST | `/api/journal/generate` | Force daily journal generation: `{ journal: {} }` |
| POST | `/api/shutdown` | Graceful shutdown (journals, closes subsystems, exits): `{ ok: true }` |

Errors: `{ "error": "<message>" }` with status 400/404/500.

### Telco (SMS & calls — Telnyx)

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| GET | `/api/telco/status` | — | Settings with the API token masked: `{ enabled, provider, fromNumber, tokenConfigured }` |
| POST | `/api/telco/configure` | `{ apiKey?, fromNumber?, messagingProfileId?, enabled? }` | Persist the Telnyx token + sender number + messaging profile (token stored vault-backed) |
| POST | `/api/telco/sms` | `{ to, text, from? }` | Send an SMS. Returns `{ result }` |
| POST | `/api/telco/call` | `{ to, from?, connectionUrl? }` | Initiate a voice call. Returns `{ result }` |

### Docker workers

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| GET | `/api/docker/list` | — | Tracked worker containers: `{ containers: [] }` |
| POST | `/api/docker/run` | `{ name, image, command?, env?, memoryLimitMb?, cpuQuotaPct? }` | Run a containerized skill worker. Returns `{ container }` |
| POST | `/api/docker/stop` | `{ name }` | Stop a worker container. Returns `{ stopped }` |
| POST | `/api/docker/remove` | `{ name }` | Remove a worker container. Returns `{ removed }` |

## WebSocket — `ws://127.0.0.1:8787/api/ws`

On connect the server sends a full snapshot:

```json
{ "type": "snapshot", "status": { ...same as GET /api/status... } }
```

Then live events (one JSON message per event):

```json
{ "type": "event", "name": "task:completed", "payload": ... }
```

Event names: `app:ready`, `app:shutdown`, `task:created`, `task:started`, `task:completed`,
`task:failed`, `task:cancelled`, `swarm:allocated`, `swarm:freed`, `display:created`,
`display:destroyed`, `healing:recovered`, `healing:failed`, `recall:macro-detected`,
`audio:gesture`, `config:changed`, `knowledge:updated`, `vault:entry`, `overlay:toggle`,
`overlay:command`, `stream:started`, `stream:stopped`.

## Live preview stream — `ws://127.0.0.1:9090`

Separate WebSocket server owned by the streamer:

- Client → `{ "type": "subscribe" }` / `{ "type": "unsubscribe" }`
- Server → `{ "type": "subscribed", "fps": 5 }`
- Server → `{ "type": "frame", "image": "<base64 png>", "seq": 1 }` (only while subscribed)
- Client → `{ "type": "command", "action": "navigate", "params": { "url": "..." } }`
- Server → `{ "type": "result", "id": "...", "result": "..." }` or `{ "type": "error", "id": "...", "error": "..." }`
- Either side → `{ "type": "ping" }` / `{ "type": "pong" }`
- Client → `{ "type": "status" }` → `{ "type": "status", "status": { "active", "clients", "fps", "port" } }`

Commands on the preview stream go through the same consent gate as REST.

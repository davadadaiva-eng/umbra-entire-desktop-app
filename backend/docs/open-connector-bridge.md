# Open-Connector Bridge — all 1,500+ providers via gateway

Umbra keeps its own catalog (`McpCatalog.ts` + `ExternalCatalog.json` + curated
tools) for offline / local-first work. **open-connector** runs next to it as a
sidecar gateway and provides the 1,500+ providers / 10,000+ Actions Umbra does
not have to re-implement.

Code entry: `src/core/mcp/OpenConnectorBridge.ts` (zero new deps, `fetch` only).
Wired once at boot in `src/index.ts` → `ConnectorApi.setOpenConnector()`.

## Transparent mode (default — users never see "open-connector")

Once the sidecar is up, gateway providers appear as ordinary Umbra connectors:

- `GET /api/connectors` merges gateway-only providers into the list with the
  same row shape (local rows win on overlap, e.g. native `productivity-gmail`
  covers gateway `gmail`; exact name matches jump the queue).
- `POST /api/connectors/:id/connect` works for gateway-only ids too — API keys
  save locally AND are mirrored into the gateway; OAuth returns the same
  `oauth_redirect` shape (authorization happens at the sidecar).
- `POST /api/connectors/execute` tries the local executor first and falls back
  to the gateway (`service.action` ids → Action call, `/paths` → proxy).
  Real provider answers are never double-called.
- Readiness/status/tool-search are gateway-aware; `/api/status` health reports
  `gateway: { available, providers }`.
- Sidecar down (or never started)? Every path degrades to the local catalog.
  Boot is never blocked. Tests: `ConnectorApi.gateway.test.ts` (mocked
  sidecar, 8 tests) proves the merge; all legacy suites run bridge-less and
  are byte-identical in behavior.

## Run it (2 commands)

```bash
# 1. start the gateway (published image, no source copied)
docker compose --profile connectors up -d
# serves http://127.0.0.1:3000  + console http://127.0.0.1:3000/

# 2. point Umbra at it
OPENCONNECTOR_BASE_URL=http://127.0.0.1:3000 npm run dev
```

Verify:

```bash
curl -s http://127.0.0.1:3000/v1/health
curl -s "http://127.0.0.1:3000/v1/actions?service=github" | head -c 500
```

Full local dev (no Docker): `npm i -g @oomol-lab/open-connector` is NOT needed —
see `https://github.com/oomol-lab/open-connector/blob/main/docs/quickstart.md`
(`docker compose up`, Node 22+, `npm run dev` on port 3000).

## Connect a provider (example: GitHub API key)

```bash
curl -s -X PUT http://127.0.0.1:3000/api/connections/github \
  -H 'content-type: application/json' \
  -d '{"authType":"api_key","values":{"apiKey":"github_pat_..."}}'

curl -s -X POST http://127.0.0.1:3000/v1/actions/github.get_current_user \
  -H 'content-type: application/json' -d '{"input":{}}'
```

OAuth2 (Gmail, Slack…): register `<publicOrigin>/oauth/callback` with the
provider, save client via `PUT /api/oauth/configs/:service`, start with
`POST /api/oauth/authorizations`. Named accounts via `connectionName: "work"`
+ header `x-oo-connector-alias: work`. See open-connector `docs/credentials.md`.

## Use from Umbra (TypeScript)

```ts
import { OpenConnectorBridge } from './core/mcp/OpenConnectorBridge';
const oc = new OpenConnectorBridge(); // reads OPENCONNECTOR_* env
const h = await oc.health();          // { ok: true }
const r = await oc.executeAction('github.get_current_user', {}, {
  connectionName: 'work',
  idempotencyKey: crypto.randomUUID(), // safe retries, 24h replay
});
```

MCP passthrough: `oc.mcpCall('execute_action', { actionId, input,
connectionName })`, plus `list_apps / list_connections / search_actions /
get_action_guide`. No silent fallback: unknown named connection errors.

## Security model (inherited)

Secrets stay in the gateway DB (SQLite `./data/connect.sqlite` or Postgres,
AES-256-GCM when `OOMOL_CONNECT_ENCRYPTION_KEY` is set). Umbra only sees safe
account labels (`accountId/displayName/grantedScopes`) + results. Enforce
least-privilege with `OOMOL_CONNECT_ALLOWED_ACTIONS="github.*,gmail.*"` +
per-token `allowedActions/blockedActions/allowedProxies/allowedConnections`.
Admin (`/api/*`) vs runtime (`/v1,/mcp`) tokens are separate. Never expose the
sidecar beyond loopback without `OOMOL_CONNECT_ADMIN_TOKEN`.

## Legal (Apache-2.0, short version)

open-connector is Apache-2.0 (see `backend/THIRD-PARTY-NOTICES.md`). We run the
published image / npm package as-is — no provider source is copied into Umbra,
so Umbra is an API client, not a Derivative Work. Provider names/trademarks
belong to their owners, interop only, no endorsement. If you later vendor
provider code, you MUST ship `LICENSE.txt`, mark modified files, and reproduce
`NOTICE.md`.

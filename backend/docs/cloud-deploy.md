# Cloud deployment (always-on Umbra)

The cloud server runs Umbra's **headless core** — API, agent loop, MCP
connectors, persistent memory, model routing/billing, and image generation —
so work continues even when the user's PC is off. Desktop control
(mouse/keyboard/OCR/real-app driving) still needs the Windows machine.

## Cost targets

| Plan | Cloud budget | Server size | Provider (approx) |
|---|---|---|---|
| Pro (€19) | **≤ $4/mo** | 2 vCPU / 4 GB | Hetzner CX22 (~€3.79) |
| Ultimate (€38) | **≤ $8–9/mo** | 4 vCPU / 8 GB | Hetzner CX32 or CPX21 (~€7–9) |

The $4 / $8–9 is the *server* cost and is separate from the $5 / $10 token
budget the plan already assigns to models.

## Execution model: PC-first, cloud as fallback

- **PC on (role `desktop`)**: Umbra runs everything locally — real desktop
  control, screen reading, browser, the full agent loop. This is the default
  and costs the cloud nothing.
- **PC off**: the cloud node (role `cloud`, `UMBRA_HEADLESS=1`) resumes any
  **in-flight tasks** the PC left behind, then serves new API-submitted tasks.
- The task queue is persisted to `<dataDir>/task-queue/` (`TaskStore`) and
  checkpointed after every step, so a task that was mid-execution on the PC
  continues from the exact step where it stopped — no re-planning, no redoing
  finished steps.

## Cloud continuation is a paid feature

- `desktop` always resumes its own local queue (free users included — it's
  their own machine).
- `cloud` only resumes when the plan is **paid** (`pro` / `ultimate` / `byok`).
  On `free`, in-flight tasks are left queued on disk and are *not* run on the
  cloud. `POST /api/plan/activate` flips `plan.cloudContinuation` accordingly.

### Sharing the queue across nodes (hybrid handoff)

The desktop and cloud nodes resume each other's tasks when they can see the
same `task-queue/` directory. Two supported setups:

1. **Shared volume**: point both nodes' `~/.umbra` (or just `task-queue/`) at
   the same NFS/object-store path (the Docker volume `umbra-data:/root/.umbra`
   already isolates it for backup/sync).
2. **API sync (built-in)**: push/pull the queue over the cloud's REST API —
   no shared filesystem or third-party tool needed:

   ```bash
   # PC → cloud (before the PC goes offline; the cloud resumes)
   UMBRA_API_URL=https://umbra.example.com npm run sync:queue -- push

   # cloud → PC (when the PC comes back online)
   UMBRA_API_URL=https://umbra.example.com npm run sync:queue -- pull
   ```

   `push` POSTs the local `~/.umbra/task-queue/*.json` to
   `POST /api/task-queue/import`; `pull` reads `GET /api/task-queue/export`
   back into the local dir. Run it from cron/Task Scheduler for continuous
   handoff.
3. **File sync**: sync the PC's `~/.umbra/task-queue/` and `recall.db` up to
   the cloud (rclone/Syncthing) as an alternative to the API helper.

## Headless mode (what the cloud skips)

`UMBRA_HEADLESS=1` (or `UMBRA_ROLE=cloud`) disables the Windows-native /
screen-bound subsystems so the Linux box boots only the core:

- Activity watcher (screen polling + OCR), screen reader, live shadowing
- Real desktop control (RealDesktop2), agent Chrome (CDP), browser-use bridge
- Preview streamer, Command HUD, P2P/PWA phone control plane

Kept on the cloud: API server, agent loop + durable task queue, MCP registry,
vector memory, model routing/billing, Graphify/Caveman, image generation, and
the built-in reasoning-engine delegation.

## Deploy

```bash
# one-time: install Docker + docker compose on the VPS, then
HOST=user@your-vps ./scripts/deploy.sh
```

The `umbra-data` volume holds `~/.umbra` (config, recall DB, vault, task
queue, logs) so state survives restarts. Secrets live in the volume's
`config.json` / `vault.bin`, never in the image.

## Device mesh (phone + PC always connected)

The cloud also runs a **DeviceHub** (WebSocket on port 8788) that every device
stays connected to:

1. **Join once** — phone scans a QR, or the PC opens a link
   (`GET /api/devices/invite` → code → `POST /api/devices/join`). The hub
   returns a long-lived token.
2. **Auto-reconnect forever** — each device runs a `DeviceClient` that
   reconnects with backoff and re-authenticates with its token, so the mesh
   survives network drops and hub restarts without re-pairing. The registry
   persists to the `umbra-data` volume.
3. **Control from the phone** — the phone submits tasks (`POST /api/task`) to
   the cloud, or relays a `cmd` through the hub to the desktop (the desktop
   executes it via real-desktop control and relays the result back).

**Plan device limits** — free/BYOK/Pro allow **1** registered device (the
phone *or* the desktop); Ultimate allows **unlimited**. Enforcement is at
join time (`POST /api/devices/join`): a second join on a 1-device plan is
rejected with a clear message until an existing device is revoked
(`POST /api/devices/revoke`) or the plan is upgraded. Already-registered
devices keep auto-reconnecting — the limit only blocks *new* registrations.
`GET /api/devices` reports the current `deviceLimit` for the plan.

Desktop → cloud join (one-time, then automatic):
```bash
UMBRA_API_URL=https://umbra.example.com \
UMBRA_HUB_URL=wss://umbra.example.com/device-ws \
node -e "os.joinRemoteHub('CODE')"
```

Set `UMBRA_PUBLIC_URL` on the cloud so QR/link payloads point at your domain.

### TLS + TURN (production edge)

`docker-compose.yml` ships an `edge` profile with TLS and a TURN relay for the
phone PWA off-LAN:

```bash
# On the VPS: point a domain at the box, then
UMBRA_DOMAIN=umbra.example.com docker compose --profile edge up -d
```

- **caddy** terminates TLS (auto Let's Encrypt) and proxies
  `https://<domain>/api/*` → `umbra:8787` and `wss://<domain>/device-ws` →
  `umbra:8788` (see `deploy/Caddyfile`).
- **coturn** is the TURN relay for WebRTC NAT traversal (host networking).
  Edit `deploy/turnserver.conf` (set your `user=…:…` credential, `realm`, and
  `server-name`), then point the phone at it in config:
  `p2p.turnServers = ["turn:turnuser:turnpass@<server>:3478"]`. The PWA falls
  back from a direct WebRTC data channel to the encrypted JPEG relay
  automatically, and TURN now lets the direct path work behind symmetric NAT.

## Billing (Stripe checkout + webhook)

The cloud can sell the hosted plans end-to-end — no manual activation needed:

1. **Stripe dashboard** → Products/Prices: create two subscription prices
   (Pro €19, Ultimate €38) and copy their `price_...` ids.
2. **Configure** the cloud node (secrets stay in the git-ignored config
   volume or env vars):

   ```bash
   UMBRA_STRIPE_SECRET_KEY=sk_live_... \
   UMBRA_STRIPE_WEBHOOK_SECRET=whsec_... \
   UMBRA_STRIPE_PRICE_PRO=price_... \
   UMBRA_STRIPE_PRICE_ULTIMATE=price_... \
   UMBRA_PUBLIC_URL=https://umbra.example.com \
   docker compose --profile edge up -d
   ```
3. **Point the webhook at the cloud**: Stripe dashboard → Webhooks → add
   endpoint `https://<domain>/api/billing/webhook` with event
   `checkout.session.completed` and copy the signing secret (`whsec_...`).
4. **Sell**: redirect buyers to `https://<domain>/api/billing/checkout?tier=pro`
   (or `?tier=ultimate`); Stripe hosts the checkout and, on success, the
   webhook verifies the signature and auto-activates the plan — routing + the
   pre-split token budget + cloud continuation, exactly like `POST
   /api/plan/activate`.

`npm run setup` collects the Stripe keys/price ids interactively instead of
env vars if you prefer config.json. The webhook path is already proxied by
Caddy in the `edge` profile.

**One-OpenRouter-key setup** — `npm run setup -- --openrouter-key sk-or-...`
(or `--openrouter` / `OPENROUTER_API_KEY`) maps every routing slot
(fast/reasoning/frontend/difficult + the `:free` spillover) to real OpenRouter
model ids with real per-1M pricing, and live-validates the key, printing the
credit limit, remaining balance, and monthly usage. One key then fundsthe whole token budget; the MeteringService still caps spend per the plan ($5 Pro
/ $10 Ultimate) and spills to free models when exhausted.

**One keys file for all of it** — `npm run setup -- --keys-file umbra-keys.json`
loads every key (OpenRouter, provider, Telnyx, Stripe, tier, public URL) from a
single JSON or `.env` file — see `umbra-keys.example.json` in the repo root.
Keys are matched case-/separator-insensitively and nested objects flatten
(`{ telnyx: { key } }` == `TELNYX_API_KEY`). The real file (`umbra-keys.json`)
is git-ignored; explicit flags and environment variables still take precedence.

## Multi-user (per-user budgets on one cloud node)

Each paying customer gets their **own $5/$10 monthly token budget**, own
spend ledger, and own device cap — one cloud node can sell to many users
without letting one heavy user drain everyone:

1. **Register the user**: `POST /api/tenants/register {id, name?, tier?}`
   (use the Stripe customer id for convenience; `GET /api/tenants` lists
   everyone with live budget/usage + device limits).
2. **They pay**: send buyers to
   `/api/billing/checkout?tier=pro&tenant=<id>` — the tenant id rides in the
   Stripe session metadata, and the webhook auto-activates *that* user's
   plan. (Or `POST /api/tenants/activate {id, tier}` manually.)
3. **Their traffic is scoped**: the phone PWA and any API client send the
   `X-Umbra-Tenant: <id>` header — every LLM call the request spawns meters
   against that user's ledger. An exhausted user spills to free models
   while everyone else keeps their paid slots; spend checks are per-tenant.
4. **Watch it**: `GET /api/plan/usage?tenant=<id>` (or all tenants via
   `GET /api/tenants`). Disable a user with
   `POST /api/tenants/disable {id}` to drop them back to the node default.

Traffic with no header (or an unregistered tenant) uses the node's own
default budget — so a single-tenant install behaves exactly as before.

## 1000+ connectors in one call

The catalog already bundles hundreds of connectors, and the rest of the
universe is one POST away:

```bash
curl -X POST http://<host>/api/mcp/import-registry -H 'content-type: application/json' \
     -d '{"maxPerSource": 0}'   # 0 = import everything
```

This pulls **Smithery** (`api.smithery.ai/servers`) and the **official MCP
registry** (`registry.modelcontextprotocol.io`, thousands of streamable-HTTP
servers) and registers every entry as a remote connector through the same
MCP router — `mcp-<name>` ids, deduped, no restart needed. Connectors that
need auth resolve their key lazily from the vault at call time. The device
PWA and the agent can then call any of them; enable the ones you actually
use to keep the surface tight.

## Voice-to-text (whisper.cpp)

Free, private, unlimited STT on the cloud server:

```bash
MODEL=medium.en ./scripts/download-whisper-model.sh   # downloads to ./models
docker compose up whisper                            # serves :8080
```

Then set in the cloud's config: `voice.enabled = true`,
`voice.sttProvider = "whisper-local"`,
`voice.sttEndpoint = "http://whisper:8080"`.

Model accuracy vs RAM (bigger = fewer missed words):

| Model | Disk | RAM | Accuracy |
|---|---|---|---|
| tiny | 75 MB | ~273 MB | misses words (demo) |
| base | 142 MB | ~388 MB | ok, clear speech |
| small | 466 MB | ~852 MB | good |
| **medium** | 1.5 GB | ~2.1 GB | **strong — recommended** |
| large-v3 | 2.9 GB | ~3.9 GB | best |

Pick **medium.en** on the 8 GB box (or small.en on 4 GB). The app sends
greedy decoding (`temperature=0`) and, when you pass `language`/`prompt`,
biases the transcript — these are what stop whisper.cpp from dropping words.

## Concurrency (how many agents at once)

A "concurrent agent" is one in-flight task holding a metering session. The
plan sets the ceiling:

| Plan | Concurrent tasks |
|---|---|
| Free | 1 |
| BYOK | 2 |
| Pro | 8 |
| Ultimate | unbounded (RAM/CPU-bound) |

On a **4 GB** box the Pro ceiling of 8 concurrent tasks is comfortable —
each task is ~10–25 MB of Node heap (LLM inference happens on external APIs),
and the whole headless core idles around 300–500 MB. An **8 GB** box adds
headroom for more concurrency or a small local 7B free model (~4–6 GB) as the
spillover tier instead of OpenRouter.

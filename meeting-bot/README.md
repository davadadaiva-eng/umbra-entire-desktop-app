# Meeting Bot

A self-hosted meeting participant bot for Google Meet and Microsoft Teams.
It joins a meeting in headless Chromium, listens through a virtual sound
card, transcribes with Whisper, thinks with an LLM, and answers aloud
through Piper TTS. Runs entirely in Docker — designed for a headless cloud
VPS with no display, no audio hardware, and no desktop.

## Architecture

```
 meeting audio ──> Chromium ──> default sink (bot_speaker)
                                  └─ .monitor ──> parecord (capture)
                                        └─> Whisper STT ──> BrainManager (LLM)
                                                  └─> Piper TTS ──> pacat
bot speech ──> pacat ──> bot_microphone sink ──> .monitor (default source)
                                  └─> Chromium mic ──> other participants
```

- `app/meeting_bot.py` — Playwright-driven join flow (Meet/Teams), meeting loop
- `app/audio_engine.py` — PulseAudio capture (`parecord`) and injection (`pacat`)
- `app/stt_engine.py` — faster-whisper, plan-based model selection
- `app/tts_engine.py` — Piper voice (Italian `it_IT-riccardo-x_low` by default)
- `app/brain_manager.py` — LLM via OpenAI-compatible API or your own webhook
- `app/main.py` — FastAPI control API (join/leave/status/transcript/command)

## Requirements

- Cloud VPS with **KVM** virtualization (DigitalOcean, Hetzner, Vultr, AWS…)
- 2 vCPU / 4 GB RAM (FREE or PRO), 8 GB for ADVANCED · 20 GB disk
- Ubuntu 22.04 / 24.04
- An LLM credential (OpenRouter API key by default)

> **Cheapest proven pick:** Hetzner **CX22** — 2 vCPU / 4 GB RAM / 40 GB NVMe,
> ~€4/month (Falkenstein or Helsinki DC). KVM, hourly billing, perfect for the
> FREE plan. Windows/macOS home machines without BIOS virtualization enabled
> cannot run Docker — deploy straight to the VPS instead.

> The bot only needs outbound internet. The API binds to loopback only;
> reach it through an SSH tunnel — never expose it publicly unauthenticated.

## Quick start (fresh VPS)

```bash
# 1. Copy this folder to the server, then:
cd meeting-bot
bash scripts/vps-setup.sh        # installs Docker, builds, downloads models, smoke-tests

# 2. Edit .env (LLM_API_KEY; optionally API_TOKEN) and re-run if prompted
nano .env

# 3. Run it
docker compose up -d
curl localhost:8000/health      # -> {"status":"ok"}
```

From your laptop, open a tunnel instead of exposing the port:

```bash
ssh -L 8000:localhost:8000 user@your-vps
# now http://localhost:8000 works locally
```

## Models

| Component | What | Size | When |
|---|---|---|---|
| Whisper STT | `PLAN=FREE`→base · `PRO`→tiny · `ADVANCED`→small | 75–500 MB | auto-downloads on first start (HuggingFace), cached in the `whisper-models` volume |
| Piper TTS | `it_IT-riccardo-x_low` | ~20 MB | `docker compose run --rm meeting-bot /app/scripts/download_models.sh` |
| LLM | remote API | — | just the API key |

Change plan by editing `PLAN` in `.env` and restarting.

## Joining a meeting

```bash
curl -X POST localhost:8000/bot/join \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_TOKEN' \   # only if API_TOKEN is set
  -d '{"url":"https://meet.google.com/abc-defg-hij","platform":"meet","bot_name":"MeetingBot"}'

curl localhost:8000/bot/status
curl localhost:8000/bot/transcript
curl -X POST localhost:8000/bot/leave
```

**Google Meet access:** the bot joins as a guest. Either a human admits the
"Ask to join" request, or provide a signed-in session via exported cookies
(see "Exporting Google Meet cookies" below).

Microsoft Teams guest links usually join without cookies.

## Exporting Google Meet cookies

The bot reads `session_data/meet_cookies.json` (bind-mounted to
`/app/session_data`) and injects the cookies into headless Chromium before
opening the meeting link — it then joins as your signed-in Google account.
Steps:

1. On your own PC, open Chrome/Edge and sign in to the Google account the bot
   should use. Prefer a **dedicated account** (e.g. an "attender" account).
2. Install a cookie-export extension that exports in **JSON** format, e.g.
   "EditThisCookie®" or "Get cookies.txt LOCALLY" (its JSON export works
   too — the bot normalizes both formats).
3. Open `https://meet.google.com` **while signed in**, click the extension,
   and export cookies for the current site (`meet.google.com`).
4. Save the file as `session_data/meet_cookies.json` next to this README (on
   the VPS: `meeting-bot/session_data/meet_cookies.json`).
5. Restart with `docker compose restart` — or just fire the next join: the
   file is re-read at every join, so a running bot picks it up too.

Notes:

- Expired/unusable cookies are skipped with a log line; if the whole file is
  unusable the bot falls back to guest mode with a warning. Check
  `docker compose logs meeting-bot | grep -i cookie` after a failed join.
- Google rotates `SID`/`SSID`/`HSID`/`APISID`/`SAPISID` roughly every
  24 h–2 weeks. When joins start landing on the "Ask to join" screen again,
  re-export.
- Treat the file like a password: it is a full access token for that Google
  account. `session_data/` is git-ignored — never commit it, never paste it
  anywhere.

### When a join fails: automatic diagnostics

Whenever the bot fails to enter a meeting — an error during the join flow,
a missing join button, or a join that silently didn't take — it dumps what
headless Chromium saw into `output/` (bind-mounted on the host):

```
output/failure_meet_20260101T120000Z.png    # screenshot of the page
output/failure_meet_20260101T120000Z.html   # full page HTML
output/failure_meet_20260101T120000Z.json   # reason, URL, meeting id
```

The JSON also mirrors to the API: after a failed join,
`curl localhost:8000/bot/status` shows the `last_diagnostics` block with the
exact reason and file paths. If `/bot/join` returns **503**, the join threw
(rejected cookies, DNS failure, ...); if it returns **joined** but a
`failure_*` file appears anyway, the click didn't take — read the HTML to
see which screen the bot was stuck on (ask-to-join pending, account
picker, consent screen, ...).

## Commands

Send while in a meeting:

```bash
curl -X POST localhost:8000/bot/command \
  -H 'Content-Type: application/json' \
  -d '{"command":"bot summarize"}'
```

Recognized: `bot take notes` · `bot generate report` · `bot summarize` ·
`bot what did I miss`. Notes/reports/summaries land in `output/` and are
also kept across restarts via the bind mount.

## Smoke test

Verifies the full pipeline without joining any real meeting:

```bash
./scripts/smoke-test.sh            # includes STT round-trip
./scripts/smoke-test.sh --skip-stt # skip the Whisper model download
```

Checks: PulseAudio graph → capture hears a tone → Piper synthesizes →
injection works → Whisper transcribes → brain fallback + webhook paths.

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `PLAN` | `FREE` | STT model tier (`FREE`/`PRO`/`ADVANCED`) |
| `LLM_API_KEY` | — | OpenRouter (or provider) key — the only required secret |
| `LLM_API_URL` | OpenRouter | any OpenAI-compatible chat-completions endpoint |
| `LLM_MODEL` | `deepseek/deepseek-chat` | model id for the endpoint |
| `LLM_WEBHOOK_URL` | — | alternative: POST `{transcript, meeting_id, command}` → `{response}` |
| `API_TOKEN` | — | if set, all `/bot/*` routes require `Authorization: Bearer <token>`; failed attempts rate-limited (10/min per IP → 429); `/docs` hidden |
| `CORS_ORIGINS` | — | browser use only: comma-separated origins allowed to call the API |
| `DOMAIN` | — | public hostname for the bundled Caddy proxy (needs a DNS A record + ports 80/443 open) |
| `COMPOSE_PROFILES` | — | `proxy` starts the Caddy HTTPS reverse-proxy service |

## Exposing the API beyond an SSH tunnel

The API is safe to publish on the internet when `API_TOKEN` is set. The
bundled Caddy reverse proxy gives you automatic HTTPS with zero manual
certificate work:

1. Point a DNS `A` record at the VPS, e.g. `bot.example.com`.
2. In `.env` set:
   ```
   API_TOKEN=<openssl rand -hex 24>
   DOMAIN=bot.example.com
   COMPOSE_PROFILES=proxy
   ```
3. Open the firewall for the proxy only — 8000 stays loopback-only:
   `ufw allow 80,443/tcp`
4. `docker compose up -d` — the Caddy service starts, obtains and renews
   the Let's Encrypt certificate automatically, and proxies to the API.
5. Call the API through the proxy:
   ```bash
   curl https://bot.example.com/bot/status \
        -H "Authorization: Bearer $API_TOKEN"
   ```

`/health` is proxied too and stays open for uptime probes. Failed auth
attempts are rate-limited per IP (10 within 60 s → HTTP 429) and
`/docs`/`/redoc`/`/openapi.json` stay disabled while a token is set. For
browser frontends also set `CORS_ORIGINS=https://your-app.example.com`.

Without the `proxy` profile nothing listens on 80/443 — the API remains
loopback-only (`ssh -L 8000:localhost:8000`). If `DOMAIN` is set but DNS
isn't ready yet, Caddy keeps retrying certificate issuance; the bot is
unaffected, only HTTPS access waits for DNS to propagate.

Before a real domain exists you can still start the profile: with an empty
`DOMAIN` Caddy serves `localhost` with a self-signed certificate (clients
need `curl -k`), which is useful to verify the proxy wiring on the VPS.

## Auto-start on boot

`vps-setup.sh` step 6 installs a systemd unit (`meeting-bot.service`) that
brings the compose stack up at boot and stops it cleanly on shutdown —
useful after VPS maintenance, kernel updates, or provider migrations.

Install or refresh it any time (idempotent):

```bash
sudo bash scripts/install-systemd.sh
bash scripts/install-systemd.sh --print   # preview the unit file only
```

The unit waits for the Docker daemon (up to ~60 s) before running
`docker compose up -d` with the same `.env` / profiles you use by hand,
and is enabled for `multi-user.target` so it survives reboots.

```bash
systemctl status meeting-bot      # stack state (active/exited = running)
sudo systemctl stop meeting-bot   # compose down (clean shutdown)
sudo systemctl restart meeting-bot
journalctl -u meeting-bot         # compose output over time
```

Once installed, manage the stack through the unit; `docker compose down`
by hand leaves it reporting `active (exited)` until the next restart.

## Nightly maintenance

The same installer drops a `meeting-bot-maintenance.timer` that runs
`scripts/vps-maintenance.sh` every night at 04:00 (+ random 15 min):

- pulls newer images (Caddy) and recreates if changed
- prunes dangling images/build cache, stopped containers, unused networks
  (never volumes — Whisper/Piper models are precious)
- vacuums the systemd journal to 100 MB
- reports disk usage, `docker system df`, and the biggest container logs

Disk safety net beyond the timer: each container's logs are capped at
3 × 20 MB in the compose file, and `vps-setup.sh` also sets a daemon-wide
Docker default (`/etc/docker/daemon.json`: `json-file`, 20 MB × 3) so any
*other* containers on the VPS get the same protection — the 40 GB disk
can't fill up with logs over months. Run maintenance by hand any time:

```bash
sudo bash scripts/vps-maintenance.sh
systemctl list-timers meeting-bot-maintenance.timer   # next run
```

## Troubleshooting

- **Container exits with "PulseAudio daemon did not become ready"** — the
  entrypoint now fails loudly by design; check `docker logs meeting-bot`.
- **"Piper voice model not found"** — run `download_models.sh` (see Models).
- **Bot is silent in the meeting** — verify with the smoke test; then check
  the meeting app picked the default mic (`bot_microphone.monitor`).
- **Transcript is empty** — confirm the meeting is audible to `bot_speaker`
  (smoke test stage 2 covers this) and Whisper finished loading.
- **401 on API calls** — `API_TOKEN` is set; send the bearer header.
- **Join failed / bot never spoke** — open the newest
  `output/failure_*.{png,html,json}` (created automatically on every failed
  join) and check `last_diagnostics` in `/bot/status`.
- **Disk filling up** — check the nightly report:
  `journalctl -u meeting-bot-maintenance.service -n 50`. A spike right
  after joining a meeting is usually `session_data/` or `output/` artifacts
  (bind mounts, safe to trim); container logs are capped at 3 × 20 MB.

## Development notes

The entrypoint sets up Xvfb (`:99`), PulseAudio, and the two virtual
sinks, verifies the default routing, then either starts the bot or `exec`s
any command passed to the container — that is how the smoke test and model
downloader run against the fully configured stack.

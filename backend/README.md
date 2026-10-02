# Umbra OS — Invisible AI Computer Assistant for Windows

Umbra OS is a local-first AI assistant for Windows: it reads what you do, learns patterns,
and can take over an isolated browser "Desktop 2" to execute real tasks for you — with
explicit consent and an emergency stop.

## Quick start

```bash
npm install
npm run build
npm start
```

On first boot Umbra OS asks permission before it sends any input to the browser
(console prompt: `y`/`n`, auto-deny after 30s).

## Ports (all loopback)

| Port | Service |
| --- | --- |
| 8787 | REST API + event WebSocket (`/api/ws`) — for the read-only UI |
| 8788 | DeviceHub WebSocket (device mesh) |
| 9090 | Live preview stream of Desktop 2 (frames + commands) |
| 9222 | Edge/Chrome CDP (internal, Desktop 2 browser) |

UI contract: [`docs/ui-contract.md`](docs/ui-contract.md).

## What it does

- **Screen reading & recall** — OCR of the active screen (Tesseract, local `eng.traineddata`
  cached in `~/.umbra/lang/`), activity sessions, keystroke/click aggregates, all privacy-filtered
  before storage.
- **Knowledge brain** — recall events are bridged into a knowledge graph every 15 minutes;
  hourly auto-journaling + topic index in `~/.umbra/knowledge/`.
- **Real agent loop** — `submitTask` → plan (LLM) → act on Desktop 2 (real Edge via CDP) →
  observe (DOM snapshot + screenshot) → verify (VLM on the after-screenshot) → learn.
  Failed steps trigger recovery (Escape ×2, then page reload) and self-healing.
- **Agent's own desktop** — on first task the agent asks consent, opens a dedicated Windows
  virtual desktop (Win+Ctrl+D), opens its workspace folder there (`~/.umbra/workspace/`),
  launches the browser on it, and switches back — working in parallel while you keep using
  your desktop. If consent is denied (or the hotkey is unavailable) it falls back to the
  in-place setup.
- **Workspace files** — the agent can read/write files inside a sandboxed
  `~/.umbra/workspace/` (path traversal blocked, 1 MB read cap).
- **Consent gate** — session grant for input actions, `~/.umbra/emergency-stop` file aborts
  tasks and blocks all actions at the next check.
- **Preview stream** — the read-only UI can watch Desktop 2 live and send commands
  (consent-gated).
- **Voice stack** — local STT/TTS/ASR via VibeVoice (voice cloning), whisper.cpp and
  Windows SAPI; hands-free voice commands, push-to-talk ("tap to listen") and meeting
  transcription. A `VoiceStackHealth` probe (STT / TTS / ASR / audio cable / loopback /
  mic) runs at boot and is reported in `/api/status`; the phone PWA can arm/disarm the
  push-to-talk hotkey from its settings card.
- **Meetings** — attend end-to-end: plan an agenda, live digest, action items and
  decisions, with speaker diarization from VibeVoice-ASR ("who said what and when") plus
  mute / raise-hand / screen-share controls.
- **MCP registry** — a model-context-protocol registry dispatches external tools over
  HTTP, native bindings or prompts, with vault-backed credentials; an MCP server endpoint
  lets external agents call Umbra's connectors.
- **P2P mesh & device pairing** — an encrypted Rust mesh daemon plus a WebSocket device
  hub (port 8788) keeps phones/desktops connected; QR-code pairing, WebRTC streaming, and
  a bundled PWA for phone control. Plan device limits: Pro = 1 connected device,
  Ultimate (aka Advanced) = 5, Enterprise = unlimited (enforced at join;
  `GET /api/devices` reports the limit).
- **Skill stack & context compression** — 20 domains × 5 skills (100 skills) route
  intents to skill definitions; a Graphify/Caveman pipeline compresses huge context
  (~10,000 tokens → ~300 with expandable cliques) before LLM calls.
- **Metering & prompt caching** — every LLM call is gated behind a plan tier, a circuit
  breaker and token accounting, with prompt caching to cut repeat-context cost.
- **Paid plans & billing** — Pro/Ultimate auto-assign a pre-split monthly token budget
  per model slot; a zero-dependency Stripe checkout + webhook (`/api/billing/checkout`,
  `/api/billing/webhook`) activates a plan automatically once payment succeeds.
- **Telco (SMS & calls)** — send an SMS or initiate a voice call through Telnyx from the
  REST API (`/api/telco/*`), with vault-persisted credentials and token-masked status.
- **Docker workers** — run, stop, remove and list containerized skill workers over the
  REST API (`/api/docker/*`) with per-container memory/CPU limits.

## Configuration

`~/.umbra/config.json` — provider (`ollama` | `openai` | `anthropic` | `openai-compatible`),
model roles (`fast`, `vision`, `reasoning`), workspace (displays, CPU/GPU limits), privacy.

## Scripts

| Command | What |
| --- | --- |
| `npm run build` | TypeScript → `dist/` |
| `npm run dev` | ts-node live run |
| `npm start` | Run from `dist/` |
| `npm test` | Jest — 1043 tests / 88 suites (agent, metering, MCP, voice, meetings, skills, graphify, p2p, api, billing, tenants, auth, cloud, wallet, routing) |
| `npm run lint` | oxlint over `src/` |

Integration tests (live system — build first, then `node scripts/<name>`; requires the
NVIDIA LLM endpoint from `config.json`):

| Script | Proves |
| --- | --- |
| `input-test.js` | Desktop-1 native input (typing, hotkey) |
| `browser-test.js` | Edge launches on Desktop 2, navigation works |
| `streamer-test.js` | Preview stream serves frames |
| `consent-test.js` | Deny blocks, grant passes, emergency stop aborts |
| `agent-loop-test.js` | Full agent task: plan → act → VLM verify → learn |
| `api-test.js` | REST + WS contract against `ApiServer` (no UI needed) |
| `vlm-probe.js` | Vision endpoint connectivity |
| `e2e-test.js` | Whole OS: boot → status → consent → agent task → streamer → emergency stop → shutdown |

## Architecture

```
src/
  index.ts                 — UmbraOS composition root (subsystems + timers + API wiring)
  api/ApiServer.ts         — REST + WS for the read-only UI
  core/
    agent/                 — LLMConnector, TaskPlanner, AgentRuntime (plan→act→observe→verify), ConsentGate, WorkspaceFiles
    browser/               — BrowserManager (CDP client over ws)
    desktop2/              — Desktop2Environment (browser-only "second desktop", executeAction)
    workspace/             — VirtualDisplayManager, InputGuard, SwarmManager
    selfheal/              — SelfHealingGuard (freeze detection on virtual displays)
    recall/                — VectorMemory (SQLite + vector search), ActivityWatcher, MacroSynthesizer
    vision/                — ScreenReader (OCR), ContentAnalyzer
    vault/                 — AuditVault (chained hashes + signing)
    privacy/               — PrivacyGuard (masking, block lists)
    audio/                 — NoiseCancellationEngine (gestures)
    voice/                 — VibeVoiceTts/VibeVoiceAsr, WhisperAsr, VoiceStackHealth
    meeting/               — MeetingAgent (agenda, digest, action items, controls)
    mcp/                   — McpRegistry, McpRouter, McpServerEndpoint (vault-backed auth)
    metering/              — MeteringService (tiers + circuit breaker), MeteredLLMConnector
    skill/                 — SkillStack (100 skills), SkillRouter, SkillCompiler
    graphify/              — Caveman/Chunker compression pipeline
  knowledge/               — KnowledgeGraph, RecallToKnowledgeBridge, journal
  mobile/PreviewStreamer.ts — ws frame stream
  native/win32/            — InputNative (SendInput via PS+C#), ScreenCaptureNative
  overlay/CommandHUD.ts    — Ctrl+Shift+Space always-on-top "Ask Umbra" box (WinForms via PS)
```

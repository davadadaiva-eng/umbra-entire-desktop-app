# AGENTS.md — AI Coding Agent Onboarding

> Quick-start for AI coding agents (Claude Code, etc.) working on the Umbra OS repository.

## 1. Read the project discovery files

- [`llms.txt`](llms.txt) — project overview, architecture, API endpoints, configuration, contributing
- [`llms-full.txt`](llms-full.txt) — full documentation (README, API contract, config reference, cloud setup)
- [`backend/README.md`](backend/README.md) — detailed backend architecture and scripts
- [`desktop/README.md`](desktop/README.md) — desktop app details and important file notes
- [`backend/docs/ui-contract.md`](backend/docs/ui-contract.md) — full REST + WebSocket API contract

Review the constraint: do **not** modify any source code (`.ts`, `.tsx`) — documentation and config files only.

## 2. Read the README

The root [`README.md`](README.md) gives the project structure. The backend [`README.md`](backend/README.md) has the detailed architecture, ports, and test/inventory scripts. The desktop [`README.md`](desktop/README.md) documents the desktop app, environment variables, and critical notes (QUIC/HTTP3 disabling, CSP, Supabase auth, Gemini fallback).

## 3. Install dependencies

```bash
# Backend (Node.js/TypeScript)
cd backend
npm install

# Desktop (React + Electron)
cd ../desktop
npm install
```

The root has no dependencies — `concurrently` is a devDependency only.

## 4. Run in development

```bash
# From the repo root — starts backend + desktop in parallel
npm run dev

# Or backend only:
cd backend && npm run dev        # ts-node, port 8787

# Or desktop only:
cd desktop && npm run desktop    # Vite + Electron
```

## 5. Run the linter

```bash
# From the repo root — lints the backend
npm run lint

# Or desktop directly:
cd desktop && npm run lint
```

The backend uses `oxlint` over `src/`. The desktop also uses `oxlint`.

---

## Additional Context

### Test suites

- **Backend**: `cd backend && npm test` — Jest, 562 tests / 62 suites covering agent, metering, MCP, voice, meetings, skills, graphify, p2P, API, billing, tenants, auth, cloud, wallet, routing.
- **Desktop**: `cd desktop && npm run test:run` — Vitest.

### Scripts (backend)

| Command | What |
| --- | --- |
| `npm run build` | TypeScript → `dist/` |
| `npm run dev` | ts-node live run |
| `npm start` | Run from `dist/` |
| `npm test` | Jest test suite |
| `npm run lint` | oxlint over `src/` |
| `npm run setup` | Interactive setup (Stripe, OpenRouter keys) |
| `npm run sync:queue` | Task queue sync (push/pull for cloud handoff) |
| `npm run vibevoice:install` | Install VibeVoice (Python 3.10+ + GPU recommended) |
| `npm run mesh:build` | Build Rust mesh daemon |

### Integration test scripts (requires build first)

| Script | Proves |
| --- | --- |
| `scripts/api-test.js` | REST + WS contract against ApiServer (no UI needed) |
| `scripts/e2e-test.js` | Whole OS: boot → status → consent → agent task → streamer → emergency stop → shutdown |
| `scripts/conson-test.js` | Consent gate behavior |
| `scripts/agent-loop-test.js` | Full agent task: plan → act → VLM verify → learn |
| `scripts/streamer-test.js` | Preview stream serves frames |
| `scripts/browser-test.js` | Edge launches on Desktop 2, navigation works |

### Project layout

- **`backend/src/`** — TypeScript backend source. Entry point: `src/index.ts` (UmbraOS class composition root). API: `src/api/ApiServer.ts` + `src/api/routes/`.
- **`backend/mesh/`** — Rust P2P core (Cargo workspace + TS bindings).
- **`desktop/src/`** — React components and stores.
- **`desktop/electron/`** — Electron main + preload processes.
- Config is stored at `~/.umbra/config.json` (git-ignored). Template keys: `backend/umbra-keys.example.json`.

### Sensitive paths to avoid

- `/backend/umbra-keys.json` — real API keys, git-ignored. Use `umbra-keys.example.json` as a template.
- `/backend/.venv/` — Python venv for BrowserUse (git-ignored).
- `/desktop/.env` — Gemini key + Supabase credentials, git-ignored.
- `/backend/src/core/vault/` — credential vault (AES-256-GCM).
- `/backend/src/core/mcp/` — MCP OAuth tokens (vault-backed).
- `/backend/src/native/win32/` — Windows native modules (not portable).

### Build notes

- Backend compiles with `tsc` (ES2022 target, CommonJS module, strict mode).
- The Rust mesh daemon is built with `cargo build --release` from `backend/mesh/`.
- Desktop uses Vite 8 with React 19, TypeScript 6.0, and Electron 43.

---

*Note: An existing `AGENTS.md` lives in `backend/` — it is specific to Chrome Extension development. This root-level file is the general onboarding document for the whole project.*

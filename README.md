# Umbra OS

Invisible AI computer assistant for Windows.

## Project Structure

```
umbra-os/
├── backend/          # Node.js/TypeScript backend (API server, AI, voice, P2P, etc.)
├── desktop/          # React + Vite + Electron desktop app
├── package.json      # Root workspace scripts
└── README.md
```

## Quick Start

```bash
# Install dependencies
cd backend && npm install
cd ../desktop && npm install

# Development (backend + desktop)
cd .. && npm run dev

# Build for production
npm run build
```

## Backend

The backend runs on port 8787 and provides:
- AI agent runtime (LLM routing, task planning, execution)
- Voice stack (STT/TTS, noise cancellation, gesture detection)
- P2P mesh networking (device pairing, encrypted channels)
- Smart home integration (SmartThings)
- Meeting companion
- Knowledge graph + recall
- Credential vault
- Billing + metering

## Desktop

The desktop app is a React 19 + Vite 8 + Electron 43 app with:
- AI chat interface
- Smart home dashboard
- Voice controls
- Meeting companion
- Skills marketplace
- Settings + configuration

## AI Agents

This repository publishes machine-readable discovery files for AI systems (crawlers, citation engines, and browsing agents):

- **[llms.txt](llms.txt)** — project overview, architecture, key features, tech stack, API endpoints, configuration, and contributing guide (the canonical AI-discovery entry point; [llms-txt.org](https://llms-txt.org))
- **[llms-full.txt](llms-full.txt)** — complete project documentation: README, full API contract, configuration reference, cloud setup, and cloud deployment guides
- **[robots.txt](robots.txt)** — crawler access policy (AI crawlers allowed; sensitive paths `/api`, `/vault`, `/mesh` disallowed)
- **[.well-known/ai.txt](.well-known/ai.txt)** — short AI agent discovery file pointing to llms.txt
- **[AGENTS.md](AGENTS.md)** — 5-step onboarding for AI coding agents (Claude Code, etc.)

The backend exposes a REST + WebSocket API at `http://127.0.0.1:8787` (loopback only). See [llms-full.txt](llms-full.txt) for the complete API contract. The MCP JSON-RPC endpoint is available at `POST http://127.0.0.1:8787/mcp`.

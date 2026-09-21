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

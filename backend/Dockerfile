# Umbra OS — cloud (always-on) runtime.
#
# Runs the headless core: API server, agent loop, MCP connectors, persistent
# memory, model routing/billing. Desktop control (mouse/keyboard/OCR) still
# requires the Windows machine — see docs/cloud-deploy.md.
#
# Hermes Agent is installed as the dedicated reasoning engine for agentic tasks.

FROM node:20-bookworm-slim

WORKDIR /app

# ── System deps for Hermes Agent + headless browser (Chromium) ────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates python3 python3-pip python3-venv \
    chromium \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# ── Install Hermes Agent CLI ───────────────────────────────────────────────
# Hermes is a Python-based agentic CLI that handles tool calling, code execution,
# browser automation, MCP server delegation, and persistent memory.
# The install is best-effort — cloud falls back to the in-process agent loop
# (AgentRuntime.inProcessAgent with browserAction/desktopAction) when the binary
# is absent, so the image still builds. On the Windows desktop the in-process
# fallback already handles browser+app control without an external binary.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash || echo "Hermes install skipped — in-process agent will be used (browser+desktop tools wired)"

# Ensure hermes is on PATH for all users (when installed)
ENV PATH="/root/.hermes/bin:/root/.hermes-agent/bin:${PATH}"

# ── Node.js app ────────────────────────────────────────────────────────────
# better-sqlite3 ships prebuilt Linux x64 binaries; install deps first to cache.
COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json jest.config.js ./
COPY src ./src
RUN npm run build

# ── Runtime config ─────────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV UMBRA_HEADLESS=1
ENV UMBRA_ROLE=cloud
# Unattended cloud node: tasks already consent-approved on the PC resume
# without re-prompting; new cloud tasks run without an interactive prompt.
ENV UMBRA_CONSENT_AUTOGRANT=1
# Hermes auto-accepts hooks (non-interactive cloud mode)
ENV HERMES_ACCEPT_HOOKS=1

EXPOSE 8787 8788

CMD ["node", "dist/index.js"]

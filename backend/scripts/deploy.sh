#!/usr/bin/env bash
# Deploy Umbra OS to the cloud VPS.
# Usage: HOST=user@1.2.3.4 OPENROUTER_API_KEY=sk-or-v1-xxx ./scripts/deploy.sh
set -euo pipefail

HOST="${HOST:-}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
UMBRA_PUBLIC_URL="${UMBRA_PUBLIC_URL:-}"

if [ -z "$HOST" ]; then
  echo "Set HOST=user@your-vps ./scripts/deploy.sh" >&2
  exit 1
fi

if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "Set OPENROUTER_API_KEY=sk-or-v1-xxx ./scripts/deploy.sh" >&2
  exit 1
fi

echo "→ Building the image locally (with Hermes Agent)…"
docker build -t umbra-os:latest .

echo "→ Shipping to $HOST…"
docker save umbra-os:latest | gzip | ssh "$HOST" 'gunzip | docker load'

echo "→ Creating Hermes config on server…"
ssh "$HOST" 'mkdir -p ~/umbra ~/.hermes'
ssh "$HOST" "cat > ~/.hermes/config.yaml << 'HERMES_EOF'
model:
  default: \"deepseek/deepseek-chat\"
  provider: \"openrouter\"
  base_url: \"https://openrouter.ai/api/v1\"

terminal:
  backend: \"local\"
  cwd: \".\"
  timeout: 180

compression:
  enabled: true

mcp_servers:
  umbra:
    url: http://127.0.0.1:8787/mcp
    connect_timeout: 10
HERMES_EOF"

echo "→ Writing .env with OpenRouter key…"
ssh "$HOST" "cat > ~/.hermes/.env << 'ENV_EOF'
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
ENV_EOF"

echo "→ Starting via docker-compose on the server…"
scp docker-compose.yml "$HOST":~/umbra/docker-compose.yml
scp -r deploy "$HOST":~/umbra/   # Caddyfile + turnserver.conf for the edge profile

# Build the env file for docker-compose
ENV_FILE="UMBRA_PUBLIC_URL=${UMBRA_PUBLIC_URL:-https://localhost}
OPENROUTER_API_KEY=$OPENROUTER_API_KEY"
echo "$ENV_FILE" | ssh "$HOST" 'cat > ~/umbra/.env'

ssh "$HOST" 'cd ~/umbra && docker compose up -d --remove-orphans'

echo "✓ Deployed. Hermes Agent is installed and configured."
echo "  API: http://<server-ip>:8787/api/health"
echo "  Hermes: runs inside the container with OpenRouter"
echo "  Phone: open https://<your-domain> to connect"

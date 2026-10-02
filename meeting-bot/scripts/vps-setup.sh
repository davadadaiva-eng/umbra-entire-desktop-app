#!/bin/bash
# One-shot bootstrap for a fresh Ubuntu 22.04/24.04 cloud VPS.
# Installs Docker, builds the meeting-bot image, downloads models,
# and runs the smoke test. Safe to re-run (idempotent).
set -euo pipefail

cd "$(dirname "$0")/.."   # meeting-bot/ root

echo "=== [1/6] Docker ==="
if docker info >/dev/null 2>&1; then
    echo "Docker already running."
else
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    # Let the daemon settle
    for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
docker compose version

# Daemon-wide log rotation default so ANY container on this VPS (this stack
# or not) can never fill the disk with json-file logs. Merge-safe: keeps
# existing daemon.json settings and respects admin-configured drivers.
if [ "$(id -u)" -eq 0 ]; then
    if out="$(python3 scripts/configure_docker_logs.py)"; then
        echo "$out"
        case "$out" in
            Updated*)
                echo "Restarting docker to apply log-rotation defaults..."
                systemctl restart docker
                for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
                ;;
        esac
    else
        echo "$out"
        echo "Note: existing Docker log configuration left untouched."
    fi
else
    echo "Skipping daemon log-rotation setup (not root; re-run as root to apply)."
fi

echo "=== [2/6] Environment ==="
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    echo "Created .env from template."
    echo ">>> EDIT IT NOW:  nano .env   (set LLM_API_KEY, optionally API_TOKEN)"
    echo ">>> Then re-run this script to continue."
    if grep -q "^LLM_API_KEY=$" .env; then
        exit 0
    fi
else
    echo ".env already present."
fi

# Advisory: with a public DOMAIN configured, Caddy needs 80+443 reachable.
if grep -qE '^DOMAIN=[^[:space:]]+' .env 2>/dev/null; then
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        echo "Note: DOMAIN is set and ufw is active. Allow the proxy through:"
        echo "  ufw allow 80,443/tcp        # keep 8000 closed (loopback only)"
    fi
fi

# If the proxy profile is enabled, validate the Caddyfile before bringing
# the stack up (--no-deps: meeting-bot is not needed for validation).
if grep -qE '^COMPOSE_PROFILES=.*proxy' .env 2>/dev/null; then
    echo "Validating Caddyfile (profile 'proxy' is enabled)..."
    if docker compose run --rm --no-deps caddy \
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
        echo "Caddyfile OK."
    else
        echo "ERROR: Caddyfile validation failed - check DOMAIN in .env"
        exit 1
    fi
fi

echo "=== [3/6] Building image ==="
docker compose build

echo "=== [4/6] Downloading models (Whisper + Piper voice) ==="
docker compose run --rm meeting-bot /app/scripts/download_models.sh

echo "=== [5/6] Smoke test (audio graph, TTS, STT, brain) ==="
# STT model may already be cached from step 4 (FREE plan preloads 'base').
docker compose run --rm meeting-bot python /app/scripts/smoke_test.py

echo "=== [6/6] Auto-start on boot (systemd unit) ==="
if [ "$(id -u)" -eq 0 ]; then
    bash scripts/install-systemd.sh
else
    echo "Skipping (not root). Enable boot auto-start afterwards with:"
    echo "  sudo bash scripts/install-systemd.sh"
fi

echo ""
echo "All set. Start the bot with:   docker compose up -d"
echo "Check it:                      curl localhost:8000/health"
echo "Join a meeting:                see README.md (curl example)"
echo "Boot auto-start:               systemctl status meeting-bot"

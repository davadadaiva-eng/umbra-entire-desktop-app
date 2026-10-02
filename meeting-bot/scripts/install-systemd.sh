#!/bin/bash
# Install a systemd unit that brings the meeting-bot compose stack up at
# boot and keeps it running. Idempotent: safe to re-run to refresh settings.
#
# Usage:
#   bash scripts/install-systemd.sh           # install + enable
#   bash scripts/install-systemd.sh --print   # show the unit file, install nothing
#
# Install requires root: writes /etc/systemd/system/meeting-bot.service.

set -euo pipefail

cd "$(dirname "$0")/.."   # meeting-bot/ root

# Locate the compose binary and bake its absolute path into the unit so the
# unit works regardless of the (minimal) PATH systemd provides.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE_PATH="$(command -v docker)"
elif [ -x /usr/libexec/docker/cli-plugins/docker-compose ]; then
    COMPOSE_PATH="/usr/libexec/docker/cli-plugins/docker-compose"   # get.docker.com default
elif [ -x /usr/lib/docker/cli-plugins/docker-compose ]; then
    COMPOSE_PATH="/usr/lib/docker/cli-plugins/docker-compose"
else
    if [ "${1:-}" = "--print" ]; then
        COMPOSE_PATH="/usr/bin/docker"   # placeholder for preview mode
    else
        echo "ERROR: docker compose plugin not found" >&2
        exit 1
    fi
fi

UNIT="$(cat <<EOF
[Unit]
Description=Meeting bot (docker compose stack)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$(pwd)
# Wait for the docker daemon (up to ~60s) before composing up
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 30); do docker info >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'
ExecStart=${COMPOSE_PATH} compose up -d
ExecStop=${COMPOSE_PATH} compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF
)"

MAINT_SERVICE="$(cat <<EOF
[Unit]
Description=Meeting bot nightly maintenance (pull, prune, disk report)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$(pwd)
ExecStart=/bin/bash $(pwd)/scripts/vps-maintenance.sh
TimeoutStartSec=600
EOF
)"

MAINT_TIMER="[Unit]
Description=Run meeting-bot maintenance nightly

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
"

if [ "${1:-}" = "--print" ]; then
    printf '\n===== meeting-bot.service =====\n'
    printf '%s\n' "$UNIT"
    printf '\n===== meeting-bot-maintenance.service =====\n'
    printf '%s\n' "$MAINT_SERVICE"
    printf '\n===== meeting-bot-maintenance.timer =====\n'
    printf '%s\n' "$MAINT_TIMER"
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "Root required to install the unit. Re-run with sudo:" >&2
    echo "  sudo bash scripts/install-systemd.sh" >&2
    exit 1
fi

printf '%s\n' "$UNIT" > /etc/systemd/system/meeting-bot.service
printf '%s\n' "$MAINT_SERVICE" > /etc/systemd/system/meeting-bot-maintenance.service
printf '%s\n' "$MAINT_TIMER" > /etc/systemd/system/meeting-bot-maintenance.timer
systemctl daemon-reload
systemctl enable --now meeting-bot.service
systemctl enable --now meeting-bot-maintenance.timer

echo "Installed and enabled:"
echo "  meeting-bot.service                  (stack up at boot)"
echo "  meeting-bot-maintenance.timer        (nightly 04:00 +15m: pull/prune/report)"
echo ""
echo "Useful commands:"
echo "  systemctl status meeting-bot     # state of the stack"
echo "  systemctl list-timers meeting-bot-maintenance.timer  # next nightly run"
echo "  sudo systemctl stop meeting-bot  # tears the stack down (compose down)"
echo "  sudo systemctl start meeting-bot # brings it back up"
echo "  sudo bash scripts/vps-maintenance.sh                 # run maintenance now"
echo ""
echo "Note: manage the stack through this unit. If you run"
echo "'docker compose down/up' by hand the unit keeps reporting active(exited);"
echo "re-run 'sudo systemctl restart meeting-bot' to resync."

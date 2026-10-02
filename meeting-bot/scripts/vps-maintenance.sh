#!/bin/bash
# Nightly VPS housekeeping for the meeting-bot stack.
#   - refreshes the Caddy image (the only pulled image; meeting-bot is built)
#   - prunes dangling build cache / stopped containers / unused networks
#   - caps the journald footprint
#   - reports disk usage + top log files
#
# Runs unattended via the meeting-bot-maintenance.timer installed by
# scripts/install-systemd.sh. Concurrency-safe via flock.

set -euo pipefail

cd "$(dirname "$0")/.."   # meeting-bot/ root

# Serialize overlapping runs (timer + manual run). /run is root-writable;
# fall back to /tmp so the script also works when run by hand.
LOCK_DIR=/run
[ -w /run ] || LOCK_DIR=/tmp
exec 9>"$LOCK_DIR/meeting-bot-maintenance.lock"
flock -n 9 || { echo "Another maintenance run is in progress; skipping."; exit 0; }

log() { echo "[maintenance $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "starting"

# 1. Pull newer images (no-op when everything is current)
docker compose pull --ignore-buildable || log "WARN: pull failed (offline?)"

# 2. Recreate if pulled images changed anything (usually a no-op)
docker compose up -d --remove-orphans || log "WARN: up failed"

# 3. Prune: dangling images/build cache, stopped containers, unused networks
#    (--volumes NOT used: model volumes are precious, tiny, and not reclaimable)
docker container prune -f >/dev/null
docker network prune -f >/dev/null
docker image prune -f >/dev/null

# 4. Cap the systemd journal (VPS disks are small; default caps are huge)
journalctl --vacuum-size=100M >/dev/null 2>&1 || true

# 5. Report
log "disk usage:"
df -h / | tail -n +2
log "docker disk usage:"
docker system df || true
log "top container log files:"
du -ah /var/lib/docker/containers/ 2>/dev/null | grep -E '\-json\.log$' | sort -rh | head -5 || true

log "done"

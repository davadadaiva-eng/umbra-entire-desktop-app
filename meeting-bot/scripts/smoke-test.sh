#!/bin/bash
# Build the meeting-bot image and run the end-to-end smoke test in a container.
set -euo pipefail

cd "$(dirname "$0")/.."   # meeting-bot/ root

STT_FLAG=""
EXTRA_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --skip-stt) STT_FLAG="--skip-stt" ;;
    esac
done

echo "=== Building meeting-bot image (this can take a few minutes) ==="
docker compose build

echo ""
echo "=== Running smoke test ==="
# The entrypoint sets up Xvfb + PulseAudio + virtual devices, then execs the
# command given as CMD/args instead of starting the bot server.
docker compose run --rm \
    -e SMOKE_ARGS="${STT_FLAG}" \
    meeting-bot \
    python /app/scripts/smoke_test.py ${STT_FLAG}

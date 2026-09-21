#!/usr/bin/env bash
# Start the Faster-Whisper STT server for Umbra OS.
#
# Usage: npm run whisper:stt-server
# Default port: 17510 (env: FASTER_WHISPER_PORT)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"

# Check for faster-whisper
if ! "$PYTHON" -c "import faster_whisper" 2>/dev/null; then
  echo "[STT] Installing faster-whisper..."
  "$PYTHON" -m pip install --quiet faster-whisper 2>&1 | tail -1
fi

exec "$PYTHON" "$SCRIPT_DIR/faster-whisper-stt-server.py" "$@"

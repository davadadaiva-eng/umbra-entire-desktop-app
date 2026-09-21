#!/usr/bin/env bash
# Start the Piper TTS server for Umbra OS.
#
# Usage: npm run piper:tts-server
# Default port: 17520 (env: PIPER_PORT)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"

# Check for piper-tts
if ! "$PYTHON" -c "import piper" 2>/dev/null; then
  # Also check if piper binary is on PATH
  if ! command -v piper &>/dev/null; then
    echo "[TTS] Installing piper-tts..."
    "$PYTHON" -m pip install --quiet piper-tts 2>&1 | tail -1
  fi
fi

exec "$PYTHON" "$SCRIPT_DIR/piper-tts-server.py" "$@"

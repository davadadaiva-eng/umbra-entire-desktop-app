#!/usr/bin/env bash
# Launch the lightweight Whisper-ASR diarization server for Umbra.
#
#   npm run whisper:asr-server [-- --model small --port 17501]
#
# Uses faster-whisper (small) + speechbrain ECAPA embeddings (~520 MB total,
# fully ungated — no Hugging Face token). Models download on first load.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR/../external/VibeVoice"

if [ ! -d "$REPO_DIR" ]; then
  echo "[ERROR] VibeVoice repo not found at $REPO_DIR"
  echo "        Clone it first: git clone https://github.com/microsoft/VibeVoice.git external/VibeVoice"
  exit 1
fi

if [ -f "$REPO_DIR/.venv/Scripts/activate" ]; then
  # shellcheck disable=SC1091
  source "$REPO_DIR/.venv/Scripts/activate"
elif [ -f "$REPO_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$REPO_DIR/.venv/bin/activate"
else
  echo "[ERROR] No .venv found in $REPO_DIR — run 'npm run vibevoice:install' first"
  exit 1
fi

exec python "$SCRIPT_DIR/whisper-asr-server.py" "$@"

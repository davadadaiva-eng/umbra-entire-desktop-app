#!/usr/bin/env bash
# Wait for the VibeVoice-ASR server to become ready, then transcribe audio.
#
#   npm run vibevoice:asr-transcribe -- /path/to/audio.wav
#
# The server answers /health immediately and flips to `ready` once the model
# finishes its first (~17 GB) download; this blocks until then and prints the
# speaker-labeled segments.
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

export PYTHONIOENCODING=utf-8
exec python "$SCRIPT_DIR/vibevoice_asr_transcribe.py" "$@"

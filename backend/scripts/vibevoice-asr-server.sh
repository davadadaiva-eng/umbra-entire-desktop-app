#!/usr/bin/env bash
# Launch the VibeVoice-ASR diarization server for Umbra.
#
#   npm run vibevoice:asr-server [-- --device cuda --port 17500]
#
# The VibeVoice repo must be cloned at external/VibeVoice and its venv built
# (npm run vibevoice:install). The model (microsoft/VibeVoice-ASR, ~17 GB)
# downloads from Hugging Face on first load — a GPU is strongly recommended.
# Pre-download it with 'npm run vibevoice:asr-download'.
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

exec python "$SCRIPT_DIR/vibevoice-asr-server.py" "$@"

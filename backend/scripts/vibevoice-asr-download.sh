#!/usr/bin/env bash
# Pre-download the VibeVoice-ASR model (microsoft/VibeVoice-ASR, ~17 GB) into
# the Hugging Face cache so the ASR server doesn't download on first load.
#
#   npm run vibevoice:asr-download
#
# Safe to interrupt and re-run: downloads resume from cached .incomplete blobs.
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

# Force the plain HTTP downloader (Xet and hf_transfer stall on some links).
export HF_HUB_DISABLE_XET=1
export HF_HUB_ENABLE_HF_TRANSFER=0
export PYTHONIOENCODING=utf-8

exec python "$SCRIPT_DIR/vibevoice_asr_download.py" "$@"

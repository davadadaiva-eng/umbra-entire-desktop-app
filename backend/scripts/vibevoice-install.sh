#!/usr/bin/env bash
# Set up Microsoft VibeVoice (cloned at external/VibeVoice) in a local venv.
#
#   npm run vibevoice:install
#
# Requirements: Python 3.10+ (with a GPU strongly recommended — torch + CUDA).
# The model weights (microsoft/VibeVoice-Realtime-0.5B, ~2 GB) are downloaded
# from Hugging Face the first time Umbra synthesizes speech, not here.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR/../external/VibeVoice"

if [ ! -d "$REPO_DIR" ]; then
  echo "[ERROR] VibeVoice repo not found at $REPO_DIR"
  echo "        Clone it first: git clone https://github.com/microsoft/VibeVoice.git external/VibeVoice"
  exit 1
fi

cd "$REPO_DIR"

# VibeVoice needs Python 3.10+. Prefer the launcher (py -3.12/3.11/3.10), then
# whatever `python3` resolves to; reject anything older than 3.10 with a hint.
PYTHON_BIN="${PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  for ver in 3.14 3.13 3.12 3.11 3.10; do
    if command -v "py" >/dev/null 2>&1 && py -"$ver" -c 'import sys' >/dev/null 2>&1; then
      PYTHON_BIN="py -$ver"
      break
    fi
    if command -v "python$ver" >/dev/null 2>&1; then
      PYTHON_BIN="python$ver"
      break
    fi
  done
  if [ -z "$PYTHON_BIN" ]; then
    PYTHON_BIN="python"
  fi
  # shellcheck disable=SC2086
  if ! $PYTHON_BIN -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
    echo "[ERROR] VibeVoice needs Python 3.10+. Found a too-old default python."
    echo "        Install Python 3.10+ (https://www.python.org/downloads/) and re-run, or"
    echo "        set PYTHON to a modern interpreter, e.g.: PYTHON='py -3.12' npm run vibevoice:install"
    exit 1
  fi
fi

if [ ! -d .venv ]; then
  echo "[INFO] Creating Python venv with: $PYTHON_BIN"
  # shellcheck disable=SC2086
  $PYTHON_BIN -m venv .venv
fi

if [ -f .venv/Scripts/activate ]; then
  # shellcheck disable=SC1091
  source .venv/Scripts/activate
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

echo "[INFO] Upgrading pip..."
pip install --upgrade pip

echo "[INFO] Installing VibeVoice (+ torch, transformers, diffusers)... this can take a while"
pip install -e ".[streamingtts]"

echo ""
echo "[SUCCESS] VibeVoice installed."
echo "         Optional: more experimental speakers →  bash demo/download_experimental_voices.sh"
echo "         Then set meeting.tts = \"vibevoice\" (or call POST /api/voice/speak) and start Umbra."

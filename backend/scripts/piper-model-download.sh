#!/usr/bin/env bash
# Download Piper TTS voice model for Umbra OS.
#
# Usage: bash piper-model-download.sh [voice]
# Example: bash piper-model-download.sh it_IT-riccardo-medium
#
# Downloads the .onnx model + config JSON from GitHub releases to ~/.piper/models/
set -euo pipefail

VOICE="${1:-it_IT-riccardo-medium}"
DEST="${PIPER_DIR:-$HOME/.piper/models}"
VERSION="${PIPER_VERSION:-v2.0.0}"

mkdir -p "$DEST"

echo "[piper] Downloading voice: $VOICE"
echo "[piper] Destination: $DEST"

# Piper voice models are hosted on HuggingFace (rhasspy/piper-voices)
BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"

# Download model file
echo "[piper] Downloading ${VOICE}.onnx..."
curl -fSL --retry 3 --retry-delay 5 \
  "${BASE_URL}/${VOICE}/${VERSION}/${VOICE}.onnx" \
  -o "${DEST}/${VOICE}.onnx" || {
    echo "[piper] ERROR: Failed to download ${VOICE}.onnx" >&2
    echo "[piper] Check the voice name at: https://huggingface.co/rhasspy/piper-voices/tree/main" >&2
    exit 1
  }

# Download config JSON
echo "[piper] Downloading ${VOICE}.onnx.json..."
curl -fSL --retry 3 --retry-delay 5 \
  "${BASE_URL}/${VOICE}/${VERSION}/${VOICE}.onnx.json" \
  -o "${DEST}/${VOICE}.onnx.json" || {
    echo "[piper] WARNING: Failed to download config JSON (model may still work)"
  }

# Verify
if [ -f "${DEST}/${VOICE}.onnx" ]; then
  SIZE=$(stat -f%z "${DEST}/${VOICE}.onnx" 2>/dev/null || stat -c%s "${DEST}/${VOICE}.onnx" 2>/dev/null)
  echo "[piper] Downloaded: ${VOICE}.onnx (${SIZE} bytes)"
  echo "[piper] Voice ready at: ${DEST}/${VOICE}.onnx"
else
  echo "[piper] ERROR: Download failed" >&2
  exit 1
fi

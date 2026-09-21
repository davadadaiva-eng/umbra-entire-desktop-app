#!/bin/bash
set -euo pipefail

echo "=== Downloading faster-whisper base model ==="
python3 -c "
from faster_whisper import WhisperModel
print('Downloading faster-whisper base model ...')
WhisperModel('base', device='cpu', compute_type='int8')
print('Done.')
"

echo ""
echo "=== Downloading Piper Italian voice (it_IT-riccardo-x_low) ==="
PIPER_DIR="${HOME}/.piper/models"
mkdir -p "${PIPER_DIR}"

VOICE="it_IT-riccardo-x_low"
VOICE_DIR="${PIPER_DIR}/${VOICE}"

if [ -d "${VOICE_DIR}" ]; then
    echo "Voice already exists at ${VOICE_DIR}; skipping."
else
    mkdir -p "${VOICE_DIR}"
    curl -sL "https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx" \
        -o "${VOICE_DIR}/${VOICE}.onnx"
    curl -sL "https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx.json" \
        -o "${VOICE_DIR}/${VOICE}.onnx.json"
    echo "Voice downloaded to ${VOICE_DIR}"
fi

echo ""
echo "=== All models downloaded ==="

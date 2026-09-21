#!/usr/bin/env bash
# Pre-download a faster-whisper model to a local directory via curl.
#
#   npm run whisper:model-download [-- base]
#
# Why curl: on slow/flaky links the huggingface_hub downloader stalls on large
# blobs, but curl's --retry + -C - resume keeps making progress. faster-whisper
# accepts a local directory as `--model`, so this sidesteps the stall entirely.
#
# Files land in external/VibeVoice/models/faster-whisper-<MODEL>.
set -euo pipefail

MODEL="${1:-base}"
REPO="Systran/faster-whisper-$MODEL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$SCRIPT_DIR/../external/VibeVoice/models/faster-whisper-$MODEL"

FILES=(config.json model.bin tokenizer.json vocabulary.txt)

mkdir -p "$DEST"
echo "[whisper-model] downloading $REPO -> $DEST"

for f in "${FILES[@]}"; do
  url="https://huggingface.co/$REPO/resolve/main/$f"
  out="$DEST/$f"
  # curl -C - resumes an existing partial file; on a fresh file it starts at 0.
  # Exit code 33 ("requested range not satisfiable") means the file is already
  # complete — treat that as success so re-runs are idempotent.
  curl -sSL --retry 999 --retry-all-errors --retry-delay 5 -C - -o "$out" "$url"
  code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 33 ]; then
    echo "[whisper-model] FAILED: $f (curl exit $code)" >&2
    exit "$code"
  fi
  echo "[whisper-model] $f -> $(stat -c%s "$out" 2>/dev/null || echo 0) bytes"
done

echo "[whisper-model] DONE: $DEST"
echo "Start the server with: npm run whisper:asr-server -- --model \"$DEST\""

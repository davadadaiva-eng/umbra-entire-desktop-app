#!/usr/bin/env bash
# Download a whisper.cpp ggml model into ./models for the local STT server.
#
# Accuracy vs RAM (from whisper.cpp README):
#   tiny   75 MiB   ~273 MB   — misses words (demo only)
#   base  142 MiB   ~388 MB   — ok for clear, slow speech
#   small 466 MiB   ~852 MB   — good accuracy, fits a 4 GB box
#   medium 1.5 GiB  ~2.1 GB   — strong accuracy, "doesn't miss words"
#   large  2.9 GiB  ~3.9 GB   — best, needs ~8 GB RAM
#
# Usage: MODEL=medium.en ./scripts/download-whisper-model.sh
set -euo pipefail

MODEL="${MODEL:-medium.en}"
mkdir -p models
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin"

echo "→ Downloading ggml-${MODEL}.bin…"
if command -v curl >/dev/null 2>&1; then
  curl -L --fail --progress-bar -o "models/ggml-${MODEL}.bin" "$URL"
else
  wget -O "models/ggml-${MODEL}.bin" "$URL"
fi

echo "✓ models/ggml-${MODEL}.bin ready"
echo "  Run the whisper.cpp server: docker compose up whisper (or ./whisper-server -m models/ggml-${MODEL}.bin --host 0.0.0.0 --port 8080)"

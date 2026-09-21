#!/usr/bin/env bash
# Start a small, free local LLM for Umbra — everything lives inside the
# Umbra folder (.local-model/), no installers, no Docker, no API keys.
#
#   ./scripts/start-local-model.sh
#
# Serves an OpenAI-compatible API on http://127.0.0.1:8080/v1. Point Umbra's
# free-model slot at it (see the printed snippet) and tasks run locally.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.local-model"
mkdir -p "$DIR"

# Swap these to use a different (larger = smarter) model.
MODEL_REPO="${MODEL_REPO:-Qwen/Qwen2.5-0.5B-Instruct-GGUF}"
MODEL_FILE="${MODEL_FILE:-qwen2.5-0.5b-instruct-q4_k_m.gguf}"
LLAMA_ZIP_URL="https://github.com/ggml-org/llama.cpp/releases/download/b10431/llama-b10431-bin-win-cpu-x64.zip"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"

# 1) llama.cpp prebuilt binary
if [ ! -f "$DIR/llama-server.exe" ] && [ ! -f "$DIR/llama-server" ]; then
  echo "→ Downloading llama.cpp (prebuilt)…"
  curl -sL -o "$DIR/llama.zip" "$LLAMA_ZIP_URL"
  (cd "$DIR" && unzip -oq llama.zip)
fi

# 2) GGUF model (resumable download)
if [ ! -f "$DIR/$MODEL_FILE" ]; then
  echo "→ Downloading $MODEL_FILE (resumable; re-run to continue)…"
  curl -sL -C - -o "$DIR/$MODEL_FILE" "https://huggingface.co/$MODEL_REPO/resolve/main/$MODEL_FILE"
fi

SRV="$DIR/llama-server.exe"
[ -f "$SRV" ] || SRV="$DIR/llama-server"

echo ""
echo "→ Starting llama-server on http://$HOST:$PORT (model: $MODEL_FILE)"
echo "→ In ~/.umbra/config.json set:"
echo '    "provider": "openai-compatible",'
echo '    "openaiCompatible": { "endpoint": "http://127.0.0.1:8080/v1", "apiKey": "" },'
echo '    "models": { "fast": "qwen2.5-0.5b-instruct", "reasoning": "qwen2.5-0.5b-instruct", "vision": "qwen2.5-0.5b-instruct" }'
echo ""
exec "$SRV" -m "$DIR/$MODEL_FILE" --host "$HOST" --port "$PORT" --ctx-size 4096

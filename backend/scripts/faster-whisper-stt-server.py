#!/usr/bin/env python3
"""
Faster-Whisper STT server for Umbra OS.

Lightweight, CPU-only speech-to-text using faster-whisper (base model, int8).
Default language: Italian (it). Fully offline after first model download.

API:
  GET  /health      -> {"ok", "state": "loading|ready|error", "model", "device", "language", "error"}
  POST /transcribe  -> multipart "audio" + optional "language" (default "it")
                       -> {"text", "language", "model", "duration_ms"}

Run via: npm run whisper:stt-server
Configure with: voice.sttProvider = "faster-whisper", voice.fasterWhisperUrl
"""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "120")

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(title="Faster-Whisper STT for Umbra OS")

MODEL_NAME = os.environ.get("FASTER_WHISPER_MODEL", "base")
DEVICE = os.environ.get("FASTER_WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("FASTER_WHISPER_COMPUTE", "int8")
DEFAULT_LANGUAGE = os.environ.get("FASTER_WHISPER_LANGUAGE", "it")

STATE = {
    "model": MODEL_NAME,
    "device": DEVICE,
    "language": DEFAULT_LANGUAGE,
    "state": "loading",
    "whisper": None,
    "error": None,
}
_LOCK = threading.Lock()


def load_model():
    """Load faster-whisper model in background thread."""
    try:
        from faster_whisper import WhisperModel

        print(f"[STT] Loading faster-whisper model: {MODEL_NAME} ({COMPUTE_TYPE} on {DEVICE})")
        model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
        with _LOCK:
            STATE["whisper"] = model
            STATE["state"] = "ready"
        print(f"[STT] Model ready: {MODEL_NAME}")
    except Exception as e:
        with _LOCK:
            STATE["state"] = "error"
            STATE["error"] = str(e)
        print(f"[STT] Model load failed: {e}", file=sys.stderr)


@app.on_event("startup")
async def startup():
    threading.Thread(target=load_model, daemon=True).start()


@app.get("/health")
async def health():
    return {
        "ok": STATE["state"] == "ready",
        "state": STATE["state"],
        "model": STATE["model"],
        "device": STATE["device"],
        "language": STATE["language"],
        "error": STATE["error"],
    }


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str = Form(default=""),
):
    if STATE["state"] != "ready":
        return JSONResponse(
            status_code=503,
            content={"error": f"Model not ready (state={STATE['state']})", "text": ""},
        )

    lang = language.strip() or DEFAULT_LANGUAGE
    start_time = time.time()

    try:
        # Read audio into temp file (faster-whisper needs a file path)
        audio_bytes = await audio.read()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            segments, info = STATE["whisper"].transcribe(
                tmp_path,
                language=lang if lang else None,
                beam_size=1,           # Greedy for speed
                temperature=0.0,       # Deterministic
                vad_filter=True,       # Skip silence
            )

            text_parts = []
            for segment in segments:
                text_parts.append(segment.text.strip())

            text = " ".join(text_parts).strip()
            elapsed_ms = int((time.time() - start_time) * 1000)

            return {
                "text": text,
                "language": info.language if info else lang,
                "model": MODEL_NAME,
                "duration_ms": elapsed_ms,
            }
        finally:
            os.unlink(tmp_path)

    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "text": ""},
        )


if __name__ == "__main__":
    port = int(os.environ.get("FASTER_WHISPER_PORT", "17510"))
    print(f"[STT] Starting Faster-Whisper STT server on port {port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

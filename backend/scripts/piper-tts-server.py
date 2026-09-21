#!/usr/bin/env python3
"""
Piper TTS server for Umbra OS.

Local, offline text-to-speech using Piper TTS CLI.
Default voice: it_IT-riccardo-medium (Italian).

API:
  GET  /health      -> {"ok", "state": "ready|error", "voice", "device", "error"}
  GET  /voices      -> [{"id", "language", "name", "gender", "file"}]
  POST /speak       -> JSON {"text", "voice"?} -> WAV audio bytes (Content-Type: audio/wav)
  POST /speak/file  -> JSON {"text", "voice"?, "output_path"} -> {"ok", "path"}

Run via: npm run piper:tts-server
Configure with: voice.ttsProvider = "piper", voice.piperUrl, voice.piperVoice
"""
import os
import sys
import subprocess
import tempfile
import glob
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="Piper TTS for Umbra OS")

PIPER_DIR = os.environ.get("PIPER_DIR", str(Path.home() / ".piper" / "models"))
DEFAULT_VOICE = os.environ.get("PIPER_VOICE", "it_IT-riccardo-medium")
PIPER_BIN = os.environ.get("PIPER_BIN", "piper")

STATE = {
    "voice": DEFAULT_VOICE,
    "device": "cpu",
    "state": "loading",
    "error": None,
    "piper_bin": None,
}


def find_piper():
    """Locate the piper binary."""
    # Check common locations
    candidates = [
        PIPER_BIN,
        "piper",
        str(Path.home() / ".local" / "bin" / "piper"),
        str(Path(__file__).parent.parent / "external" / "piper" / "piper"),
        # Python package entry point
        sys.executable and subprocess.run(
            [sys.executable, "-m", "piper", "--help"],
            capture_output=True, timeout=5
        ) and sys.executable,
    ]

    for candidate in candidates:
        if not candidate:
            continue
        try:
            result = subprocess.run(
                [candidate, "--help"],
                capture_output=True, timeout=5
            )
            if result.returncode == 0 or b"piper" in result.stdout.lower() + result.stderr.lower():
                return candidate
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue

    return None


def list_voices():
    """List available Piper voice models in the models directory."""
    voices = []
    models_dir = Path(PIPER_DIR)
    if not models_dir.exists():
        return voices

    for onnx_file in models_dir.glob("*.onnx"):
        voice_id = onnx_file.stem
        # Parse voice ID: e.g. "it_IT-riccardo-medium" -> language="it", name="riccardo", gender="medium"
        parts = voice_id.split("-", 2)
        lang = parts[0] if len(parts) > 0 else "unknown"
        name = parts[1] if len(parts) > 1 else voice_id
        gender = parts[2] if len(parts) > 2 else "unknown"

        # Check for config JSON
        config_file = onnx_file.with_suffix(".onnx.json")
        if not config_file.exists():
            config_file = onnx_file.parent / f"{voice_id}.onnx.json"

        voices.append({
            "id": voice_id,
            "language": lang.split("_")[0] if "_" in lang else lang,
            "name": name.title(),
            "gender": gender.title(),
            "file": str(onnx_file),
            "has_config": config_file.exists(),
        })

    return voices


@app.on_event("startup")
async def startup():
    piper_bin = find_piper()
    if piper_bin:
        STATE["piper_bin"] = piper_bin
        STATE["state"] = "ready"
        print(f"[TTS] Piper binary found: {piper_bin}")
        voices = list_voices()
        print(f"[TTS] Available voices: {[v['id'] for v in voices]}")
        if not voices:
            print(f"[TTS] No voice models found in {PIPER_DIR}")
            print(f"[TTS] Run: npm run piper:model-download")
    else:
        STATE["state"] = "error"
        STATE["error"] = "Piper binary not found. Install with: pip install piper-tts"
        print(f"[TTS] {STATE['error']}", file=sys.stderr)


class SpeakRequest(BaseModel):
    text: str
    voice: str = ""
    speaker_id: int = 0
    length_scale: float = 1.0
    noise_scale: float = 0.667
    noise_w: float = 0.8


class SpeakFileRequest(BaseModel):
    text: str
    voice: str = ""
    output_path: str = ""
    speaker_id: int = 0
    length_scale: float = 1.0
    noise_scale: float = 0.667
    noise_w: float = 0.8


@app.get("/health")
async def health():
    return {
        "ok": STATE["state"] == "ready",
        "state": STATE["state"],
        "voice": STATE["voice"],
        "device": STATE["device"],
        "error": STATE["error"],
    }


@app.get("/voices")
async def voices():
    return list_voices()


@app.post("/speak")
async def speak(req: SpeakRequest):
    if STATE["state"] != "ready":
        return JSONResponse(
            status_code=503,
            content={"error": f"Piper not ready (state={STATE['state']})"},
        )

    if not req.text.strip():
        return JSONResponse(status_code=400, content={"error": "Empty text"})

    voice_id = req.voice.strip() or DEFAULT_VOICE
    voice_path = Path(PIPER_DIR) / f"{voice_id}.onnx"

    if not voice_path.exists():
        voices = list_voices()
        return JSONResponse(
            status_code=404,
            content={"error": f"Voice '{voice_id}' not found. Available: {[v['id'] for v in voices]}"},
        )

    try:
        # Run piper CLI to synthesize WAV
        cmd = [
            STATE["piper_bin"],
            "--model", str(voice_path),
            "--output_file", "-",  # Output to stdout
            "--speaker", str(req.speaker_id),
            "--length-scale", str(req.length_scale),
            "--noise-scale", str(req.noise_scale),
            "--noise-w", str(req.noise_w),
        ]

        result = subprocess.run(
            cmd,
            input=req.text.encode("utf-8"),
            capture_output=True,
            timeout=30,
        )

        if result.returncode != 0:
            error_msg = result.stderr.decode("utf-8", errors="replace")[:500]
            return JSONResponse(status_code=500, content={"error": f"Piper failed: {error_msg}"})

        wav_bytes = result.stdout
        if not wav_bytes or len(wav_bytes) < 44:
            return JSONResponse(status_code=500, content={"error": "Piper produced no audio"})

        return Response(content=wav_bytes, media_type="audio/wav")

    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "Piper timed out (30s limit)"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/speak/file")
async def speak_file(req: SpeakFileRequest):
    if STATE["state"] != "ready":
        return JSONResponse(
            status_code=503,
            content={"error": f"Piper not ready (state={STATE['state']})"},
        )

    if not req.text.strip():
        return JSONResponse(status_code=400, content={"error": "Empty text"})

    voice_id = req.voice.strip() or DEFAULT_VOICE
    voice_path = Path(PIPER_DIR) / f"{voice_id}.onnx"

    if not voice_path.exists():
        return JSONResponse(status_code=404, content={"error": f"Voice '{voice_id}' not found"})

    output_path = req.output_path or tempfile.mktemp(suffix=".wav", dir=str(Path.home() / ".umbra" / "tts"))

    try:
        cmd = [
            STATE["piper_bin"],
            "--model", str(voice_path),
            "--output_file", output_path,
            "--speaker", str(req.speaker_id),
            "--length-scale", str(req.length_scale),
            "--noise-scale", str(req.noise_scale),
            "--noise-w", str(req.noise_w),
        ]

        result = subprocess.run(
            cmd,
            input=req.text.encode("utf-8"),
            capture_output=True,
            timeout=30,
        )

        if result.returncode != 0:
            error_msg = result.stderr.decode("utf-8", errors="replace")[:500]
            return JSONResponse(status_code=500, content={"error": f"Piper failed: {error_msg}"})

        if not os.path.exists(output_path):
            return JSONResponse(status_code=500, content={"error": "Piper produced no output file"})

        return {"ok": True, "path": output_path, "voice": voice_id}

    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "Piper timed out (30s limit)"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    port = int(os.environ.get("PIPER_PORT", "17520"))
    print(f"[TTS] Starting Piper TTS server on port {port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

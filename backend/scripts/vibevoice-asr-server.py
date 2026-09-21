#!/usr/bin/env python
"""
VibeVoice-ASR diarization server for Umbra OS.

Loads microsoft/VibeVoice-ASR once and keeps it resident so meeting audio can
be transcribed chunk-by-chunk without re-loading the model (7B) every time.
The model jointly performs ASR + speaker diarization + timestamping, returning
"who said what and when".

The HTTP API comes up *immediately*; the model (and its ~17 GB download on
first run) is loaded in a background thread, so /health always answers and
reports progress instead of hanging during the multi-hour first download.

Endpoints:
  GET  /health      -> {"ok": bool, "state": "loading|ready|error",
                        "model": str, "device": str}
  POST /transcribe  -> multipart: "audio" (wav/mp3/...), "context" (hotwords)
                       -> {"segments": [{speaker_id, start_time, end_time, text}],
                           "raw_text": str}

Run via `npm run vibevoice:asr-server` (scripts/vibevoice-asr-server.sh), which
activates the VibeVoice venv and launches this script. Model weights are
downloaded from Hugging Face on first load (~17 GB — a GPU is recommended);
pre-download them with `npm run vibevoice:asr-download`.
"""
import argparse
import json
import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path

# Force the plain sequential HTTP downloader before anything touches the Hub;
# the parallel/Xet downloaders stall on slow links. The ASR downloader module
# (imported below) sets the same defaults and provides the reliable fetch loop.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
# Default stream read timeout is 10s, which a slow/flaky link trips constantly.
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "120")

REPO = Path(__file__).resolve().parents[1] / "external" / "VibeVoice"
SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "demo"))
sys.path.insert(0, str(SCRIPTS_DIR))

from fastapi import FastAPI, File, Form, UploadFile  # noqa: E402
import uvicorn  # noqa: E402

from vibevoice_asr_download import download_all  # noqa: E402

app = FastAPI(title="VibeVoice-ASR for Umbra OS")

STATE = {
    "model_path": "microsoft/VibeVoice-ASR",
    "device": "auto",
    "max_new_tokens": 4096,
    "state": "loading",
    "processor": None,
    "model": None,
    "run_device": "auto",
    "error": None,
}
_LOCK = threading.Lock()


def fallback_normalize(raw_text: str):
    """Parse segments even if the official post-processor missed them."""
    try:
        m = re.search(r"\[.*\]", raw_text, re.S)
        text = m.group(0) if m else raw_text
        data = json.loads(text)
    except Exception:
        return []
    if isinstance(data, dict):
        data = [data]

    def pick(item, *keys):
        for k in keys:
            if k in item and item[k] not in (None, ""):
                return item[k]
        return None

    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        seg = {
            "speaker_id": pick(item, "speaker_id", "Speaker ID", "Speaker", "speaker"),
            "start_time": pick(item, "start_time", "Start time", "Start", "start"),
            "end_time": pick(item, "end_time", "End time", "End", "end"),
            "text": pick(item, "text", "Content", "content"),
        }
        if seg["text"] is not None:
            out.append(seg)
    return out


def load_model():
    import torch
    from vibevoice.modular.modeling_vibevoice_asr import VibeVoiceASRForConditionalGeneration
    from vibevoice.processor.vibevoice_asr_processor import VibeVoiceASRProcessor

    # Ensure all weights are cached (idempotent, resumable) before from_pretrained,
    # which would otherwise use the stalling parallel downloader.
    if STATE["model_path"] == "microsoft/VibeVoice-ASR":
        print("[vibevoice-asr] ensuring model is cached (sequential download)", flush=True)
        download_all()

    print(f"[vibevoice-asr] loading processor + model from {STATE['model_path']}", flush=True)
    processor = VibeVoiceASRProcessor.from_pretrained(
        STATE["model_path"], language_model_pretrained_name="Qwen/Qwen2.5-7B"
    )
    device = STATE["device"]
    # bf16 halves memory on CPU too (7B model: ~17 GB fp32 vs ~8.6 GB bf16)
    dtype = torch.bfloat16 if device in ("cuda", "cpu") else torch.float32
    model = VibeVoiceASRForConditionalGeneration.from_pretrained(
        STATE["model_path"],
        torch_dtype=dtype,
        device_map=device if device == "auto" else None,
        attn_implementation="sdpa",
        trust_remote_code=True,
    )
    if device != "auto":
        model = model.to(device)
    model.eval()
    run_device = device if device != "auto" else str(next(model.parameters()).device)
    print(f"[vibevoice-asr] model loaded on {run_device}", flush=True)
    return processor, model, run_device


def transcribe_file(audio_path: str, context: str):
    import torch

    with _LOCK:
        processor = STATE["processor"]
        model = STATE["model"]
        device = STATE["run_device"]

    inputs = processor(
        audio=audio_path,
        sampling_rate=None,
        return_tensors="pt",
        add_generation_prompt=True,
        context_info=(context or ""),
    )
    inputs = {k: v.to(device) if isinstance(v, torch.Tensor) else v for k, v in inputs.items()}

    gen = {
        "max_new_tokens": STATE["max_new_tokens"],
        "do_sample": False,
        "num_beams": 1,
        "pad_token_id": processor.pad_id,
        "eos_token_id": processor.tokenizer.eos_token_id,
    }
    with torch.no_grad():
        output_ids = model.generate(**inputs, **gen)

    generated_ids = output_ids[0, inputs["input_ids"].shape[1]:]
    raw_text = processor.decode(generated_ids, skip_special_tokens=True)
    segments = processor.post_process_transcription(raw_text)
    if not segments:
        segments = fallback_normalize(raw_text)
    return raw_text, segments


@app.get("/health")
def health():
    return {
        "ok": STATE["state"] == "ready",
        "state": STATE["state"],
        "model": STATE["model_path"],
        "device": STATE["run_device"] if STATE["state"] == "ready" else STATE["device"],
        "error": STATE["error"],
    }


@app.post("/transcribe")
async def transcribe_endpoint(audio: UploadFile = File(...), context: str = Form("")):
    if STATE["state"] != "ready":
        return {"error": f"model not ready (state: {STATE['state']})", "segments": [], "raw_text": ""}

    suffix = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(await audio.read())
        raw_text, segments = transcribe_file(tmp_path, context or "")
        return {"segments": segments, "raw_text": raw_text}
    except Exception as e:
        return {"error": str(e)[:500], "segments": [], "raw_text": ""}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _load_worker():
    # Retry the whole load until it succeeds: the ~17 GB download can drop a
    # chunk on flaky links, and hf_hub_download resumes, so a retry continues
    # in place. Capped exponential backoff avoids hot-looping while staying alive.
    attempts = 1000
    delay = 15.0
    last_error = None
    for n in range(1, attempts + 1):
        try:
            processor, model, run_device = load_model()
            with _LOCK:
                STATE["processor"] = processor
                STATE["model"] = model
                STATE["run_device"] = run_device
                STATE["state"] = "ready"
                STATE["error"] = None
            return
        except Exception as e:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            last_error = e
            if n == attempts:
                break
            with _LOCK:
                STATE["error"] = f"{type(e).__name__}: {e} (attempt {n}/{attempts})"
            print(f"[vibevoice-asr] load attempt {n}/{attempts} failed; retrying in {delay:.0f}s", flush=True)
            time.sleep(delay)
    with _LOCK:
        STATE["state"] = "error"
        STATE["error"] = f"{type(last_error).__name__}: {last_error}"


def main():
    parser = argparse.ArgumentParser(description="VibeVoice-ASR diarization server for Umbra")
    parser.add_argument("--model_path", default="microsoft/VibeVoice-ASR")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu", "mps", "xpu"])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17500)
    parser.add_argument("--max_new_tokens", type=int, default=4096)
    args = parser.parse_args()

    STATE["model_path"] = args.model_path
    STATE["device"] = args.device
    STATE["max_new_tokens"] = args.max_new_tokens

    # Serve the API immediately; load the model in the background so /health
    # answers during the (potentially multi-hour) first download.
    threading.Thread(target=_load_worker, daemon=True, name="vibevoice-asr-loader").start()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

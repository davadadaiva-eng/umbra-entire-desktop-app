#!/usr/bin/env python
"""
Whisper-ASR diarization server for Umbra OS (lightweight alternative).

Replaces the 17 GB microsoft/VibeVoice-ASR joint model with a ~520 MB,
fully-ungated stack:

  - faster-whisper (Systran/faster-whisper-small, ~460 MB) for transcription
    with per-segment timestamps.
  - speechbrain ECAPA speaker embeddings (~60 MB) clustered per segment to
    label "who said what".

Both models download automatically from Hugging Face on first use (no gated
license, no token). The API mirrors scripts/vibevoice-asr-server.py so the
TypeScript client can swap providers without changing its parsing:

  GET  /health      -> {"ok", "state": "loading|ready|error", "model", "device", "error"}
  POST /transcribe  -> multipart "audio" (+ optional "context", "language")
                       -> {"segments": [{speaker_id, start_time, end_time, text}], "raw_text"}

Run via `npm run whisper:asr-server` (scripts/whisper-asr-server.sh). Configure
with `voice.asrProvider = "whisper"` and `voice.whisperAsrUrl`.
"""
import argparse
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

# Default stream read timeout is 10s, which a slow/flaky link trips constantly
# mid-download. Set these before faster_whisper/huggingface_hub are imported so
# the model fetch tolerates stalls and resumes instead of dead-ending.
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "120")

import numpy as np

from fastapi import FastAPI, File, Form, UploadFile
import uvicorn

app = FastAPI(title="Whisper-ASR for Umbra OS")

STATE = {
    "model": os.environ.get("WHISPER_ASR_MODEL", "base"),
    "device": os.environ.get("WHISPER_ASR_DEVICE", "cpu"),
    "compute_type": os.environ.get("WHISPER_ASR_COMPUTE", "int8"),
    "state": "loading",
    "whisper": None,
    "encoder": None,
    "error": None,
}
_LOCK = threading.Lock()

# Cosine-similarity threshold for "same speaker" during embedding clustering.
# ECAPA embeddings are ~unit-norm, so cosine == dot product. 0.75 is a
# conservative default: distinct voices separate, while a single speaker's
# channel/session variance stays together.
SPEAKER_SIM_THRESHOLD = float(os.environ.get("WHISPER_ASR_SPEAKER_THRESHOLD", "0.75"))


def _cosine(a, b):
    an = a / (np.linalg.norm(a) + 1e-12)
    bn = b / (np.linalg.norm(b) + 1e-12)
    return float(np.dot(an, bn))


def _load_waveform_16k(path: str):
    """Decode any audio file to a 16 kHz mono float32 numpy array.

    Prefers librosa (already in the VibeVoice venv); falls back to PyAV
    (a faster-whisper dependency) if librosa is unavailable.
    """
    try:
        import librosa  # type: ignore
        wav, _sr = librosa.load(path, sr=16000, mono=True)
        return np.asarray(wav, dtype=np.float32)
    except Exception:
        import av  # type: ignore
        container = av.open(path)
        resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
        frames = []
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                frames.append(out.to_ndarray())
        container.close()
        if not frames:
            return np.zeros(0, dtype=np.float32)
        audio = np.concatenate([f.reshape(-1) for f in frames]).astype(np.float32) / 32768.0
        return audio


def _slice(wav: np.ndarray, sr: int, start: float, end: float):
    s = max(0, int(start * sr))
    e = min(len(wav), int(end * sr))
    return wav[s:e]


def cluster_speakers(embeddings):
    """Greedy online clustering into unknown-N speakers.

    Returns a list of 0-based speaker indices aligned with `embeddings`. Each
    new embedding joins the closest existing speaker if its cosine similarity
    clears the threshold; otherwise it starts a new speaker. Centroids are
    running means so a speaker's label stays stable as more of their audio
    arrives.
    """
    centroids: list[np.ndarray] = []
    counts: list[int] = []
    labels: list[int] = []
    for emb in embeddings:
        if emb is None or emb.shape[0] == 0:
            labels.append(0)
            continue
        if not centroids:
            centroids.append(emb.astype(np.float32))
            counts.append(1)
            labels.append(0)
            continue
        sims = [_cosine(emb, c) for c in centroids]
        best_i = int(np.argmax(sims))
        if sims[best_i] >= SPEAKER_SIM_THRESHOLD:
            labels.append(best_i)
            counts[best_i] += 1
            centroids[best_i] = centroids[best_i] + (emb.astype(np.float32) - centroids[best_i]) / counts[best_i]
        else:
            labels.append(len(centroids))
            centroids.append(emb.astype(np.float32))
            counts.append(1)
    return labels


def load_models():
    from faster_whisper import WhisperModel

    print(f"[whisper-asr] loading faster-whisper {STATE['model']} on {STATE['device']}", flush=True)
    whisper = WhisperModel(
        STATE["model"],
        device=STATE["device"],
        compute_type=STATE["compute_type"],
    )

    print("[whisper-asr] loading speechbrain ECAPA speaker encoder", flush=True)
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy

    # COPY instead of the default SYMLINK: Windows can't create symlinks
    # without Developer Mode/admin, which crashed the loader.
    encoder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=os.path.join(tempfile.gettempdir(), "umbra-ecapa"),
        local_strategy=LocalStrategy.COPY,
    )
    return whisper, encoder


def transcribe_file(audio_path: str, context: str, language: str):
    import torch

    with _LOCK:
        whisper = STATE["whisper"]
        encoder = STATE["encoder"]

    segments_iter, info = whisper.transcribe(
        audio_path,
        language=language or None,
        initial_prompt=context or None,
        beam_size=1,
        word_timestamps=False,
        vad_filter=True,
    )
    segments = list(segments_iter)

    wav = _load_waveform_16k(audio_path)
    sr = 16000

    embeddings = []
    for seg in segments:
        sl = _slice(wav, sr, seg.start, seg.end)
        if sl.shape[0] < int(0.15 * sr):
            embeddings.append(None)
            continue
        try:
            with torch.no_grad():
                emb = encoder.encode_batch(torch.from_numpy(sl).unsqueeze(0))
            embeddings.append(emb.squeeze().cpu().numpy())
        except Exception:
            embeddings.append(None)

    labels = cluster_speakers(embeddings)

    out_segments = []
    for seg, label in zip(segments, labels):
        text = (seg.text or "").strip()
        if not text:
            continue
        out_segments.append(
            {
                "speaker_id": f"SPEAKER_{label:02d}",
                "start_time": round(float(seg.start), 3),
                "end_time": round(float(seg.end), 3),
                "text": text,
            }
        )

    raw_text = " ".join(s["text"] for s in out_segments)
    return raw_text, out_segments


@app.get("/health")
def health():
    return {
        "ok": STATE["state"] == "ready",
        "state": STATE["state"],
        "model": f"faster-whisper/{STATE['model']} + ECAPA",
        "device": STATE["device"],
        "error": STATE["error"],
    }


@app.post("/transcribe")
async def transcribe_endpoint(audio: UploadFile = File(...), context: str = Form(""), language: str = Form("")):
    if STATE["state"] != "ready":
        return {
            "error": f"model not ready (state: {STATE['state']})",
            "segments": [],
            "raw_text": "",
        }

    suffix = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(await audio.read())
        raw_text, segments = transcribe_file(tmp_path, context or "", language or "")
        return {"segments": segments, "raw_text": raw_text}
    except Exception as e:
        return {"error": str(e)[:500], "segments": [], "raw_text": ""}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _load_worker():
    attempts = 10
    delay = 5.0
    last_error = None
    for n in range(1, attempts + 1):
        try:
            whisper, encoder = load_models()
            with _LOCK:
                STATE["whisper"] = whisper
                STATE["encoder"] = encoder
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
            print(f"[whisper-asr] load attempt {n}/{attempts} failed; retrying in {delay:.0f}s", flush=True)
            time.sleep(delay)
    with _LOCK:
        STATE["state"] = "error"
        STATE["error"] = f"{type(last_error).__name__}: {last_error}"


def main():
    parser = argparse.ArgumentParser(description="Whisper-ASR diarization server for Umbra")
    parser.add_argument("--model", default=STATE["model"])
    parser.add_argument("--device", default=STATE["device"], choices=["auto", "cuda", "cpu"])
    parser.add_argument("--compute-type", default=STATE["compute_type"], choices=["int8", "float16", "float32"])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17501)
    args = parser.parse_args()

    STATE["model"] = args.model
    STATE["device"] = args.device
    STATE["compute_type"] = args.compute_type

    threading.Thread(target=_load_worker, daemon=True, name="whisper-asr-loader").start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

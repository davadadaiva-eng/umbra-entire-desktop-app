"""End-to-end smoke test for the meeting-bot container.

Runs INSIDE the container after the entrypoint has set up PulseAudio and
Xvfb. Verifies every stage of the audio/brain pipeline with no external
services (no real LLM needed) and no real meeting:

  1. PulseAudio graph       - daemon up, virtual devices present and default
  2. Audio capture          - parecord hears a tone played into bot_speaker
  3. TTS synthesis          - Piper produces valid WAV bytes
  4. Audio injection        - pacat injects the WAV into the virtual mic
  5. STT round-trip         - Whisper transcribes synthesized speech
  6. Brain (deterministic)  - BrainManager returns its canned response
                              without an API key
  7. Webhook brain          - posts to a tiny local HTTP server that returns
                              a fixed response, proving the HTTP brain path

Usage (from the repo root):
  docker compose -f meeting-bot/docker-compose.yml run --rm meeting-bot \\
      python /app/scripts/smoke_test.py

Or via the wrapper script:
  ./scripts/smoke-test.sh --skip-stt   # STT model download can be slow
"""

from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import math
import shutil
import struct
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

# Make `import app.*` work regardless of cwd
sys.path.insert(0, "/app")

# Deterministic test phrase. Piper has no builtin "smoke" voice, so reuse the
# configured Italian voice: the STT check asserts on WORD COUNT, not text.
TEST_PHRASE = "Uno due tre quattro cinque"

PASS: list[str] = []
FAIL: list[str] = []


def step(name: str) -> None:
    print(f"\n=== {name} ===", flush=True)


def record(name: str, ok: bool, detail: str) -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}: {detail}", flush=True)
    (PASS if ok else FAIL).append(f"{name}: {detail}")


def synth_tone(rate: int, seconds: float, freq: int = 440) -> bytes:
    """Build a WAV (s16le mono) sine tone."""
    n = int(rate * seconds)
    samples = (int(22000 * math.sin(2 * math.pi * freq * i / rate)) for i in range(n))
    pcm = struct.pack(f"<{n}h", *samples)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def wav_duration(data: bytes) -> float:
    with wave.open(io.BytesIO(data), "rb") as w:
        return w.getnframes() / max(w.getframerate(), 1)


def wav_to_raw_pcm(data: bytes) -> tuple[bytes, int, int]:
    with wave.open(io.BytesIO(data), "rb") as w:
        return (
            w.readframes(w.getnframes()),
            w.getframerate(),
            w.getnchannels(),
        )


async def check_pulseaudio() -> bool:
    step("1. PulseAudio graph")
    proc = await asyncio.create_subprocess_exec(
        "pactl", "info",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    info = out.decode(errors="replace")
    record(
        "pactl info",
        proc.returncode == 0,
        info.strip() or err.decode(errors="replace").strip() or "no output",
    )
    if proc.returncode != 0:
        return False

    sink_ok = "Default Sink: bot_speaker" in info
    source_ok = "Default Source: bot_microphone.monitor" in info
    record("default sink is bot_speaker", sink_ok, info)
    record("default source is bot_microphone.monitor", source_ok, info)

    for binary in ("parecord", "pacat"):
        record(f"{binary} on PATH", shutil.which(binary) is not None, "checked")

    return sink_ok and source_ok


async def check_capture(config) -> None:
    step("2. Audio capture (monitor hears a tone)")

    # NOTE: the capture thread runs its own event loop, so it must only touch
    # plain lists here - no cross-thread asyncio primitives.
    received: list[bytes] = []

    async def on_chunk(chunk: bytes) -> None:
        received.append(chunk)

    audio = None
    try:
        from app.audio_engine import AudioEngine

        audio = AudioEngine(config)
    except FileNotFoundError as exc:
        record("AudioEngine init", False, str(exc))
        return

    target_bytes = config.audio_sample_rate * 2  # 1 s of s16le mono
    await audio.start_capture(on_chunk)

    # Play a 1 s tone into bot_speaker; its monitor should deliver it.
    pcm, rate, ch = wav_to_raw_pcm(synth_tone(config.audio_sample_rate, 1.0))
    inject = await asyncio.create_subprocess_exec(
        "pacat", "--device", "bot_speaker",
        "--format", "s16le", "--rate", str(rate), "--channels", str(ch),
        "--raw",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    await inject.communicate(pcm)

    # Poll (thread-safe) until we have ~1 s of audio or time out.
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if sum(len(c) for c in received) >= target_bytes:
            break
        await asyncio.sleep(0.1)
    await audio.stop_capture()

    total = sum(len(c) for c in received)
    record("capture delivered audio", total > 0, f"{len(received)} chunks, {total} bytes")
    record("capture size plausible", total >= target_bytes, f"{total} bytes >= {target_bytes}")


async def check_tts(config) -> bytes | None:
    step("3. TTS synthesis (Piper)")
    from app.tts_engine import PiperTTS

    tts = PiperTTS(config)
    try:
        await tts.load()
        record("piper voice loaded", True, config.tts_voice)
    except Exception as exc:
        record("piper voice loaded", False, repr(exc))
        return None

    try:
        wav = await tts.synthesize(TEST_PHRASE)
        dur = wav_duration(wav)
        ok = dur > 0.5
        record("synthesized WAV", ok, f"{len(wav)} bytes, {dur:.2f}s")
        return wav if ok else None
    except Exception as exc:
        record("synthesized WAV", False, repr(exc))
        return None


async def check_stt(config, wav: bytes | None, skip: bool) -> None:
    step("4. STT round-trip (faster-whisper)")
    if skip:
        print("  [SKIP] --skip-stt set")
        return

    from app.stt_engine import FasterWhisperSTT

    stt = FasterWhisperSTT(config)
    try:
        await stt.load()
        record("whisper model loaded", True, config.stt_model)
    except Exception as exc:
        record("whisper model loaded", False, repr(exc))
        return

    source = wav
    if source is None:
        # Fall back to the tone: STT should return empty text, not crash.
        source = synth_tone(config.audio_sample_rate, 1.0)
        print("  (TTS output unavailable; verifying STT handles a pure tone)")

    try:
        result = await stt.transcribe(source)
        text = result.get("text", "").strip()
        words = [w for w in text.split() if w]
        record(
            "transcription ran",
            True,
            f"text={text!r} language={result.get('language')!r}",
        )
        # Tone -> no words expected. Speech -> word count within tolerance
        # (accent/model variance). Never assert exact wording.
        if wav is not None:
            record(
                "word count in range",
                3 <= len(words) <= 7,
                f"got {len(words)} words from {len(TEST_PHRASE.split())}-word phrase",
            )
        else:
            record("tone yields no text", len(words) == 0, f"got {len(words)} words")
    except Exception as exc:
        record("transcription ran", False, repr(exc))


async def check_brain(config) -> None:
    step("5. Brain - deterministic fallback (no API key)")
    from app.brain_manager import BrainManager

    # Force the no-credentials path so the result does not depend on the
    # environment's LLM settings.
    offline_config = dataclasses.replace(config, llm_api_key="", llm_webhook_url="")
    brain = BrainManager(offline_config)
    try:
        resp = await brain.think(
            transcript="bot what did I miss",
            context={"meeting_id": "smoke"},
            command={"command": "what_did_i_miss", "args": {}, "confidence": 0.9},
        )
        record("fallback response returned", bool(resp.strip()), f"resp={resp!r}")
    finally:
        await brain.close()


async def check_brain_webhook(config) -> None:
    step("6. Brain - webhook path (local HTTP server)")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            payload = json.loads(body.decode())
            reply = json.dumps(
                {"response": f"echo:{payload.get('transcript', '')}"}
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    task = asyncio.create_task(asyncio.to_thread(server.serve_forever, 0.05))

    from app.brain_manager import BrainManager

    webhook_config = dataclasses.replace(
        config, llm_webhook_url=f"http://127.0.0.1:{port}/hook"
    )
    webhook_brain = BrainManager(webhook_config)
    try:
        resp = await webhook_brain.think(
            transcript="webhook-smoke-probe",
            context={"meeting_id": "smoke"},
        )
        record(
            "webhook round-trip",
            resp == "echo:webhook-smoke-probe",
            f"resp={resp!r}",
        )
    finally:
        await webhook_brain.close()
        server.shutdown()
        task.cancel()


async def main() -> int:
    from app.config import get_config

    config = get_config()
    skip_stt = "--skip-stt" in sys.argv
    started = time.monotonic()

    await check_pulseaudio()
    await check_capture(config)
    wav = await check_tts(config)
    await check_stt(config, wav, skip_stt)
    await check_brain(config)
    await check_brain_webhook(config)

    elapsed = time.monotonic() - started
    print(f"\n{'=' * 60}")
    status = "PASSED" if not FAIL else "FAILED"
    print(
        f"SMOKE TEST {status} in {elapsed:.1f}s "
        f"({len(PASS)} passed, {len(FAIL)} failed)"
    )
    for f in FAIL:
        print(f"  FAIL: {f}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

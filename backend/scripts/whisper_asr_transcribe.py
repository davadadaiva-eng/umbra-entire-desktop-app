#!/usr/bin/env python
"""
Wait for the Whisper-ASR server to finish loading, then transcribe an audio
file and print the speaker-labeled segments.

Usage (from the VibeVoice venv):

    cd external/VibeVoice
    ./.venv/Scripts/python.exe ../../scripts/whisper_asr_transcribe.py \
        /tmp/meeting-test/meeting.wav

The server (npm run whisper:asr-server) serves /health immediately and flips
from `state: loading` to `ready` once the ~520 MB models are loaded (first run
downloads them). This polls /health until then, then POSTs the file and
pretty-prints the diarized result.
"""
import argparse
import json
import sys
import time

import requests

DEFAULT_AUDIO = "/tmp/meeting-test/meeting.wav"


def main() -> int:
    parser = argparse.ArgumentParser(description="Wait for Whisper-ASR then transcribe audio")
    parser.add_argument("audio", nargs="?", default=DEFAULT_AUDIO)
    parser.add_argument("--url", default="http://127.0.0.1:17501")
    parser.add_argument("--context", default="")
    parser.add_argument("--language", default="")
    parser.add_argument("--poll", type=int, default=5, help="seconds between /health polls")
    parser.add_argument("--timeout", type=int, default=0, help="max wait seconds (0 = forever)")
    args = parser.parse_args()

    base = args.url.rstrip("/")
    started = time.time()
    while True:
        try:
            health = requests.get(f"{base}/health", timeout=5).json()
        except Exception as exc:  # noqa: BLE001
            print(f"[wait] server not reachable yet ({exc}); retrying", flush=True)
            health = {"state": "down"}
        state = health.get("state", "down")
        print(f"[wait] ASR state: {state}", flush=True)
        if state == "ready":
            break
        if state == "error":
            print(f"[error] model failed to load: {health.get('error')}", file=sys.stderr)
            return 1
        if args.timeout and time.time() - started > args.timeout:
            print(f"[timeout] still not ready after {args.timeout}s", file=sys.stderr)
            return 2
        time.sleep(args.poll)

    print(f"[transcribe] {args.audio}", flush=True)
    with open(args.audio, "rb") as f:
        resp = requests.post(
            f"{base}/transcribe",
            files={"audio": (args.audio.rsplit("/", 1)[-1], f, "audio/wav")},
            data={"context": args.context, "language": args.language},
            timeout=15 * 60,
        )
    resp.raise_for_status()
    body = resp.json()
    if body.get("error"):
        print(f"[error] {body['error']}", file=sys.stderr)
        return 1
    print(json.dumps(body.get("segments", []), indent=2, ensure_ascii=False))
    print("[raw_text]", body.get("raw_text", ""), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

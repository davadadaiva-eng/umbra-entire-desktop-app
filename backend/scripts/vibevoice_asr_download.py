#!/usr/bin/env python
"""
Download microsoft/VibeVoice-ASR to the local Hugging Face cache.

Why this exists: the model is ~17 GB across 8 safetensors shards. The default
parallel downloader stalls on some connections, and a single stalled worker
can silently hang the whole fetch. This script downloads every required file
*sequentially* with hf_hub_download, which resumes from ``.incomplete`` blobs,
so it can be killed and re-run safely (Ctrl-C, session restarts, etc.).

Run from the VibeVoice venv:

    cd external/VibeVoice
    ./.venv/Scripts/python.exe ../../scripts/vibevoice-asr-download.py

When it prints "DONE", the model is cached and `npm run vibevoice:asr-server`
will load it without re-downloading. The ASR server also imports `download_all`
so its background loader pre-fetches the model with this same reliable path.
"""
import os
import sys
import time

# Force the plain HTTP downloader before anything touches the Hub: the
# parallel and Xet downloaders stall on slow links, but sequential HTTP
# downloads reliably and resumes from .incomplete blobs.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
# Bump the stream read timeout: the default is 10s, which a slow/flaky link
# trips constantly ("Read timed out" mid-shard). 120s tolerates stalls while
# still resetting dead connections fast enough to resume with a fresh one.
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "120")

from huggingface_hub import hf_hub_download  # noqa: E402

REPO = "microsoft/VibeVoice-ASR"

# Order matters: config + index first (cheap, needed to even know the shards),
# then shards in order so the most likely-to-be-interrupted work resumes.
FILES = [
    "config.json",
    "model.safetensors.index.json",
    "model-00001-of-00008.safetensors",
    "model-00002-of-00008.safetensors",
    "model-00003-of-00008.safetensors",
    "model-00004-of-00008.safetensors",
    "model-00005-of-00008.safetensors",
    "model-00006-of-00008.safetensors",
    "model-00007-of-00008.safetensors",
    "model-00008-of-00008.safetensors",
]


def _download_with_retry(fname: str, attempts: int = 40, base_delay: float = 5.0) -> str:
    """hf_hub_download with retry/backoff for flaky links.

    hf_hub_download resumes from .incomplete blobs, so a retry after a dropped
    connection continues where it left off rather than restarting the file.
    """
    last: Exception | None = None
    for n in range(1, attempts + 1):
        try:
            return hf_hub_download(REPO, fname)
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
            if n == attempts:
                break
            delay = base_delay * (2 ** (n - 1))
            print(
                f"[asr-download] {fname} attempt {n}/{attempts} failed "
                f"({type(exc).__name__}); retrying in {delay:.0f}s",
                flush=True,
            )
            time.sleep(delay)
    raise last  # type: ignore[misc]


def download_all() -> None:
    """Fetch every required file sequentially; safe to call repeatedly.

    Already-cached files are skipped instantly (huggingface_hub returns the
    cached blob without a network round-trip), and interrupted downloads
    resume from their .incomplete blobs. Transient connection failures are
    retried with exponential backoff.
    """
    for i, fname in enumerate(FILES, 1):
        t0 = time.time()
        path = _download_with_retry(fname)
        mb = os.path.getsize(path) / 1e6
        print(f"[asr-download {i}/{len(FILES)}] {fname}: {mb:.0f} MB in {time.time()-t0:.0f}s", flush=True)
    print(f"[asr-download] all {len(FILES)} files cached", flush=True)


def main() -> int:
    start = time.time()
    try:
        download_all()
    except KeyboardInterrupt:
        print("Interrupted — re-run to resume from cached blobs.", flush=True)
        return 130
    print(f"DONE: all {len(FILES)} files cached in {time.time()-start:.0f}s", flush=True)
    print("The model is now cached under the Hugging Face cache dir; ", flush=True)
    print(f"`npm run vibevoice:asr-server` will load {REPO} without re-downloading.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

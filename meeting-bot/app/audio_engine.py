"""PulseAudio-based audio capture and playback engine."""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import threading
from typing import Any, Callable, Coroutine, Optional

from app.config import BotConfig

logger = logging.getLogger(__name__)

# Type alias for async callback: receives raw PCM bytes
AudioCallback = Callable[[bytes], Coroutine[Any, Any, None]]


class AudioEngine:
    """Captures audio from a PulseAudio monitor and injects into a virtual mic.

    All public methods are async-safe; internal capture runs in a daemon thread.
    """

    def __init__(self, config: BotConfig) -> None:
        self._config = config
        self._capture_process: Optional[subprocess.Popen[bytes]] = None
        self._inject_process: Optional[subprocess.Popen[bytes]] = None
        self._capture_thread: Optional[threading.Thread] = None
        self._running = False
        self._callback: Optional[AudioCallback] = None

        self._ensure_binaries()

    def _ensure_binaries(self) -> None:
        """Verify that ``parecord`` and ``pacat`` are available."""
        for binary in ("parecord", "pacat"):
            if shutil.which(binary) is None:
                raise FileNotFoundError(
                    f"PulseAudio binary '{binary}' not found on PATH. "
                    "Install PulseAudio and ensure it is running."
                )

    async def start_capture(self, callback: AudioCallback) -> None:
        """Begin capturing audio from the PulseAudio monitor source.

        Each chunk of raw PCM audio is forwarded to *callback* in a new
        ``asyncio`` task.

        Parameters
        ----------
        callback:
            Async function that receives ``bytes`` of raw audio data.
        """
        if self._running:
            logger.warning("Capture already running; ignoring start_capture()")
            return

        self._callback = callback
        self._running = True

        cmd = [
            "parecord",
            "--device", self._config.pulse_monitor,
            "--format", "s16le",
            "--rate", str(self._config.audio_sample_rate),
            "--channels", str(self._config.audio_channels),
            "--file-format=wav",
            "--raw",
        ]

        logger.info("Starting audio capture: %s", " ".join(cmd))

        self._capture_process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

        self._capture_thread = threading.Thread(
            target=self._read_capture,
            daemon=True,
            name="audio-capture",
        )
        self._capture_thread.start()

    def _read_capture(self) -> None:
        """Blocking read loop that forwards audio to the event loop."""
        assert self._capture_process is not None
        assert self._capture_process.stdout is not None
        assert self._callback is not None

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        chunk_bytes = (
            self._config.audio_chunk_duration_sec
            * self._config.audio_sample_rate
            * self._config.audio_channels
            * 2  # 16-bit = 2 bytes per sample
        )

        try:
            while self._running:
                data = self._capture_process.stdout.read(chunk_bytes)
                if not data:
                    break
                loop.run_until_complete(self._callback(data))
        except Exception:
            logger.exception("Audio capture read loop failed")
        finally:
            loop.close()

    async def stop_capture(self) -> None:
        """Gracefully stop the capture process."""
        self._running = False

        if self._capture_process is not None:
            try:
                self._capture_process.terminate()
                self._capture_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._capture_process.kill()
            except Exception:
                logger.exception("Error stopping capture process")
            finally:
                self._capture_process = None

        if self._capture_thread is not None and self._capture_thread.is_alive():
            self._capture_thread.join(timeout=5)
            self._capture_thread = None

        logger.info("Audio capture stopped")

    async def inject_audio(self, wav_bytes: bytes) -> None:
        """Pipe WAV audio data into the virtual microphone source.

        Parameters
        ----------
        wav_bytes:
            Complete WAV file contents to inject.
        """
        cmd = [
            "pacat",
            "--device", self._config.pulse_source,
            "--format", "s16le",
            "--rate", str(self._config.audio_sample_rate),
            "--channels", str(self._config.audio_channels),
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate(input=wav_bytes)

            if proc.returncode != 0:
                logger.error("pacat exited with code %d", proc.returncode)
            else:
                logger.debug("Injected %d bytes into virtual mic", len(wav_bytes))
        except Exception:
            logger.exception("Audio injection failed")

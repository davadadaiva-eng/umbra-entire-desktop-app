"""PulseAudio-based audio capture and playback engine."""

from __future__ import annotations

import asyncio
import io
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

        # Emit self-describing WAV (RIFF header + s16le PCM at the configured
        # rate). The STT engine parses each chunk with soundfile, which needs
        # the header. Do NOT pass --raw alongside --file-format=wav.
        cmd = [
            "parecord",
            "--device", self._config.pulse_monitor,
            "--format", "s16le",
            "--rate", str(self._config.audio_sample_rate),
            "--channels", str(self._config.audio_channels),
            "--file-format=wav",
            "-",  # write to stdout
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

    async def inject_audio(self, wav_bytes: bytes) -> float:
        """Play a TTS-generated WAV into the virtual microphone sink.

        Parameters
        ----------
        wav_bytes:
            Complete WAV file contents (header + PCM) as produced by
            :meth:`tts_engine.PiperTTS.synthesize`.

        Returns
        -------
        float
            Duration of the injected audio in seconds (0.0 on failure).
        """
        try:
            pcm, rate, channels = self._extract_pcm(wav_bytes)
        except Exception:
            logger.exception("Could not parse TTS WAV blob; not injecting")
            return 0.0

        # Chromium captures bot_microphone.monitor; play the raw PCM into the
        # bot_microphone sink at the TTS's own sample rate. The sink's monitor
        # automatically exposes the stream to Chromium at the mic's negotiated
        # rate, so no manual resampling is needed here.
        cmd = [
            "pacat",
            "--device", self._config.pulse_source,
            "--format", "s16le",
            "--rate", str(rate),
            "--channels", str(channels),
            "--raw",  # PCM only; the WAV header must NOT be played as audio
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate(input=pcm)

            duration = len(pcm) / (rate * channels * 2) if rate else 0.0
            if proc.returncode != 0:
                logger.error(
                    "pacat exited with code %d: %s",
                    proc.returncode,
                    stderr.decode(errors="replace").strip(),
                )
                return 0.0
            logger.debug(
                "Injected %.1fs of PCM into virtual mic", duration
            )
            return duration
        except Exception:
            logger.exception("Audio injection failed")
            return 0.0

    @staticmethod
    def _extract_pcm(wav_bytes: bytes) -> tuple[bytes, int, int]:
        """Extract raw PCM, sample rate and channel count from a WAV blob."""
        import wave

        with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
            rate = wav_file.getframerate()
            channels = wav_file.getnchannels()
            pcm = wav_file.readframes(wav_file.getnframes())
        return pcm, rate, channels

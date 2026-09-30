"""Text-to-speech engine backed by Piper TTS."""

from __future__ import annotations

import io
import logging
import wave
from pathlib import Path
from typing import Any

from app.config import BotConfig

logger = logging.getLogger(__name__)


class PiperTTS:
    """Wraps :mod:`piper` for high-quality on-device TTS."""

    def __init__(self, config: BotConfig) -> None:
        self._config = config
        self._model: Any = None

    async def load(self) -> None:
        """Download and load the Piper voice model.

        Raises
        ------
        RuntimeError
            If the Piper library or model fails to initialise.
        """
        try:
            import piper

            model_dir = Path(self._config.tts_data_dir).expanduser()
            model_dir.mkdir(parents=True, exist_ok=True)

            # PiperVoice.load() takes a model FILE path and reads
            # "<path>.onnx.json" as the voice config next to it.
            model_path = model_dir / f"{self._config.tts_voice}.onnx"
            if not model_path.exists():
                raise FileNotFoundError(
                    f"Piper voice model not found at {model_path}. "
                    "Run scripts/download_models.sh to fetch it."
                )

            logger.info(
                "Loading Piper voice %s from %s",
                self._config.tts_voice,
                model_path,
            )
            self._model = piper.PiperVoice.load(str(model_path))
            logger.info("Piper voice loaded successfully")
        except Exception:
            logger.exception("Failed to load Piper voice model")
            raise

    async def synthesize(self, text: str) -> bytes:
        """Synthesise text into WAV audio bytes.

        Parameters
        ----------
        text:
            The text to speak.

        Returns
        -------
        bytes
            Complete WAV file contents (header + PCM samples).
        """
        if self._model is None:
            raise RuntimeError("Piper model not loaded. Call load() first.")

        if not text or not text.strip():
            raise ValueError("Cannot synthesise empty text")

        try:
            wav_buffer = io.BytesIO()

            with wave.open(wav_buffer, "wb") as wav_file:
                self._model.synthesize(
                    text,
                    wav_file,
                )

            wav_bytes = wav_buffer.getvalue()
            logger.debug("Synthesised %d bytes of WAV audio", len(wav_bytes))
            return wav_bytes
        except Exception:
            logger.exception("TTS synthesis failed")
            raise

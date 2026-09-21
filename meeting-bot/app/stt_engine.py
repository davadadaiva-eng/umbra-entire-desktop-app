"""Speech-to-text engine backed by faster-whisper."""

from __future__ import annotations

import io
import logging
from typing import Any

import numpy as np
import soundfile as sf

from app.config import BotConfig

logger = logging.getLogger(__name__)


class FasterWhisperSTT:
    """Wraps :mod:`faster_whisper` for on-demand transcription."""

    def __init__(self, config: BotConfig) -> None:
        self._config = config
        self._model: Any = None

    async def load(self) -> None:
        """Lazily download and load the CTranslate2 model.

        This may take a while on the first run as the model weights are
        fetched from the Hugging Face Hub.
        """
        try:
            from faster_whisper import WhisperModel

            logger.info(
                "Loading faster-whisper model %s (compute_type=%s)",
                self._config.stt_model,
                self._config.stt_compute_type,
            )
            self._model = WhisperModel(
                self._config.stt_model,
                device=self._config.stt_device,
                compute_type=self._config.stt_compute_type,
            )
            logger.info("Whisper model loaded successfully")
        except Exception:
            logger.exception("Failed to load Whisper model")
            raise

    async def transcribe(self, audio_bytes: bytes) -> dict[str, Any]:
        """Transcribe raw audio bytes and return structured results.

        Parameters
        ----------
        audio_bytes:
            Raw PCM or WAV audio data.

        Returns
        -------
        dict
            ``{"text": str, "segments": list[dict], "language": str}``
        """
        if self._model is None:
            raise RuntimeError("Model not loaded. Call load() first.")

        try:
            audio_data, sample_rate = sf.read(io.BytesIO(audio_bytes))

            # Reshape to mono float32 if needed
            if audio_data.ndim > 1:
                audio_data = audio_data.mean(axis=1)

            # Resample to 16 kHz if necessary
            if sample_rate != 16000:
                from scipy.signal import resample

                num_samples = int(len(audio_data) * 16000 / sample_rate)
                audio_data = resample(audio_data, num_samples).astype(np.float32)

            segments, info = self._model.transcribe(
                audio_data,
                beam_size=5,
                language=None,
            )

            result_segments: list[dict[str, Any]] = []
            full_text_parts: list[str] = []

            for seg in segments:
                result_segments.append(
                    {
                        "start": seg.start,
                        "end": seg.end,
                        "text": seg.text.strip(),
                    }
                )
                full_text_parts.append(seg.text.strip())

            return {
                "text": " ".join(full_text_parts),
                "segments": result_segments,
                "language": info.language,
            }
        except Exception:
            logger.exception("Transcription failed")
            return {"text": "", "segments": [], "language": "unknown"}

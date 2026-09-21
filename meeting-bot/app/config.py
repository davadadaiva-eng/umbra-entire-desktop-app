"""PLAN-based configuration for the meeting bot."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

PlanLevel = Literal["FREE", "PRO", "ADVANCED"]

PLAN_STT_MODEL: dict[PlanLevel, str] = {
    "FREE": "base",
    "PRO": "tiny",
    "ADVANCED": "small",
}

PLAN_STT_COMPUTE: dict[PlanLevel, str] = {
    "FREE": "float32",
    "PRO": "int8",
    "ADVANCED": "int8",
}

PLAN_MAX_RAM_MB: dict[PlanLevel, int] = {
    "FREE": 0,
    "PRO": 2000,
    "ADVANCED": 3000,
}


@dataclass(frozen=True)
class BotConfig:
    """Immutable bot configuration resolved once at startup."""

    plan: PlanLevel

    # STT settings
    stt_model: str = "base"
    stt_device: str = "cpu"
    stt_compute_type: str = "float32"

    # TTS settings
    tts_voice: str = "it_IT-riccardo-x_low"
    tts_data_dir: str = "~/.piper/models"

    # Resource limits
    max_ram_mb: int = 0

    # LLM settings
    llm_webhook_url: str = ""
    llm_api_key: str = ""
    llm_api_url: str = "https://openrouter.ai/api/v1/chat/completions"
    llm_model: str = "deepseek/deepseek-chat"

    # Server
    server_host: str = "0.0.0.0"
    server_port: int = 8000

    # Paths
    session_data_dir: str = "../session_data"
    output_dir: str = "../output"

    # Audio
    audio_sample_rate: int = 16000
    audio_channels: int = 1
    audio_chunk_duration_sec: int = 5

    # PulseAudio virtual devices
    pulse_sink: str = "bot_speaker"
    pulse_source: str = "bot_microphone"
    pulse_monitor: str = "bot_speaker.monitor"


def _is_docker() -> bool:
    """Heuristic: /.dockerenv exists inside containers."""
    return os.path.exists("/.dockerenv")


def get_config() -> BotConfig:
    """Build a :class:`BotConfig` from the ``PLAN`` environment variable."""

    raw_plan: str = os.getenv("PLAN", "FREE").upper()
    if raw_plan not in PLAN_STT_MODEL:
        raise ValueError(
            f"Unknown PLAN '{raw_plan}'. Must be one of: FREE, PRO, ADVANCED"
        )
    plan: PlanLevel = raw_plan  # type: ignore[assignment]

    docker = _is_docker()

    return BotConfig(
        plan=plan,
        stt_model=PLAN_STT_MODEL[plan],
        stt_device="cpu",
        stt_compute_type=PLAN_STT_COMPUTE[plan],
        tts_voice="it_IT-riccardo-x_low",
        tts_data_dir="~/.piper/models",
        max_ram_mb=PLAN_MAX_RAM_MB[plan],
        llm_webhook_url=os.getenv("LLM_WEBHOOK_URL", ""),
        llm_api_key=os.getenv("LLM_API_KEY", ""),
        llm_api_url=os.getenv(
            "LLM_API_URL", "https://openrouter.ai/api/v1/chat/completions"
        ),
        llm_model=os.getenv("LLM_MODEL", "deepseek/deepseek-chat"),
        server_host="0.0.0.0",
        server_port=8000,
        session_data_dir="/app/session_data" if docker else "../session_data",
        output_dir="/app/output" if docker else "../output",
        audio_sample_rate=16000,
        audio_channels=1,
        audio_chunk_duration_sec=5,
        pulse_sink="bot_speaker",
        pulse_source="bot_microphone",
        pulse_monitor="bot_speaker.monitor",
    )

"""FastAPI application entry point for the meeting bot."""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import sys
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

# Ensure the project root is on sys.path so ``app.*`` imports work
# when running with ``python -m app.main``.
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from app.audio_engine import AudioEngine
from app.brain_manager import BrainManager
from app.chat_handler import ChatHandler
from app.command_parser import CommandParser
from app.config import BotConfig, get_config
from app.file_writer import FileWriter
from app.meeting_bot import MeetingBot
from app.stt_engine import FasterWhisperSTT
from app.tts_engine import PiperTTS

logger = logging.getLogger("meeting_bot")

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
_config: BotConfig
_stt: FasterWhisperSTT
_tts: PiperTTS
_audio: AudioEngine
_brain: BrainManager
_chat: ChatHandler | None = None
_bot: MeetingBot | None = None
_writer: FileWriter
_command_parser: CommandParser


# ---------------------------------------------------------------------------
# API authentication
# ---------------------------------------------------------------------------
# Set API_TOKEN in the environment (or .env) to require
#   Authorization: Bearer <API_TOKEN>
# on every route except /health. Leave unset for open access (fine when the
# API is only reachable over an SSH tunnel / loopback).
_bearer = HTTPBearer(auto_error=False)

# Naive in-memory sliding-window rate limit for FAILED auth attempts. Good
# enough for a single-process deployment and blocks brute-forcing of the
# token when the API is exposed publicly.
_AUTH_FAIL_WINDOW_SEC = 60.0
_AUTH_FAIL_LIMIT = 10
_failed_auth: dict[str, list[float]] = {}


def require_token(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Enforce the bearer token when API_TOKEN is configured.

    Uses a timing-safe comparison and rate-limits failed attempts per IP
    (10 failures within 60 s -> HTTP 429).
    """
    expected = os.getenv("API_TOKEN", "")
    if not expected:
        return

    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()

    recent = [
        t
        for t in _failed_auth.get(client_ip, [])
        if now - t < _AUTH_FAIL_WINDOW_SEC
    ]
    if len(recent) >= _AUTH_FAIL_LIMIT:
        _failed_auth[client_ip] = recent
        raise HTTPException(
            status_code=429, detail="Too many failed attempts; retry later"
        )

    supplied = (
        creds.credentials
        if creds is not None and creds.scheme.lower() == "bearer"
        else None
    )
    if supplied is None or not secrets.compare_digest(supplied, expected):
        recent.append(now)
        _failed_auth[client_ip] = recent
        raise HTTPException(status_code=401, detail="Invalid or missing API token")

    # Successful auth clears the failure history for this IP.
    _failed_auth.pop(client_ip, None)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Load ML models once on startup, tear down on shutdown."""
    global _config, _stt, _tts, _audio, _brain, _writer, _command_parser

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    _config = get_config()
    logger.info("Plan: %s", _config.plan)

    _stt = FasterWhisperSTT(_config)
    _tts = PiperTTS(_config)
    _audio = AudioEngine(_config)
    _brain = BrainManager(_config)
    _writer = FileWriter(_config)
    _command_parser = CommandParser()

    # Load ML models in background to avoid blocking the event loop
    await asyncio.gather(_stt.load(), _tts.load())
    logger.info("All models loaded")

    yield

    # Shutdown
    if _bot:
        await _bot.leave_meeting()
    await _brain.close()
    logger.info("Shutdown complete")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
# When the API is protected by a token (public exposure), also disable the
# auto-generated docs surface so the API schema is not world-readable.
_api_protected = bool(os.getenv("API_TOKEN", ""))

app = FastAPI(
    title="Meeting Bot",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None if _api_protected else "/docs",
    redoc_url=None if _api_protected else "/redoc",
    openapi_url=None if _api_protected else "/openapi.json",
)

# CORS is opt-in via CORS_ORIGINS (comma-separated). Browsers calling this API
# authenticate with the Authorization header, which does not need the
# credentials mode, so allow_credentials stays off.
_cors_origins = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()
]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class JoinRequest(BaseModel):
    url: str = Field(..., description="Meeting URL")
    platform: str = Field("meet", description="'meet' or 'teams'")
    bot_name: str = Field("MeetingBot", description="Display name")


class CommandRequest(BaseModel):
    command: str = Field(..., description="Command string")


class StatusResponse(BaseModel):
    meeting_id: str = ""
    platform: str = ""
    running: bool = False
    transcript_lines: int = 0
    last_diagnostics: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.post("/bot/join")
async def bot_join(
    req: JoinRequest,
    _token: None = Depends(require_token),
) -> dict[str, str]:
    """Start the bot worker and join a meeting."""
    global _bot, _chat

    if _bot and _bot._running:
        raise HTTPException(status_code=409, detail="Bot already in a meeting")

    _chat = ChatHandler(page=None, platform=req.platform)  # type: ignore[arg-type]

    _bot = MeetingBot(
        config=_config,
        stt=_stt,
        tts=_tts,
        audio=_audio,
        brain=_brain,
        chat_handler=_chat,
    )

    try:
        meeting_id = await _bot.join_meeting(
            url=req.url,
            platform=req.platform,
            bot_name=req.bot_name,
        )
    except Exception as exc:
        # join_meeting() already dumped diagnostics (screenshot + HTML) to
        # output/ when a page existed; clean up so a retry gets a fresh bot.
        logger.exception("Failed to join meeting (diagnostics in output/)")
        _bot = None
        _chat = None
        raise HTTPException(
            status_code=503,
            detail=f"Failed to join meeting: {exc}",
        ) from exc

    # Inject the real page into the chat handler now that we have one
    if _chat and _bot._page:
        _chat._page = _bot._page
        await _chat.start_polling()

    # Start the processing loop in the background
    asyncio.create_task(_bot._handle_meeting_loop())

    return {"meeting_id": meeting_id, "status": "joined"}


@app.post("/bot/leave")
async def bot_leave(
    _token: None = Depends(require_token),
) -> dict[str, str]:
    """Stop the bot worker and leave the meeting."""
    global _bot, _chat

    if _bot is None or not _bot._running:
        raise HTTPException(status_code=404, detail="No active meeting")

    if _chat:
        await _chat.stop_polling()

    meeting_id = _bot._meeting_id
    transcript = _bot.transcript

    await _bot.leave_meeting()

    # Persist transcript
    if transcript:
        _writer.save_transcript(meeting_id, transcript)

    _bot = None
    _chat = None

    return {"meeting_id": meeting_id, "status": "left"}


@app.get("/bot/status", response_model=StatusResponse)
async def bot_status(
    _token: None = Depends(require_token),
) -> StatusResponse:
    """Return current bot state."""
    if _bot is None:
        return StatusResponse()

    return StatusResponse(
        meeting_id=_bot._meeting_id,
        platform=_bot._platform,
        running=_bot._running,
        transcript_lines=len(_bot.transcript),
        last_diagnostics=_bot.last_diagnostics,
    )


@app.get("/bot/transcript")
async def bot_transcript(
    _token: None = Depends(require_token),
) -> list[dict[str, str]]:
    """Return the full transcript so far."""
    if _bot is None:
        return []
    return _bot.transcript


@app.post("/bot/command")
async def bot_command(
    req: CommandRequest,
    _token: None = Depends(require_token),
) -> dict[str, Any]:
    """Send a command to the bot brain."""
    parsed = _command_parser.parse(req.command)

    if parsed["command"] == "unknown":
        return {"error": "unrecognised command", "parsed": parsed}

    if _bot is None:
        raise HTTPException(status_code=404, detail="No active meeting")

    response = await _brain.think(
        transcript=req.command,
        context={"meeting_id": _bot._meeting_id},
        command=parsed,
    )

    # Dispatch side-effects
    if parsed["command"] == "take_notes":
        notes_text = response or req.command
        path = _writer.save_notes(_bot._meeting_id, notes_text)
        return {"action": "notes_saved", "path": str(path), "response": response}

    if parsed["command"] == "generate_report":
        path = _writer.save_report(_bot._meeting_id, response or "No report generated.")
        return {"action": "report_saved", "path": str(path), "response": response}

    if parsed["command"] == "summarize":
        path = _writer.save_report(_bot._meeting_id, response or "No summary available.")
        return {"action": "summary_saved", "path": str(path), "response": response}

    return {"action": parsed["command"], "response": response}


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Direct uvicorn invocation
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        log_level="info",
    )

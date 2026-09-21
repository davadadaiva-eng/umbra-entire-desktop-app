"""FastAPI application entry point for the meeting bot."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
app = FastAPI(
    title="Meeting Bot",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.post("/bot/join")
async def bot_join(req: JoinRequest) -> dict[str, str]:
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

    meeting_id = await _bot.join_meeting(
        url=req.url,
        platform=req.platform,
        bot_name=req.bot_name,
    )

    # Inject the real page into the chat handler now that we have one
    if _chat and _bot._page:
        _chat._page = _bot._page
        await _chat.start_polling()

    # Start the processing loop in the background
    asyncio.create_task(_bot._handle_meeting_loop())

    return {"meeting_id": meeting_id, "status": "joined"}


@app.post("/bot/leave")
async def bot_leave() -> dict[str, str]:
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
async def bot_status() -> StatusResponse:
    """Return current bot state."""
    if _bot is None:
        return StatusResponse()

    return StatusResponse(
        meeting_id=_bot._meeting_id,
        platform=_bot._platform,
        running=_bot._running,
        transcript_lines=len(_bot.transcript),
    )


@app.get("/bot/transcript")
async def bot_transcript() -> list[dict[str, str]]:
    """Return the full transcript so far."""
    if _bot is None:
        return []
    return _bot.transcript


@app.post("/bot/command")
async def bot_command(req: CommandRequest) -> dict[str, Any]:
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

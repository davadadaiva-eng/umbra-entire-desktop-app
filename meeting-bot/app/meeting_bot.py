"""Playwright-driven meeting bot for Google Meet and Microsoft Teams."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from playwright.async_api import Browser, BrowserContext, Page, async_playwright

from app.config import BotConfig

logger = logging.getLogger(__name__)

CHROMIUM_ARGS = [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
    '--js-flags="--max-old-space-size=1500"',
    # --use-fake-ui-for-media-stream auto-accepts the mic permission prompt;
    # the device itself must be the real PulseAudio virtual mic so the bot
    # is audible to other participants.
    "--use-fake-ui-for-media-stream",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
]


class MeetingBot:
    """Drives a headless Chromium instance to join an online meeting."""

    def __init__(
        self,
        config: BotConfig,
        stt: Any,
        tts: Any,
        audio: Any,
        brain: Any,
        chat_handler: Any,
    ) -> None:
        self._config = config
        self._stt = stt
        self._tts = tts
        self._audio = audio
        self._brain = brain
        self._chat = chat_handler

        self._playwright: Any = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None

        self._meeting_id = ""
        self._meeting_url = ""
        self._platform = ""
        self._running = False
        # Wall-clock timestamp until which captured audio should be ignored
        # because it is the bot's own TTS (prevents self-transcription).
        self._bot_talking_until = 0.0
        self._transcript: list[dict[str, Any]] = []

    @property
    def transcript(self) -> list[dict[str, Any]]:
        return list(self._transcript)

    async def join_meeting(
        self,
        url: str,
        platform: str = "meet",
        bot_name: str = "MeetingBot",
    ) -> str:
        """Launch Chromium, navigate to the meeting URL, and join.

        Parameters
        ----------
        url:
            Full meeting URL.
        platform:
            ``"meet"`` or ``"teams"``.
        bot_name:
            Display name shown in the meeting.

        Returns
        -------
        str
            The meeting ID assigned to this session.
        """
        self._meeting_id = uuid.uuid4().hex[:12]
        self._meeting_url = url
        self._platform = platform.lower()
        self._running = True

        logger.info(
            "Joining %s meeting: %s (id=%s)", self._platform, url, self._meeting_id
        )

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=CHROMIUM_ARGS,
        )

        # Load cookies from session_data if available
        cookie_path = Path(self._config.session_data_dir) / f"{self._platform}_cookies.json"
        if cookie_path.exists():
            logger.info("Loading cookies from %s", cookie_path)

        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 720},
            permissions=["microphone", "camera", "notifications"],
        )

        if cookie_path.exists():
            try:
                import json

                cookies = json.loads(cookie_path.read_text(encoding="utf-8"))
                await self._context.add_cookies(cookies)
            except Exception:
                logger.warning("Failed to load cookies from %s", cookie_path)

        self._page = await self._context.new_page()

        # Platform-specific navigation and join flow
        if self._platform == "meet":
            await self._join_google_meet(bot_name)
        elif self._platform == "teams":
            await self._join_teams(bot_name)
        else:
            raise ValueError(f"Unsupported platform: {self._platform}")

        await asyncio.sleep(3)
        logger.info("Successfully joined meeting %s", self._meeting_id)
        return self._meeting_id

    async def _join_google_meet(self, bot_name: str) -> None:
        """Navigate through Google Meet join flow."""
        assert self._page is not None

        await self._page.goto(self._meeting_url, wait_until="networkidle")
        await asyncio.sleep(2)

        # Dismiss cookie banner if present
        try:
            cookie_btn = self._page.locator("button:has-text('Accept')")
            if await cookie_btn.is_visible(timeout=3000):
                await cookie_btn.click()
        except Exception:
            pass

        # Enter name if prompted
        try:
            name_input = self._page.locator('input[aria-label="Your name"]')
            if await name_input.is_visible(timeout=3000):
                await name_input.fill(bot_name)
        except Exception:
            pass

        # NOTE: deliberately NOT muting the microphone here. The bot must
        # be audible to other participants; muting before joining silences
        # the TTS audio Chromium captures from the virtual mic.
        # Click join / ask to join
        try:
            join_btn = self._page.locator(
                'button:has-text("Join now"), '
                'button:has-text("Richiedi di partecipare"), '
                'button:has-text("Ask to join")'
            )
            if await join_btn.is_visible(timeout=5000):
                await join_btn.click()
        except Exception:
            logger.warning("Could not find join button for Google Meet")

    async def _join_teams(self, bot_name: str) -> None:
        """Navigate through Microsoft Teams join flow."""
        assert self._page is not None

        await self._page.goto(self._meeting_url, wait_until="networkidle")
        await asyncio.sleep(2)

        # Dismiss overlays
        try:
            dismiss = self._page.locator(
                'button:has-text("Dismiss"), button:has-text("Chiudi")'
            )
            if await dismiss.is_visible(timeout=3000):
                await dismiss.click()
        except Exception:
            pass

        # Enter name
        try:
            name_input = self._page.locator('input[placeholder*="name"], input[name="name"]')
            if await name_input.is_visible(timeout=3000):
                await name_input.fill(bot_name)
        except Exception:
            pass

        # Join as guest
        try:
            join_btn = self._page.locator(
                'button:has-text("Join now"), '
                'button:has-text("Unisciti adesso")'
            )
            if await join_btn.is_visible(timeout=5000):
                await join_btn.click()
        except Exception:
            logger.warning("Could not find join button for Teams")

    async def leave_meeting(self) -> None:
        """Gracefully disconnect from the meeting and clean up."""
        self._running = False
        logger.info("Leaving meeting %s", self._meeting_id)

        await self._audio.stop_capture()

        # Click the leave/hangup button
        if self._page is not None:
            try:
                leave_btn = self._page.locator(
                    'button[aria-label*="Leave"], '
                    'button[aria-label*="Hang up"], '
                    'button[aria-label*="Esci"]'
                )
                if await leave_btn.is_visible(timeout=3000):
                    await leave_btn.click()
            except Exception:
                logger.debug("Leave button not found; closing page directly")

        await asyncio.sleep(1)

        if self._page:
            await self._page.close()
            self._page = None
        if self._context:
            await self._context.close()
            self._context = None
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None

        logger.info("Meeting bot cleaned up for %s", self._meeting_id)

    async def _handle_meeting_loop(self) -> None:
        """Main processing loop: capture audio -> STT -> brain -> TTS -> inject."""

        async def on_audio_chunk(chunk: bytes) -> None:
            if not self._running:
                return
            # Suppress chunks captured while the bot itself is speaking (+
            # tail) so it never transcribes its own voice.
            if time.monotonic() < self._bot_talking_until:
                logger.debug("Skipping chunk: bot is talking (self-echo guard)")
                return
            try:
                result = await self._stt.transcribe(chunk)
                text = result.get("text", "").strip()
                if not text:
                    return

                entry = {"text": text, "language": result.get("language", "")}
                self._transcript.append(entry)
                logger.info("Transcript: %s", text)

                response = await self._brain.think(
                    transcript=text,
                    context={"meeting_id": self._meeting_id},
                )

                if response:
                    wav_bytes = await self._tts.synthesize(response)
                    duration = await self._audio.inject_audio(wav_bytes)
                    if duration > 0:
                        # Ignore mic audio for the speech duration plus a tail
                        # covering pacat teardown and codec/room latency.
                        self._bot_talking_until = (
                            time.monotonic() + duration + 0.5
                        )
            except Exception:
                logger.exception("Error in meeting audio processing loop")

        await self._audio.start_capture(on_audio_chunk)

        # Keep the loop alive while the meeting is active
        while self._running:
            await asyncio.sleep(1)

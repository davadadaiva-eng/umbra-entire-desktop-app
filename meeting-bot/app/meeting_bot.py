"""Playwright-driven meeting bot for Google Meet and Microsoft Teams."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
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
        self._last_diagnostics: dict[str, Any] = {}
        self._leaving = False

    @property
    def last_diagnostics(self) -> dict[str, Any]:
        """Metadata of the most recent diagnostics dump (empty if none)."""
        return dict(self._last_diagnostics)

    async def _dump_diagnostics(self, reason: str) -> Optional[dict[str, Any]]:
        """Save a screenshot + page HTML from the live page to output/.

        Called whenever the bot fails to enter (or silently drops out of) a
        meeting, so a human can see exactly what headless Chromium saw.
        Never raises: diagnostics must not mask the original failure.
        Returns dump metadata, or None if nothing could be captured.
        """
        page = self._page
        if page is None:
            return None
        try:
            out_dir = Path(self._config.output_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            base = out_dir / f"failure_{self._platform}_{stamp}"

            shot_path = base.with_suffix(".png")
            await page.screenshot(path=str(shot_path), full_page=True)

            html_path = base.with_suffix(".html")
            html_path.write_text(
                await page.content(), encoding="utf-8"
            )

            url = ""
            try:
                url = page.url
            except Exception:
                pass

            info = {
                "reason": reason,
                "meeting_id": self._meeting_id,
                "platform": self._platform,
                "url": url,
                "screenshot": str(shot_path),
                "html": str(html_path),
            }
            (out_dir / f"failure_{self._platform}_{stamp}.json").write_text(
                json.dumps(info, indent=2), encoding="utf-8"
            )
            self._last_diagnostics = info
            logger.warning(
                "Diagnostics saved to %s.png / .html / .json (reason: %s)",
                base,
                reason,
            )
            return info
        except Exception:
            logger.exception("Failed to save join-failure diagnostics")
            return None

    async def _verify_in_meeting(self) -> bool:
        """Heuristically check whether the bot actually entered the meeting.

        Both Meet and Teams change the page structure after a successful
        join; if none of the markers is present shortly after clicking
        "join", the click silently failed (button not found, 'Ask to join'
        still pending, wrong account, ...). We dump diagnostics on failure.
        """
        if self._page is None:
            return False
        try:
            page_url = self._page.url
        except Exception:
            return False

        # URL-based marker (works even if the DOM check races)
        if self._platform == "meet":
            in_meeting = "/landing" not in page_url
        else:
            # Teams: the URL does not change on join, so only the DOM
            # markers below (leave/hangup button visible in-meeting) can
            # confirm success; default to not-in-meeting.
            in_meeting = False

        # DOM markers of the in-meeting UI
        for selector in (
            'button[aria-label*="Leave"]',
            'button[aria-label*="Hang up"]',
            'button[aria-label*="Esci"]',
        ):  # same labels the leave flow uses
            try:
                if await self._page.locator(selector).first.is_visible(timeout=500):
                    in_meeting = True
                    break
            except Exception:
                continue

        if in_meeting:
            return True

        await self._dump_diagnostics("join did not appear to succeed")
        return False
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

        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 720},
            permissions=["microphone", "camera", "notifications"],
        )

        if cookie_path.exists():
            try:
                cookies = self._load_cookies(cookie_path)
                await self._context.add_cookies(cookies)
                logger.info(
                    "Loaded %d cookie(s) from %s", len(cookies), cookie_path
                )
            except FileNotFoundError:
                logger.warning("Cookie file not found: %s", cookie_path)
            except json.JSONDecodeError as exc:
                logger.warning("Cookie file is not valid JSON (%s): %s", cookie_path, exc)
            except Exception as exc:
                logger.warning(
                    "Failed to load cookies from %s: %s", cookie_path, exc
                )

        self._page = await self._context.new_page()

        # Platform-specific navigation and join flow
        try:
            if self._platform == "meet":
                await self._join_google_meet(bot_name)
            elif self._platform == "teams":
                await self._join_teams(bot_name)
            else:
                raise ValueError(f"Unsupported platform: {self._platform}")
        except Exception as exc:
            await self._dump_diagnostics(f"exception during join flow: {exc}")
            raise

        await asyncio.sleep(3)
        joined = await self._verify_in_meeting()
        if joined:
            logger.info("Successfully joined meeting %s", self._meeting_id)
            return self._meeting_id
        logger.error(
            "Failed to enter meeting %s; see output/ diagnostics artifacts",
            self._meeting_id,
        )
        return self._meeting_id

    @staticmethod
    def _load_cookies(cookie_path: Path) -> list[dict[str, Any]]:
        """Read a cookie file and normalize it for Playwright's add_cookies().

        Accepts:
        - the Playwright/storage-state format: {"cookies": [...], "origins": [...]}
        - a plain JSON array of cookies
        - cookie objects as emitted by popular "Export cookies" extensions
          (sameSite values "no_restriction"/"lax"/"strict"/"unspecified",
          camelCase names like expirationDate/session/ hostOnly), which
          add_cookies() would otherwise reject.
        """
        raw = json.loads(cookie_path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            cookies = raw.get("cookies", [])
            if not isinstance(cookies, list):
                raise ValueError("'cookies' key must be a list")
        elif isinstance(raw, list):
            cookies = raw
        else:
            raise ValueError(
                "expected a JSON array of cookies or an object with a 'cookies' list"
            )

        same_site_map = {
            "no_restriction": "None",
            "unspecified": "Lax",
            "lax": "Lax",
            "strict": "Strict",
            "": "Lax",
        }
        normalized: list[dict[str, Any]] = []
        for i, cookie in enumerate(cookies):
            if not isinstance(cookie, dict):
                raise ValueError(f"cookie #{i} is not an object")
            name = cookie.get("name")
            value = cookie.get("value")
            domain = cookie.get("domain") or ""
            path = cookie.get("path") or "/"
            if not name or not domain:
                raise ValueError(
                    f"cookie #{i} is missing 'name' or 'domain' (got keys: {sorted(cookie)})"
                )
            out: dict[str, Any] = {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path,
            }
            if domain.startswith("."):
                out["domain"] = domain
            expires = cookie.get("expires")
            if expires is None and "expirationDate" in cookie:
                expires = cookie["expirationDate"]
            if isinstance(expires, (int, float)) and expires > 0:
                if expires <= time.time():
                    logger.info(
                        "Skipping expired cookie '%s' (domain=%s)", name, domain
                    )
                    continue
                out["expires"] = expires
            # No positive "expires"/"expirationDate" -> session cookie;
            # omitting the key is exactly how Playwright represents those.

            raw_same_site = str(cookie.get("sameSite", "")).strip().lower()
            out["sameSite"] = same_site_map.get(raw_same_site, "Lax")
            if cookie.get("httpOnly") is not None:
                out["httpOnly"] = bool(cookie["httpOnly"])
            if cookie.get("secure") is not None:
                out["secure"] = bool(cookie["secure"])
            normalized.append(out)

        if not normalized:
            raise ValueError("no usable (non-expired) cookies in file")
        return normalized

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
            await self._dump_diagnostics("Google Meet join button not found")

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
            await self._dump_diagnostics("Teams join button not found")

    async def leave_meeting(self) -> None:
        """Gracefully disconnect from the meeting and clean up."""
        self._leaving = True
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

        # _running went False while the page was still open and this was not
        # a graceful leave: the meeting ended or the tab was closed under us.
        # Capture what the page looked like at that moment.
        if self._page is not None and not self._leaving:
            await self._dump_diagnostics(
                "meeting ended unexpectedly (tab closed or removed)"
            )

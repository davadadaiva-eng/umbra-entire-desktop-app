"""Playwright-based chat polling and message injection."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from playwright.async_api import Page

logger = logging.getLogger(__name__)

# Platform-specific CSS selectors for the chat input and message list
_SELECTORS: dict[str, dict[str, str]] = {
    "meet": {
        "message_list": 'div[role="log"] div.r4nke',
        "chat_input": 'div[contenteditable="true"][aria-label*="message"], '
                       'div[contenteditable="true"][aria-label*="Messaggio"]',
        "send_button": 'button[aria-label*="Send"], button[aria-label*="Invia"]',
    },
    "teams": {
        "message_list": 'div[data-tid="chat-list"] div.ms-List-cell',
        "chat_input": 'div[contenteditable="true"][role="textbox"]',
        "send_button": 'button[aria-label*="Send"], button[aria-label*="Invia"]',
    },
}


class ChatHandler:
    """Polls and sends messages in the meeting chat panel.

    Parameters
    ----------
    config:
        Bot configuration (used for poll interval, etc.).
    page:
        Playwright :class:`Page` instance with the meeting open.
    platform:
        ``"meet"`` or ``"teams"``.
    poll_interval:
        Seconds between chat poll cycles.
    """

    def __init__(
        self,
        page: Page,
        platform: str = "meet",
        poll_interval: float = 2.0,
    ) -> None:
        self._page = page
        self._platform = platform.lower()
        self._poll_interval = poll_interval
        self._seen_count = 0
        self._running = False
        self._poll_task: Optional[asyncio.Task[None]] = None

        selectors = _SELECTORS.get(self._platform, _SELECTORS["meet"])
        self._msg_list_sel = selectors["message_list"]
        self._input_sel = selectors["chat_input"]
        self._send_sel = selectors["send_button"]

    async def poll_chat(self) -> list[dict[str, str]]:
        """Return new messages since the last poll.

        Returns
        -------
        list[dict[str, str]]
            List of ``{"sender": str, "text": str}`` dicts.
        """
        messages: list[dict[str, str]] = []

        try:
            elements = await self._page.locator(self._msg_list_sel).all()
            new_elements = elements[self._seen_count:]
            self._seen_count = len(elements)

            for el in new_elements:
                raw = (await el.inner_text()).strip()
                if not raw:
                    continue

                # Best-effort parse: "Name: message text"
                if ": " in raw:
                    sender, text = raw.split(": ", 1)
                else:
                    sender = "unknown"
                    text = raw

                messages.append({"sender": sender, "text": text})

        except Exception:
            logger.debug("Chat poll encountered no messages or selector mismatch")

        return messages

    async def send_message(self, text: str) -> None:
        """Type and send a message into the meeting chat.

        Parameters
        ----------
        text:
            Message body to send.
        """
        if not text or not text.strip():
            return

        try:
            # Try to open the chat panel if collapsed (best-effort)
            try:
                chat_toggle = self._page.locator(
                    'button[aria-label*="Chat"], button[aria-label*="Chat"]'
                )
                if await chat_toggle.is_visible(timeout=1000):
                    await chat_toggle.click()
                    await asyncio.sleep(0.5)
            except Exception:
                pass

            input_el = self._page.locator(self._input_sel).first
            await input_el.click()
            await input_el.fill(text)
            await asyncio.sleep(0.2)

            # Press Enter to send (most platforms accept this)
            await input_el.press("Enter")
            logger.info("Chat message sent: %s", text[:80])
        except Exception:
            logger.exception("Failed to send chat message")

    async def start_polling(self) -> None:
        """Start a background polling loop that logs incoming messages."""
        if self._running:
            return

        self._running = True
        self._poll_task = asyncio.create_task(self._poll_loop())
        logger.info("Chat polling started (interval=%.1fs)", self._poll_interval)

    async def _poll_loop(self) -> None:
        while self._running:
            new_msgs = await self.poll_chat()
            for msg in new_msgs:
                logger.info("Chat [%s]: %s", msg["sender"], msg["text"])
            await asyncio.sleep(self._poll_interval)

    async def stop_polling(self) -> None:
        """Stop the background polling loop."""
        self._running = False
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        logger.info("Chat polling stopped")

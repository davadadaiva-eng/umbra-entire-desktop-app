"""LLM-backed brain manager for the meeting bot."""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.config import BotConfig

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are an intelligent meeting assistant. You receive live transcripts "
    "from an online meeting and produce concise, useful responses. "
    "Keep replies brief (1-3 sentences) unless the user asks for more detail. "
    "Always respond in the same language as the transcript."
)


class BrainManager:
    """Sends transcript fragments to an LLM endpoint and returns responses."""

    def __init__(self, config: BotConfig) -> None:
        self._config = config
        self._client: httpx.AsyncClient | None = None
        self._conversation_history: list[dict[str, str]] = []

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def think(
        self,
        transcript: str,
        context: Optional[dict[str, Any]] = None,
        command: Optional[dict[str, Any]] = None,
    ) -> str:
        """Send a transcript fragment to the LLM and return the response.

        Parameters
        ----------
        transcript:
            The latest transcribed text.
        context:
            Optional context dict (meeting_id, participants, etc.).
        command:
            Parsed command dict if the user issued a directive.

        Returns
        -------
        str
            LLM response text, or empty string on failure.
        """
        if not transcript or not transcript.strip():
            return ""

        messages = self._build_messages(transcript, context, command)

        if self._config.llm_webhook_url:
            return await self._send_webhook(transcript, context, command)

        if not self._config.llm_api_key:
            logger.warning("No LLM API key configured; returning canned response")
            return self._fallback_response(transcript, command)

        try:
            return await self._call_llm(messages)
        except Exception:
            logger.exception("LLM call failed; falling back")
            return self._fallback_response(transcript, command)

    def _build_messages(
        self,
        transcript: str,
        context: Optional[dict[str, Any]],
        command: Optional[dict[str, Any]],
    ) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]

        # Include conversation history (last 20 turns)
        messages.extend(self._conversation_history[-20:])

        user_content = transcript
        if command and command.get("command") != "unknown":
            user_content = f"[COMMAND: {command['command']}] {transcript}"

        if context:
            context_str = ", ".join(f"{k}={v}" for k, v in context.items())
            user_content = f"[Context: {context_str}] {user_content}"

        messages.append({"role": "user", "content": user_content})
        return messages

    async def _call_llm(self, messages: list[dict[str, str]]) -> str:
        """Make the HTTP POST to the chat completions endpoint."""
        client = await self._ensure_client()

        payload: dict[str, Any] = {
            "model": self._config.llm_model,
            "messages": messages,
            "max_tokens": 300,
            "temperature": 0.7,
        }

        headers = {
            "Authorization": f"Bearer {self._config.llm_api_key}",
            "Content-Type": "application/json",
        }

        response = await client.post(
            self._config.llm_api_url,
            json=payload,
            headers=headers,
        )
        response.raise_for_status()

        data = response.json()
        assistant_msg = data["choices"][0]["message"]["content"].strip()

        # Maintain rolling conversation history
        messages_without_system = [m for m in messages if m["role"] != "system"]
        self._conversation_history.extend(messages_without_system)
        self._conversation_history.append({"role": "assistant", "content": assistant_msg})

        # Trim to last 40 entries
        self._conversation_history = self._conversation_history[-40:]

        return assistant_msg

    async def _send_webhook(
        self,
        transcript: str,
        context: Optional[dict[str, Any]],
        command: Optional[dict[str, Any]],
    ) -> str:
        """Post transcript to an external webhook for processing."""
        client = await self._ensure_client()

        payload: dict[str, Any] = {
            "transcript": transcript,
            "meeting_id": context.get("meeting_id", "") if context else "",
            "command": command,
        }

        try:
            response = await client.post(
                self._config.llm_webhook_url,
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()
            return response.json().get("response", "")
        except Exception:
            logger.exception("Webhook call failed")
            return ""

    @staticmethod
    def _fallback_response(transcript: str, command: Optional[dict[str, Any]]) -> str:
        """Return a canned response when the LLM is unavailable."""
        if command and command.get("command") == "what_did_i_miss":
            return "I'm currently unable to access the meeting history. The LLM backend is unavailable."
        if command and command.get("command") == "summarize":
            return "I'd like to summarise the conversation, but my brain module is offline right now."
        return ""

    async def close(self) -> None:
        """Shut down the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()

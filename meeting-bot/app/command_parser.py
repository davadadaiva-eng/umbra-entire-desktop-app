"""Regex-based command parser for bot directives."""

from __future__ import annotations

import re
from typing import Any

# Pattern -> (command_name, arg_extractor)
# arg_extractor receives the regex match and returns the args dict.
_COMMAND_PATTERNS: list[tuple[str, str, Any]] = [
    # "bot take notes" / "bot, take notes" / "/take_notes"
    (r"(?:bot[,.]?\s+|/)take[_\s]?notes?\b", "take_notes", lambda m: {}),
    # "bot generate report" / "bot, generate report"
    (r"(?:bot[,.]?\s+|/)generate[_\s]?report\b", "generate_report", lambda m: {}),
    # "bot summarise" / "bot summarize this"
    (r"(?:bot[,.]?\s+|/)summar(?:ise|ize)\b", "summarize", lambda m: {}),
    # "what did I miss" / "bot what did I miss"
    (r"(?:bot[,.]?\s+|/)what[_\s]?did[_\s]?I[_\s]?miss\b", "what_did_i_miss", lambda m: {}),
]


class CommandParser:
    """Extracts structured commands from free-text speech.

    Parameters
    ----------
    prefix:
        Optional command prefix that triggers command mode (default: ``"bot"``).
    """

    def __init__(self, prefix: str = "bot") -> None:
        self._prefix = prefix
        self._compiled: list[tuple[re.Pattern[str], str, Any]] = []
        for pattern, cmd, extractor in _COMMAND_PATTERNS:
            self._compiled.append((re.compile(pattern, re.IGNORECASE), cmd, extractor))

    def parse(self, text: str) -> dict[str, Any]:
        """Parse *text* and return a structured command dict.

        Returns
        -------
        dict
            ``{"command": str, "args": dict, "confidence": float}``

        ``command`` is one of:
        ``take_notes``, ``generate_report``, ``summarize``,
        ``what_did_i_miss``, ``unknown``.
        """
        if not text or not text.strip():
            return {"command": "unknown", "args": {}, "confidence": 0.0}

        cleaned = text.strip()

        for regex, cmd_name, extractor in self._compiled:
            match = regex.search(cleaned)
            if match:
                args = extractor(match)
                return {
                    "command": cmd_name,
                    "args": args,
                    "confidence": 0.9,
                }

        # Loose keyword fallback
        lowered = cleaned.lower()
        if any(kw in lowered for kw in ("note", "notes", "annota")):
            return {"command": "take_notes", "args": {}, "confidence": 0.5}
        if any(kw in lowered for kw in ("report", "rapporto")):
            return {"command": "generate_report", "args": {}, "confidence": 0.5}
        if any(kw in lowered for kw in ("summarise", "summarize", "riassum")):
            return {"command": "summarize", "args": {}, "confidence": 0.5}
        if any(kw in lowered for kw in ("miss", "perso", "reminder")):
            return {"command": "what_did_i_miss", "args": {}, "confidence": 0.5}

        return {"command": "unknown", "args": {}, "confidence": 0.0}

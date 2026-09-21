"""Persistence layer for transcripts, reports, and notes."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import BotConfig

logger = logging.getLogger(__name__)


class FileWriter:
    """Writes meeting artefacts to ``output/{meeting_id}/``."""

    def __init__(self, config: BotConfig) -> None:
        self._base_dir = Path(config.output_dir)

    def _meeting_dir(self, meeting_id: str) -> Path:
        """Return (and create) the output directory for *meeting_id*."""
        d = self._base_dir / meeting_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def save_transcript(
        self, meeting_id: str, transcript_lines: list[dict[str, Any]]
    ) -> Path:
        """Persist the full transcript as a JSON lines file.

        Parameters
        ----------
        meeting_id:
            Unique meeting identifier.
        transcript_lines:
            List of ``{"text": ..., "language": ...}`` dicts.

        Returns
        -------
        Path
            Absolute path to the saved file.
        """
        import json

        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        filename = f"transcript_{ts}.jsonl"
        filepath = self._meeting_dir(meeting_id) / filename

        with filepath.open("w", encoding="utf-8") as fh:
            for entry in transcript_lines:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

        logger.info("Transcript saved to %s", filepath)
        return filepath

    def save_report(self, meeting_id: str, report_text: str) -> Path:
        """Persist a generated report as a Markdown file.

        Returns
        -------
        Path
            Absolute path to the saved file.
        """
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        filename = f"report_{ts}.md"
        filepath = self._meeting_dir(meeting_id) / filename

        filepath.write_text(report_text, encoding="utf-8")
        logger.info("Report saved to %s", filepath)
        return filepath

    def save_notes(self, meeting_id: str, notes_text: str) -> Path:
        """Persist extracted notes as a Markdown file.

        Returns
        -------
        Path
            Absolute path to the saved file.
        """
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        filename = f"notes_{ts}.md"
        filepath = self._meeting_dir(meeting_id) / filename

        filepath.write_text(notes_text, encoding="utf-8")
        logger.info("Notes saved to %s", filepath)
        return filepath

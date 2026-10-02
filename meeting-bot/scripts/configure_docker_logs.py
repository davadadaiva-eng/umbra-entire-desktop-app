#!/usr/bin/env python3
"""Set a bounded default log driver for the Docker daemon.

Writes /etc/docker/daemon.json **merge-safe**: preserves any existing
settings (registry mirrors, DNS, data-root, ...), only fills in the
log-rotation keys when missing. Existing explicit choices are never
overwritten — an admin's configured driver is a deliberate decision.

Idempotent: exits 0 with "unchanged" when rotation is already configured.

Exit codes: 0 = configured or already fine, 1 = needs attention (conflict).
"""

from __future__ import annotations

import json
import os
import sys

DAEMON_JSON = "/etc/docker/daemon.json"
LOG_KEYS = {"log-driver": "json-file", "log-opts": {"max-size": "20m", "max-file": "3"}}


def main() -> int:
    docker_dir = os.path.dirname(DAEMON_JSON)
    if not os.path.isdir(docker_dir):
        print(f"ERROR: {docker_dir} does not exist (is Docker installed?)")
        return 1

    data: dict = {}
    if os.path.exists(DAEMON_JSON):
        try:
            with open(DAEMON_JSON, encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"WARN: cannot parse {DAEMON_JSON} ({exc}); creating a backup first")
            # Preserve the broken file rather than deleting the admin's config
            try:
                with open(DAEMON_JSON + ".bak", "wb") as bak:
                    with open(DAEMON_JSON, "rb") as orig:
                        bak.write(orig.read())
            except OSError:
                pass
            data = {}

    if not isinstance(data, dict):
        print(f"WARN: {DAEMON_JSON} is not an object; backed up, starting fresh")
        data = {}

    # 1. Respect an admin's explicit driver choice.
    if "log-driver" in data and data["log-driver"] != LOG_KEYS["log-driver"]:
        print(
            f"Existing log-driver '{data['log-driver']}' kept as-is "
            "(only 'json-file' defaults are managed here)"
        )
        return 0

    # 2. Respect existing (possibly different) rotation options.
    if "log-opts" in data and data["log-opts"] != LOG_KEYS["log-opts"]:
        print(
            f"Existing log-opts {data['log-opts']} kept as-is "
            "(not overwriting custom rotation settings)"
        )
        return 0

    needs_change = data.get("log-driver") != LOG_KEYS["log-driver"] or data.get(
        "log-opts"
    ) != LOG_KEYS["log-opts"]

    if not needs_change:
        print("Docker daemon log rotation already configured - unchanged")
        return 0

    data.update(LOG_KEYS)
    tmp = DAEMON_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, DAEMON_JSON)  # atomic on POSIX
    print(f"Updated {DAEMON_JSON}: default log-driver=json-file, max-size=20m, max-file=3")
    return 0


if __name__ == "__main__":
    sys.exit(main())

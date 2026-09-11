#!/usr/bin/env python3
"""Apply host settings without discarding native workspace trust."""

import json
import os
import sys
from pathlib import Path

seed = Path.home() / ".babysit-antigravity-settings.json"
try:
    path = Path.home() / ".gemini/antigravity-cli/settings.json"
    if seed.exists() or os.environ.get("GEMINI_API_KEY"):
        existing = json.loads(path.read_text()) if path.exists() else {}
        settings = json.loads(seed.read_text()) if seed.exists() else existing
        if not isinstance(existing, dict) or not isinstance(settings, dict):
            raise ValueError("Antigravity settings must be an object")
        # Trust was explicitly accepted in this workspace. Host snapshots must
        # not reset that choice on every container recreation.
        trust = existing.get("trustedWorkspaces", [])
        host_trust = settings.get("trustedWorkspaces", [])
        if not isinstance(trust, list) or not isinstance(host_trust, list):
            raise ValueError("Antigravity trustedWorkspaces must be an array")
        if trust or host_trust:
            settings["trustedWorkspaces"] = list(dict.fromkeys(trust + host_trust))
        if os.environ.get("GEMINI_API_KEY"):
            settings["modelProvider"] = "gemini"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(settings) + "\n")
        seed.unlink(missing_ok=True)
except (OSError, ValueError, TypeError) as error:
    print(f"Antigravity settings setup failed: {error}", file=sys.stderr)
    command = sys.argv[1:]
    primary = command[:1] == ["agy"] or command[1:4] == [
        "/home/node/.babysit-capture/capture.py", "launch", "antigravity"
    ]
    # Secondary CLI setup must not prevent another frontend from starting.
    sys.exit(1 if primary else 0)

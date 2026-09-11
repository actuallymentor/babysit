#!/usr/bin/env python3
"""Select the API provider after host rc/environment credentials are loaded."""

import json
import os
from pathlib import Path

if os.environ.get("GEMINI_API_KEY"):
    path = Path.home() / ".gemini/antigravity-cli/settings.json"
    settings = json.loads(path.read_text()) if path.exists() else {}
    settings["modelProvider"] = "gemini"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings) + "\n")

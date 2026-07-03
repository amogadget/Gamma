"""Central configuration. Everything tunable comes from environment variables."""

import os
from pathlib import Path

# Where all persistent state lives: users.db, users/<name>/{pages.db,data.db,uploads/}.
# Defaults to the backend/ directory for backward compatibility with existing installs.
DATA_DIR = Path(os.environ.get("GAMMA_DATA_DIR", "") or Path(__file__).resolve().parent.parent)
USERS_DB = DATA_DIR / "users.db"
USERS_DIR = DATA_DIR / "users"

# Built frontend (vite dist/). When set and the directory exists, the backend
# serves it as an SPA — no separate static file server or reverse proxy needed.
STATIC_DIR = os.environ.get("GAMMA_STATIC_DIR", "")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

# AI chat: any Anthropic-Messages-API-compatible endpoint (Anthropic, DeepSeek, ...).
AI_API_KEY = os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
AI_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
AI_MODEL = os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash")

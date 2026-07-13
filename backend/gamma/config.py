"""Central configuration. Everything tunable comes from environment variables."""

import os
from pathlib import Path

# Where all persistent state lives: users.db, users/<name>/{pages.db,data.db,uploads/}.
# Defaults to a data/ folder at the repo root — the local mirror of Docker's /data
# volume. Override with GAMMA_DATA_DIR (the Docker image sets it to /data).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("GAMMA_DATA_DIR", "") or _REPO_ROOT / "data")
USERS_DB = DATA_DIR / "users.db"
USERS_DIR = DATA_DIR / "users"

# Built frontend (vite dist/). When set and the directory exists, the backend
# serves it as an SPA — no separate static file server or reverse proxy needed.
STATIC_DIR = os.environ.get("GAMMA_STATIC_DIR", "")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

# --- AI chat -----------------------------------------------------------------
# AI configuration is per-user, not env: each user adds provider entries in the
# GUI (Settings → AI providers) — a wire protocol + API key + optional label,
# base URL, and model list — stored server-side in their data.db and resolved
# per request by gamma/ai_settings.ai_runtime(). Two wire protocols exist:
#   "anthropic" — Anthropic Messages API (Anthropic, DeepSeek, Kimi, GLM, ...)
#   "openai"    — OpenAI Chat Completions API (OpenAI and compatible)
# The env can only override each protocol's default base URL (shown as the
# placeholder in the GUI and used when an entry leaves it blank):
#   GAMMA_AI_ANTHROPIC_BASE_URL / GAMMA_AI_OPENAI_BASE_URL
# (legacy GAMMA_AI_BASE_URL / ANTHROPIC_BASE_URL alias the anthropic slot).

_legacy_url = os.environ.get("GAMMA_AI_BASE_URL", "") or os.environ.get("ANTHROPIC_BASE_URL", "")

AI_PROTOCOLS = {
    "anthropic": {
        "label": "Anthropic Messages API",
        "base_url": (os.environ.get("GAMMA_AI_ANTHROPIC_BASE_URL", "") or _legacy_url
                     or "https://api.anthropic.com").rstrip("/"),
        "default_model": "claude-haiku-4-5-20251001",
    },
    "openai": {
        "label": "OpenAI Chat Completions API",
        "base_url": (os.environ.get("GAMMA_AI_OPENAI_BASE_URL", "")
                     or "https://api.openai.com").rstrip("/"),
        "default_model": "gpt-4o-mini",
    },
}

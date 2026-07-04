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

# AI chat. Two wire protocols are supported, selected by GAMMA_AI_PROVIDER:
#   "anthropic" (default) — Anthropic Messages API (Anthropic, DeepSeek, Kimi, GLM, ...)
#   "openai"              — OpenAI Chat Completions API (OpenAI and compatible)
# The ANTHROPIC_* names are legacy aliases kept for existing deployments.
AI_PROVIDER = os.environ.get("GAMMA_AI_PROVIDER", "anthropic").strip().lower()

_DEFAULTS = {
    "anthropic": ("https://api.anthropic.com", "claude-haiku-4-5-20251001"),
    "openai": ("https://api.openai.com", "gpt-4o-mini"),
}
if AI_PROVIDER not in _DEFAULTS:
    raise ValueError(f"GAMMA_AI_PROVIDER must be 'anthropic' or 'openai', got {AI_PROVIDER!r}")
_default_base_url, _default_model = _DEFAULTS[AI_PROVIDER]

AI_API_KEY = os.environ.get("GAMMA_AI_API_KEY", "") or os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
AI_BASE_URL = (os.environ.get("GAMMA_AI_BASE_URL", "")
               or os.environ.get("ANTHROPIC_BASE_URL", "")
               or _default_base_url).rstrip("/")
AI_MODEL = (os.environ.get("GAMMA_AI_MODEL", "")
            or os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "")
            or _default_model)

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

# Contact email sent to polite-pool APIs (Unpaywall open-access lookup).
# Set your real address — it's only used to identify this instance to those services.
CONTACT_EMAIL = os.environ.get("GAMMA_CONTACT_EMAIL", "gamma-pdf-annotator@example.com")

# --- AI chat -----------------------------------------------------------------
# Two wire protocols, each independently configurable so both can be offered at
# once in the chat panel's model switcher:
#   "anthropic" — Anthropic Messages API (Anthropic, DeepSeek, Kimi, GLM, ...)
#   "openai"    — OpenAI Chat Completions API (OpenAI and compatible)
#
#   GAMMA_AI_ANTHROPIC_API_KEY / GAMMA_AI_ANTHROPIC_BASE_URL
#   GAMMA_AI_OPENAI_API_KEY    / GAMMA_AI_OPENAI_BASE_URL
#   GAMMA_AI_MODELS = comma-separated "provider:model" entries, e.g.
#                     "anthropic:claude-haiku-4-5-20251001,openai:gpt-5.5"
#                     (bare model names use GAMMA_AI_PROVIDER; the first entry
#                     is the default model)
#
# Legacy single-provider names (GAMMA_AI_API_KEY/GAMMA_AI_BASE_URL/GAMMA_AI_MODEL
# and the ANTHROPIC_* aliases) still work: they configure the GAMMA_AI_PROVIDER
# slot, so existing .env files keep working unchanged.

_PROVIDER_DEFAULTS = {
    "anthropic": ("https://api.anthropic.com", "claude-haiku-4-5-20251001"),
    "openai": ("https://api.openai.com", "gpt-4o-mini"),
}

AI_PROVIDER = os.environ.get("GAMMA_AI_PROVIDER", "anthropic").strip().lower()
if AI_PROVIDER not in _PROVIDER_DEFAULTS:
    raise ValueError(f"GAMMA_AI_PROVIDER must be 'anthropic' or 'openai', got {AI_PROVIDER!r}")

_legacy_key = os.environ.get("GAMMA_AI_API_KEY", "") or os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
_legacy_url = os.environ.get("GAMMA_AI_BASE_URL", "") or os.environ.get("ANTHROPIC_BASE_URL", "")

AI_PROVIDERS = {}
for _name, (_url, _model) in _PROVIDER_DEFAULTS.items():
    _key = os.environ.get(f"GAMMA_AI_{_name.upper()}_API_KEY", "")
    _base = os.environ.get(f"GAMMA_AI_{_name.upper()}_BASE_URL", "")
    if _name == AI_PROVIDER:  # legacy single-provider vars fill the default provider's slot
        _key = _key or _legacy_key
        _base = _base or _legacy_url
    AI_PROVIDERS[_name] = {
        "api_key": _key,
        "base_url": (_base or _url).rstrip("/"),
        "default_model": _model,
    }


def _parse_model_entry(entry: str):
    """'provider:model' or bare 'model' (uses GAMMA_AI_PROVIDER) → (provider, model)."""
    provider, sep, model = entry.partition(":")
    if sep and provider.strip().lower() in _PROVIDER_DEFAULTS:
        return provider.strip().lower(), model.strip()
    return AI_PROVIDER, entry.strip()


# Ordered model registry for the chat panel: [{"id": "openai:gpt-5.5", ...}, ...].
# The first entry is the default. GAMMA_AI_MODEL / ANTHROPIC_DEFAULT_HAIKU_MODEL
# (legacy) seed the list; unset everything → each configured provider's default.
_model_entries = []
_legacy_model = os.environ.get("GAMMA_AI_MODEL", "") or os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "")
if _legacy_model:
    _model_entries.append(_parse_model_entry(_legacy_model))
for _e in os.environ.get("GAMMA_AI_MODELS", "").split(","):
    if _e.strip():
        _model_entries.append(_parse_model_entry(_e))
if not _model_entries:
    for _name, _conf in AI_PROVIDERS.items():
        if _conf["api_key"]:
            _model_entries.append((_name, _conf["default_model"]))
if not _model_entries:  # nothing configured at all — placeholder for the default provider
    _model_entries.append((AI_PROVIDER, AI_PROVIDERS[AI_PROVIDER]["default_model"]))

AI_MODELS = []
for _provider, _model in _model_entries:
    _id = f"{_provider}:{_model}"
    if _model and _id not in [m["id"] for m in AI_MODELS]:
        AI_MODELS.append({"id": _id, "provider": _provider, "model": _model})

AI_DEFAULT_MODEL = AI_MODELS[0]

# True when at least one provider has an API key — gates the whole chat feature.
AI_ENABLED = any(c["api_key"] for c in AI_PROVIDERS.values())

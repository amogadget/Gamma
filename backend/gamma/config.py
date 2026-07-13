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

# Contact email sent to polite-pool APIs (Unpaywall open-access lookup).
# Set your real address — it's only used to identify this instance to those services.
CONTACT_EMAIL = os.environ.get("GAMMA_CONTACT_EMAIL", "gamma-pdf-annotator@example.com")

# --- AI chat -----------------------------------------------------------------
# Two wire protocols, both offered in the chat panel's model switcher:
#   "anthropic" — Anthropic Messages API (Anthropic, DeepSeek, Kimi, GLM, ...)
#   "openai"    — OpenAI Chat Completions API (OpenAI and compatible)
#
# API keys are NOT env-configured: each user stores their own via the GUI
# (Settings → AI providers), kept server-side in their data.db and resolved
# per request by gamma/ai_settings.ai_runtime(). The env only sets instance
# defaults users inherit until they override them in the GUI:
#   GAMMA_AI_ANTHROPIC_BASE_URL / GAMMA_AI_OPENAI_BASE_URL
#   GAMMA_AI_MODELS = comma-separated "provider:model" entries, e.g.
#                     "anthropic:claude-haiku-4-5-20251001,openai:gpt-5.5"
#                     (bare model names use GAMMA_AI_PROVIDER; the first entry
#                     is the default model)
# Legacy GAMMA_AI_BASE_URL/ANTHROPIC_BASE_URL and GAMMA_AI_MODEL still work.

_PROVIDER_DEFAULTS = {
    "anthropic": ("https://api.anthropic.com", "claude-haiku-4-5-20251001"),
    "openai": ("https://api.openai.com", "gpt-4o-mini"),
}

AI_PROVIDER = os.environ.get("GAMMA_AI_PROVIDER", "anthropic").strip().lower()
if AI_PROVIDER not in _PROVIDER_DEFAULTS:
    raise ValueError(f"GAMMA_AI_PROVIDER must be 'anthropic' or 'openai', got {AI_PROVIDER!r}")

_legacy_url = os.environ.get("GAMMA_AI_BASE_URL", "") or os.environ.get("ANTHROPIC_BASE_URL", "")

AI_PROVIDERS = {}
for _name, (_url, _model) in _PROVIDER_DEFAULTS.items():
    _base = os.environ.get(f"GAMMA_AI_{_name.upper()}_BASE_URL", "")
    if _name == AI_PROVIDER:  # legacy single-provider var fills the default provider's slot
        _base = _base or _legacy_url
    AI_PROVIDERS[_name] = {
        "base_url": (_base or _url).rstrip("/"),
        "default_model": _model,
    }


def _parse_model_entry(entry: str):
    """'provider:model' or bare 'model' (uses GAMMA_AI_PROVIDER) → (provider, model)."""
    provider, sep, model = entry.partition(":")
    if sep and provider.strip().lower() in _PROVIDER_DEFAULTS:
        return provider.strip().lower(), model.strip()
    return AI_PROVIDER, entry.strip()


def build_ai_models(providers: dict, models_str: str) -> list:
    """Ordered model registry [{"id": "provider:model", "provider", "model"}, ...]
    from a comma-separated "provider:model" list (first entry = default).
    Empty list string → each keyed provider's default model; no keys at all →
    a placeholder for the default provider. `providers` is a per-user merged
    config from gamma/ai_settings.ai_runtime() (entries carry "api_key")."""
    entries = [_parse_model_entry(e) for e in (models_str or "").split(",") if e.strip()]
    if not entries:
        entries = [(name, conf["default_model"]) for name, conf in providers.items() if conf.get("api_key")]
    if not entries:  # nothing configured at all — placeholder for the default provider
        entries = [(AI_PROVIDER, providers[AI_PROVIDER]["default_model"])]
    models = []
    for provider, model in entries:
        mid = f"{provider}:{model}"
        if model and mid not in [m["id"] for m in models]:
            models.append({"id": mid, "provider": provider, "model": model})
    return models


# The env-configured default model list as one canonical string (users inherit
# it until they set their own in the GUI). GAMMA_AI_MODEL /
# ANTHROPIC_DEFAULT_HAIKU_MODEL (legacy) seed the list.
_legacy_model = os.environ.get("GAMMA_AI_MODEL", "") or os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "")
AI_MODELS_ENV = ",".join(
    e.strip() for e in [_legacy_model, *os.environ.get("GAMMA_AI_MODELS", "").split(",")] if e.strip()
)

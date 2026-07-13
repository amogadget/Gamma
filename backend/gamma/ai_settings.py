"""Per-user AI provider settings (GUI-configured API keys, base URLs, models).

Keys are per-user only — there is no env/server-wide key. They live in the
user's data.db under the reserved `ai-settings` prefs key, which the generic
/api/prefs endpoints refuse to serve: the only read path is the masked
GET /api/ai/settings (last 4 characters, never the key itself). data.db is
part of the owner's /api/export backup, which only their session can request.

The env still provides instance defaults users inherit until they override
them in the GUI: base URLs (GAMMA_AI_*_BASE_URL) and the model list
(GAMMA_AI_MODELS).
"""

from .config import AI_MODELS_ENV, AI_PROVIDERS, build_ai_models
from .db import get_pref, set_pref

AI_SETTINGS_PREF_KEY = "ai-settings"

MAX_KEY_LEN = 512
MAX_URL_LEN = 300
MAX_MODELS_LEN = 2000


def load_ai_settings(user: str) -> dict:
    """The user's stored settings: {"providers": {name: {"api_key", "base_url"}}, "models": str}."""
    value, _ = get_pref(user, AI_SETTINGS_PREF_KEY)
    return value if isinstance(value, dict) else {}


def save_ai_settings(user: str, settings: dict):
    set_pref(user, AI_SETTINGS_PREF_KEY, settings)


def ai_runtime(user: str) -> dict:
    """The effective AI config for a request: env defaults (base URLs, model
    list) overlaid with the user's stored settings and keys. Same shape
    everywhere: {"providers": {...}, "models": [registry], "default": entry,
    "enabled": bool}."""
    settings = load_ai_settings(user) if user else {}
    stored = settings.get("providers") or {}
    providers = {}
    for name, conf in AI_PROVIDERS.items():
        u = stored.get(name) or {}
        providers[name] = {
            "api_key": (u.get("api_key") or "").strip(),
            "base_url": ((u.get("base_url") or "").strip() or conf["base_url"]).rstrip("/"),
            "default_model": conf["default_model"],
        }
    models = build_ai_models(providers, (settings.get("models") or "").strip() or AI_MODELS_ENV)
    return {
        "providers": providers,
        "models": models,
        "default": models[0],
        "enabled": any(c["api_key"] for c in providers.values()),
    }

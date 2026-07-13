"""Per-user AI provider entries (GUI-managed API keys).

Users manage a LIST of provider entries (Settings → AI providers), each one:
  {"id", "name", "protocol": "anthropic"|"openai", "api_key",
   "base_url": "" = protocol default, "models": "a, b" = comma list ("" =
   protocol default model), "created_at"}

Entries live in the user's data.db under the reserved `ai-settings` prefs key,
which the generic /api/prefs endpoints refuse to serve: the only read path is
the masked GET /api/ai/settings (last 4 characters, never the key itself).
data.db is part of the owner's /api/export backup, which only their session
can request. There is no env/server-wide key.
"""

import secrets

from .config import AI_PROTOCOLS
from .db import get_pref, set_pref

AI_SETTINGS_PREF_KEY = "ai-settings"

MAX_KEY_LEN = 512
MAX_URL_LEN = 300
MAX_MODELS_LEN = 1000
MAX_NAME_LEN = 60
MAX_PROVIDERS = 20


def load_provider_entries(user: str) -> list:
    value, _ = get_pref(user, AI_SETTINGS_PREF_KEY)
    entries = (value or {}).get("providers") if isinstance(value, dict) else None
    return [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []


def save_provider_entries(user: str, entries: list):
    set_pref(user, AI_SETTINGS_PREF_KEY, {"providers": entries})


def new_provider_id() -> str:
    return secrets.token_urlsafe(6)


def entry_models(entry: dict) -> list:
    """The entry's model names, or its protocol's default model when unset."""
    models = [m.strip() for m in (entry.get("models") or "").split(",") if m.strip()]
    return models or [AI_PROTOCOLS[entry["protocol"]]["default_model"]]


def ai_runtime(user: str) -> dict:
    """The effective AI config for a request, built from the user's provider
    entries: {"providers": {id: {api_key, base_url, protocol, name}},
    "models": [{"id": "<pid>:<model>", "provider": pid, "provider_name",
    "model"}], "default": first model or None, "enabled": bool}."""
    entries = load_provider_entries(user) if user else []
    providers, models = {}, []
    for e in entries:
        protocol = e.get("protocol")
        pid = str(e.get("id") or "")
        key = (e.get("api_key") or "").strip()
        if protocol not in AI_PROTOCOLS or not pid or not key or pid in providers:
            continue
        name = (e.get("name") or "").strip() or AI_PROTOCOLS[protocol]["label"]
        providers[pid] = {
            "api_key": key,
            "base_url": ((e.get("base_url") or "").strip() or AI_PROTOCOLS[protocol]["base_url"]).rstrip("/"),
            "protocol": protocol,
            "name": name,
        }
        for model in entry_models(e):
            mid = f"{pid}:{model}"
            if mid not in [m["id"] for m in models]:
                models.append({"id": mid, "provider": pid, "provider_name": name, "model": model})
    return {
        "providers": providers,
        "models": models,
        "default": models[0] if models else None,
        "enabled": bool(models),
    }

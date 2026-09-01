"""Per-user AI provider entries (GUI-managed API keys).

Users manage a LIST of provider entries (Settings → AI providers), each one:
  {"id", "name", "protocol": "anthropic"|"openai", "api_key",
   "base_url": "" = protocol default, "models": "a, b" = comma list ("" =
   protocol default model), "created_at"}

Entries may also carry "catalog_models" + "catalog_at" — the live model list
auto-fetched from the account by the periodic watcher (routers/ai.py). It is
merged AFTER the hand-edited "models" list, so curated picks stay pinned and
newly released models still reach the chat selector.

Entries live in the user's data.db under the reserved `ai-settings` prefs key,
which the generic /api/prefs endpoints refuse to serve: the only read path is
the masked GET /api/ai/settings (last 4 characters, never the key itself).
data.db is part of the owner's /api/export backup, which only their session
can request. There is no env/server-wide key.
"""

import re
import secrets
import time

from fastapi import HTTPException

from . import chatgpt_oauth
from .config import AI_PROTOCOLS
from .db import get_pref, set_pref

AI_SETTINGS_PREF_KEY = "ai-settings"

MAX_KEY_LEN = 512
MAX_URL_LEN = 300
MAX_MODELS_LEN = 1000
MAX_NAME_LEN = 60
MAX_PROVIDERS = 20
# Cap on the auto-fetched catalog kept per entry — enough to cover every model
# a major provider offers while keeping the chat dropdown usable.
CATALOG_MAX = 120


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


# --- model ordering ------------------------------------------------------------
# Providers list dozens of models and the newest generation is what people
# reach for, so the selector shows newest first instead of the order the
# provider happened to return. Ordering only — nothing is hidden, because a
# cheap older model is the right choice for bulk jobs (translation, metadata)
# and filtering by "generation" would quietly remove exactly those.

_DATE_RE = re.compile(r"(20\d{2})[-_]?(\d{2})[-_]?(\d{2})")
_MAX_GEN = 20  # a "generation" above this is not a version number


def _model_rank(name: str) -> tuple:
    """Sort key for one model name, biggest = newest. Deliberately generic:
    vendors rename things constantly, so this reads version-ish numbers rather
    than hardcoding families.

    ("gpt-5.6" -> 5.6) > ("gpt-5.1" -> 5.1) > ("gpt-4o" -> 4) and
    "claude-haiku-4-5-20251001" -> generation 4.5, dated 20251001.
    """
    raw = str(name or "").lower()
    # A release date is the strongest recency signal; pull it out first so its
    # digits cannot be misread as a generation number.
    date = 0
    m = _DATE_RE.search(raw)
    if m:
        date = int(m.group(1) + m.group(2) + m.group(3))
        raw = raw[:m.start()] + " " + raw[m.end():]
    # "latest"/"newest" aliases track the newest release by definition.
    alias = 1 if re.search(r"latest|newest", raw) else 0
    # Highest version-ish number in what's left: "5.6", "4-5" (claude family
    # generations) or a bare "4"/"3". The trailing exclusion skips sizes and
    # context windows — "70b", "8x7b", "32k", "7m" are not generations, and
    # llama-3.3-70b must not rank above gpt-5.6. Anything above _MAX_GEN is
    # some other number that slipped through (a build id, a parameter count).
    best = (0.0, 0.0)
    for major, minor in re.findall(r"(?<![\d.])(\d{1,2})(?:[.\-_](\d{1,2}))?(?![\dbkmx])", raw):
        cand = (float(major), float(minor or 0))
        if cand[0] <= _MAX_GEN and cand > best:
            best = cand
    # Version first, then release date, and only then the alias: "latest" marks
    # the newest build *within* a family, so it must not lift chatgpt-4o-latest
    # above gpt-5.6.
    return (best[0], best[1], date, alias)


def sort_models_newest_first(names: list) -> list:
    """Model names ordered newest-generation-first, ties keeping their original
    (provider-supplied) order so the result is stable."""
    return [n for _, n in sorted(
        ((_model_rank(n), n) for n in names),
        key=lambda pair: pair[0], reverse=True,
    )]


def entry_catalog(entry: dict) -> list:
    """The auto-fetched model catalog cached on the entry (list of names)."""
    catalog = entry.get("catalog_models")
    if not isinstance(catalog, list):
        return []
    seen, out = set(), []
    for m in catalog:
        name = str(m).strip() if m is not None else ""
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out[:CATALOG_MAX]


def set_entry_catalog(entry: dict, models: list, at: str) -> dict:
    """Persist a fetched catalog + fetch time on the entry (in place)."""
    seen, names = set(), []
    for m in models:
        name = str(m).strip() if m is not None else ""
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    entry["catalog_models"] = names[:CATALOG_MAX]
    entry["catalog_at"] = at
    return entry


def ai_runtime(user: str) -> dict:
    """The effective AI config for a request, built from the user's provider
    entries: {"providers": {id: {api_key, base_url, protocol, name}},
    "models": [{"id": "<pid>:<model>", "provider": pid, "provider_name",
    "model"}], "default": first model or None, "enabled": bool}.

    Each entry contributes its hand-edited `models` list first, then the
    auto-fetched `catalog_models` (periodically refreshed by the background
    watcher) — deduped so a curated model never appears twice. The catalog is
    additive: it keeps newly released models visible in the chat selector
    without ever overwriting what the user pinned.

    Within each group the models are presented newest-generation-first
    (sort_models_newest_first) because providers list dozens — pinned models
    stay ahead of catalog ones, so curated-before-catalog still holds.
    "default" is unaffected and stays the first pinned model, so the
    no-model-specified fallback never silently moves to a newer, pricier
    model."""
    entries = load_provider_entries(user) if user else []
    providers, models = {}, []
    default_id = None
    dirty = False
    for e in entries:
        protocol = e.get("protocol")
        pid = str(e.get("id") or "")
        if protocol not in AI_PROTOCOLS or not pid or pid in providers:
            continue
        name = (e.get("name") or "").strip() or AI_PROTOCOLS[protocol]["label"]
        conf = {
            "base_url": ((e.get("base_url") or "").strip() or AI_PROTOCOLS[protocol]["base_url"]).rstrip("/"),
            "protocol": protocol,
            "name": name,
        }
        if protocol == "chatgpt":
            # OAuth entry: the bearer token comes from the ChatGPT sign-in and
            # is refreshed lazily here (persisted so other requests reuse it).
            oauth = e.get("oauth") if isinstance(e.get("oauth"), dict) else None
            if not oauth or not oauth.get("access_token"):
                continue
            # Back off after a failed refresh: ai_runtime runs on every AI
            # request, and retrying a dead grant each time would add a full
            # auth.openai.com round trip to chat/metadata/model calls.
            failed_at = oauth.get("refresh_failed_at") or 0
            if chatgpt_oauth.needs_refresh(oauth) and time.time() - failed_at > 300:
                refreshed = chatgpt_oauth.refresh(oauth)
                if refreshed:
                    e["oauth"] = oauth = refreshed
                else:
                    # Keep the stale token: the call will fail with a clear
                    # upstream 401 → the user reconnects in Settings.
                    oauth["refresh_failed_at"] = int(time.time())
                dirty = True
            conf["api_key"] = oauth["access_token"]
            conf["account_id"] = oauth.get("account_id") or ""
        else:
            key = (e.get("api_key") or "").strip()
            if not key:
                continue
            conf["api_key"] = key
        providers[pid] = conf
        # Dedupe in merge order (pinned first), then present newest-first. The
        # DEFAULT deliberately stays the merge-order head, not the sorted head:
        # rt["default"] is what _resolve_model falls back to when a request
        # names no model, and quietly promoting the newest (usually priciest)
        # model would raise the bill on bulk jobs like translation.
        # Sort WITHIN each group, not across them: curated-before-catalog is a
        # documented guarantee (the pinned list is the user's deliberate
        # choice), so newest-first applies inside the pinned block and inside
        # the catalog block rather than mixing the two.
        seen_names, pinned, fetched = set(), [], []
        for model, bucket in ([(m, pinned) for m in entry_models(e)]
                              + [(m, fetched) for m in entry_catalog(e)]):
            if model in seen_names:
                continue
            seen_names.add(model)
            bucket.append(model)
        if pinned and default_id is None:
            default_id = f"{pid}:{pinned[0]}"
        elif fetched and default_id is None:
            default_id = f"{pid}:{fetched[0]}"
        entry_names = sort_models_newest_first(pinned) + sort_models_newest_first(fetched)
        for model in entry_names:
            mid = f"{pid}:{model}"
            if mid not in [m["id"] for m in models]:
                models.append({"id": mid, "provider": pid, "provider_name": name, "model": model,
                               # Whether the provider takes the PDF file itself
                               # (native document part). The ChatGPT sign-in wire
                               # is the Codex backend, which refuses input_file
                               # parts — the chat falls back to extracted text.
                               "native_pdf": protocol != "chatgpt"})
    if dirty:
        save_provider_entries(user, entries)
    return {
        "providers": providers,
        "models": models,
        "default": next((m for m in models if m["id"] == default_id), models[0] if models else None),
        "enabled": bool(models),
    }


def clear_refresh_backoff(user: str, provider_id: str) -> None:
    """Forget a ChatGPT entry's failed-refresh timestamp so the next
    ai_runtime() re-attempts the token refresh immediately (an explicit
    retry, e.g. the settings Test button)."""
    entries = load_provider_entries(user)
    for e in entries:
        oauth = e.get("oauth")
        if e.get("id") == provider_id and isinstance(oauth, dict) \
                and oauth.pop("refresh_failed_at", None) is not None:
            save_provider_entries(user, entries)
            return


def require_ai_runtime(user: str) -> dict:
    """ai_runtime(), raising the standard 503 when no provider is usable."""
    rt = ai_runtime(user)
    if not rt["enabled"]:
        raise HTTPException(status_code=503, detail="AI not configured (add an API key in Settings → AI providers)")
    return rt

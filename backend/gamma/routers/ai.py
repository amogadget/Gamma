"""AI chat, provider settings, model discovery, and ChatGPT OAuth routes."""

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.request import Request as URLRequest, urlopen

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import chatgpt_oauth, ratelimit
from ..ai_client import (
    UpstreamError,
    call_ai as _call_ai,
    chatgpt_request as _chatgpt_request,  # noqa: F401  (re-exported for tests)
    open_ai as _open_ai,
    protocol as _protocol,
    read_reply as _read_reply,
    sse_deltas as _sse_deltas,
    sse_events as _sse_events,
    upstream_detail as _upstream_detail,
    wire_protocol as _wire_protocol,
)
from ..ai_tools import (
    AGENT_PROMPT,
    MAX_TOOL_ACTIONS,
    MAX_TOOL_ROUNDS,
    MUTATING_TOOLS,
    agent_system,
    agent_tools,
    run_agent_tool,
    tool_action,
)
from ..ai_context import (
    build_messages as _build_messages,
    gather_inputs as _gather_inputs,
    parse_files as _parse_files,  # noqa: F401  (re-exported for tests)
    parse_images as _parse_images,
    pdf_path as _pdf_path,
)
from ..ai_settings import (
    MAX_KEY_LEN,
    MAX_MODELS_LEN,
    MAX_NAME_LEN,
    MAX_PROVIDERS,
    MAX_URL_LEN,
    ai_runtime,
    clear_refresh_backoff,
    entry_models,
    load_provider_entries,
    new_provider_id,
    require_ai_runtime,
    save_provider_entries,
    set_entry_catalog,
)
from ..auth import require_user
from ..config import AI_MODEL_CATALOG_TTL, AI_PROTOCOLS, USERS_DIR
from ..db import page_now, user_db_path
from ..logbuf import log
from ..pdf_text import extract_text
from ..textnorm import INDEX_VERSION

router = APIRouter(prefix="/api", tags=["ai"])

# Reasoning-depth values accepted by both wire protocols (Anthropic
# output_config.effort / OpenAI reasoning_effort). Only sent when the user
# picks one — many models reject the parameter outright.
EFFORT_LEVELS = {"minimal", "low", "medium", "high", "xhigh", "max"}


class AIChatRequest(BaseModel):
    prompt: str
    doc_id: str = ""
    history: list = Field(default_factory=list)  # [{role: "user"|"ai", text: str}, ...]
    model: str = ""  # model registry id ("provider:model"), must be in AI_MODELS
    selection: str = ""  # text the user selected in the PDF — focus the answer on it
    attach_pdf: bool = False  # send the PDF itself instead of extracted text
    effort: str = ""  # reasoning effort; empty = provider default (param omitted)
    system: str = ""  # custom system prompt; empty = built-in default
    pages: list = Field(default_factory=list)  # page block ids for multi-PDF chat / reports
    include_notes: bool = False  # also include the user's highlights + notes for those pages
    images: list = Field(default_factory=list)  # pasted figures as data URLs
    files: list = Field(default_factory=list)  # uploaded PDFs as {name, data} data URLs
    stream: bool = False  # NDJSON stream of {"delta": …} lines instead of one JSON body
    # Agent chat (gamma/ai_tools.py): agent_scope declares what this chat's
    # tools reach — "folder" (the home/folder view; `folder` is the path,
    # "" = library root) or "page" (the per-paper chat; `page_id` is the
    # focused page — read tools only). "" = plain chat. Every tool call comes
    # back as an {"action": …} NDJSON line alongside the text deltas.
    # `permissions` is the Settings → Assistant per-tool map ({list, read,
    # search, rename, move}; missing key = allowed) — everything off degrades
    # to a plain chat. agent_system overrides the base agent prompt (the
    # scope/permission lines are always appended); tool_rounds overrides the
    # agent round budget and read_char_limit the per-read_page-call document
    # text cap (both 0 = server default).
    agent_scope: str = ""
    folder: str = ""
    page_id: str = ""
    permissions: dict = Field(default_factory=dict)
    agent_system: str = ""
    tool_rounds: int = Field(default=0, ge=0, le=100)
    read_char_limit: int = Field(default=0, ge=0, le=1_000_000)
    context_char_limit: int = Field(default=8000, ge=100, le=1_000_000)
    multi_context_char_limit: int = Field(default=18000, ge=100, le=1_000_000)


def _resolve_model(rt: dict, requested: str) -> dict:
    """Registry entry for a requested model id (or bare model name) in the
    user's effective config (`rt` from ai_runtime()); default otherwise."""
    for entry in rt["models"]:
        if requested == entry["id"] or requested == entry["model"]:
            return entry
    return rt["default"]


def _resolve_effort(requested: str) -> str:
    requested = (requested or "").strip().lower()
    return requested if requested in EFFORT_LEVELS else ""


def _search_index_status(user: str, doc_id: str) -> dict:
    """Whether the search index covers this doc — same rules as
    /api/metadata/status (ver mismatch = stale, re-indexed lazily)."""
    try:
        with sqlite3.connect(user_db_path(user, "data.db")) as conn:
            row = conn.execute("SELECT ver FROM pdf_fts_docs WHERE doc_id = ?", (doc_id,)).fetchone()
    except sqlite3.OperationalError:
        row = None  # index tables don't exist yet — search has never run
    return {"indexed": bool(row and row[0] == INDEX_VERSION), "index_stale": bool(row and row[0] != INDEX_VERSION)}


# Sync def: extraction runs in the threadpool (pdfium stops at the sample cap).
@router.get("/pdf-text-status")
def pdf_text_status(doc_id: str, request: Request, preview: int = 0):
    """Whether a doc's PDF yields extractable text and whether the search
    index covers it. Feeds the metadata popover's health rows — a
    scanned/image-only PDF is why AI answers blind and metadata lookups come
    up empty. `preview` > 0 additionally returns that many characters of the
    text itself (capped)."""
    user = require_user(request)
    preview = min(max(preview, 0), 20000)
    index = _search_index_status(user, doc_id)
    pdf_path = _pdf_path(user, doc_id)
    if not pdf_path:
        return {"found": False, "ok": False, "chars": 0, **index}
    try:
        text = extract_text(str(pdf_path), preview or 4000)
        stripped = text.strip()
        out = {"found": True, "ok": len(stripped) >= 50, "chars": len(stripped), **index}
        if preview:
            out["text"] = text[:preview]
        return out
    except Exception as e:
        log.warning(f"[pdf-text-status] {e}")
        return {"found": True, "ok": False, "chars": 0, **index}


# The grounding clause is deliberate: the document text below this prompt is
# usually a small head excerpt of a long paper, and without being told so the
# model answers detail questions from its memory of similar papers — inventing
# plausible, wrong numbers and attributing them to the user's paper. Scoped to
# claims ABOUT the paper, so background explanations still work.
_SYSTEM_PROMPT = (
    "You are a research assistant helping the user understand a PDF they are reading. "
    "The document text you are given is usually an EXCERPT, not the whole paper. "
    "Anything you state as being in THIS paper — a number, a parameter, a method, a "
    "result — must come from text you have actually read here. Never fill such a gap "
    "from your knowledge of similar papers: a value you half-remember from elsewhere "
    "is worse than no answer. If the text you have does not contain it, say so plainly "
    "(and look it up first if you have tools). General background the user asks you to "
    "explain is fine to answer from your own knowledge — just make clear it is "
    "background, not something this paper states. Be concise, and cite the PDF page "
    "for specific values you attribute to the paper.")

# Default prompt for AI-based metadata extraction (used when neither an arXiv id
# nor a DOI identifies the paper). Editable per-user in the frontend prompt editor.
METADATA_PROMPT = (
    "You extract bibliographic metadata from the first pages of an academic paper. "
    "Reply with ONLY a JSON object (no code fences, no commentary) with these keys: "
    'title (string), authors (list of "First Last" strings, in order), year (string), '
    'venue (journal or conference name; "arXiv" for preprints), volume (string), '
    'pages (string, e.g. "173-179"), doi (string), arxiv_id (string, e.g. "1810.11086"). '
    "Use empty strings/lists for anything not stated in the text. Never invent a DOI or arXiv id."
)

# Default prompt for the minimal slide-deck citation. Editable in the frontend.
CITE_PROMPT = (
    "The user provides a citation in an arbitrary format (BibTeX, CSL JSON, or plain text). "
    "You return ONLY a minimal, PPT-style citation suitable for a presentation slide, "
    "labeling italic and bold with markdown syntax correctly. Follow these examples exactly:\n"
    "Guo _et al._ arXiv **1810.11086** (2018).\n"
    "Schine _et al._, Nature **565**, 173–179 (2019)\n"
    "Use the journal name (abbreviated if long), bold volume, page range, and year in parentheses. "
    "For preprints use the arXiv number in bold. If there is exactly one author, use their surname "
    'without _et al._; for two authors use "Surname & Surname".'
)


@router.get("/ai/models")
async def ai_models(request: Request):
    user = require_user(request)
    rt = ai_runtime(user)
    return {
        "enabled": rt["enabled"],
        "models": rt["models"],  # [{id: "<pid>:<model>", provider, provider_name, model}, ...]
        "default": rt["default"]["id"] if rt["default"] else "",
        "efforts": ["low", "medium", "high"],  # offered in the UI; omitted unless picked
        "refreshed_at": _max_catalog_at(user),  # newest auto-fetched catalog time, "" = never
        "default_prompt": _SYSTEM_PROMPT,  # shown in the prompt editor
        "metadata_prompt": METADATA_PROMPT,  # AI metadata-extraction fallback
        "cite_prompt": CITE_PROMPT,  # PPT-style citation generator
        "agent_prompt": AGENT_PROMPT,  # library-agent base role prompt
    }


# --- Per-user AI provider entries (GUI key management) ------------------------
# OpenAI-platform-style key list: add / edit / remove provider entries. Keys
# are write-only from the client: GET returns a masked hint, never the key.
# Stored under the reserved `ai-settings` prefs key in the user's data.db —
# see gamma/ai_settings.py for the security rationale.


def _masked_settings(user: str, is_guest: bool) -> dict:
    out = []
    for e in load_provider_entries(user):
        key = (e.get("api_key") or "").strip()
        oauth = e.get("oauth") if isinstance(e.get("oauth"), dict) else {}
        out.append(
            {
                "id": e.get("id") or "",
                "name": (e.get("name") or "").strip(),
                "protocol": e.get("protocol") or "",
                # Enough to recognize the key, never enough to use it.
                "key_hint": f"…{key[-4:]}" if len(key) >= 12 else ("set" if key else ""),
                "base_url": (e.get("base_url") or "").strip(),
                "models": (e.get("models") or "").strip(),
                "created_at": e.get("created_at") or "",
                # ChatGPT sign-in entries: connection status + account label only,
                # never the tokens themselves.
                "oauth_connected": bool(oauth.get("access_token")),
                "account": oauth.get("email") or "",
            }
        )
    return {
        "providers": out,
        # Feeds the "Add provider" dropdown and the form placeholders.
        # auth "oauth" = sign-in entries (no API key field in the form).
        "protocols": [
            {
                "id": pid,
                "label": conf["label"],
                "default_base_url": conf["base_url"],
                "default_model": conf["default_model"],
                "auth": conf.get("auth", "key"),
            }
            for pid, conf in AI_PROTOCOLS.items()
        ],
        "can_edit": not is_guest,
    }


def _require_editor(request: Request) -> str:
    user = require_user(request)
    if request.state.is_guest:
        # The guest workspace is shared by everyone — a stored key would be
        # spendable (though never readable) by any visitor.
        raise HTTPException(status_code=403, detail="guest accounts cannot store API keys")
    return user


class AIProviderRequest(BaseModel):
    protocol: str = ""  # "anthropic" | "openai" (required on add)
    name: str | None = None  # display label; "" = protocol label
    api_key: str | None = None  # required on add; omitted/empty on edit = keep
    base_url: str | None = None  # "" = protocol default
    models: str | None = None  # comma-separated model names; "" = protocol default


def _apply_provider_fields(entry: dict, payload: AIProviderRequest):
    """Validate + copy the editable fields of a provider entry in place."""
    oauth_entry = AI_PROTOCOLS.get(entry.get("protocol"), {}).get("auth") == "oauth"
    if payload.name is not None:
        entry["name"] = str(payload.name).strip()[:MAX_NAME_LEN]
    # OAuth secrets and endpoints are owned by the sign-in flow. In particular,
    # accepting an arbitrary base URL here would let a crafted API request
    # redirect the bearer token on the next model, usage or chat call.
    if payload.api_key and not oauth_entry:  # never clears; delete the entry to drop a key
        key = str(payload.api_key).strip()
        if not key or len(key) > MAX_KEY_LEN or any(c.isspace() for c in key):
            raise HTTPException(status_code=400, detail="invalid API key")
        entry["api_key"] = key
    if payload.base_url is not None and not oauth_entry:
        url = str(payload.base_url).strip().rstrip("/")
        if (url and not re.match(r"^https?://", url)) or len(url) > MAX_URL_LEN:
            raise HTTPException(status_code=400, detail="base URL must start with http(s)://")
        entry["base_url"] = url
    if payload.models is not None:
        models = str(payload.models).strip()
        if len(models) > MAX_MODELS_LEN:
            raise HTTPException(status_code=400, detail="model list too long")
        entry["models"] = models


@router.get("/ai/settings")
async def ai_settings_get(request: Request):
    user = require_user(request)
    return _masked_settings(user, request.state.is_guest)


@router.post("/ai/providers")
async def ai_provider_add(payload: AIProviderRequest, request: Request):
    user = _require_editor(request)
    entries = load_provider_entries(user)
    if len(entries) >= MAX_PROVIDERS:
        raise HTTPException(status_code=400, detail="too many providers")
    if AI_PROTOCOLS.get(payload.protocol, {}).get("auth") == "oauth":
        raise HTTPException(
            status_code=400, detail="ChatGPT entries are created by signing in — use the Connect button"
        )
    if payload.protocol not in AI_PROTOCOLS:
        raise HTTPException(status_code=400, detail="protocol must be 'anthropic' or 'openai'")
    if not (payload.api_key or "").strip():
        raise HTTPException(status_code=400, detail="API key required")
    entry = {
        "id": new_provider_id(),
        "protocol": payload.protocol,
        "name": "",
        "api_key": "",
        "base_url": "",
        "models": "",
        "created_at": page_now(),
    }
    _apply_provider_fields(entry, payload)
    entries.append(entry)
    save_provider_entries(user, entries)
    return _masked_settings(user, request.state.is_guest)


@router.put("/ai/providers/{provider_id}")
async def ai_provider_update(provider_id: str, payload: AIProviderRequest, request: Request):
    user = _require_editor(request)
    entries = load_provider_entries(user)
    entry = next((e for e in entries if e.get("id") == provider_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail="provider not found")
    # Protocol edits never cross the key/OAuth boundary — a sign-in entry stays
    # a sign-in entry (name/models remain editable through this endpoint).
    if (
        payload.protocol
        and payload.protocol in AI_PROTOCOLS
        and AI_PROTOCOLS[payload.protocol].get("auth") == AI_PROTOCOLS.get(entry.get("protocol"), {}).get("auth")
    ):
        entry["protocol"] = payload.protocol
    _apply_provider_fields(entry, payload)
    save_provider_entries(user, entries)
    return _masked_settings(user, request.state.is_guest)


@router.delete("/ai/providers/{provider_id}")
async def ai_provider_delete(provider_id: str, request: Request):
    user = _require_editor(request)
    entries = [e for e in load_provider_entries(user) if e.get("id") != provider_id]
    save_provider_entries(user, entries)
    return _masked_settings(user, request.state.is_guest)


# Sync def: the probe call runs in the threadpool.
@router.post("/ai/providers/{provider_id}/test")
def ai_provider_test(provider_id: str, request: Request):
    """One tiny live completion through a saved entry, for the settings list's
    Test button — answers "does this credential still work" without waiting for
    a real chat to 502 (the common case: an expired/revoked ChatGPT sign-in).
    The probe result comes back in-body — a failed probe is a successful test,
    not an HTTP error."""
    user = _require_editor(request)
    entries = load_provider_entries(user)
    entry = next((e for e in entries if e.get("id") == provider_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail="provider not found")
    # A test click is an explicit retry: drop the refresh backoff so a ChatGPT
    # entry re-attempts its token refresh now instead of reusing a stale token.
    clear_refresh_backoff(user, provider_id)
    rt = ai_runtime(user)
    if provider_id not in rt["providers"]:
        return {"ok": False, "error": "entry has no usable credential — set an API key or sign in again"}
    model = entry_models(entry)[0]
    started = time.time()
    try:
        # Generous cap: reasoning models burn invisible tokens even on "ok".
        _call_ai([{"role": "user", "content": 'Reply with the single word "ok".'}],
                 "", {"provider": provider_id, "model": model}, rt,
                 max_tokens=2048, timeout=45)
    except Exception as e:
        return {"ok": False, "model": model, "error": str(e)}
    return {"ok": True, "model": model, "latency_ms": int((time.time() - started) * 1000)}


# Fallback when the live listing fails on a connected entry (offline, backend
# hiccup): models the ChatGPT backend has been known to serve.
_CHATGPT_MODEL_FALLBACK = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
]
# GET {base}/models gates its answer on the caller's version — keep in rough
# sync with a current Codex CLI release so new models show up.
_CHATGPT_CLIENT_VERSION = "0.146.0"
_MODEL_CATALOG_TIMEOUT = 5


def _model_catalog_json(req: URLRequest) -> dict:
    """Fetch one model catalog with a short, UI-friendly timeout."""
    with urlopen(req, timeout=_MODEL_CATALOG_TIMEOUT) as resp:
        return json.loads(resp.read())


def _chatgpt_model_catalog(user: str, provider_id: str = "", with_fallback: bool = True) -> list:
    """Live model list from the ChatGPT (codex) backend, Codex CLI's own
    listing call: GET {base}/models?client_version=… with the OAuth bearer.
    Needs a connected entry — the list is account-gated; falls back to the
    known-good list only when the fetch itself fails."""
    providers = ai_runtime(user)["providers"]
    conf = providers.get(provider_id) if provider_id else None
    if not conf or conf.get("protocol") != "chatgpt":
        if provider_id:
            # Background refresh / saved-entry listing: the named entry is not
            # connected — never silently list a different account's models.
            raise ModelListError("ChatGPT entry is not connected — sign in again")
        # Pre-connect "Add key" form has no entry yet — any connected one will do.
        conf = next((c for c in providers.values() if c.get("protocol") == "chatgpt"), None)
    if not conf:
        raise HTTPException(
            status_code=400, detail="sign in with ChatGPT first — the model list comes from your account"
        )
    try:
        req = URLRequest(
            f"{conf['base_url']}/models?client_version={_CHATGPT_CLIENT_VERSION}",
            headers={
                "Authorization": f"Bearer {conf['api_key']}",
                "chatgpt-account-id": conf.get("account_id", ""),
                "originator": "codex_cli_rs",
            },
        )
        data = _model_catalog_json(req)
        listed, hidden = [], []
        for m in data.get("models") or []:
            slug = str(m.get("slug") or "").strip()
            vis = m.get("visibility") or "list"
            if not slug or vis == "none":  # "none" = not usable by this account
                continue
            (hidden if vis == "hide" else listed).append(slug)
        # `hide` marks picker-hidden but usable slugs — offer them after the
        # listed ones rather than dropping them.
        models = list(dict.fromkeys(listed + hidden))
        if not models:
            raise ModelListError("the account returned an empty model list")
        return models
    except ModelListError:
        raise
    except Exception as e:
        log.warning(f"[ai] chatgpt model listing failed, using fallback: {e}")
        if not with_fallback:
            raise ModelListError(f"model list failed: {e}") from e
        return _CHATGPT_MODEL_FALLBACK


class ModelCatalogRequest(BaseModel):
    provider_id: str = ""  # saved entry to use the stored key of; "" = use the fields below
    protocol: str = ""
    api_key: str = ""
    base_url: str = ""


class ModelListError(Exception):
    """A provider refused or failed a model-list request; carries a UI message."""


def _filter_chat_models(ids: list, require_chat_prefix: bool = True) -> list:
    """Drop the non-conversational families from an account listing (OpenAI's
    includes embeddings/audio/image models the chat endpoint can't use).
    Anthropic-wire gateways (DeepSeek, …) may serve models without a gpt-*/o*
    prefix, so the prefix whitelist is only applied to OpenAI listings."""
    out = []
    for i in ids:
        if re.search(r"embed|whisper|tts|audio|image|dall-e|moderation|transcribe|realtime|search", i, re.I):
            continue
        if require_chat_prefix and not re.match(r"^(gpt-|o\d|chatgpt-)", i):
            continue
        out.append(i)
    return out


def _fetch_key_protocol_models(protocol: str, base: str, api_key: str) -> list:
    """Live model names for a key-based protocol entry. Tries the provider's
    listing endpoint in wire order and raises ModelListError when none
    answers. Anthropic-wire gateways that don't list under the anthropic path
    (DeepSeek's /anthropic base is one) usually answer their OpenAI-compatible
    listing with the same key, so the parent base is tried as a fallback."""
    candidates = []
    if protocol == "openai":
        candidates.append((f"{base}/v1/models", {"Authorization": f"Bearer {api_key}"}, True))
    else:  # anthropic
        candidates.append(
            (f"{base}/v1/models?limit=100", {"x-api-key": api_key, "anthropic-version": "2023-06-01"}, False)
        )
        parent = base[: -len("/anthropic")] if base.endswith("/anthropic") else base
        if parent != base:
            candidates.append((f"{parent}/v1/models", {"Authorization": f"Bearer {api_key}"}, False))
        candidates.append((f"{base}/v1/models", {"Authorization": f"Bearer {api_key}"}, False))
    last = None
    for url, headers, chat_prefix in candidates:
        try:
            req = URLRequest(
                url, headers={**headers, "Accept": "application/json", "User-Agent": "Gamma/model-catalog"}
            )
            data = _model_catalog_json(req)
            ids = [str(m.get("id") or "") for m in (data.get("data") or []) if m.get("id")]
            ids = _filter_chat_models(ids, chat_prefix)
            if ids:
                return sorted(set(ids))
        except urllib.error.HTTPError as e:
            last = _upstream_detail(e, 200)
        except Exception as e:
            last = str(e)
    raise ModelListError(f"model list failed: {last or 'no listing endpoint'}")


# Sync def: the upstream /v1/models fetch runs in the threadpool.
@router.post("/ai/model-catalog")
def ai_model_catalog(payload: ModelCatalogRequest, request: Request):
    """Model names offered by a provider, for the settings form's model picker.
    API protocols are asked live (GET /v1/models with the entry's key); the
    ChatGPT backend is asked via Codex CLI's listing call with the OAuth
    token (known-good fallback list when not connected)."""
    user = _require_editor(request)
    entry = {}
    protocol = payload.protocol
    if payload.provider_id:
        entry = next((e for e in load_provider_entries(user) if e.get("id") == payload.provider_id), None) or {}
        protocol = entry.get("protocol") or protocol
    if protocol == "chatgpt":
        try:
            return {"models": _chatgpt_model_catalog(user, payload.provider_id)}
        except ModelListError as e:
            raise HTTPException(status_code=400, detail=str(e))
    if protocol not in AI_PROTOCOLS:
        raise HTTPException(status_code=400, detail="unknown protocol")
    key = (payload.api_key or "").strip() or (entry.get("api_key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="enter the API key first, then load the model list")
    base = (
        (payload.base_url or "").strip() or (entry.get("base_url") or "").strip() or AI_PROTOCOLS[protocol]["base_url"]
    ).rstrip("/")
    try:
        models = _fetch_key_protocol_models(protocol, base, key)
    except ModelListError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"models": models}


# --- PDF translation ----------------------------------------------------------
# Backs the viewer's translated view: the frontend segments a page into
# paragraph blocks (frontend/src/pdfTranslate.js) and sends their TEXT here;
# geometry never leaves the client. Translations are cached per (user, target
# language, model, source text) — IN MEMORY only, deliberately: nothing is
# persisted to disk, the cache just makes retries, re-shows and halted-job
# resumes free until the server restarts.
#
# The selected paragraphs are sent to the user's own configured AI provider —
# the same disclosure that applies to chat. Nothing translates unless the user
# asks for it, and share/read-only views never expose the endpoint.

# Allowlisted target languages (code → name spliced into the prompt). Mirrored
# in frontend/src/prefs.js TRANSLATE_LANGS — keep the two in sync.
TRANSLATE_LANGS = {
    "en": "English", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese",
    "ja": "Japanese", "ko": "Korean", "de": "German", "fr": "French",
    "es": "Spanish", "pt": "Portuguese", "it": "Italian", "ru": "Russian",
}

_TRANSLATE_PROMPT = (
    "You translate paragraphs extracted from an academic paper into {lang}. "
    "The user message is a JSON array of strings; each string is one paragraph, "
    "heading, or caption. Reply with ONLY a JSON array of strings of the SAME "
    "length and order — element i is the translation of element i. No code "
    "fences, no commentary. Rules: keep inline math, LaTeX, numbers, symbols, "
    "variable names, citation markers like [12], and URLs exactly as written; "
    "keep the register of an academic paper; translate headings as headings. "
    "Return a string unchanged when it is already in the target language or is "
    "pure math/code."
)

_TRANSLATE_MAX_TEXTS = 200      # paragraphs per request (a page is ~10–50)
_TRANSLATE_MAX_CHARS = 60000    # total source chars per request
# Per-user request ceiling. The viewer caps itself at 8 parallel requests and
# chunks a page into ~6-paragraph calls, so a whole-document job on a long book
# stays well inside this; it exists to bound cost/abuse, not normal reading.
_TRANSLATE_RATE_MAX = 240
_TRANSLATE_RATE_WINDOW = 60
# In-memory LRU: key (see _translate_key) → translated text. Process-wide,
# never written to disk; a restart simply starts cold. The lock matters:
# requests run in FastAPI's threadpool and the viewer fires several in
# parallel, so touches and evictions would otherwise race.
_TRANSLATE_CACHE: "OrderedDict[str, str]" = OrderedDict()
_TRANSLATE_CACHE_CAP = 5000     # cached paragraphs kept in memory (LRU)
_TRANSLATE_LOCK = threading.Lock()
# Concurrent single-paragraph retries when a batch reply is miscounted. Bounded
# so one malformed 200-paragraph batch cannot fan out into 200 provider calls.
_TRANSLATE_SALVAGE_WORKERS = 4


class AITranslateRequest(BaseModel):
    texts: list = Field(default_factory=list)  # source paragraphs, viewer order
    lang: str = "zh-CN"   # target language code (TRANSLATE_LANGS key)
    model: str = ""       # model registry id; "" = the user's default
    effort: str = ""      # reasoning effort; "" = provider default (param omitted)


def _translate_key(user: str, lang: str, model: str, text: str) -> str:
    # Keyed on the bare model NAME (not the registry id): registry ids embed
    # the provider-entry id, which changes when a key is re-added — the cached
    # translation shouldn't die with it. The username scopes the shared
    # in-memory dict per account.
    return hashlib.sha256(f"{user}\x00{lang}\x00{model}\x00{text}".encode()).hexdigest()


def _translate_cache_get(keys: list) -> dict:
    """LRU-touching lookup: {key: translation} for every key already cached."""
    with _TRANSLATE_LOCK:
        hits = {}
        for k in keys:
            if k in _TRANSLATE_CACHE:
                _TRANSLATE_CACHE.move_to_end(k)  # LRU touch
                hits[k] = _TRANSLATE_CACHE[k]
        return hits


def _translate_cache_put(key: str, text: str) -> None:
    """Store one translation and trim to the cap, under the shared lock."""
    with _TRANSLATE_LOCK:
        _TRANSLATE_CACHE[key] = text
        _TRANSLATE_CACHE.move_to_end(key)
        while len(_TRANSLATE_CACHE) > _TRANSLATE_CACHE_CAP:
            _TRANSLATE_CACHE.popitem(last=False)


def _parse_translation_array(reply: str, n: int) -> list:
    """The model's reply as a list of n strings — tolerates code fences and
    prose around the array, nothing else."""
    s = (reply or "").strip()
    i, j = s.find("["), s.rfind("]")
    if i < 0 or j <= i:
        raise ValueError("no JSON array in reply")
    arr = json.loads(s[i:j + 1])
    if not isinstance(arr, list) or len(arr) != n:
        raise ValueError(f"expected {n} translations, got {len(arr) if isinstance(arr, list) else 'non-list'}")
    return ["" if t is None else str(t) for t in arr]


# Sync def: the AI call runs in the threadpool.
@router.post("/ai/translate")
def ai_translate(payload: AITranslateRequest, request: Request):
    user = require_user(request)
    lang = payload.lang
    if lang not in TRANSLATE_LANGS:
        raise HTTPException(status_code=400, detail="unsupported target language")
    texts = payload.texts
    if not isinstance(texts, list) or not texts or len(texts) > _TRANSLATE_MAX_TEXTS:
        raise HTTPException(status_code=400, detail=f"texts must be 1–{_TRANSLATE_MAX_TEXTS} strings")
    if any(not isinstance(t, str) for t in texts):
        raise HTTPException(status_code=400, detail="texts must be strings")
    if sum(len(t) for t in texts) > _TRANSLATE_MAX_CHARS:
        raise HTTPException(status_code=413, detail="too much text in one request")
    ratelimit.check(f"ai-translate:{user}", _TRANSLATE_RATE_MAX, _TRANSLATE_RATE_WINDOW)

    rt = require_ai_runtime(user)
    entry = _resolve_model(rt, payload.model)
    model_name = entry["model"]

    keys = [_translate_key(user, lang, model_name, t) for t in texts]
    # hits: key → translation, for every paragraph that won't need the model.
    # Filled from the cache now and from the provider reply below; the final
    # response reads texts the map doesn't cover (whitespace-only paragraphs)
    # verbatim.
    hits = _translate_cache_get(keys)

    # Whitespace-only paragraphs never reach the model; every other cache miss
    # goes upstream in ONE call (duplicates collapsed — running headers and
    # repeated captions are common), as a JSON array both ways.
    miss, queued = [], set()
    for i, t in enumerate(texts):
        if keys[i] not in hits and keys[i] not in queued and t.strip():
            queued.add(keys[i])
            miss.append(i)
    if miss:
        miss_texts = [texts[i] for i in miss]
        system = _TRANSLATE_PROMPT.format(lang=TRANSLATE_LANGS[lang])
        effort = _resolve_effort(payload.effort)

        def call(batch):
            # Output roughly tracks input length (CJK ≈ 1 token/char); the
            # generous floor covers JSON overhead and reasoning models whose
            # thinking spends from the same budget.
            max_tokens = min(30000, 8000 + 2 * sum(len(t) for t in batch))
            return _call_ai(
                [{"role": "user", "content": json.dumps(batch, ensure_ascii=False)}],
                system, entry, rt, effort=effort, max_tokens=max_tokens, timeout=180)

        try:
            reply = call(miss_texts)
        except Exception as e:
            log.warning(f"[ai_translate] {e}")
            raise HTTPException(status_code=502, detail=f"translation failed: {e}")
        try:
            translated = _parse_translation_array(reply, len(miss_texts))
        except ValueError as e:
            # The provider answered but the array is off — models sometimes
            # merge or drop an element. Salvage paragraph by paragraph (a
            # 1-element array can't misalign) instead of failing the chunk;
            # a paragraph that still won't translate comes back VERBATIM, so
            # the viewer shows the original there instead of erroring. The
            # single-paragraph calls run concurrently — sequential salvage of a
            # 6-paragraph chunk would take 6 model round-trips — but the worker
            # count is capped so a malformed batch can't multiply provider
            # calls without bound.
            log.warning(f"[ai_translate] {e} — salvaging per paragraph")

            def salvage(t):
                try:
                    return _parse_translation_array(call([t]), 1)[0]
                except Exception as e2:
                    log.warning(f"[ai_translate] paragraph salvage failed: {e2}")
                    return t

            workers = min(_TRANSLATE_SALVAGE_WORKERS, len(miss_texts))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                translated = list(pool.map(salvage, miss_texts))
        for i, t in zip(miss, translated):
            hits[keys[i]] = t
            if t and t != texts[i]:  # identity fallbacks stay uncached so a retry can improve them
                _translate_cache_put(keys[i], t)
    # Duplicates resolve through the shared key map, so a repeated paragraph
    # gets the one translation that was fetched for it.
    out = [hits.get(k, texts[i]) for i, k in enumerate(keys)]
    return {"translations": out, "model": entry["id"], "cached": not miss}


# --- Periodic model-catalog refresh ------------------------------------------
# Each provider entry caches the live model list from its account
# (`catalog_models` + `catalog_at`, managed in gamma/ai_settings.py);
# ai_runtime() merges it after the user's hand-edited `models`, so newly
# released models appear in the chat selector without touching what the user
# pinned. The daemon thread below refreshes stale catalogs in the background;
# POST /api/ai/models/refresh (the chat header's ↻) forces it immediately.
CATALOG_CHECK_SECONDS = 600
_catalog_watcher_started = False


def _max_catalog_at(user: str) -> str:
    """Newest catalog_at across the user's entries ("" when none yet)."""
    ats = [e.get("catalog_at") or "" for e in load_provider_entries(user) if e.get("catalog_at")]
    return max(ats) if ats else ""


def _catalog_age_seconds(entry: dict) -> float:
    at = entry.get("catalog_at") or ""
    try:
        parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
        return time.time() - parsed.timestamp()
    except Exception:
        return float("inf")


def _live_models_for_entry(user: str, entry: dict) -> list:
    """Live model names for one provider entry; raises ModelListError on
    failure so callers keep the previous cached catalog."""
    protocol = entry.get("protocol")
    if protocol == "chatgpt":
        # No fallback list here: a failed refetch must keep the previous
        # catalog, never cache the hardcoded fallback as if it were live.
        return _chatgpt_model_catalog(user, str(entry.get("id") or ""), with_fallback=False)
    if protocol not in AI_PROTOCOLS:
        raise ModelListError(f"unknown protocol: {protocol}")
    api_key = (entry.get("api_key") or "").strip()
    if not api_key:
        raise ModelListError("no API key stored")
    base = ((entry.get("base_url") or "").strip() or AI_PROTOCOLS[protocol]["base_url"]).rstrip("/")
    return _fetch_key_protocol_models(protocol, base, api_key)


def refresh_entry_catalog(user: str, provider_id: str, force: bool = False) -> bool:
    """Fetch one entry's live model list and cache it. True when a fresh
    catalog was stored; stale-yet-fresh entries and failed fetches leave the
    previous catalog untouched and return False."""
    entries = load_provider_entries(user)
    entry = next((e for e in entries if e.get("id") == provider_id), None)
    if not entry:
        return False
    if not force and _catalog_age_seconds(entry) < AI_MODEL_CATALOG_TTL:
        return False
    try:
        models = _live_models_for_entry(user, entry)
    except Exception as e:
        log.warning(f"[ai] model catalog refresh failed for {user}/{entry.get('name') or entry.get('protocol')}: {e}")
        return False
    if not models:
        return False
    set_entry_catalog(entry, models, page_now())
    save_provider_entries(user, entries)
    log.info(
        f"[ai] refreshed model catalog for {user} '{entry.get('name') or entry.get('protocol')}': {len(models)} models"
    )
    return True


def refresh_all_catalogs(force: bool = False) -> dict:
    """Refresh stale catalogs for every user's provider entries. Used by the
    background watcher; returns a summary for logging."""
    users = [d.name for d in USERS_DIR.iterdir() if d.is_dir() and (d / "data.db").exists()]
    refreshed = 0
    for user in users:
        for entry in load_provider_entries(user):
            if refresh_entry_catalog(user, str(entry.get("id") or ""), force):
                refreshed += 1
    return {"users": len(users), "refreshed": refreshed}


@router.post("/ai/models/refresh")
def ai_models_refresh(request: Request):
    """Force a live refresh of every provider's cached catalog now (bounded by
    the per-provider listing timeout) and return the fresh /ai/models payload.
    This powers the chat header's ↻; the background watcher does the same once
    a day on its own."""
    user = _require_editor(request)
    refreshed = 0
    for entry in load_provider_entries(user):
        if refresh_entry_catalog(user, str(entry.get("id") or ""), force=True):
            refreshed += 1
    rt = ai_runtime(user)
    return {
        "refreshed": refreshed,
        "enabled": rt["enabled"],
        "models": rt["models"],
        "default": rt["default"]["id"] if rt["default"] else "",
        "efforts": ["low", "medium", "high"],
        "refreshed_at": _max_catalog_at(user),
        "default_prompt": _SYSTEM_PROMPT,
        "metadata_prompt": METADATA_PROMPT,
        "cite_prompt": CITE_PROMPT,
    }


def _catalog_watcher_loop():
    """Daemon loop: check every 10 minutes, refresh entries whose cached
    catalog is older than the TTL (fetches are the exception, not the rule)."""
    time.sleep(60)  # let startup settle before the first sweep
    while True:
        try:
            summary = refresh_all_catalogs()
            if summary["refreshed"]:
                log.info(f"[ai] model catalog sweep: {summary}")
        except Exception as e:
            log.warning(f"[ai] model catalog sweep failed: {e}")
        time.sleep(CATALOG_CHECK_SECONDS)


def start_model_catalog_watcher():
    """Idempotent. Called from app assembly; one daemon thread per process
    (uvicorn --workers spawns one app instance per worker, each with its own
    thread — fine, refresh_entry_catalog is guarded by the TTL)."""
    global _catalog_watcher_started
    if _catalog_watcher_started:
        return
    _catalog_watcher_started = True
    threading.Thread(target=_catalog_watcher_loop, name="model-catalog-watcher", daemon=True).start()


# --- Voice dictation ----------------------------------------------------------

# Default = ChatGPT's dictation model (user-overridable per request); whisper-1
# is the retry for OpenAI-compatible servers (proxies, local gateways) that
# only expose the older Whisper API.
_TRANSCRIBE_DEFAULT = "gpt-4o-transcribe"
_TRANSCRIBE_FALLBACK = "whisper-1"
_TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024  # OpenAI's audio upload limit


def _multipart_body(fields: dict, filename: str, content_type: str, data: bytes):
    """Encode fields + one file as multipart/form-data (urllib has no helper)."""
    boundary = secrets.token_hex(16)
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode()
        + data
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# Sync def: the provider upload runs in the threadpool.
@router.post("/ai/transcribe")
def ai_transcribe(
    request: Request,
    file: UploadFile = File(...),
    model_hint: str = Form(""),
    model: str = Form(""),
    language: str = Form(""),
):
    """Speech-to-text for the chat composer's mic button. Audio goes to the
    OpenAI transcriptions API with the user's own key — `model_hint` is the
    chat's current model-registry id, so dictation billing follows the chat's
    provider when that entry speaks the OpenAI protocol. `model` and
    `language` (ISO-639-1, "" = auto-detect) come from Settings → AI chat."""
    user = require_user(request)
    rt = require_ai_runtime(user)
    hinted = rt["providers"].get((model_hint or "").split(":", 1)[0])
    conf = (
        hinted
        if hinted and hinted["protocol"] == "openai"
        else next((c for c in rt["providers"].values() if c["protocol"] == "openai"), None)
    )
    if not conf:
        raise HTTPException(
            status_code=503,
            detail="Voice input needs an OpenAI API-key provider (Settings → AI providers) — "
            "Anthropic and ChatGPT sign-in entries don't offer transcription.",
        )
    audio = file.file.read(_TRANSCRIBE_MAX_BYTES + 1)
    if not audio:
        raise HTTPException(status_code=400, detail="empty recording")
    if len(audio) > _TRANSCRIBE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="recording too long to transcribe (max 25 MB)")
    filename = re.sub(r"[^A-Za-z0-9._-]", "_", file.filename or "") or "dictation.webm"
    requested = (model or "").strip()
    if requested and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}", requested):
        raise HTTPException(status_code=400, detail="invalid transcription model")
    language = (language or "").strip().lower()
    if language and not re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,8})?", language):
        raise HTTPException(status_code=400, detail="invalid language code")
    candidates = [requested or _TRANSCRIBE_DEFAULT]
    if _TRANSCRIBE_FALLBACK not in candidates:
        candidates.append(_TRANSCRIBE_FALLBACK)
    detail = ""
    for model in candidates:
        fields = {"model": model, **({"language": language} if language else {})}
        body, content_type = _multipart_body(fields, filename, file.content_type or "application/octet-stream", audio)
        req = URLRequest(
            f"{conf['base_url']}/v1/audio/transcriptions",
            data=body,
            headers={
                "Authorization": f"Bearer {conf['api_key']}",
                "Content-Type": content_type,
            },
        )
        try:
            with urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            return {"text": (data.get("text") or "").strip(), "model": model}
        except urllib.error.HTTPError as error:
            detail = _upstream_detail(error)
            log.warning(f"[transcribe] {model}: {detail}")
            # 400/403/404 are model-availability shaped — worth the whisper-1
            # retry; auth/rate-limit failures would just fail again.
            if error.code not in (400, 403, 404):
                break
        except Exception as error:
            detail = str(error)
            log.warning(f"[transcribe] {model}: {error}")
            break
    raise HTTPException(status_code=502, detail=f"transcription failed — {detail}")


# --- ChatGPT subscription sign-in (OAuth PKCE, Codex CLI's flow) --------------
# start → the browser opens auth.openai.com; after login it is redirected to
# http://localhost:1455/auth/callback (which fails to load — nothing listens
# there when Gamma runs remotely). The user pastes that URL into complete,
# which redeems the code with the stashed PKCE verifier and stores the tokens
# on a provider entry. See gamma/chatgpt_oauth.py.

_OAUTH_STATES: dict = {}  # state -> {"verifier", "at"} — in-memory, 15 min TTL
_OAUTH_STATE_TTL = 900

# Last-resort models seeded on a fresh connect when even the live listing
# fails; freely editable per entry afterwards.
_CHATGPT_DEFAULT_MODELS = "gpt-5.6-sol, gpt-5.6-terra"


@router.post("/ai/oauth/chatgpt/start")
async def chatgpt_auth_start(request: Request):
    _require_editor(request)
    now = time.time()
    for k in [k for k, v in _OAUTH_STATES.items() if now - v["at"] > _OAUTH_STATE_TTL]:
        del _OAUTH_STATES[k]
    state, verifier, url = chatgpt_oauth.start_auth()
    _OAUTH_STATES[state] = {"verifier": verifier, "at": now}
    return {"auth_url": url, "state": state}


class ChatGPTAuthComplete(BaseModel):
    state: str = ""
    callback: str = ""  # pasted redirect URL (or a bare authorization code)
    provider_id: str = ""  # existing entry to reconnect; "" creates a new one
    name: str = ""
    models: str = ""


@router.post("/ai/oauth/chatgpt/complete")
async def chatgpt_auth_complete(payload: ChatGPTAuthComplete, request: Request):
    user = _require_editor(request)
    st = _OAUTH_STATES.pop(payload.state, None)
    if not st or time.time() - st["at"] > _OAUTH_STATE_TTL:
        raise HTTPException(status_code=400, detail="sign-in session expired — hit 'Open ChatGPT sign-in' again")
    try:
        code = chatgpt_oauth.parse_callback(payload.callback, payload.state)
        oauth = chatgpt_oauth.exchange_code(code, st["verifier"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"token exchange failed: {e}")

    entries = load_provider_entries(user)
    if payload.provider_id:
        entry = next((e for e in entries if e.get("id") == payload.provider_id), None)
        if not entry or entry.get("protocol") != "chatgpt":
            raise HTTPException(status_code=404, detail="provider not found")
        entry["oauth"] = oauth
        if payload.name.strip():
            entry["name"] = payload.name.strip()[:MAX_NAME_LEN]
        if payload.models.strip():
            entry["models"] = payload.models.strip()[:MAX_MODELS_LEN]
    else:
        if len(entries) >= MAX_PROVIDERS:
            raise HTTPException(status_code=400, detail="too many providers")
        entry = {
            "id": new_provider_id(),
            "protocol": "chatgpt",
            "name": payload.name.strip()[:MAX_NAME_LEN] or "ChatGPT",
            "api_key": "",
            "base_url": "",
            "models": payload.models.strip()[:MAX_MODELS_LEN],
            "created_at": page_now(),
            "oauth": oauth,
        }
        entries.append(entry)
        if not entry["models"]:
            # Seed the model list live from the account instead of a
            # hardcoded (quickly stale) default. Tokens must be stored first —
            # the listing call reads them back through ai_runtime.
            save_provider_entries(user, entries)
            try:
                live = _chatgpt_model_catalog(user, entry["id"], with_fallback=False)
                entry["models"] = ", ".join(live[:2])[:MAX_MODELS_LEN] or _CHATGPT_DEFAULT_MODELS
                # The live list doubles as the entry's auto-refreshed catalog —
                # no need for the background watcher to re-fetch immediately.
                set_entry_catalog(entry, live, page_now())
            except Exception:
                entry["models"] = _CHATGPT_DEFAULT_MODELS
    save_provider_entries(user, entries)
    return _masked_settings(user, request.state.is_guest)


# Providers whose backend refused native input_file parts — skip the wasted
# upload on later requests. In-memory: a restart retries native once.
_NATIVE_PDF_REJECTED: set = set()


# Sync endpoint on purpose: the AI call can take minutes; FastAPI's threadpool
# keeps the event loop free for other requests meanwhile.
@router.post("/ai/chat")
def ai_chat(payload: AIChatRequest, request: Request):
    user = require_user(request)
    rt = require_ai_runtime(user)

    entry = _resolve_model(rt, payload.model)
    effort = _resolve_effort(payload.effort)
    images = _parse_images(payload.images)
    custom_system = (payload.system or "").strip()[:8000]
    # The scope decides which tools exist; the permission toggles pick the
    # armed subset — an empty result (or no scope) is a plain chat.
    scope = {"type": payload.agent_scope, "folder": payload.folder,
             "page_id": payload.page_id, "read_chars": payload.read_char_limit}
    valid_scope = payload.agent_scope in ("folder", "page") and (
        payload.agent_scope != "page" or payload.page_id)
    tools = (agent_tools(payload.agent_scope, payload.permissions,
                         payload.read_char_limit) or None) if valid_scope else None
    # The conversation the agent loop grows across tool rounds (agent mode).
    state = {}

    def prepared(allow_native):
        pdf_b64s, context = _gather_inputs(user, payload, allow_native)
        # Agent chats replay each saved reply's tool calls/results so the
        # model keeps what it already listed/read/changed across turns.
        messages = _build_messages(payload, context, with_tools=bool(tools))
        # A custom prompt always applies; the built-in one only when there's a document
        system = custom_system or (_SYSTEM_PROMPT if (context or pdf_b64s) else "")
        if tools:
            system = ((system + "\n\n" if system else "")
                      + agent_system(scope, payload.permissions,
                                     (payload.agent_system or "").strip()[:8000]))
        return pdf_b64s, messages, system

    def open_with_fallback(stream):
        """Open the upstream call; if the ChatGPT backend refuses native PDF
        parts (4xx before any bytes), retry with extracted text. A provider
        that rejected native parts and then succeeded as text is remembered,
        so later requests skip the wasted multi-MB upload."""
        attempts = (False,) if entry["provider"] in _NATIVE_PDF_REJECTED else (True, False)
        for native in attempts:
            pdf_b64s, messages, system = prepared(native)
            try:
                resp = _open_ai(messages, system, entry, rt, pdf_b64s,
                                effort=effort, timeout=180, images=images, stream=stream,
                                tools=tools)
                if not native and True in attempts:
                    _NATIVE_PDF_REJECTED.add(entry["provider"])
                state.update(messages=messages, system=system, pdf_b64s=pdf_b64s)
                return resp
            except UpstreamError as e:
                if not (native and pdf_b64s and _protocol(rt, entry) == "chatgpt" and 400 <= e.status < 500):
                    raise
                log.warning(f"[ai_chat] chatgpt rejected native PDF parts, retrying as text: {e}")

    def agent_events(first_resp):
        """Organizer tool loop: yield ("delta", text) / ("action", dict) events.
        Each round streams one provider turn; tool calls are executed here and
        their results appended before the next round re-opens the provider."""
        proto = _wire_protocol(rt, entry, tools)  # tools may reroute openai → /v1/responses
        messages, system, pdf_b64s = state["messages"], state["system"], state["pdf_b64s"]
        armed = {t["name"] for t in tools}  # only armed tools execute
        resp = first_resp
        actions = 0
        max_rounds = payload.tool_rounds or MAX_TOOL_ROUNDS
        for round_no in range(max_rounds):
            calls, text_parts = [], []
            try:
                for kind, data in _sse_events(resp, proto):
                    if kind == "text":
                        text_parts.append(data)
                        yield ("delta", data)
                    else:
                        calls.append(data)
            finally:
                resp.close()
            if not calls:
                return
            messages.append({"role": "assistant", "content": "".join(text_parts),
                             "tool_calls": calls})
            for call in calls:
                if call["name"] not in armed:
                    result = ("error: tool not enabled — the user's permission "
                              "settings do not allow it")
                    action = tool_action("error", f'{call["name"]} — blocked by permissions',
                                         call["name"], call["arguments"], result, error=True)
                elif call["name"] in MUTATING_TOOLS and actions >= MAX_TOOL_ACTIONS:
                    result = ("error: change limit for one message reached — "
                              "stop and tell the user")
                    action = tool_action("error", f'{call["name"]} — change limit reached',
                                         call["name"], call["arguments"], result, error=True)
                else:
                    result, action = run_agent_tool(user, scope,
                                                    call["name"], call["arguments"])
                # Reads and failures render as chips too, but only applied
                # mutations count against the change budget.
                if call["name"] in MUTATING_TOOLS and not action.get("error"):
                    actions += 1
                yield ("action", action)
                messages.append({"role": "tool", "call_id": call["id"], "content": result})
            if round_no == max_rounds - 1:
                yield ("delta", "\n\n*(stopped: tool-round limit reached — "
                                "raise it in Settings → Assistant)*")
                return
            resp = _open_ai(messages, system, entry, rt, pdf_b64s, effort=effort,
                            timeout=180, images=images, stream=True, tools=tools)

    try:
        if payload.stream:
            # Open upstream eagerly: connection/auth errors still become a
            # proper HTTP error instead of dying inside a committed stream.
            resp = open_with_fallback(True)

            if tools:
                def agent_ndjson():
                    try:
                        for kind, data in agent_events(resp):
                            yield json.dumps({"delta" if kind == "delta" else "action": data}) + "\n"
                    except Exception as e:
                        log.warning(f"[ai_chat] agent stream error: {e}")
                        yield json.dumps({"error": f"AI call failed: {e}"}) + "\n"

                return StreamingResponse(agent_ndjson(), media_type="application/x-ndjson")

            def ndjson():
                try:
                    for text in _sse_deltas(resp, _protocol(rt, entry)):
                        yield json.dumps({"delta": text}) + "\n"
                except Exception as e:
                    log.warning(f"[ai_chat] stream error: {e}")
                    yield json.dumps({"error": f"AI call failed: {e}"}) + "\n"
                finally:
                    resp.close()

            return StreamingResponse(ndjson(), media_type="application/x-ndjson")
        if tools:
            # The tool loop is SSE-based on every protocol; join it for
            # non-stream callers and return the actions alongside the text.
            parts, actions = [], []
            for kind, data in agent_events(open_with_fallback(True)):
                (parts if kind == "delta" else actions).append(data)
            return {"response": "".join(parts), "actions": actions}
        with open_with_fallback(False) as resp2:
            text = _read_reply(resp2, _protocol(rt, entry))
        return {"response": text}
    except HTTPException:
        raise
    except Exception as e:
        log.warning(f"[ai_chat] API error: {e}")
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")

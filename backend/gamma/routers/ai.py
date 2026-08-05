"""AI chat, provider settings, model discovery, and ChatGPT OAuth routes."""

import json
import re
import secrets
import sqlite3
import time
import urllib.error
from urllib.request import Request as URLRequest, urlopen

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import chatgpt_oauth
from ..ai_client import (
    UpstreamError,
    call_ai as _call_ai,
    chatgpt_request as _chatgpt_request,
    open_ai as _open_ai,
    protocol as _protocol,
    read_reply as _read_reply,
    sse_deltas as _sse_deltas,
    upstream_detail as _upstream_detail,
)
from ..ai_context import (
    build_messages as _build_messages,
    extract_pdf_context as _extract_pdf_context,
    gather_inputs as _gather_inputs,
    parse_files as _parse_files,
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
    load_provider_entries,
    new_provider_id,
    require_ai_runtime,
    save_provider_entries,
)
from ..auth import require_user
from ..config import AI_PROTOCOLS
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
    model: str = ""       # model registry id ("provider:model"), must be in AI_MODELS
    selection: str = ""   # text the user selected in the PDF — focus the answer on it
    attach_pdf: bool = False  # send the PDF itself instead of extracted text
    effort: str = ""      # reasoning effort; empty = provider default (param omitted)
    system: str = ""      # custom system prompt; empty = built-in default
    pages: list = Field(default_factory=list)  # page block ids for multi-PDF chat / reports
    include_notes: bool = False  # also include the user's highlights + notes for those pages
    images: list = Field(default_factory=list)  # pasted figures as data URLs
    files: list = Field(default_factory=list)  # uploaded PDFs as {name, data} data URLs
    stream: bool = False  # NDJSON stream of {"delta": …} lines instead of one JSON body
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
            row = conn.execute(
                "SELECT ver FROM pdf_fts_docs WHERE doc_id = ?", (doc_id,)
            ).fetchone()
    except sqlite3.OperationalError:
        row = None  # index tables don't exist yet — search has never run
    return {"indexed": bool(row and row[0] == INDEX_VERSION),
            "index_stale": bool(row and row[0] != INDEX_VERSION)}


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


_SYSTEM_PROMPT = ("You are a research assistant helping the user understand a PDF they are reading. "
                  "The user may ask questions about the document. Be concise and reference specific "
                  "parts of the text when relevant.")

# Default prompt for AI-based metadata extraction (used when neither an arXiv id
# nor a DOI identifies the paper). Editable per-user in the frontend prompt editor.
METADATA_PROMPT = (
    "You extract bibliographic metadata from the first pages of an academic paper. "
    "Reply with ONLY a JSON object (no code fences, no commentary) with these keys: "
    'title (string), authors (list of "First Last" strings, in order), year (string), '
    "venue (journal or conference name; \"arXiv\" for preprints), volume (string), "
    "pages (string, e.g. \"173-179\"), doi (string), arxiv_id (string, e.g. \"1810.11086\"). "
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
    "without _et al._; for two authors use \"Surname & Surname\"."
)



@router.get("/ai/models")
async def ai_models(request: Request):
    user = require_user(request)
    rt = ai_runtime(user)
    return {
        "enabled": rt["enabled"],
        "models": rt["models"],             # [{id: "<pid>:<model>", provider, provider_name, model}, ...]
        "default": rt["default"]["id"] if rt["default"] else "",
        "efforts": ["low", "medium", "high"],  # offered in the UI; omitted unless picked
        "default_prompt": _SYSTEM_PROMPT,   # shown in the prompt editor
        "metadata_prompt": METADATA_PROMPT,  # AI metadata-extraction fallback
        "cite_prompt": CITE_PROMPT,          # PPT-style citation generator
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
        out.append({
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
        })
    return {
        "providers": out,
        # Feeds the "Add provider" dropdown and the form placeholders.
        # auth "oauth" = sign-in entries (no API key field in the form).
        "protocols": [
            {"id": pid, "label": conf["label"], "default_base_url": conf["base_url"],
             "default_model": conf["default_model"], "auth": conf.get("auth", "key")}
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
    protocol: str = ""      # "anthropic" | "openai" (required on add)
    name: str | None = None      # display label; "" = protocol label
    api_key: str | None = None   # required on add; omitted/empty on edit = keep
    base_url: str | None = None  # "" = protocol default
    models: str | None = None    # comma-separated model names; "" = protocol default


def _apply_provider_fields(entry: dict, payload: AIProviderRequest):
    """Validate + copy the editable fields of a provider entry in place."""
    if payload.name is not None:
        entry["name"] = str(payload.name).strip()[:MAX_NAME_LEN]
    if payload.api_key:  # never clears — deleting the entry is the only way to drop a key
        key = str(payload.api_key).strip()
        if not key or len(key) > MAX_KEY_LEN or any(c.isspace() for c in key):
            raise HTTPException(status_code=400, detail="invalid API key")
        entry["api_key"] = key
    if payload.base_url is not None:
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
        raise HTTPException(status_code=400,
                            detail="ChatGPT entries are created by signing in — use the Connect button")
    if payload.protocol not in AI_PROTOCOLS:
        raise HTTPException(status_code=400, detail="protocol must be 'anthropic' or 'openai'")
    if not (payload.api_key or "").strip():
        raise HTTPException(status_code=400, detail="API key required")
    entry = {"id": new_provider_id(), "protocol": payload.protocol,
             "name": "", "api_key": "", "base_url": "", "models": "",
             "created_at": page_now()}
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
    if (payload.protocol and payload.protocol in AI_PROTOCOLS
            and AI_PROTOCOLS[payload.protocol].get("auth")
                == AI_PROTOCOLS.get(entry.get("protocol"), {}).get("auth")):
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


# Fallback when the live listing fails on a connected entry (offline, backend
# hiccup): models the ChatGPT backend has been known to serve.
_CHATGPT_MODEL_FALLBACK = [
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
]
# GET {base}/models gates its answer on the caller's version — keep in rough
# sync with a current Codex CLI release so new models show up.
_CHATGPT_CLIENT_VERSION = "0.146.0"
_MODEL_CATALOG_TIMEOUT = 5


def _model_catalog_json(req: URLRequest) -> dict:
    """Fetch one model catalog with a short, UI-friendly timeout."""
    with urlopen(req, timeout=_MODEL_CATALOG_TIMEOUT) as resp:
        return json.loads(resp.read())


def _chatgpt_model_catalog(user: str, provider_id: str = "") -> list:
    """Live model list from the ChatGPT (codex) backend, Codex CLI's own
    listing call: GET {base}/models?client_version=… with the OAuth bearer.
    Needs a connected entry — the list is account-gated; falls back to the
    known-good list only when the fetch itself fails."""
    providers = ai_runtime(user)["providers"]
    conf = providers.get(provider_id)
    if not conf or conf.get("protocol") != "chatgpt":
        # Pre-connect "Add key" form has no entry yet — any connected one will do.
        conf = next((c for c in providers.values() if c.get("protocol") == "chatgpt"), None)
    if not conf:
        raise HTTPException(status_code=400,
                            detail="sign in with ChatGPT first — the model list comes from your account")
    try:
        req = URLRequest(
            f"{conf['base_url']}/models?client_version={_CHATGPT_CLIENT_VERSION}",
            headers={
                "Authorization": f"Bearer {conf['api_key']}",
                "chatgpt-account-id": conf.get("account_id", ""),
                "originator": "codex_cli_rs",
            })
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
        return models or _CHATGPT_MODEL_FALLBACK
    except Exception as e:
        log.warning(f"[ai] chatgpt model listing failed, using fallback: {e}")
        return _CHATGPT_MODEL_FALLBACK


class ModelCatalogRequest(BaseModel):
    provider_id: str = ""  # saved entry to use the stored key of; "" = use the fields below
    protocol: str = ""
    api_key: str = ""
    base_url: str = ""


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
        return {"models": _chatgpt_model_catalog(user, payload.provider_id)}
    if protocol not in AI_PROTOCOLS:
        raise HTTPException(status_code=400, detail="unknown protocol")
    key = (payload.api_key or "").strip() or (entry.get("api_key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="enter the API key first, then load the model list")
    base = ((payload.base_url or "").strip() or (entry.get("base_url") or "").strip()
            or AI_PROTOCOLS[protocol]["base_url"]).rstrip("/")
    try:
        if protocol == "anthropic":
            req = URLRequest(f"{base}/v1/models?limit=100",
                             headers={
                                 "x-api-key": key,
                                 "anthropic-version": "2023-06-01",
                                 "Accept": "application/json",
                                 "User-Agent": "Gamma/model-catalog",
                             })
        else:
            req = URLRequest(f"{base}/v1/models", headers={
                "Authorization": f"Bearer {key}",
                "Accept": "application/json",
                "User-Agent": "Gamma/model-catalog",
            })
        data = _model_catalog_json(req)
    except urllib.error.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"model list failed: {_upstream_detail(e, 200)}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"model list failed: {e}")
    ids = [str(m.get("id") or "") for m in (data.get("data") or []) if m.get("id")]
    if protocol == "openai":
        # The account listing includes embeddings/audio/image models the chat
        # endpoint can't use — keep the conversational families.
        ids = [i for i in ids
               if re.match(r"^(gpt-|o\d|chatgpt-)", i)
               and not re.search(r"embed|whisper|tts|audio|image|dall-e|moderation|transcribe|realtime|search", i)]
    return {"models": sorted(set(ids))}


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
        f"Content-Type: {content_type}\r\n\r\n".encode() + data + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# Sync def: the provider upload runs in the threadpool.
@router.post("/ai/transcribe")
def ai_transcribe(request: Request, file: UploadFile = File(...),
                  model_hint: str = Form(""), model: str = Form(""), language: str = Form("")):
    """Speech-to-text for the chat composer's mic button. Audio goes to the
    OpenAI transcriptions API with the user's own key — `model_hint` is the
    chat's current model-registry id, so dictation billing follows the chat's
    provider when that entry speaks the OpenAI protocol. `model` and
    `language` (ISO-639-1, "" = auto-detect) come from Settings → AI chat."""
    user = require_user(request)
    rt = require_ai_runtime(user)
    hinted = rt["providers"].get((model_hint or "").split(":", 1)[0])
    conf = hinted if hinted and hinted["protocol"] == "openai" else next(
        (c for c in rt["providers"].values() if c["protocol"] == "openai"), None)
    if not conf:
        raise HTTPException(status_code=503,
                            detail="Voice input needs an OpenAI API-key provider (Settings → AI providers) — "
                                   "Anthropic and ChatGPT sign-in entries don't offer transcription.")
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
        body, content_type = _multipart_body(
            fields, filename, file.content_type or "application/octet-stream", audio)
        req = URLRequest(f"{conf['base_url']}/v1/audio/transcriptions", data=body, headers={
            "Authorization": f"Bearer {conf['api_key']}",
            "Content-Type": content_type,
        })
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
    callback: str = ""      # pasted redirect URL (or a bare authorization code)
    provider_id: str = ""   # existing entry to reconnect; "" creates a new one
    name: str = ""
    models: str = ""


@router.post("/ai/oauth/chatgpt/complete")
async def chatgpt_auth_complete(payload: ChatGPTAuthComplete, request: Request):
    user = _require_editor(request)
    st = _OAUTH_STATES.pop(payload.state, None)
    if not st or time.time() - st["at"] > _OAUTH_STATE_TTL:
        raise HTTPException(status_code=400,
                            detail="sign-in session expired — hit 'Open ChatGPT sign-in' again")
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
                live = _chatgpt_model_catalog(user, entry["id"])
            except Exception:
                live = []
            entry["models"] = ", ".join(live[:2])[:MAX_MODELS_LEN] or _CHATGPT_DEFAULT_MODELS
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

    def prepared(allow_native):
        pdf_b64s, context = _gather_inputs(user, payload, allow_native)
        messages = _build_messages(payload, context)
        # A custom prompt always applies; the built-in one only when there's a document
        system = custom_system or (_SYSTEM_PROMPT if (context or pdf_b64s) else "")
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
                                effort=effort, timeout=180, images=images, stream=stream)
                if not native and True in attempts:
                    _NATIVE_PDF_REJECTED.add(entry["provider"])
                return resp
            except UpstreamError as e:
                if not (native and pdf_b64s and _protocol(rt, entry) == "chatgpt"
                        and 400 <= e.status < 500):
                    raise
                log.warning(f"[ai_chat] chatgpt rejected native PDF parts, retrying as text: {e}")

    try:
        if payload.stream:
            # Open upstream eagerly: connection/auth errors still become a
            # proper HTTP error instead of dying inside a committed stream.
            resp = open_with_fallback(True)

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
        with open_with_fallback(False) as resp2:
            text = _read_reply(resp2, _protocol(rt, entry))
        return {"response": text}
    except HTTPException:
        raise
    except Exception as e:
        log.warning(f"[ai_chat] API error: {e}")
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")

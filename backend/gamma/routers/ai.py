"""AI chat (Anthropic or OpenAI wire protocol), report generation, and chat history."""

import base64
import json
import re
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from urllib.request import Request as URLRequest, urlopen

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import chatgpt_oauth
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
from ..blocks_store import fetch_subtree
from ..config import AI_PROTOCOLS
from ..db import connect_data_db, page_now, user_db_path, user_uploads_dir
from ..pdf_text import PDF_EXTRACT_FAILED, extract_text

router = APIRouter(prefix="/api", tags=["ai"])

MAX_ATTACH_PDF_BYTES = 15 * 1024 * 1024  # keep base64 payload well under API request limits

# Reasoning-depth values accepted by both wire protocols (Anthropic
# output_config.effort / OpenAI reasoning_effort). Only sent when the user
# picks one — many models reject the parameter outright.
EFFORT_LEVELS = {"minimal", "low", "medium", "high", "xhigh", "max"}


class AIChatRequest(BaseModel):
    prompt: str
    doc_id: str = ""
    history: list = []  # [{role: "user"|"ai", text: str}, ...]
    model: str = ""       # model registry id ("provider:model"), must be in AI_MODELS
    selection: str = ""   # text the user selected in the PDF — focus the answer on it
    attach_pdf: bool = False  # send the PDF itself instead of extracted text
    effort: str = ""      # reasoning effort; empty = provider default (param omitted)
    system: str = ""      # custom system prompt; empty = built-in default
    pages: list = []      # page block ids to include as context (multi-PDF chat / reports)
    include_notes: bool = False  # also include the user's highlights + notes for those pages
    images: list = []     # pasted figures as data URLs ("data:image/png;base64,…")
    files: list = []      # uploaded PDFs as {name, data} with a data URL — attached natively
    stream: bool = False  # NDJSON stream of {"delta": …} lines instead of one JSON body
    context_char_limit: int = Field(default=8000, ge=100, le=1_000_000)
    multi_context_char_limit: int = Field(default=18000, ge=100, le=1_000_000)


def _parse_images(images: list) -> list[tuple[str, str]]:
    """Validated (media_type, base64) pairs from data URLs; junk is dropped."""
    out = []
    for s in (images or [])[:4]:
        m = re.match(r"^data:(image/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$", str(s))
        if not m:
            continue
        mt, b64 = m.group(1), m.group(2)
        if len(b64) > 8_000_000:  # ~6 MB image — beyond that providers reject anyway
            continue
        out.append(("image/jpeg" if mt == "image/jpg" else mt, b64))
    return out


def _parse_files(files: list) -> list[str]:
    """Base64 payloads of uploaded PDF data URLs ({name, data} items); junk
    and oversize entries are dropped."""
    out = []
    for f in (files or [])[:4]:
        if not isinstance(f, dict):
            continue
        m = re.match(r"^data:application/pdf;base64,([A-Za-z0-9+/=]+)$", str(f.get("data", "")))
        if not m:
            continue
        b64 = m.group(1)
        if len(b64) > MAX_ATTACH_PDF_BYTES * 4 // 3:
            continue
        out.append(b64)
    return out


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


def _final_prompt(payload: AIChatRequest) -> str:
    prompt = payload.prompt
    selection = (payload.selection or "").strip()[:24000]
    if selection:
        prompt = (
            f"{prompt}\n\n"
            f'The user has selected the following passage(s) from the document '
            f'(multiple passages are separated by "---"). '
            f'Answer specifically about them:\n"""\n{selection}\n"""'
        )
    return prompt


def _build_messages(payload: AIChatRequest, context: str):
    """Build the messages array with chat history and PDF context.
    Context is prepended to the first user message. History is included
    for multi-turn conversations."""
    msgs = []
    has_context = bool(context)
    context_used = False
    for h in (payload.history or []):
        # Anthropic Messages API requires "user" / "assistant"; the frontend
        # tags assistant turns as "ai" in its local chat state.
        role = "assistant" if h.get("role") == "ai" else "user"
        content = h.get("text", "")
        if role == "user" and has_context and not context_used:
            content = f"Here is the PDF text:\n\n{context}\n\nUser question: {content}"
            context_used = True
        msgs.append({"role": role, "content": content})
    # Always append the current prompt
    content = _final_prompt(payload)
    if has_context and not context_used:
        content = f"Here is the PDF text:\n\n{context}\n\nUser question: {content}"
    msgs.append({"role": "user", "content": content})
    return msgs


def _download_pdf_from_source(user: str, doc_id: str, pdf_path):
    """Best-effort: fetch the PDF from its recorded source_url so we can extract text."""
    print(f"[ai_chat] PDF NOT FOUND at {pdf_path}, attempting download from source_url")
    try:
        with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
            row = conn.execute(
                "SELECT properties FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
                (doc_id,),
            ).fetchone()
        if not row:
            return
        props = json.loads(row[0] or "{}")
        src = props.get("source_url") or props.get("sourceUrl") or ""
        if not src:
            return
        req = URLRequest(src, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/pdf,*/*;q=0.8"})
        with urlopen(req, timeout=30) as resp:
            pdf_data = resp.read()
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(pdf_data)
        print(f"[ai_chat] downloaded {len(pdf_data)} bytes from {src}")
    except Exception as dl_err:
        print(f"[ai_chat] download failed: {dl_err}")


def _pdf_path(user: str, doc_id: str):
    """Local path of the doc's PDF, downloading from source_url if needed."""
    pdf_path = user_uploads_dir(user) / f"{doc_id}.pdf"
    if not pdf_path.exists():
        _download_pdf_from_source(user, doc_id, pdf_path)
    return pdf_path if pdf_path.exists() else None


def _truncate(text: str, limit: int) -> str:
    return text[:limit] + "\n…[truncated]" if len(text) > limit else text


def _extract_pdf_context(user: str, doc_id: str, limit: int = 8000) -> str:
    pdf_path = _pdf_path(user, doc_id)
    if not pdf_path:
        print("[ai_chat] PDF still not found after download attempt")
        return ""
    try:
        return _truncate(extract_text(str(pdf_path), limit), limit)
    except Exception as e:
        print(f"[ai_chat] extraction error: {e}")
        return PDF_EXTRACT_FAILED


def _load_pdf_b64(user: str, doc_id: str) -> str | None:
    """Base64 of the doc's PDF for native attachment, or None if unavailable/too big."""
    pdf_path = _pdf_path(user, doc_id)
    if not pdf_path:
        return None
    data = pdf_path.read_bytes()
    if len(data) > MAX_ATTACH_PDF_BYTES:
        print(f"[ai_chat] PDF too large to attach ({len(data)} bytes), falling back to text")
        return None
    return base64.standard_b64encode(data).decode("ascii")


# Sync def: extraction runs in the threadpool (pdfium stops at the sample cap).
@router.get("/pdf-text-status")
def pdf_text_status(doc_id: str, request: Request, preview: int = 0):
    """Whether a doc's PDF yields extractable text. Feeds the metadata
    popover's health row — a scanned/image-only PDF is why AI answers blind
    and metadata lookups come up empty. `preview` > 0 additionally returns
    that many characters of the text itself (capped)."""
    user = require_user(request)
    preview = min(max(preview, 0), 20000)
    pdf_path = _pdf_path(user, doc_id)
    if not pdf_path:
        return {"found": False, "ok": False, "chars": 0}
    try:
        text = extract_text(str(pdf_path), preview or 4000)
        stripped = text.strip()
        out = {"found": True, "ok": len(stripped) >= 50, "chars": len(stripped)}
        if preview:
            out["text"] = text[:preview]
        return out
    except Exception as e:
        print(f"[pdf-text-status] {e}")
        return {"found": True, "ok": False, "chars": 0}


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


def _anthropic_request(conf, messages, system, model, pdf_b64s=None, effort="", max_tokens=8192, images=None, stream=False):
    """Anthropic Messages API: POST /v1/messages, x-api-key auth."""
    if pdf_b64s or images:
        last = messages[-1]
        last["content"] = [
            *[{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b}}
              for b in (pdf_b64s or [])],
            *[{"type": "image", "source": {"type": "base64", "media_type": mt, "data": b}}
              for (mt, b) in (images or [])],
            {"type": "text", "text": last["content"]},
        ]
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }
    if effort:
        body["output_config"] = {"effort": effort}
    if stream:
        body["stream"] = True
    return urllib.request.Request(f"{conf['base_url']}/v1/messages", data=json.dumps(body).encode(), headers={
        "x-api-key": conf["api_key"],
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    })


def _anthropic_extract(data) -> str:
    text = "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")
    if not text.strip():
        raise RuntimeError(f"empty response (stop_reason={data.get('stop_reason', 'unknown')})")
    return text


def _openai_request(conf, messages, system, model, pdf_b64s=None, effort="", max_tokens=8192, images=None, stream=False):
    """OpenAI Chat Completions API: POST /v1/chat/completions, Bearer auth."""
    if pdf_b64s or images:
        last = messages[-1]
        last["content"] = [
            *[{"type": "file", "file": {"filename": f"document-{i + 1}.pdf",
                                        "file_data": f"data:application/pdf;base64,{b}"}}
              for i, b in enumerate(pdf_b64s or [])],
            *[{"type": "image_url", "image_url": {"url": f"data:{mt};base64,{b}"}}
              for (mt, b) in (images or [])],
            {"type": "text", "text": last["content"]},
        ]
    if system:
        messages = [{"role": "system", "content": system}] + messages
    body = {
        "model": model,
        # not max_tokens: current OpenAI models 400 on it ("use max_completion_tokens").
        # The cap covers hidden reasoning tokens too, so it must be generous —
        # reasoning models can burn thousands of tokens before the first visible one.
        "max_completion_tokens": max_tokens,
        "messages": messages,
    }
    if effort:
        body["reasoning_effort"] = effort
    if stream:
        body["stream"] = True
    return urllib.request.Request(f"{conf['base_url']}/v1/chat/completions", data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {conf['api_key']}",
        "Content-Type": "application/json",
    })


def _openai_extract(data) -> str:
    choices = data.get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content") or ""
    if not text.strip():
        reason = choices[0].get("finish_reason", "unknown")
        raise RuntimeError(
            f"empty response (finish_reason={reason} — a reasoning model may have spent "
            f"the whole token budget thinking; try effort: low or a shorter request)")
    return text


def _chatgpt_request(conf, messages, system, model, pdf_b64s=None, effort="", max_tokens=8192, images=None, stream=False):
    """ChatGPT backend (subscription OAuth): POST {base}/responses.

    Speaks the Responses API and ONLY streams SSE — non-stream callers join
    the deltas in _call_ai. Attachments use the Responses input_file /
    input_image parts; ai_chat falls back to extracted text if the backend
    rejects the file part."""
    items = []
    for m in messages:
        if m["role"] == "assistant":
            items.append({"type": "message", "role": "assistant",
                          "content": [{"type": "output_text", "text": m["content"]}]})
        else:
            items.append({"type": "message", "role": "user",
                          "content": [{"type": "input_text", "text": m["content"]}]})
    if pdf_b64s or images:
        last = items[-1]
        last["content"] = [
            *[{"type": "input_file", "filename": f"document-{i + 1}.pdf",
               "file_data": f"data:application/pdf;base64,{b}"}
              for i, b in enumerate(pdf_b64s or [])],
            *[{"type": "input_image", "image_url": f"data:{mt};base64,{b}"}
              for (mt, b) in (images or [])],
            *last["content"],
        ]
    body = {
        "model": model,
        "instructions": system or "You are a helpful research assistant.",
        "input": items,
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "store": False,   # the backend requires stateless requests
        "stream": True,   # …and always streams
        "include": [],
    }
    if effort:
        body["reasoning"] = {"effort": effort}
    return urllib.request.Request(f"{conf['base_url']}/responses", data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {conf['api_key']}",
        "chatgpt-account-id": conf.get("account_id", ""),
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "session_id": str(uuid.uuid4()),
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    })


# protocol -> (request builder, non-stream reply extractor). chatgpt has no
# extractor: its backend only streams, so _read_reply joins the SSE deltas.
_WIRE = {
    "anthropic": (_anthropic_request, _anthropic_extract),
    "openai": (_openai_request, _openai_extract),
    "chatgpt": (_chatgpt_request, None),
}


def _protocol(rt, entry) -> str:
    """Wire protocol of the provider entry serving a model registry entry —
    provider ids are user-generated, only the entry's protocol picks the wire."""
    return rt["providers"][entry["provider"]]["protocol"]


class UpstreamError(RuntimeError):
    """Provider HTTP error with the status attached (fallback logic keys on it)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _upstream_detail(e: urllib.error.HTTPError, cap: int = 500) -> str:
    """Human-readable upstream failure — the body, not just the status line
    ("400 Bad Request" alone is undebuggable)."""
    body = ""
    try:
        body = e.read().decode("utf-8", "replace")[:cap]
    except Exception:
        pass
    return f"upstream {e.code}: {body or e.reason}"


def _open_ai(messages, system, entry, rt, pdf_b64s=None, effort="", max_tokens=8192, timeout=60, images=None, stream=False):
    """Open the provider HTTP call for `entry` (a model registry entry) using
    the user's effective config (`rt` from ai_runtime()). Raises before any
    bytes are consumed, so callers can still return a normal HTTP error status."""
    conf = rt["providers"][entry["provider"]]
    build_request = _WIRE[conf["protocol"]][0]
    req = build_request(conf, messages, system, entry["model"], pdf_b64s, effort, max_tokens, images, stream)
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = _upstream_detail(e)
        print(f"[ai] {detail}")
        raise UpstreamError(e.code, detail)


def _read_reply(resp, proto) -> str:
    """Full reply text from an open provider response, any protocol.
    chatgpt's backend only streams — join its SSE deltas."""
    if proto == "chatgpt":
        return "".join(_sse_deltas(resp, proto))
    return _WIRE[proto][1](json.loads(resp.read()))


def _call_ai(messages, system, entry, rt, pdf_b64s=None, effort="", max_tokens=8192, timeout=60, images=None):
    """Send a chat to the provider that serves `entry`; return the full reply text."""
    with _open_ai(messages, system, entry, rt, pdf_b64s, effort, max_tokens, timeout, images) as resp:
        return _read_reply(resp, _protocol(rt, entry))


def _sse_deltas(resp, provider):
    """Text deltas from a provider's SSE stream (both speak `data: {json}` lines)."""
    got_text = False
    stop = ""
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            ev = json.loads(data)
        except ValueError:
            continue
        if provider == "anthropic":
            kind = ev.get("type")
            if kind == "content_block_delta":
                text = (ev.get("delta") or {}).get("text") or ""
                if text:
                    got_text = True
                    yield text
            elif kind == "message_delta":
                stop = (ev.get("delta") or {}).get("stop_reason") or stop
            elif kind == "error":
                raise RuntimeError((ev.get("error") or {}).get("message") or "stream error")
        elif provider == "chatgpt":
            kind = ev.get("type") or ""
            if kind == "response.output_text.delta":
                text = ev.get("delta") or ""
                if text:
                    got_text = True
                    yield text
            elif kind == "response.completed":
                stop = ((ev.get("response") or {}).get("status")) or "completed"
            elif kind in ("response.failed", "error"):
                err = ((ev.get("response") or {}).get("error") or {}) if kind == "response.failed" else ev
                raise RuntimeError(err.get("message") or "stream error")
        else:
            if ev.get("error"):
                raise RuntimeError((ev["error"] or {}).get("message") or "stream error")
            choice = (ev.get("choices") or [{}])[0]
            text = (choice.get("delta") or {}).get("content") or ""
            if text:
                got_text = True
                yield text
            stop = choice.get("finish_reason") or stop
    if not got_text:
        raise RuntimeError(
            f"empty response (stop reason={stop or 'unknown'} — a reasoning model may have spent "
            f"the whole token budget thinking; try effort: low or a shorter request)")


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
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
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
        print(f"[ai] chatgpt model listing failed, using fallback: {e}")
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
                             headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
        else:
            req = URLRequest(f"{base}/v1/models", headers={"Authorization": f"Bearer {key}"})
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
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


def _pdf_text_from_b64(b64: str, limit: int = 8000) -> str:
    """Extracted text of a base64 PDF (fallback when native attach is refused)."""
    try:
        return _truncate(extract_text(base64.standard_b64decode(b64), limit), limit)
    except Exception as e:
        print(f"[ai_chat] uploaded-PDF extraction failed: {e}")
        return ""


def _gather_inputs(user: str, payload: AIChatRequest, allow_native: bool):
    """(pdf_b64s, context) for a chat request. allow_native=False forces every
    document into extracted text — the fallback when a provider (the ChatGPT
    backend) rejects native file parts."""
    pdf_b64s = []
    context_sections = []
    attach = payload.attach_pdf and allow_native

    page_ids = [str(p) for p in (payload.pages or []) if p][:6]
    if page_ids:
        # Multi-page context: attach/extract each selected page's PDF, and
        # optionally the user's highlights + notes for it.
        text_budget = max(1, payload.multi_context_char_limit // len(page_ids))
        total_b64 = 0
        with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
            for pid in page_ids:
                row = conn.execute(
                    "SELECT content, properties FROM unified_blocks WHERE id = ?", (pid,)
                ).fetchone()
                if not row:
                    continue
                title = row[0] or "Untitled"
                props = json.loads(row[1] or "{}")
                doc_id = props.get("doc_id") or ""
                attached = False
                if doc_id and attach:
                    b64 = _load_pdf_b64(user, doc_id)
                    if b64 and total_b64 + len(b64) < 20_000_000:
                        pdf_b64s.append(b64)
                        total_b64 += len(b64)
                        attached = True
                if doc_id and not attached:
                    txt = _extract_pdf_context(user, doc_id, limit=text_budget)
                    if txt:
                        context_sections.append(f"### {title}\n{txt}")
                if payload.include_notes:
                    section = _page_report_section(conn, user, pid, 0)  # notes only, no PDF excerpt
                    if section:
                        context_sections.append(section)
    elif payload.doc_id:
        # Single-document chat for the open page
        if attach:
            b64 = _load_pdf_b64(user, payload.doc_id)
            if b64:
                pdf_b64s.append(b64)
        if not pdf_b64s:
            txt = _extract_pdf_context(user, payload.doc_id, limit=payload.context_char_limit)
            if txt:
                context_sections.append(txt)

    # Ad-hoc uploads from the chat "+" menu ride along regardless of attach_pdf.
    for i, b64 in enumerate(_parse_files(payload.files)):
        if allow_native:
            pdf_b64s.append(b64)
        else:
            txt = _pdf_text_from_b64(b64)
            if txt:
                context_sections.append(f"### Attached PDF {i + 1}\n{txt}")

    return pdf_b64s, "\n\n---\n\n".join(context_sections)


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
                print(f"[ai_chat] chatgpt rejected native PDF parts, retrying as text: {e}")

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
                    print(f"[ai_chat] stream error: {e}")
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
        print(f"[ai_chat] API error: {e}")
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")


# --- Per-page notes/highlights context (used by multi-paper chat) ------------

def _page_report_section(conn, user: str, page_id: str, pdf_budget: int) -> str | None:
    rows = fetch_subtree(conn, page_id)
    if not rows:
        return None
    by_parent: dict = {}
    root = None
    for r in rows:
        if r[0] == page_id:
            root = r
        else:
            by_parent.setdefault(r[1], []).append(r)
    for v in by_parent.values():
        v.sort(key=lambda r: r[2])

    props = json.loads(root[4] or "{}")
    highlights: list[str] = []
    notes: list[str] = []

    def walk(bid, depth):
        for r in by_parent.get(bid, []):
            p = json.loads(r[4] or "{}")
            quote = (p.get("quote") or "").strip()
            content = (r[3] or "").strip()
            if quote:
                entry = f'- Highlighted: "{quote}"'
                if content:
                    entry += f"\n  User note: {content}"
                highlights.append(entry)
            elif content:
                notes.append("  " * depth + f"- {content}")
            walk(r[0], depth + 1)

    walk(page_id, 0)

    lines = [f"### {root[3] or 'Untitled'}"]
    if props.get("summary"):
        lines.append(f"Summary: {props['summary']}")
    if props.get("doc_id") and pdf_budget > 0:
        excerpt = _extract_pdf_context(user, props["doc_id"], limit=pdf_budget)
        if excerpt:
            lines.append(f"Document text (excerpt):\n{excerpt}")
    if highlights:
        lines.append("User's highlighted passages:\n" + "\n".join(highlights))
    if notes:
        lines.append("User's notes:\n" + "\n".join(notes))
    return "\n\n".join(lines)


class ChatSaveRequest(BaseModel):
    messages: list


@router.get("/chats/{block_id}")
async def get_chat(block_id: str, request: Request):
    user = require_user(request)
    with connect_data_db(user) as db:
        row = db.execute("SELECT messages FROM chats WHERE block_id = ?", (block_id,)).fetchone()
    return {"messages": json.loads(row[0]) if row else []}


@router.put("/chats/{block_id}")
async def save_chat(block_id: str, payload: ChatSaveRequest, request: Request):
    user = require_user(request)
    with connect_data_db(user) as db:
        db.execute(
            "INSERT INTO chats (block_id, messages, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(block_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at",
            (block_id, json.dumps(payload.messages), page_now()),
        )
        db.commit()
    return {"ok": True}


@router.delete("/chats/{block_id}")
async def delete_chat(block_id: str, request: Request):
    user = require_user(request)
    with connect_data_db(user) as db:
        db.execute("DELETE FROM chats WHERE block_id = ?", (block_id,))
        db.commit()
    return {"ok": True}

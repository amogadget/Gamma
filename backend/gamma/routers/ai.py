"""AI chat (Anthropic or OpenAI wire protocol), report generation, and chat history."""

import base64
import json
import re
import sqlite3
import urllib.error
import urllib.request
from urllib.request import Request as URLRequest, urlopen

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_user
from ..blocks_store import fetch_subtree
from ..config import AI_DEFAULT_MODEL, AI_ENABLED, AI_MODELS, AI_PROVIDERS
from ..db import page_now, user_db_path, user_uploads_dir

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


def _resolve_model(requested: str) -> dict:
    """Registry entry for a requested model id (or bare model name); default otherwise."""
    for entry in AI_MODELS:
        if requested == entry["id"] or requested == entry["model"]:
            return entry
    return AI_DEFAULT_MODEL


def _resolve_effort(requested: str) -> str:
    requested = (requested or "").strip().lower()
    return requested if requested in EFFORT_LEVELS else ""


def _final_prompt(payload: AIChatRequest) -> str:
    prompt = payload.prompt
    selection = (payload.selection or "").strip()[:4000]
    if selection:
        prompt = (
            f"{prompt}\n\n"
            f'The user has selected the following passage from the document. '
            f'Answer specifically about this passage:\n"""\n{selection}\n"""'
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


def _extract_pdf_context(user: str, doc_id: str, limit: int = 8000) -> str:
    pdf_path = _pdf_path(user, doc_id)
    if not pdf_path:
        print("[ai_chat] PDF still not found after download attempt")
        return ""
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(str(pdf_path))
        pages_text = [t for page in reader.pages if (t := page.extract_text())]
        context = "\n\n".join(pages_text)
        print(f"[ai_chat] context={len(pages_text)} pages, {len(context)} chars")
        if len(context) > limit:
            context = context[:limit] + "\n…[truncated]"
        return context
    except Exception as e:
        print(f"[ai_chat] extraction error: {e}")
        return "(PDF text extraction failed)"


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


def _anthropic_request(conf, messages, system, model, pdf_b64s=None, effort="", max_tokens=8192, images=None):
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


def _openai_request(conf, messages, system, model, pdf_b64s=None, effort="", max_tokens=8192, images=None):
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


_WIRE = {
    "anthropic": (_anthropic_request, _anthropic_extract),
    "openai": (_openai_request, _openai_extract),
}


def _call_ai(messages, system, entry, pdf_b64s=None, effort="", max_tokens=8192, timeout=60, images=None):
    """Send a chat to the provider that serves `entry` (a model registry entry)."""
    conf = AI_PROVIDERS[entry["provider"]]
    if not conf["api_key"]:
        raise HTTPException(status_code=503,
                            detail=f"provider '{entry['provider']}' not configured "
                                   f"(set GAMMA_AI_{entry['provider'].upper()}_API_KEY)")
    build_request, extract_text = _WIRE[entry["provider"]]
    req = build_request(conf, messages, system, entry["model"], pdf_b64s, effort, max_tokens, images)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # Surface the upstream error body — "400 Bad Request" alone is undebuggable
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        print(f"[ai] upstream {e.code}: {body}")
        raise RuntimeError(f"upstream {e.code}: {body or e.reason}")
    return extract_text(data)


@router.get("/ai/models")
async def ai_models(request: Request):
    require_user(request)
    return {
        "enabled": AI_ENABLED,
        "models": AI_MODELS,                # [{id: "provider:model", provider, model}, ...]
        "default": AI_DEFAULT_MODEL["id"],
        "efforts": ["low", "medium", "high"],  # offered in the UI; omitted unless picked
        "default_prompt": _SYSTEM_PROMPT,   # shown in the prompt editor
        "metadata_prompt": METADATA_PROMPT,  # AI metadata-extraction fallback
        "cite_prompt": CITE_PROMPT,          # PPT-style citation generator
    }


# Sync endpoint on purpose: the AI call can take minutes; FastAPI's threadpool
# keeps the event loop free for other requests meanwhile.
@router.post("/ai/chat")
def ai_chat(payload: AIChatRequest, request: Request):
    if not AI_ENABLED:
        raise HTTPException(status_code=503, detail="AI not configured (set a provider API key)")

    user = require_user(request)

    pdf_b64s = []
    context_sections = []

    page_ids = [str(p) for p in (payload.pages or []) if p][:6]
    if page_ids:
        # Multi-page context: attach/extract each selected page's PDF, and
        # optionally the user's highlights + notes for it.
        text_budget = max(3000, 18000 // len(page_ids))
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
                if doc_id and payload.attach_pdf:
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
        if payload.attach_pdf:
            b64 = _load_pdf_b64(user, payload.doc_id)
            if b64:
                pdf_b64s.append(b64)
        if not pdf_b64s:
            txt = _extract_pdf_context(user, payload.doc_id)
            if txt:
                context_sections.append(txt)

    context = "\n\n---\n\n".join(context_sections)
    messages = _build_messages(payload, context)
    custom_system = (payload.system or "").strip()[:8000]
    # A custom prompt always applies; the built-in one only when there's a document
    system = custom_system or (_SYSTEM_PROMPT if (context or pdf_b64s) else "")
    try:
        text = _call_ai(messages, system, _resolve_model(payload.model), pdf_b64s,
                        effort=_resolve_effort(payload.effort), timeout=180,
                        images=_parse_images(payload.images))
        return {"response": text}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ai_chat] API error: {e}")
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")


# --- Multi-paper report -----------------------------------------------------

class AIReportRequest(BaseModel):
    page_ids: list
    model: str = ""
    instructions: str = ""
    effort: str = ""


_REPORT_SYSTEM = (
    "You are a research assistant. Write a well-structured markdown report about the papers/pages "
    "provided. The user's highlighted passages and notes show what they care about most — organize "
    "the report around those. For each paper summarize the key points, then draw connections, "
    "agreements, and contrasts between papers where relevant. Use headings, keep it substantive."
)


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


@router.post("/ai/report")
def ai_report(payload: AIReportRequest, request: Request):
    if not AI_ENABLED:
        raise HTTPException(status_code=503, detail="AI not configured (set a provider API key)")
    user = require_user(request)
    page_ids = [str(p) for p in (payload.page_ids or [])][:12]
    if not page_ids:
        raise HTTPException(status_code=400, detail="no pages selected")

    # Split the context budget across papers so many-paper reports stay within limits
    pdf_budget = max(2000, 24000 // len(page_ids))
    sections = []
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        for pid in page_ids:
            section = _page_report_section(conn, user, pid, pdf_budget)
            if section:
                sections.append(section)
    if not sections:
        raise HTTPException(status_code=404, detail="none of the selected pages were found")

    prompt = "Write the report for these papers/pages:\n\n" + "\n\n---\n\n".join(sections)
    if payload.instructions.strip():
        prompt += f"\n\nAdditional instructions from the user: {payload.instructions.strip()}"

    try:
        text = _call_ai([{"role": "user", "content": prompt}], _REPORT_SYSTEM,
                        _resolve_model(payload.model),
                        effort=_resolve_effort(payload.effort), max_tokens=16384, timeout=180)
        return {"report": text}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ai_report] API error: {e}")
        raise HTTPException(status_code=502, detail=f"AI call failed: {e}")


class ChatSaveRequest(BaseModel):
    messages: list


_CHATS_TABLE = "CREATE TABLE IF NOT EXISTS chats (block_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL)"


@router.get("/chats/{block_id}")
async def get_chat(block_id: str, request: Request):
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "data.db")) as db:
        db.execute(_CHATS_TABLE)
        row = db.execute("SELECT messages FROM chats WHERE block_id = ?", (block_id,)).fetchone()
    return {"messages": json.loads(row[0]) if row else []}


@router.put("/chats/{block_id}")
async def save_chat(block_id: str, payload: ChatSaveRequest, request: Request):
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "data.db")) as db:
        db.execute(_CHATS_TABLE)
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
    with sqlite3.connect(user_db_path(user, "data.db")) as db:
        db.execute(_CHATS_TABLE)
        db.execute("DELETE FROM chats WHERE block_id = ?", (block_id,))
        db.commit()
    return {"ok": True}

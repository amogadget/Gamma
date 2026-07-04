"""AI chat (Anthropic-compatible Messages API) and per-block chat history."""

import json
import sqlite3
import urllib.request
from urllib.request import Request as URLRequest, urlopen

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_user
from ..config import AI_API_KEY, AI_BASE_URL, AI_MODEL, AI_PROVIDER
from ..db import page_now, user_db_path, user_uploads_dir

router = APIRouter(prefix="/api", tags=["ai"])


class AIChatRequest(BaseModel):
    prompt: str
    doc_id: str = ""
    history: list = []  # [{role: "user"|"ai", text: str}, ...]


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
    content = payload.prompt
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


def _extract_pdf_context(user: str, doc_id: str) -> str:
    pdf_path = user_uploads_dir(user) / f"{doc_id}.pdf"
    if not pdf_path.exists():
        _download_pdf_from_source(user, doc_id, pdf_path)
    if not pdf_path.exists():
        print("[ai_chat] PDF still not found after download attempt")
        return ""
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(str(pdf_path))
        pages_text = [t for page in reader.pages if (t := page.extract_text())]
        context = "\n\n".join(pages_text)
        print(f"[ai_chat] context={len(pages_text)} pages, {len(context)} chars")
        if len(context) > 8000:
            context = context[:8000] + "\n…[truncated]"
        return context
    except Exception as e:
        print(f"[ai_chat] extraction error: {e}")
        return "(PDF text extraction failed)"


_SYSTEM_PROMPT = ("You are a research assistant helping the user understand a PDF they are reading. "
                  "The user may ask questions about the document. Be concise and reference specific "
                  "parts of the text when relevant.")


def _anthropic_request(messages, system):
    """Anthropic Messages API: POST /v1/messages, x-api-key auth."""
    body = json.dumps({
        "model": AI_MODEL,
        "max_tokens": 4096,
        "system": system,
        "messages": messages,
    }).encode()
    return urllib.request.Request(f"{AI_BASE_URL}/v1/messages", data=body, headers={
        "x-api-key": AI_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    })


def _anthropic_extract(data) -> str:
    return "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")


def _openai_request(messages, system):
    """OpenAI Chat Completions API: POST /v1/chat/completions, Bearer auth."""
    if system:
        messages = [{"role": "system", "content": system}] + messages
    body = json.dumps({
        "model": AI_MODEL,
        "max_tokens": 4096,
        "messages": messages,
    }).encode()
    return urllib.request.Request(f"{AI_BASE_URL}/v1/chat/completions", data=body, headers={
        "Authorization": f"Bearer {AI_API_KEY}",
        "Content-Type": "application/json",
    })


def _openai_extract(data) -> str:
    choices = data.get("choices") or [{}]
    return (choices[0].get("message") or {}).get("content") or ""


_PROVIDERS = {
    "anthropic": (_anthropic_request, _anthropic_extract),
    "openai": (_openai_request, _openai_extract),
}


@router.post("/ai/chat")
async def ai_chat(payload: AIChatRequest, request: Request):
    if not AI_API_KEY:
        raise HTTPException(status_code=503, detail="AI not configured (set GAMMA_AI_API_KEY)")

    user = require_user(request)
    context = _extract_pdf_context(user, payload.doc_id) if payload.doc_id else ""

    build_request, extract_text = _PROVIDERS[AI_PROVIDER]
    req = build_request(_build_messages(payload, context), _SYSTEM_PROMPT if context else "")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return {"response": extract_text(data)}
    except Exception as e:
        print(f"[ai_chat] API error: {e}")
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

"""PDF attachments, extracted document context, and common chat messages."""

import base64
import json
import re
import sqlite3
from urllib.request import Request as URLRequest, urlopen

from .blocks_store import fetch_subtree
from .db import user_db_path, user_uploads_dir
from .logbuf import log
from .pdf_text import PDF_EXTRACT_FAILED, extract_text
from .server_settings import can_store


MAX_ATTACH_PDF_BYTES = 15 * 1024 * 1024


def parse_images(images: list) -> list[tuple[str, str]]:
    """Return validated ``(media_type, base64)`` pairs from image data URLs."""
    parsed = []
    for item in (images or [])[:4]:
        match = re.match(
            r"^data:(image/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$",
            str(item),
        )
        if not match:
            continue
        media_type, data = match.group(1), match.group(2)
        if len(data) > 8_000_000:
            continue
        parsed.append(("image/jpeg" if media_type == "image/jpg" else media_type, data))
    return parsed


def parse_files(files: list) -> list[str]:
    """Return valid, size-limited PDF payloads from uploaded data URLs."""
    parsed = []
    for item in (files or [])[:4]:
        if not isinstance(item, dict):
            continue
        match = re.match(
            r"^data:application/pdf;base64,([A-Za-z0-9+/=]+)$",
            str(item.get("data", "")),
        )
        if not match:
            continue
        data = match.group(1)
        if len(data) <= MAX_ATTACH_PDF_BYTES * 4 // 3:
            parsed.append(data)
    return parsed


def final_prompt(payload) -> str:
    """Append the selected PDF passage to a user's current prompt."""
    prompt = payload.prompt
    selection = (payload.selection or "").strip()[:24000]
    if selection:
        prompt = (
            f"{prompt}\n\n"
            "The user has selected the following passage(s) from the document "
            '(multiple passages are separated by "---"). '
            f'Answer specifically about them:\n"""\n{selection}\n"""'
        )
    return prompt


def build_messages(payload, context: str) -> list[dict]:
    """Build common chat messages, injecting context once before a user turn."""
    messages = []
    context_used = False
    for history_item in (payload.history or []):
        role = "assistant" if history_item.get("role") == "ai" else "user"
        content = history_item.get("text", "")
        if role == "user" and context and not context_used:
            content = f"Here is the PDF text:\n\n{context}\n\nUser question: {content}"
            context_used = True
        messages.append({"role": role, "content": content})
    content = final_prompt(payload)
    if context and not context_used:
        content = f"Here is the PDF text:\n\n{context}\n\nUser question: {content}"
    messages.append({"role": "user", "content": content})
    return messages


def _download_pdf_from_source(user: str, doc_id: str, pdf_path) -> None:
    """Best-effort download of a missing PDF from its recorded source URL."""
    log.info(f"[ai_chat] PDF NOT FOUND at {pdf_path}, attempting download from source_url")
    try:
        with sqlite3.connect(user_db_path(user, "pages.db")) as connection:
            row = connection.execute(
                "SELECT properties FROM unified_blocks "
                "WHERE json_extract(properties, '$.doc_id') = ?",
                (doc_id,),
            ).fetchone()
        if not row:
            return
        properties = json.loads(row[0] or "{}")
        source = properties.get("source_url") or properties.get("sourceUrl") or ""
        if not source:
            return
        request = URLRequest(
            source,
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/pdf,*/*;q=0.8"},
        )
        with urlopen(request, timeout=30) as response:
            pdf_data = response.read()
        if not can_store(user, len(pdf_data)):
            log.info(f"[ai_chat] not caching {doc_id} ({len(pdf_data)} bytes): over storage limits")
            return
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(pdf_data)
        log.info(f"[ai_chat] downloaded {len(pdf_data)} bytes from {source}")
    except Exception as error:
        log.warning(f"[ai_chat] download failed: {error}")


def pdf_path(user: str, doc_id: str):
    """Return a document's local PDF path, downloading it when possible."""
    path = user_uploads_dir(user) / f"{doc_id}.pdf"
    if not path.exists():
        _download_pdf_from_source(user, doc_id, path)
    return path if path.exists() else None


def truncate(text: str, limit: int) -> str:
    return text[:limit] + "\n…[truncated]" if len(text) > limit else text


def extract_pdf_context(user: str, doc_id: str, limit: int = 8000) -> str:
    path = pdf_path(user, doc_id)
    if not path:
        log.warning("[ai_chat] PDF still not found after download attempt")
        return ""
    try:
        return truncate(extract_text(str(path), limit), limit)
    except Exception as error:
        log.warning(f"[ai_chat] extraction error: {error}")
        return PDF_EXTRACT_FAILED


def load_pdf_b64(user: str, doc_id: str) -> str | None:
    """Return a size-limited document PDF as base64."""
    path = pdf_path(user, doc_id)
    if not path:
        return None
    data = path.read_bytes()
    if len(data) > MAX_ATTACH_PDF_BYTES:
        log.info(f"[ai_chat] PDF too large to attach ({len(data)} bytes), falling back to text")
        return None
    return base64.standard_b64encode(data).decode("ascii")


def pdf_text_from_b64(data: str, limit: int = 8000) -> str:
    """Extract text from a base64 PDF when native attachment is unavailable."""
    try:
        return truncate(extract_text(base64.standard_b64decode(data), limit), limit)
    except Exception as error:
        log.warning(f"[ai_chat] uploaded-PDF extraction failed: {error}")
        return ""


def page_report_section(connection, user: str, page_id: str, pdf_budget: int) -> str | None:
    """Render a page's PDF excerpt, highlights, and nested notes as context."""
    rows = fetch_subtree(connection, page_id)
    if not rows:
        return None
    by_parent: dict = {}
    root = None
    for row in rows:
        if row[0] == page_id:
            root = row
        else:
            by_parent.setdefault(row[1], []).append(row)
    for children in by_parent.values():
        children.sort(key=lambda row: row[2])

    properties = json.loads(root[4] or "{}")
    highlights: list[str] = []
    notes: list[str] = []

    def walk(block_id, depth):
        for row in by_parent.get(block_id, []):
            child_properties = json.loads(row[4] or "{}")
            quote = (child_properties.get("quote") or "").strip()
            content = (row[3] or "").strip()
            if quote:
                entry = f'- Highlighted: "{quote}"'
                if content:
                    entry += f"\n  User note: {content}"
                highlights.append(entry)
            elif content:
                notes.append("  " * depth + f"- {content}")
            walk(row[0], depth + 1)

    walk(page_id, 0)
    sections = [f"### {root[3] or 'Untitled'}"]
    if properties.get("summary"):
        sections.append(f"Summary: {properties['summary']}")
    if properties.get("doc_id") and pdf_budget > 0:
        excerpt = extract_pdf_context(user, properties["doc_id"], limit=pdf_budget)
        if excerpt:
            sections.append(f"Document text (excerpt):\n{excerpt}")
    if highlights:
        sections.append("User's highlighted passages:\n" + "\n".join(highlights))
    if notes:
        sections.append("User's notes:\n" + "\n".join(notes))
    return "\n\n".join(sections)


def gather_inputs(user: str, payload, allow_native: bool) -> tuple[list[str], str]:
    """Collect native PDF attachments and extracted text for a chat request."""
    pdf_b64s = []
    context_sections = []
    attach = payload.attach_pdf and allow_native

    page_ids = [str(page) for page in (payload.pages or []) if page][:6]
    if page_ids:
        text_budget = max(1, payload.multi_context_char_limit // len(page_ids))
        total_b64 = 0
        with sqlite3.connect(user_db_path(user, "pages.db")) as connection:
            for page_id in page_ids:
                row = connection.execute(
                    "SELECT content, properties FROM unified_blocks WHERE id = ?",
                    (page_id,),
                ).fetchone()
                if not row:
                    continue
                title = row[0] or "Untitled"
                properties = json.loads(row[1] or "{}")
                doc_id = properties.get("doc_id") or ""
                attached = False
                if doc_id and attach:
                    data = load_pdf_b64(user, doc_id)
                    if data and total_b64 + len(data) < 20_000_000:
                        pdf_b64s.append(data)
                        total_b64 += len(data)
                        attached = True
                if doc_id and not attached:
                    text = extract_pdf_context(user, doc_id, limit=text_budget)
                    if text:
                        context_sections.append(f"### {title}\n{text}")
                if payload.include_notes:
                    section = page_report_section(connection, user, page_id, 0)
                    if section:
                        context_sections.append(section)
    elif payload.doc_id:
        if attach:
            data = load_pdf_b64(user, payload.doc_id)
            if data:
                pdf_b64s.append(data)
        if not pdf_b64s:
            text = extract_pdf_context(user, payload.doc_id, limit=payload.context_char_limit)
            if text:
                context_sections.append(text)

    for index, data in enumerate(parse_files(payload.files)):
        if allow_native:
            pdf_b64s.append(data)
        else:
            text = pdf_text_from_b64(data)
            if text:
                context_sections.append(f"### Attached PDF {index + 1}\n{text}")

    return pdf_b64s, "\n\n---\n\n".join(context_sections)

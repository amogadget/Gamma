"""PDF attachments, extracted document context, and common chat messages."""

import base64
import json
import re
import sqlite3
from urllib.request import Request as URLRequest

from .blocks_store import fetch_subtree
from .db import pdf_upload_path, user_db_path
from .logbuf import log
from .net_guard import guarded_urlopen
from .pdf_text import PDF_EXTRACT_FAILED, extract_pages, extract_text
from .server_settings import can_store
from .textnorm import normalize_text


# 55 MB overflows the context window even on gpt-5.6-sol; 40 MB is the
# empirical ceiling. Oversize attachments fall back to extracted text.
MAX_ATTACH_PDF_BYTES = 40 * 1024 * 1024


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


# Replayed tool results across the whole history share this char budget
# (newest first); older results are elided so long agent sessions don't grow
# each request without bound. The calls themselves are always kept — they are
# what stops the model from repeating work it already did.
TOOL_REPLAY_BUDGET = 8000
_ELIDED_RESULT = "(older result elided to save space — call the tool again if needed)"


def _replayable(history_item: dict) -> list[dict]:
    """The saved actions of one AI reply that carry the raw call (chips saved
    before tool recording existed have no tool/result and can't be replayed)."""
    if history_item.get("role") != "ai":
        return []
    return [a for a in (history_item.get("actions") or [])
            if isinstance(a, dict) and a.get("tool")]


def _elide_old_results(history: list) -> dict[int, set]:
    """Pick which replayed tool results keep their text: walk newest-first
    under TOOL_REPLAY_BUDGET; everything older is elided. Returns
    {history_index: {action_index, ...}} of the elided ones."""
    elided: dict[int, set] = {}
    budget = TOOL_REPLAY_BUDGET
    for i in range(len(history) - 1, -1, -1):
        for j, action in reversed(list(enumerate(_replayable(history[i])))):
            budget -= len(str(action.get("result") or ""))
            if budget < 0:
                elided.setdefault(i, set()).add(j)
    return elided


def build_messages(payload, context: str, with_tools: bool = False) -> list[dict]:
    """Build common chat messages, injecting context once before a user turn.

    With ``with_tools`` (an agent chat), each saved reply's tool calls are
    replayed as assistant ``tool_calls`` + ``role:"tool"`` result turns — the
    same common shapes the wire builders translate for the live loop — so the
    model remembers what it already listed/read/changed instead of repeating
    the calls each turn. Plain chats must not replay them: providers reject
    tool blocks without tool definitions in the request.
    """
    history = payload.history or []
    elided = _elide_old_results(history) if with_tools else {}
    messages = []
    context_used = False
    for i, history_item in enumerate(history):
        role = "assistant" if history_item.get("role") == "ai" else "user"
        content = history_item.get("text", "")
        if with_tools:
            actions = _replayable(history_item)
            if actions:
                # Calls first, then their results, then the reply prose — the
                # order the turn actually happened in. Synthetic call ids only
                # need to pair within this one request.
                messages.append({"role": "assistant", "content": "", "tool_calls": [
                    {"id": f"call_h{i}_{j}", "name": a["tool"], "arguments": a.get("args") or {}}
                    for j, a in enumerate(actions)]})
                for j, a in enumerate(actions):
                    result = (_ELIDED_RESULT if j in elided.get(i, ())
                              else str(a.get("result") or ""))
                    messages.append({"role": "tool", "call_id": f"call_h{i}_{j}",
                                     "content": result or "(empty result)"})
        if not content.strip():
            # An organizer reply can be tool actions with no prose; providers
            # (Anthropic especially) reject empty content blocks.
            continue
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
                "SELECT properties FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
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
        with guarded_urlopen(request, timeout=30) as response:
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
    try:
        path = pdf_upload_path(user, doc_id)
    except ValueError:
        return None
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


def pdf_excerpt(user: str, doc_id: str, limit: int, offset: int = 0,
                start_page: int = 1):
    """Slice ``[offset, offset+limit)`` of a document's extracted text so long
    papers can be read in successive windows; start_page (1-based) starts the
    extraction at that PDF page — the shape search hits come in — and offset
    then counts from there. Returns ``(text, next_offset, seen)``: next_offset
    is where a follow-up read should continue (None = the extraction ended
    inside this window), seen is how many chars were extracted in total — when
    offset points past the end, that's the full extracted length (from
    start_page on)."""
    path = pdf_path(user, doc_id)
    if not path:
        log.warning("[ai_chat] PDF still not found after download attempt")
        return "", None, 0
    try:
        # extract_text stops after the page that crosses the limit, so a
        # longer-than-requested result means more pages remain.
        full = extract_text(str(path), offset + limit, start_page=start_page)
    except Exception as error:
        log.warning(f"[ai_chat] extraction error: {error}")
        return PDF_EXTRACT_FAILED, None, 0
    text = full[offset:offset + limit]
    next_offset = offset + limit if len(full) > offset + limit else None
    return text, next_offset, len(full)


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


def _locate_passage(pages: list[str], passage: str) -> int | None:
    """1-based PDF page a selected passage starts on (None = not found).
    Matches the passage's head on normalized text (textnorm rules — the same
    canon the pdf.js text layer and the extractors converge to), so viewer
    selections find their spot despite ligature/whitespace differences."""
    needle = normalize_text(passage).lower()[:200]
    if len(needle) < 12:  # too short to be a trustworthy anchor
        return None
    previous = None
    for page_no, page in enumerate(pages, start=1):
        if needle in normalize_text(page).lower():
            return page_no
        # A selection starting near the bottom of a page continues onto the
        # next — normalize the seam as one string (so hyphenated line breaks
        # across the boundary re-join) and credit the page it starts on.
        if previous is not None:
            seam = normalize_text(previous[-500:] + "\n" + page[:500]).lower()
            if needle in seam:
                return page_no - 1
        previous = page
    return None


def selection_context(user: str, doc_id: str, selection: str, budget: int) -> str | None:
    """Chat context for selected passages: a small head slice (title/abstract
    grounding) plus text around each passage's PDF page — instead of spending
    the whole budget on the start of the paper, which rarely covers what the
    selection is about. Labels carry the page numbers so the model knows where
    each passage sits. None = nothing located (caller falls back to the plain
    head-of-document context)."""
    path = pdf_path(user, doc_id)
    if not path:
        return None
    try:
        pages = extract_pages(str(path))
    except Exception as error:
        log.warning(f"[ai_chat] selection-context extraction error: {error}")
        return None
    # The chat UI joins multiple selections with "---" on its own line.
    passages = [p.strip() for p in re.split(r"\n\s*---\s*\n", selection) if p.strip()][:6]
    located = [(p, page_no) for p in passages
               if (page_no := _locate_passage(pages, p))]
    if not located:
        return None
    sections = []
    head = min(2000, budget // 4)
    head_text = "\n\n".join(pages)[:head].strip()
    if head_text:
        sections.append(f"Start of the document (for grounding):\n{head_text}")
    share = max(1, (budget - head) // len(located))
    windows = 0
    seen = set()
    for _, page_no in located:
        if page_no in seen:  # passages on one page share a window
            continue
        seen.add(page_no)
        window = "\n\n".join(pages[page_no - 1:])[:share].strip()
        if window:
            windows += 1
            sections.append("Text around the selected passage "
                            f"(starting at PDF page {page_no}):\n{window}")
    return "\n\n".join(sections) if windows else None


def page_report_section(connection, user: str, page_id: str, pdf_budget: int,
                        pdf_offset: int = 0, pdf_page: int = 1) -> str | None:
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
        excerpt, next_offset, seen = pdf_excerpt(
            user, properties["doc_id"], pdf_budget, pdf_offset, pdf_page)
        at_page = f"pdf_page={pdf_page}, " if pdf_page > 1 else ""
        if excerpt:
            where = ([f"from PDF page {pdf_page}"] if pdf_page > 1 else []) + \
                    ([f"from char {pdf_offset}"] if pdf_offset else [])
            label = (f"Document text ({', '.join(where)}):" if where
                     else "Document text (excerpt):")
            if next_offset:
                excerpt += ("\n…[more text remains — call read_page again with "
                            f"{at_page}pdf_offset={next_offset} to continue]")
            sections.append(f"{label}\n{excerpt}")
        elif pdf_offset and seen:
            source = (f"the text from PDF page {pdf_page} on" if pdf_page > 1
                      else "the extracted text")
            sections.append(f"Document text: pdf_offset {pdf_offset} is past the "
                            f"end — {source} is ~{seen} chars long.")
        elif pdf_page > 1:
            sections.append(f"Document text: no text at or after PDF page {pdf_page}.")
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
            # With a selection, center the budget on the selected passages
            # (located by page) instead of the start of the paper; fall back
            # to the plain head excerpt when nothing could be located.
            selection = (payload.selection or "").strip()[:24000]
            text = (selection_context(user, payload.doc_id, selection,
                                      payload.context_char_limit)
                    if selection else None)
            if not text:
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

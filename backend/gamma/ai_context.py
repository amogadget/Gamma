"""Chat context assembly: pages from the user's knowledge base (title,
properties, notes and — when the page carries a PDF attachment — the
document's text), native PDF attachments, and the common message shapes."""

import base64
import json
import re
import sqlite3
from urllib.request import Request as URLRequest

from .blocks_store import fetch_subtree, page_attachment, page_for_doc, page_root_id
from .db import connect_pages_db, pdf_upload_path, ws_db_path
from .foldertags import parse_tags
from .logbuf import log
from .net_guard import guarded_urlopen
from .pdf_text import PDF_EXTRACT_FAILED, extract_pages, extract_text, extract_text_pages, page_count
from .server_settings import can_store
from .textnorm import normalize_text


MAX_ATTACH_PDF_BYTES = 15 * 1024 * 1024
# Cap on the selected-PDF-passages payload a chat request may carry — the
# prompt copy (final_prompt) and the context locator (gather_inputs) share it.
MAX_SELECTION_CHARS = 24_000

# Renamed agent tools: old name → current. Saved chats replay their recorded
# tool calls by name (build_messages), so a chat that ran before a rename
# must still replay — and a model that copies the old name from that history
# must still be served (ai_tools.run_agent_tool resolves through this map).
DEPRECATED_TOOLS = {"search_pdfs": "search_library"}

# What precedes the page context in the user turn. The wording matters: an
# unlabelled "here is the text" reads as the whole document, and the model
# answers detail questions from memory (docs/dev/ai_context.md).
CONTEXT_INTRO = (
    "Context — pages from the user's knowledge base. Each page gives its title, "
    "properties and the user's notes; a page that carries a PDF attachment also "
    "gives the document's text, which is often an excerpt (see its label).")


def canonical_tool(name: str) -> str:
    return DEPRECATED_TOOLS.get(name, name)


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
    """Append the selected PDF passage(s) and selected note text to a user's
    current prompt."""
    prompt = payload.prompt
    selection = (payload.selection or "").strip()[:MAX_SELECTION_CHARS]
    if selection:
        prompt = (
            f"{prompt}\n\n"
            "The user has selected the following passage(s) from the page's PDF "
            'attachment (multiple passages are separated by "---"). '
            f'Answer specifically about them:\n"""\n{selection}\n"""'
        )
    passages = [str(p).strip() for p in (getattr(payload, "note_passages", None) or [])
                if str(p).strip()][:MAX_NOTE_PASSAGES]
    if passages:
        joined = "\n\n---\n\n".join(p[:MAX_NOTE_PASSAGE_CHARS] for p in passages)
        prompt = (
            f"{prompt}\n\n"
            "The user has selected the following text in their own notes on this "
            'page (multiple selections are separated by "---"). Answer specifically '
            f'about it:\n"""\n{joined}\n"""'
        )
    return prompt


# Caps for what a message may point at inside the notes: attached blocks
# (chips), selected note text, and the size of each in the prompt.
MAX_CONTEXT_BLOCKS = 12
MAX_NOTE_PASSAGES = 6
MAX_NOTE_PASSAGE_CHARS = 4000
MAX_BLOCK_SECTION_CHARS = 12_000


def notes_focus_section(ws: str, payload) -> str:
    """The user's pointer into their notes, as one context section: the
    block their cursor is on and the blocks they attached to this message,
    each as ``[id] text`` with its sub-blocks indented — the same id-labelled
    form ``read_block`` gives, so an agent can edit them straight away. Only
    blocks of the request's context pages are served (a chip from another
    page is silently dropped). Empty when there is nothing to point at."""
    focus = str(getattr(payload, "focus_block_id", "") or "").strip()
    chips = [str(b).strip() for b in (getattr(payload, "context_blocks", None) or [])
             if str(b).strip()][:MAX_CONTEXT_BLOCKS]
    if not focus and not chips:
        return ""
    pages = {str(p) for p in (payload.pages or []) if p}
    if payload.page_id:
        pages.add(payload.page_id)
    if not pages:
        return ""
    out = []
    try:
        with connect_pages_db(ws) as conn:
            def outline(block_id: str, budget: int) -> str | None:
                if page_root_id(conn, block_id) not in pages:
                    return None
                rows = fetch_subtree(conn, block_id)
                if not rows:
                    return None
                by_parent: dict = {}
                own = None
                for row in rows:
                    if row[0] == block_id:
                        own = row
                    else:
                        by_parent.setdefault(row[1], []).append(row)
                if own is None:
                    return None
                for children in by_parent.values():
                    children.sort(key=lambda r: r[2])
                lines, used = [], 0

                def line(row, depth):
                    try:
                        props = json.loads(row[4] or "{}")
                    except ValueError:
                        props = {}
                    text = (row[3] or "").strip() or "(empty)"
                    quote = (props.get("quote") or "").strip()
                    if quote:
                        text = f'(highlight: "{quote[:200]}") {text}'
                    pad = "  " * depth
                    return pad + f"- [{row[0]}] " + text.replace("\n", "\n" + pad + "  ")

                def walk(parent, depth):
                    nonlocal used
                    for row in by_parent.get(parent, []):
                        entry = line(row, depth)
                        if used + len(entry) > budget:
                            lines.append("  " * depth + "- … (more sub-blocks not shown)")
                            return
                        used += len(entry)
                        lines.append(entry)
                        walk(row[0], depth + 1)

                head = line(own, 0)
                if len(head) > budget:
                    head = head[:budget] + "…"
                used = len(head)
                lines.append(head)
                walk(block_id, 1)
                return "\n".join(lines)

            if focus and focus not in pages:
                text = outline(focus, 1500)
                if text:
                    out.append("The user's cursor is on this note block (\"this block\", "
                               "\"here\" mean it):\n" + text)
            if chips:
                shown = []
                budget = MAX_BLOCK_SECTION_CHARS
                for block_id in chips:
                    if block_id in pages:
                        continue
                    text = outline(block_id, max(500, budget // max(1, len(chips))))
                    if text:
                        shown.append(text)
                if shown:
                    out.append("Note blocks the user attached to this message (ids in "
                               "brackets; edit them by id when asked to change them):\n"
                               + "\n".join(shown))
    except sqlite3.Error as error:
        log.warning(f"[ai_chat] notes focus section failed: {error}")
        return ""
    return "\n\n".join(out)


# Replayed tool results across the whole history share this char budget
# (newest first); older results are elided so long agent sessions don't grow
# each request without bound. The calls themselves are always kept — they are
# what stops the model from repeating work it already did.
TOOL_REPLAY_BUDGET = 8000
_ELIDED_RESULT = "(older result elided to save space — call the tool again if needed)"
# Replayed results are snapshots: the notes may have been edited since (by
# the user, or by the agent's own later calls). Saying so on every replayed
# result stops the model from answering "read X" from a stale outline.
_REPLAYED_NOTE = "[result from an earlier turn — notes may have changed since; call again before quoting or editing]\n"


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
        if history_item.get("error"):
            # A reply that failed before it started (the client's error
            # bubble) — not an answer the model gave, so never replayed.
            continue
        role = "assistant" if history_item.get("role") == "ai" else "user"
        content = history_item.get("text", "")
        if with_tools:
            actions = _replayable(history_item)
            if actions:
                # Calls first, then their results, then the reply prose — the
                # order the turn actually happened in. Synthetic call ids only
                # need to pair within this one request.
                messages.append({"role": "assistant", "content": "", "tool_calls": [
                    {"id": f"call_h{i}_{j}", "name": canonical_tool(a["tool"]),
                     "arguments": a.get("args") or {}}
                    for j, a in enumerate(actions)]})
                for j, a in enumerate(actions):
                    result = (_ELIDED_RESULT if j in elided.get(i, ())
                              else _REPLAYED_NOTE + str(a.get("result") or "(empty result)"))
                    messages.append({"role": "tool", "call_id": f"call_h{i}_{j}",
                                     "content": result})
        if not content.strip():
            # An organizer reply can be tool actions with no prose; providers
            # (Anthropic especially) reject empty content blocks.
            continue
        if role == "user" and context and not context_used:
            content = f"{CONTEXT_INTRO}\n\n{context}\n\nUser question: {content}"
            context_used = True
        messages.append({"role": role, "content": content})
    content = final_prompt(payload)
    if context and not context_used:
        content = f"{CONTEXT_INTRO}\n\n{context}\n\nUser question: {content}"
    messages.append({"role": "user", "content": content})
    return messages


def _download_pdf_from_source(ws: str, doc_id: str, pdf_path) -> None:
    """Best-effort download of a missing PDF from its recorded source URL."""
    log.info(f"[ai_chat] PDF NOT FOUND at {pdf_path}, attempting download from source_url")
    try:
        with connect_pages_db(ws) as connection:
            row = connection.execute(
                "SELECT properties FROM unified_blocks "
                "WHERE json_extract(properties, '$.doc_id') = ?",
                (doc_id,),
            ).fetchone()
        if not row:
            return
        properties = json.loads(row[0] or "{}")
        source = properties.get("source_url") or ""
        if not source:
            return
        request = URLRequest(
            source,
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/pdf,*/*;q=0.8"},
        )
        with guarded_urlopen(request, timeout=30) as response:
            pdf_data = response.read()
        if not can_store(ws, len(pdf_data)):
            log.info(f"[ai_chat] not caching {doc_id} ({len(pdf_data)} bytes): over storage limits")
            return
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(pdf_data)
        log.info(f"[ai_chat] downloaded {len(pdf_data)} bytes from {source}")
    except Exception as error:
        log.warning(f"[ai_chat] download failed: {error}")


def pdf_path(ws: str, doc_id: str):
    """Return a document's local PDF path, downloading it when possible."""
    try:
        path = pdf_upload_path(ws, doc_id)
    except ValueError:
        return None
    if not path.exists():
        _download_pdf_from_source(ws, doc_id, path)
    return path if path.exists() else None


def truncate(text: str, limit: int) -> str:
    return text[:limit] + "\n…[truncated]" if len(text) > limit else text


def extract_pdf_context(ws: str, doc_id: str, limit: int = 8000) -> str:
    """The head of a document's text, labelled with how little of it that is.

    Without the label the model reads "Here is the PDF text:" as the whole
    paper and answers detail questions from memory rather than looking them
    up — measurably the biggest source of confident wrong answers.
    """
    return head_context(ws, doc_id, limit)[0]


def head_context(ws: str, doc_id: str, limit: int) -> tuple[str, dict]:
    """extract_pdf_context plus its coverage: ``{"partial", "chars",
    "pages", "pages_shown"}`` — what the chat reports back to the user so a
    truncated paper is visible in the UI, not only in the prompt label."""
    text, next_offset, _, pages_shown = pdf_excerpt(ws, doc_id, limit, with_pages=True)
    cover = {"partial": next_offset is not None, "chars": len(text),
             "pages": pages_shown, "pages_shown": pages_shown}
    if next_offset is None:
        return text, cover  # the whole document fits (or nothing extracted) — no caveat needed
    path = pdf_path(ws, doc_id)
    pages = cover["pages"] = page_count(str(path)) if path else 0
    where = f" of this {pages}-page PDF" if pages else ""
    return (f"[EXCERPT — the first {limit:,} characters{where}. The rest of the "
            f"document is NOT shown below. Anything outside this excerpt has to "
            f"be looked up before you can answer about it.]\n\n"
            f"{text}\n…[truncated]"), cover


# One line per PDF page, read from the search index (which already holds the
# per-page text) so building it costs a query rather than a re-parse. It tells
# the agent where things are, so it can jump to a page instead of guessing —
# in testing this cut tool calls and stopped it settling for a plausible but
# wrong neighbouring page.
MAP_BUDGET = 2400
# Chars of page text one outline line shows; the substr fetches a little extra
# so whitespace collapse still fills the line, and the sampling step estimates
# each line's cost as the text plus the "  p.N: " prefix.
_MAP_LINE_CHARS = 80


def ensure_indexed(ws: str, doc_id: str) -> bool:
    """Kick the background indexer for a paper the search index doesn't hold
    at the current version, so a page chat's document map and search_library
    exist by the next turn even when the model never calls search. Returns
    True when the paper is already current."""
    # Local import: keep gamma.* module load free of the routers package.
    from .pdf_index import pdf_missing
    from .routers.search import _index_missing_async
    try:
        with sqlite3.connect(ws_db_path(ws, "data.db")) as connection:
            missing = pdf_missing(connection, [doc_id])
    except sqlite3.OperationalError as e:
        log.warning(f"[ai_context] index check for {doc_id} failed: {e}")
        return False
    if not missing:
        return True
    _index_missing_async(ws, missing)
    return False


def document_map(ws: str, doc_id: str, budget: int = MAP_BUDGET) -> str:
    """How each PDF page starts, as a compact outline. "" when the document
    isn't indexed yet (search is unavailable then too; ensure_indexed kicks
    the indexer so the next turn has both). Reads whichever index version is
    stored — a page-start outline barely depends on normalization, and stale
    docs re-index lazily through the search paths anyway."""
    try:
        with sqlite3.connect(ws_db_path(ws, "data.db")) as connection:
            rows = connection.execute(
                f"SELECT page, substr(content, 1, {_MAP_LINE_CHARS + 10}) FROM pdf_fts "
                "WHERE doc_id = ? ORDER BY page", (doc_id,)).fetchall()
    except sqlite3.OperationalError:
        return ""  # index tables don't exist yet
    if len(rows) < 3:
        return ""  # too short to need a map
    step = max(1, len(rows) * (_MAP_LINE_CHARS + 20) // budget)
    lines = [f"  p.{page}: {' '.join((head or '').split())[:_MAP_LINE_CHARS]}"
             for page, head in rows[::step] if (head or "").strip()]
    if not lines:
        return ""
    every = "" if step == 1 else f", every {step}th page"
    return (f"[DOCUMENT MAP — how each page of this {rows[-1][0]}-page PDF starts"
            f"{every}. Use it to pick the page to read: "
            f"read_page(pdf_page=N).]\n" + "\n".join(lines))


def pdf_excerpt(ws: str, doc_id: str, limit: int, offset: int = 0,
                start_page: int = 1, with_pages: bool = False):
    """Slice ``[offset, offset+limit)`` of a document's extracted text so long
    papers can be read in successive windows; start_page (1-based) starts the
    extraction at that PDF page — the shape search hits come in — and offset
    then counts from there. Returns ``(text, next_offset, seen)``: next_offset
    is where a follow-up read should continue (None = the extraction ended
    inside this window), seen is how many chars were extracted in total — when
    offset points past the end, that's the full extracted length (from
    start_page on). with_pages=True appends how many PDF pages the
    extraction spanned (from start_page) as a fourth value."""
    path = pdf_path(ws, doc_id)
    if not path:
        log.warning("[ai_chat] PDF still not found after download attempt")
        return ("", None, 0, 0) if with_pages else ("", None, 0)
    try:
        # extract_text stops after the page that crosses the limit, so a
        # longer-than-requested result means more pages remain.
        if with_pages:
            full, pages = extract_text_pages(str(path), offset + limit, start_page=start_page)
        else:
            full, pages = extract_text(str(path), offset + limit, start_page=start_page), 0
    except Exception as error:
        log.warning(f"[ai_chat] extraction error: {error}")
        return (PDF_EXTRACT_FAILED, None, 0, 0) if with_pages else (PDF_EXTRACT_FAILED, None, 0)
    text = full[offset:offset + limit]
    next_offset = offset + limit if len(full) > offset + limit else None
    return (text, next_offset, len(full), pages) if with_pages else (text, next_offset, len(full))


def load_pdf_b64(ws: str, doc_id: str) -> str | None:
    """Return a size-limited document PDF as base64."""
    path = pdf_path(ws, doc_id)
    if not path:
        return None
    data = path.read_bytes()
    if len(data) > MAX_ATTACH_PDF_BYTES:
        log.info(f"[ai_chat] PDF too large to attach ({len(data)} bytes), falling back to text")
        return None
    return base64.standard_b64encode(data).decode("ascii")


def pdf_text_from_b64(data: str, limit: int = 8000) -> str:
    """Extract text from a base64 PDF when native attachment is unavailable."""
    return pdf_text_cover_from_b64(data, limit)[0]


def pdf_text_cover_from_b64(data: str, limit: int) -> tuple[str, dict]:
    """pdf_text_from_b64 plus the coverage dict head_context reports."""
    try:
        raw = base64.standard_b64decode(data)
        full, pages_shown = extract_text_pages(raw, limit)
        partial = len(full) > limit
        return (truncate(full, limit),
                {"partial": partial, "chars": min(len(full), limit),
                 "pages": page_count(raw) if partial else pages_shown,
                 "pages_shown": pages_shown})
    except Exception as error:
        log.warning(f"[ai_chat] uploaded-PDF extraction failed: {error}")
        return "", {"partial": False, "chars": 0, "pages": 0, "pages_shown": 0}


# Selected-passage location: how much of a passage's head anchors the search,
# the least head that's trustworthy, and how far the seam window reaches to
# either side of a page boundary.
_ANCHOR_CHARS = 200
_MIN_ANCHOR_CHARS = 12
_SEAM_CHARS = 500
_MAX_SELECTIONS = 6           # passages per request; the chat UI "---"-joins them
_HEAD_GROUNDING_CHARS = 2000  # head slice (title/abstract) kept for grounding


def _normalized_pages(pages: list[str]) -> tuple[list[str], list[str]]:
    """Each page's normalized text plus the page-seam joins (page i glued to
    i+1, so hyphenated line breaks across the boundary re-join), computed once
    so locating several passages doesn't re-normalize the whole document."""
    norm = [normalize_text(p).lower() for p in pages]
    seams = [normalize_text(a[-_SEAM_CHARS:] + "\n" + b[:_SEAM_CHARS]).lower()
             for a, b in zip(pages, pages[1:])]
    return norm, seams


def _locate_passage(norm: list[str], seams: list[str], passage: str) -> int | None:
    """1-based PDF page a selected passage starts on (None = not found).
    Matches the passage's head on normalized text (textnorm rules — the same
    canon the pdf.js text layer and the extractors converge to), so viewer
    selections find their spot despite ligature/whitespace differences."""
    needle = normalize_text(passage).lower()[:_ANCHOR_CHARS]
    if len(needle) < _MIN_ANCHOR_CHARS:  # too short to be a trustworthy anchor
        return None
    for page_no, page_norm in enumerate(norm, start=1):
        if needle in page_norm:
            return page_no
        # A selection starting near the bottom of a page continues onto the
        # next — the seam covers the boundary and credits the page it starts on.
        if page_no >= 2 and needle in seams[page_no - 2]:
            return page_no - 1
    return None


def _join_upto(pages: list[str], start: int, limit: int) -> str:
    """pages[start:] joined with blank lines, cut at limit chars — without
    materializing the whole rest of the document just to slice it."""
    parts, total = [], 0
    for page in pages[start:]:
        parts.append(page)
        total += len(page) + 2
        if total >= limit:
            break
    return "\n\n".join(parts)[:limit]


def selection_context(ws: str, doc_id: str, selection: str, budget: int) -> str | None:
    """Chat context for selected passages: a small head slice (title/abstract
    grounding) plus text around each passage's PDF page — instead of spending
    the whole budget on the start of the paper, which rarely covers what the
    selection is about. Labels carry the page numbers so the model knows where
    each passage sits. None = nothing located (caller falls back to the plain
    head-of-document context)."""
    path = pdf_path(ws, doc_id)
    if not path:
        return None
    try:
        pages = extract_pages(str(path))
    except Exception as error:
        log.warning(f"[ai_chat] selection-context extraction error: {error}")
        return None
    passages = [p.strip() for p in re.split(r"\n\s*---\s*\n", selection)
                if p.strip()][:_MAX_SELECTIONS]
    norm, seams = _normalized_pages(pages)
    located = [(p, page_no) for p in passages
               if (page_no := _locate_passage(norm, seams, p))]
    if not located:
        return None
    sections = []
    head = min(_HEAD_GROUNDING_CHARS, budget // 4)
    head_text = _join_upto(pages, 0, head).strip()
    if head_text:
        sections.append(f"Start of the document (for grounding):\n{head_text}")
    share = max(1, (budget - head) // len(located))
    windows = 0
    seen = set()
    for _, page_no in located:
        if page_no in seen:  # passages on one page share a window
            continue
        seen.add(page_no)
        window = _join_upto(pages, page_no - 1, share).strip()
        if window:
            windows += 1
            sections.append("Text around the selected passage "
                            f"(starting at PDF page {page_no}):\n{window}")
    return "\n\n".join(sections) if windows else None


def page_properties_line(properties: dict) -> str:
    """One line describing what a page carries and how it is filed —
    folders, labels, cached metadata (authors, year, venue, DOI/arXiv), web
    source, attachment — so the model can tell a paper from a note about one.
    "" when the page has none of it."""
    properties = properties or {}
    bits = []
    folders = parse_tags(properties.get("folder"))
    if folders:
        bits.append("folders: " + ", ".join(folders))
    labels = parse_tags(properties.get("category"))
    if labels:
        bits.append("labels: " + ", ".join(labels))
    meta = properties.get("meta") or {}
    if isinstance(meta, dict):
        authors = [str(a).strip() for a in (meta.get("authors") or []) if str(a).strip()]
        if authors:
            shown = ", ".join(authors[:6]) + (" et al." if len(authors) > 6 else "")
            bits.append(f"authors: {shown}")
        for key, label in (("year", "year"), ("venue", "venue"), ("doi", "doi"), ("arxiv_id", "arXiv")):
            if meta.get(key):
                bits.append(f"{label}: {str(meta[key])[:120]}")
    if properties.get("web_url"):
        bits.append(f"web source: {str(properties['web_url'])[:200]}")
    attachment = page_attachment(properties)
    if attachment:
        name = f" ({attachment['name']})" if attachment.get("name") else ""
        bits.append(f"attachment: PDF{name}")
    return ("Properties: " + "; ".join(bits)) if bits else ""


def page_report_section(connection, ws: str, page_id: str, pdf_budget: int,
                        pdf_offset: int = 0, pdf_page: int = 1,
                        document_text: str | None = None,
                        include_notes: bool = True) -> str | None:
    """Render one page as context: title, properties, the attachment's text
    (a windowed excerpt of ``pdf_budget`` chars from ``pdf_offset`` /
    ``pdf_page`` — read_page's shape — or ``document_text`` when the caller
    already built it), then the user's highlights and nested notes. A page
    without an attachment is its notes: they are always included; for a
    page with a PDF, ``include_notes=False`` leaves them out (the chat's
    "include my notes" switch). None when the page doesn't exist."""
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
    attachment = page_attachment(properties)
    doc_id = attachment["id"] if attachment else ""
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

    if include_notes or not doc_id:
        walk(page_id, 0)
    sections = [f"### {root[3] or 'Untitled'}"]
    props_line = page_properties_line(properties)
    if props_line:
        sections.append(props_line)
    if properties.get("summary"):
        sections.append(f"Summary: {properties['summary']}")
    if document_text is not None:
        if document_text:
            sections.append(f"Document text:\n{document_text}")
    elif doc_id and pdf_budget > 0:
        excerpt, next_offset, seen = pdf_excerpt(ws, doc_id, pdf_budget, pdf_offset, pdf_page)
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
    elif not doc_id and not highlights:
        sections.append("User's notes: (this page has no notes yet)")
    return "\n\n".join(sections)


def gather_inputs(ws: str, payload, allow_native: bool) -> tuple[list[str], str, list[dict]]:
    """Collect the chat's context: native PDF attachments and the text
    sections for the request's pages.

    The pages come from ``payload.pages`` (several — a report across pages,
    each getting an even share of ``multi_context_char_limit``) or, when that
    is empty, the one page of ``payload.page_id`` with the full
    ``context_char_limit`` (``payload.doc_id`` alone is the compatibility
    input: it resolves to the page carrying that PDF, and a doc no page
    carries contributes nothing). Every page contributes its
    title, properties and notes; a page with a PDF attachment adds the
    document's text (or the file itself when ``attach_pdf`` and the provider
    takes it) and hides the notes unless ``include_notes`` — a page without
    one IS its notes, so they always go.

    The third value is the coverage report the chat streams back as its
    first `{"context": [...]}` line — one entry per page: ``{"title",
    "doc_id" ("" for a page without a PDF), "native" (the file itself went),
    "native_requested" (the user asked for that; requested but not native =
    the provider refused it and text went instead), "partial", "chars",
    "pages", "pages_shown"}`` — so the UI can say "the model saw pages 1–9
    of 22" instead of leaving the user to guess."""
    pdf_b64s = []
    context_sections = []
    coverage = []
    attach = payload.attach_pdf and allow_native
    none = {"partial": False, "chars": 0, "pages": 0, "pages_shown": 0}

    def report(title, doc_id, native, cover=None):
        coverage.append({"title": title, "doc_id": doc_id, "native": native,
                         "native_requested": bool(payload.attach_pdf), **(cover or none)})

    page_ids = [str(page) for page in (payload.pages or []) if page][:6]
    single = not page_ids
    with connect_pages_db(ws) as connection:
        if single:
            page_id = str(getattr(payload, "page_id", "") or "")
            if not page_id or not connection.execute(
                    "SELECT 1 FROM unified_blocks WHERE id = ? AND parent_id = 'root'",
                    (page_id,)).fetchone():
                row = page_for_doc(connection, payload.doc_id)
                page_id = row[0] if row else ""
            page_ids = [page_id] if page_id else []
        text_budget = (payload.context_char_limit if single
                       else max(1, payload.multi_context_char_limit // max(1, len(page_ids))))
        total_b64 = 0
        for page_id in page_ids:
            row = connection.execute(
                "SELECT content, properties FROM unified_blocks WHERE id = ?", (page_id,),
            ).fetchone()
            if not row:
                continue
            title = row[0] or "Untitled"
            properties = json.loads(row[1] or "{}")
            attachment = page_attachment(properties)
            doc_id = attachment["id"] if attachment else ""
            document_text = ""
            attached = False
            if doc_id and attach:
                data = load_pdf_b64(ws, doc_id)
                if data and total_b64 + len(data) < 20_000_000:
                    pdf_b64s.append(data)
                    total_b64 += len(data)
                    attached = True
            if doc_id and single:
                # Index the paper (background) so the map and search_library
                # exist for the next turn — the first chat on a fresh paper
                # otherwise runs without them for as long as the model never
                # calls search.
                ensure_indexed(ws, doc_id)
            if doc_id and attached:
                report(title, doc_id, True)
            elif doc_id:
                selection = ((payload.selection or "").strip()[:MAX_SELECTION_CHARS]
                             if single else "")
                # With a selection, center the budget on the selected
                # passages (located by page) instead of the start of the
                # paper; fall back to the plain head excerpt when nothing
                # could be located.
                document_text = (selection_context(ws, doc_id, selection, text_budget)
                                 if selection else None)
                if document_text:
                    # Selection-centred context: the budget went to windows
                    # around the passages, so there is no head page span.
                    report(title, doc_id, False,
                           {**none, "partial": True, "chars": len(document_text), "selection": True})
                else:
                    document_text, cover = head_context(ws, doc_id, limit=text_budget)
                    report(title, doc_id, False, cover)
            section = page_report_section(connection, ws, page_id, 0,
                                          document_text=document_text or "",
                                          include_notes=bool(payload.include_notes))
            if section:
                context_sections.append(section)
                if not doc_id:
                    report(title, "", False, {**none, "chars": len(section)})
            # Only for a page chat with tools: the map is worth its tokens
            # when the model can act on it (read_page), not in plain chat.
            if doc_id and single and getattr(payload, "agent_scope", "") == "page":
                outline = document_map(ws, doc_id)
                if outline:
                    context_sections.append(outline)

    names = [str(f.get("name") or "") for f in (payload.files or []) if isinstance(f, dict)]
    for index, data in enumerate(parse_files(payload.files)):
        title = (names[index] if index < len(names) else "") or f"Attached PDF {index + 1}"
        if allow_native:
            pdf_b64s.append(data)
            coverage.append({"title": title, "doc_id": "", "native": True,
                             "native_requested": True, **none})
        else:
            # Uploaded files get the single-paper budget, like the open paper.
            text, cover = pdf_text_cover_from_b64(data, payload.context_char_limit)
            coverage.append({"title": title, "doc_id": "", "native": False,
                             "native_requested": True, **cover})
            if text:
                context_sections.append(f"### {title}\n{text}")

    # Where the user is pointing inside the notes (cursor block, attached
    # block chips) — last, right before the question it belongs to.
    focus_section = notes_focus_section(ws, payload)
    if focus_section:
        context_sections.append(focus_section)

    return pdf_b64s, "\n\n---\n\n".join(context_sections), coverage

"""Library-wide full-text search over PDF contents.

Backed by SQLite FTS5 (per-user, in data.db): each paper's text is extracted
once into the index, so searching ~1000 papers is a millisecond-range query
instead of opening a thousand PDFs. Missing papers are indexed lazily by a
background thread the first time a search runs; the response reports how many
are still pending so the UI can hint that results are incomplete.

Extraction prefers pypdfium2 (PDFium — proper word spacing and unicode) and
falls back to PyPDF2. Text is stored in normalized form (see gamma.textnorm)
so queries like "3000" hit "3,000-qubit"; queries are normalized the same way
at search time. Bumping textnorm.INDEX_VERSION re-indexes everything lazily.

Positions are deliberately NOT stored here: the frontend re-finds the matched
text with pdf.js (the engine that renders the page) when a hit is opened, so
highlight rects always agree with what's on screen.
"""

import re
import sqlite3
import threading

from fastapi import APIRouter, Request

from ..auth import require_user
from ..db import page_now, user_db_path
from ..textnorm import INDEX_VERSION, normalize_text
from .ai import _pdf_path

router = APIRouter(prefix="/api", tags=["search"])

_FTS_SCHEMA = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS pdf_fts USING fts5(doc_id UNINDEXED, page UNINDEXED, content)",
    "CREATE TABLE IF NOT EXISTS pdf_fts_docs (doc_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, pages INTEGER, ver INTEGER NOT NULL DEFAULT 0)",
)

_MAX_PAGES = 400          # per document
_MAX_PAGE_CHARS = 20000   # per page

_index_threads: dict[str, threading.Thread] = {}
_index_progress: dict[str, dict] = {}  # user -> {"total": n, "done": m}
_index_lock = threading.Lock()


def _ensure_schema(conn):
    for stmt in _FTS_SCHEMA:
        conn.execute(stmt)
    try:  # older DBs predate the ver column
        conn.execute("ALTER TABLE pdf_fts_docs ADD COLUMN ver INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass


def _extract_pages(path) -> list[str]:
    """Text per page (1-based order). pypdfium2 first — PyPDF2 mangles word
    spacing badly enough to break phrase search."""
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(str(path))
        try:
            out = []
            for i in range(min(len(pdf), _MAX_PAGES)):
                page = pdf[i]
                textpage = page.get_textpage()
                out.append(textpage.get_text_bounded() or "")
                textpage.close()
                page.close()
            return out
        finally:
            pdf.close()
    except Exception as e:
        print(f"[pdf-search] pypdfium2 extraction failed ({e}), falling back to PyPDF2")
    from PyPDF2 import PdfReader
    reader = PdfReader(str(path))
    out = []
    for i, pg in enumerate(reader.pages):
        if i >= _MAX_PAGES:
            break
        try:
            out.append(pg.extract_text() or "")
        except Exception:
            out.append("")
    return out


def _index_doc(user: str, doc_id: str):
    """Extract a PDF's text into the FTS index. Failures are recorded (pages=0)
    so a broken file isn't re-parsed on every search."""
    rows = []
    try:
        path = _pdf_path(user, doc_id)
        if path:
            for i, raw in enumerate(_extract_pages(path), start=1):
                text = normalize_text(raw)
                if text:
                    rows.append((doc_id, i, text[:_MAX_PAGE_CHARS]))
    except Exception as e:
        print(f"[pdf-search] indexing {doc_id} failed: {e}")
    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        _ensure_schema(conn)
        conn.execute("DELETE FROM pdf_fts WHERE doc_id = ?", (doc_id,))
        conn.executemany("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)", rows)
        conn.execute(
            "INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) VALUES (?, ?, ?, ?)",
            (doc_id, page_now(), len(rows), INDEX_VERSION),
        )
        conn.commit()


def _index_missing_async(user: str, doc_ids: list[str]) -> bool:
    """One background indexer per user at a time, with visible progress.
    Returns False if one is already running (the request is dropped, not
    queued — the next search re-computes what's missing anyway)."""
    with _index_lock:
        t = _index_threads.get(user)
        if t and t.is_alive():
            return False

        def run():
            prog = _index_progress[user] = {"total": len(doc_ids), "done": 0}
            for d in doc_ids:
                _index_doc(user, d)
                prog["done"] += 1

        t = threading.Thread(target=run, daemon=True)
        _index_threads[user] = t
        t.start()
        return True


@router.post("/search-reindex")
def search_reindex(request: Request):
    """Settings button: throw away the whole index and re-extract every paper.
    Progress is visible via /api/tasks like any lazy indexing run."""
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        doc_ids = [r[0] for r in conn.execute(
            "SELECT json_extract(properties, '$.doc_id') FROM unified_blocks "
            "WHERE parent_id = 'root' AND json_extract(properties, '$.doc_id') IS NOT NULL"
        ).fetchall() if r[0]]
    # Stamp everything stale first: if the run is interrupted, the next search
    # still sees the remainder as missing and finishes the job.
    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        _ensure_schema(conn)
        conn.execute("UPDATE pdf_fts_docs SET ver = 0")
        conn.commit()
    started = doc_ids and _index_missing_async(user, doc_ids)
    return {"scheduled": len(doc_ids) if started else 0,
            "busy": bool(doc_ids) and not started}


@router.get("/tasks")
def background_tasks(request: Request):
    """Server-side background work for the tasks popover (extensible)."""
    user = require_user(request)
    with _index_lock:
        t = _index_threads.get(user)
        prog = _index_progress.get(user) or {"total": 0, "done": 0}
        return {"indexing": {**prog, "active": bool(t and t.is_alive())}}


def _fts_query(q: str) -> str:
    """User text → safe FTS5 MATCH: AND of quoted terms, prefix on the last.
    Normalized first so "3,000" and "3000" build the same query the index
    stores."""
    terms = [t for t in re.split(r"\s+", normalize_text(q)) if t]
    if not terms:
        return ""
    quoted = ['"' + t.replace('"', '""') + '"' for t in terms]
    quoted[-1] += "*"
    return " ".join(quoted)


@router.get("/pdf-search")
def pdf_search(request: Request, q: str = "", limit: int = 20):
    user = require_user(request)
    q = (q or "").strip()
    if not q:
        return {"results": [], "indexing": 0}

    # Library papers: doc_id → page block (title + id to open)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        rows = conn.execute(
            "SELECT id, content, json_extract(properties, '$.doc_id') FROM unified_blocks "
            "WHERE parent_id = 'root' AND json_extract(properties, '$.doc_id') IS NOT NULL"
        ).fetchall()
    docs = {r[2]: {"block_id": r[0], "title": r[1] or "Untitled"} for r in rows if r[2]}
    if not docs:
        return {"results": [], "indexing": 0}

    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        _ensure_schema(conn)
        current = {r[0] for r in conn.execute(
            "SELECT doc_id FROM pdf_fts_docs WHERE ver = ?", (INDEX_VERSION,)).fetchall()}
        missing = [d for d in docs if d not in current]  # never indexed or stale version
        if missing:
            _index_missing_async(user, missing)

        results = []
        match = _fts_query(q)
        if match:
            try:
                cur = conn.execute(
                    "SELECT doc_id, page, snippet(pdf_fts, 2, '', '', '…', 14) FROM pdf_fts "
                    "WHERE pdf_fts MATCH ? ORDER BY rank LIMIT ?",
                    (match, limit * 3),
                )
                for doc_id, page, snip in cur:
                    info = docs.get(doc_id)  # skips docs deleted since indexing
                    if not info:
                        continue
                    results.append({"block_id": info["block_id"], "doc_id": doc_id,
                                    "title": info["title"], "page": page, "snippet": snip})
                    if len(results) >= limit:
                        break
            except sqlite3.OperationalError:
                pass  # malformed MATCH — treat as no results

    return {"results": results, "indexing": len(missing)}

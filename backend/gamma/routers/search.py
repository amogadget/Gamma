"""Library-wide full-text search: notes (block_fts) and PDF contents (pdf_fts).

Both indexes are SQLite FTS5 tables in the workspace's data.db. The PDF one is
built here: each paper's text is extracted once, so searching ~1000 papers is
a millisecond-range query instead of opening a thousand PDFs; missing papers
are indexed lazily by a background thread the first time a search runs, and
the response reports how many are still pending so the UI can hint that
results are incomplete. The notes index lives in gamma.block_index (rebuilt
per page, synchronously, when a page changed since its last build).

Extraction prefers pypdfium2 (PDFium — proper word spacing and unicode) and
falls back to PyPDF2. Text is stored in normalized form (see gamma.textnorm)
so queries like "3000" hit "3,000-qubit"; queries are normalized the same way
at search time. Bumping textnorm.INDEX_VERSION re-indexes everything lazily.

Positions are deliberately NOT stored here: the frontend re-finds the matched
text with pdf.js (the engine that renders the page) when a hit is opened, so
highlight rects always agree with what's on screen.

``GET /api/search`` is the one endpoint over both indexes (hits carry
``source: "notes" | "pdf"``); ``/pdf-search`` is the PDF-only predecessor the
frontend still uses.
"""

import sqlite3
import threading

from fastapi import APIRouter, Request
from pydantic import BaseModel

from .. import block_index, pdf_index
from ..ai_context import pdf_path as _pdf_path
from .. import pdf_meta
from ..auth import require_ws
from ..block_index import fts_query
from ..blocks_store import root_pages
from ..db import connect_pages_db, page_now, ws_db_path
from ..logbuf import log
from ..pdf_text import extract_pages
from ..textnorm import INDEX_VERSION, normalize_text

router = APIRouter(prefix="/api", tags=["search"])

_MAX_PAGE_CHARS = 20000   # per page

_index_threads: dict[str, threading.Thread] = {}
_index_progress: dict[str, dict] = {}  # workspace -> {"total": n, "done": m}
_index_stop: set[str] = set()          # workspaces whose running indexer was asked to stop
_index_lock = threading.Lock()


def _extract_pages(path) -> list[str]:
    """Text per page (1-based order) — the shared extractor in gamma.pdf_text."""
    return extract_pages(str(path))


def _index_doc(ws: str, doc_id: str):
    """Extract a PDF's text into the FTS index. Failures are recorded (pages=0)
    so a broken file isn't re-parsed on every search."""
    rows = []
    try:
        path = _pdf_path(ws, doc_id)
        if path:
            pdf_meta.ensure(ws, doc_id)  # the viewer's manifest, while the file is at hand anyway
            for i, raw in enumerate(_extract_pages(path), start=1):
                text = normalize_text(raw)
                if text:
                    rows.append((doc_id, i, text[:_MAX_PAGE_CHARS]))
    except Exception as e:
        log.warning(f"[pdf-search] indexing {doc_id} failed: {e}")
    with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
        pdf_index.ensure_schema(conn)
        conn.execute("DELETE FROM pdf_fts WHERE doc_id = ?", (doc_id,))
        conn.executemany("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)", rows)
        conn.execute(
            "INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) VALUES (?, ?, ?, ?)",
            (doc_id, page_now(), len(rows), INDEX_VERSION),
        )
        conn.commit()


def _index_missing_async(ws: str, doc_ids: list[str]) -> bool:
    """One background indexer per workspace at a time, with visible progress.
    Returns False if one is already running (the request is dropped, not
    queued — the next search re-computes what's missing anyway)."""
    with _index_lock:
        t = _index_threads.get(ws)
        if t and t.is_alive():
            return False

        _index_stop.discard(ws)

        def run():
            prog = _index_progress[ws] = {"total": len(doc_ids), "done": 0}
            for d in doc_ids:
                if ws in _index_stop:
                    break  # the rest stays stamped stale: the next search finishes the job
                _index_doc(ws, d)
                prog["done"] += 1

        t = threading.Thread(target=run, daemon=True)
        _index_threads[ws] = t
        t.start()
        return True


class ReindexRequest(BaseModel):
    doc_ids: list[str] = []  # empty = rebuild the whole library


@router.post("/search-reindex")
def search_reindex(request: Request, payload: ReindexRequest | None = None):
    """Settings: re-extract papers into the FTS index. With doc_ids, just those
    papers (the Library pane's per-paper button — no global stale stamp);
    without, the whole library. Progress is visible via /api/tasks either way."""
    ws = require_ws(request, write=True)
    with connect_pages_db(ws) as conn:
        library = [info["doc_id"] for info in root_pages(conn).values() if info["doc_id"]]
    wanted = [d for d in (payload.doc_ids if payload else []) if d]
    if wanted:
        doc_ids = [d for d in library if d in set(wanted)]  # only own papers
    else:
        doc_ids = library
        # Stamp everything stale first: if the run is interrupted, the next
        # search still sees the remainder as missing and finishes the job.
        with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
            pdf_index.ensure_schema(conn)
            conn.execute("UPDATE pdf_fts_docs SET ver = 0")
            conn.commit()
    started = doc_ids and _index_missing_async(ws, doc_ids)
    if not wanted:
        block_index.mark_all_dirty(ws)  # notes rebuild on the next search
    return {"scheduled": len(doc_ids) if started else 0,
            "busy": bool(doc_ids) and not started}


@router.get("/tasks")
def background_tasks(request: Request):
    """Server-side background work for the tasks popover (extensible)."""
    ws = require_ws(request)
    with _index_lock:
        t = _index_threads.get(ws)
        prog = _index_progress.get(ws) or {"total": 0, "done": 0}
        return {"indexing": {**prog, "active": bool(t and t.is_alive())}}


@router.delete("/tasks/indexing")
def stop_indexing(request: Request):
    """The tasks popover's stop button: the workspace's running indexer
    finishes the paper it is on and skips the rest (they stay stamped stale,
    so the next search picks them up). ``cancelled`` says whether one was
    running."""
    ws = require_ws(request, write=True)
    with _index_lock:
        t = _index_threads.get(ws)
        running = bool(t and t.is_alive())
        if running:
            _index_stop.add(ws)
    return {"cancelled": running}


@router.get("/search")
def library_search(request: Request, q: str = "", limit: int = 20, scope: str = ""):
    """One search over the workspace's knowledge base: notes (block_fts) and the
    text of PDF attachments (pdf_fts). Owner-only, like /pdf-search. Results
    are notes first (bm25 order), then PDF hits, each capped at ``limit``;
    ``indexing`` counts what is still being built (note pages waiting for a
    rebuild batch + PDFs the background extractor hasn't reached)."""
    ws = require_ws(request)
    q = (q or "").strip()
    limit = max(1, min(int(limit or 20), 100))
    if not q:
        return {"results": [], "indexing": 0}
    match = fts_query(q)
    with connect_pages_db(ws) as conn:
        pages = root_pages(conn, scope)
        # Notes: rebuild what changed (synchronous, batch-capped), then query.
        pending = block_index.refresh(ws, conn, list(pages)) if pages else 0
    docs = {info["doc_id"]: page_id for page_id, info in pages.items() if info["doc_id"]}
    results = []
    missing: list = []
    with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
        for block_id, page_id, snippet in block_index.search_blocks(conn, match, limit, pages):
            results.append({"source": "notes", "block_id": block_id, "page_id": page_id,
                            "title": pages[page_id]["title"], "snippet": snippet})
        if docs:
            missing = pdf_index.pdf_missing(conn, docs)
            if missing:
                _index_missing_async(ws, missing)
            for doc_id, page, snippet in pdf_index.search_pdf(conn, match, limit, docs):
                page_id = docs[doc_id]
                results.append({"source": "pdf", "block_id": page_id, "page_id": page_id,
                                "doc_id": doc_id, "title": pages[page_id]["title"],
                                "page": page, "snippet": snippet})
    return {"results": results, "indexing": pending + len(missing)}


@router.get("/pdf-search")
def pdf_search(request: Request, q: str = "", limit: int = 20):
    ws = require_ws(request)
    q = (q or "").strip()
    if not q:
        return {"results": [], "indexing": 0}

    # Library papers: doc_id → page block (title + id to open)
    with connect_pages_db(ws) as conn:
        docs = {info["doc_id"]: {"block_id": page_id, "title": info["title"]}
                for page_id, info in root_pages(conn).items() if info["doc_id"]}
    if not docs:
        return {"results": [], "indexing": 0}

    with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
        missing = pdf_index.pdf_missing(conn, docs)  # never indexed or stale version
        if missing:
            _index_missing_async(ws, missing)
        results = [{"block_id": docs[doc_id]["block_id"], "doc_id": doc_id,
                    "title": docs[doc_id]["title"], "page": page, "snippet": snip}
                   for doc_id, page, snip in pdf_index.search_pdf(conn, fts_query(q), limit, docs)]
    return {"results": results, "indexing": len(missing)}

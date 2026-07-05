"""Library-wide full-text search over PDF contents.

Backed by SQLite FTS5 (per-user, in data.db): each paper's text is extracted
once into the index, so searching ~1000 papers is a millisecond-range query
instead of opening a thousand PDFs. Missing papers are indexed lazily by a
background thread the first time a search runs; the response reports how many
are still pending so the UI can hint that results are incomplete.
"""

import re
import sqlite3
import threading

from fastapi import APIRouter, Request

from ..auth import require_user
from ..db import page_now, user_db_path
from .ai import _pdf_path

router = APIRouter(prefix="/api", tags=["search"])

_FTS_SCHEMA = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS pdf_fts USING fts5(doc_id UNINDEXED, page UNINDEXED, content)",
    "CREATE TABLE IF NOT EXISTS pdf_fts_docs (doc_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, pages INTEGER)",
)

_MAX_PAGES = 400          # per document
_MAX_PAGE_CHARS = 20000   # per page

_index_threads: dict[str, threading.Thread] = {}
_index_progress: dict[str, dict] = {}  # user -> {"total": n, "done": m}
_index_lock = threading.Lock()


def _ensure_schema(conn):
    for stmt in _FTS_SCHEMA:
        conn.execute(stmt)


def _index_doc(user: str, doc_id: str):
    """Extract a PDF's text into the FTS index. Failures are recorded (pages=0)
    so a broken file isn't re-parsed on every search."""
    rows = []
    try:
        path = _pdf_path(user, doc_id)
        if path:
            from PyPDF2 import PdfReader
            reader = PdfReader(str(path))
            for i, pg in enumerate(reader.pages, start=1):
                if i > _MAX_PAGES:
                    break
                try:
                    text = re.sub(r"\s+", " ", pg.extract_text() or "").strip()
                except Exception:
                    text = ""
                if text:
                    rows.append((doc_id, i, text[:_MAX_PAGE_CHARS]))
    except Exception as e:
        print(f"[pdf-search] indexing {doc_id} failed: {e}")
    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        _ensure_schema(conn)
        conn.execute("DELETE FROM pdf_fts WHERE doc_id = ?", (doc_id,))
        conn.executemany("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)", rows)
        conn.execute(
            "INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages) VALUES (?, ?, ?)",
            (doc_id, page_now(), len(rows)),
        )
        conn.commit()


def _index_missing_async(user: str, doc_ids: list[str]):
    """One background indexer per user at a time, with visible progress."""
    with _index_lock:
        t = _index_threads.get(user)
        if t and t.is_alive():
            return

        def run():
            prog = _index_progress[user] = {"total": len(doc_ids), "done": 0}
            for d in doc_ids:
                _index_doc(user, d)
                prog["done"] += 1

        t = threading.Thread(target=run, daemon=True)
        _index_threads[user] = t
        t.start()


@router.get("/tasks")
def background_tasks(request: Request):
    """Server-side background work for the tasks popover (extensible)."""
    user = require_user(request)
    with _index_lock:
        t = _index_threads.get(user)
        prog = _index_progress.get(user) or {"total": 0, "done": 0}
        return {"indexing": {**prog, "active": bool(t and t.is_alive())}}


def _fts_query(q: str) -> str:
    """User text → safe FTS5 MATCH: AND of quoted terms, prefix on the last."""
    terms = [t for t in re.split(r"\s+", q) if t]
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
        indexed = {r[0] for r in conn.execute("SELECT doc_id FROM pdf_fts_docs").fetchall()}
        missing = [d for d in docs if d not in indexed]
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
                    results.append({"block_id": info["block_id"], "title": info["title"],
                                    "page": page, "snippet": snip})
                    if len(results) >= limit:
                        break
            except sqlite3.OperationalError:
                pass  # malformed MATCH — treat as no results

    return {"results": results, "indexing": len(missing)}

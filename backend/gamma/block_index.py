"""Full-text index over note blocks — ``block_fts`` in the workspace's data.db,
next to the PDF index (``pdf_fts``, routers/search.py).

Every non-root block's content is indexed under its page root (highlights
included — their note text is a note like any other; the quoted PDF passage
is already in ``pdf_fts``). Text is stored normalized (gamma.textnorm — the
same rules and INDEX_VERSION as the PDF index) so one query matches both.

The index is built lazily and per page, like the PDF one: ``refresh()`` runs
before a search and rebuilds only the pages whose bookkeeping row
(``block_fts_meta``) is missing, stale (older INDEX_VERSION) or no longer
matches the page root's ``updated_at``. That fingerprint covers every write
that touches the page root (the editor's PUT /children, imports, the agent
tools, clips); the block endpoints that change a child without touching the
root (POST/PUT/DELETE /blocks/{id}, reorder) call ``mark_page_dirty`` — the
invalidation is "forget the page's row", the next search rebuilds it. Pages
are small, so a rebuild is one subtree read + one insert; a first-ever
search over a big library rebuilds in batches (``REFRESH_BATCH`` pages per
request) and reports the remainder as still indexing.

No positions are stored: the frontend re-finds the match in the block text.
"""

import sqlite3

from . import pdf_index
from .blocks_store import fetch_subtree
from .db import connect_data_db, ws_db_path
from .logbuf import log
from .textnorm import INDEX_VERSION, normalize_text

SCHEMA = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5(block_id UNINDEXED, page_id UNINDEXED, content)",
    "CREATE TABLE IF NOT EXISTS block_fts_meta (page_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, "
    "ver INTEGER NOT NULL DEFAULT 0)",
)

MAX_BLOCK_CHARS = 20000   # per block
REFRESH_BATCH = 300       # pages rebuilt per refresh() call; the rest wait for the next search
SNIPPET_TOKENS = 14


def ensure_schema(conn: sqlite3.Connection) -> None:
    for stmt in SCHEMA:
        conn.execute(stmt)


def fts_query(q: str) -> str:
    """User text → safe FTS5 MATCH: AND of quoted terms, prefix on the last.
    Normalized first so "3,000" and "3000" build the same query the indexes
    store. Shared by the PDF and the block index (same tokenizer, same rules)."""
    terms = [t for t in normalize_text(q).split(" ") if t]
    if not terms:
        return ""
    quoted = ['"' + t.replace('"', '""') + '"' for t in terms]
    quoted[-1] += "*"
    return " ".join(quoted)


def mark_page_dirty(ws: str, page_id: str | None) -> None:
    """Forget a page's index bookkeeping so the next search rebuilds it. Called
    by the block writers whose change doesn't move the page root's
    updated_at. Never raises — the index is derived data."""
    if not page_id:
        return
    try:
        with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
            ensure_schema(conn)
            conn.execute("DELETE FROM block_fts_meta WHERE page_id = ?", (page_id,))
            conn.commit()
    except sqlite3.Error:
        pass


def mark_all_dirty(ws: str) -> None:
    """Stamp every page stale (the Settings "rebuild index" path): rows keep
    their text until rebuilt, so search stays usable meanwhile."""
    try:
        with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
            ensure_schema(conn)
            conn.execute("UPDATE block_fts_meta SET ver = 0")
            conn.commit()
    except sqlite3.Error:
        pass


def _root_pages(pages_conn: sqlite3.Connection, page_ids=None) -> dict:
    """{page_id: updated_at} for the root pages (all, or just page_ids)."""
    if page_ids is not None:
        ids = [p for p in page_ids if p]
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        rows = pages_conn.execute(
            f"SELECT id, updated_at FROM unified_blocks WHERE parent_id = 'root' AND id IN ({placeholders})",
            ids).fetchall()
    else:
        rows = pages_conn.execute(
            "SELECT id, updated_at FROM unified_blocks WHERE parent_id = 'root'").fetchall()
    return {r[0]: r[1] or "" for r in rows}


def index_page(pages_conn: sqlite3.Connection, data_conn: sqlite3.Connection,
               page_id: str, updated_at: str) -> int:
    """Rebuild one page's rows; returns how many blocks were indexed."""
    rows = []
    for row in fetch_subtree(pages_conn, page_id):
        if row[0] == page_id:
            continue
        text = normalize_text(row[3] or "")
        if text:
            rows.append((row[0], page_id, text[:MAX_BLOCK_CHARS]))
    data_conn.execute("DELETE FROM block_fts WHERE page_id = ?", (page_id,))
    data_conn.executemany("INSERT INTO block_fts (block_id, page_id, content) VALUES (?, ?, ?)", rows)
    data_conn.execute(
        "INSERT OR REPLACE INTO block_fts_meta (page_id, updated_at, ver) VALUES (?, ?, ?)",
        (page_id, updated_at, INDEX_VERSION))
    return len(rows)


def refresh(ws: str, pages_conn: sqlite3.Connection, page_ids=None) -> int:
    """Bring the index up to date for the given pages (None = every page):
    rebuild the stale ones, at most ``REFRESH_BATCH`` per call. Returns how
    many are still stale afterwards (the "indexing" count a search reports)."""
    live = _root_pages(pages_conn, page_ids)
    with sqlite3.connect(ws_db_path(ws, "data.db")) as data_conn:
        ensure_schema(data_conn)
        current = {r[0]: r[1] for r in data_conn.execute(
            "SELECT page_id, updated_at FROM block_fts_meta WHERE ver = ?", (INDEX_VERSION,))}
        stale = [p for p, at in live.items() if current.get(p) != at]
        for page_id in stale[:REFRESH_BATCH]:
            index_page(pages_conn, data_conn, page_id, live[page_id])
        data_conn.commit()
    return max(0, len(stale) - REFRESH_BATCH)


def prune(data_conn: sqlite3.Connection, live_page_ids) -> int:
    """Drop rows of pages that no longer exist. Returns pages pruned."""
    ensure_schema(data_conn)
    live = set(live_page_ids)
    gone = [r[0] for r in data_conn.execute(
        "SELECT DISTINCT page_id FROM block_fts_meta UNION SELECT DISTINCT page_id FROM block_fts")
        if r[0] not in live]
    for page_id in gone:
        data_conn.execute("DELETE FROM block_fts WHERE page_id = ?", (page_id,))
        data_conn.execute("DELETE FROM block_fts_meta WHERE page_id = ?", (page_id,))
    return len(gone)


def search_blocks(data_conn: sqlite3.Connection, match: str, limit: int,
                  page_ids) -> list[tuple[str, str, str]]:
    """bm25-ranked ``(block_id, page_id, snippet)`` hits for an FTS MATCH,
    restricted to ``page_ids`` — the pages the search reaches (a scope may be
    a folder; rows of deleted pages linger until pruned). A malformed MATCH
    is no results, not an error."""
    if not match or limit <= 0:
        return []
    ensure_schema(data_conn)
    found = []
    allowed = set(page_ids)
    try:
        cur = data_conn.execute(
            f"SELECT block_id, page_id, snippet(block_fts, 2, '', '', '…', {SNIPPET_TOKENS}) "
            "FROM block_fts WHERE block_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit * 3))
        for block_id, page_id, snippet in cur:
            if page_id not in allowed:
                continue
            found.append((block_id, page_id, snippet))
            if len(found) >= limit:
                break
    except sqlite3.OperationalError:
        pass
    return found


def purge_page_data(ws: str, pages_conn: sqlite3.Connection, deleted_ids) -> None:
    """Sweep data.db after blocks were deleted or a PDF detached: chats of the
    deleted blocks, ``pdf_fts`` rows of papers no page carries any more, and
    the notes-index rows of pages that are gone — none of it cleans itself.
    Never raises (derived data)."""
    try:
        live_docs = {r[0] for r in pages_conn.execute(
            "SELECT json_extract(properties, '$.doc_id') FROM unified_blocks "
            "WHERE json_extract(properties, '$.doc_id') IS NOT NULL").fetchall()}
        live_pages = [r[0] for r in pages_conn.execute(
            "SELECT id FROM unified_blocks WHERE parent_id = 'root'").fetchall()]
        with connect_data_db(ws) as ddb:
            pdf_index.ensure_schema(ddb)
            ddb.executemany("DELETE FROM chats WHERE block_id = ?", [(i,) for i in deleted_ids])
            ddb.executemany("DELETE FROM chat_history WHERE bucket = ?", [(i,) for i in deleted_ids])
            stale = [r[0] for r in ddb.execute("SELECT doc_id FROM pdf_fts_docs").fetchall()
                     if r[0] not in live_docs]
            for d in stale:
                ddb.execute("DELETE FROM pdf_fts WHERE doc_id = ?", (d,))
                ddb.execute("DELETE FROM pdf_fts_docs WHERE doc_id = ?", (d,))
            prune(ddb, live_pages)
            ddb.commit()
    except Exception as e:
        log.warning(f"[block_index] derived-data cleanup failed: {e}")

"""The PDF text index — ``pdf_fts`` in the per-user data.db, next to the notes
index (``block_index``). The schema and the two queries every consumer of the
index shares: which papers still need extracting, and the ranked hits for a
MATCH. Extraction itself (and the background indexer thread) lives in
routers/search.py; the same normalization rules as the notes index apply
(gamma.textnorm — bump INDEX_VERSION to re-index lazily)."""

import sqlite3

from .textnorm import INDEX_VERSION

SCHEMA = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS pdf_fts USING fts5(doc_id UNINDEXED, page UNINDEXED, content)",
    "CREATE TABLE IF NOT EXISTS pdf_fts_docs (doc_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, pages INTEGER, ver INTEGER NOT NULL DEFAULT 0)",
)

SNIPPET_TOKENS = 14


def ensure_schema(conn: sqlite3.Connection) -> None:
    for stmt in SCHEMA:
        conn.execute(stmt)
    try:  # older DBs predate the ver column
        conn.execute("ALTER TABLE pdf_fts_docs ADD COLUMN ver INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass


def pdf_missing(data_conn: sqlite3.Connection, doc_ids) -> list[str]:
    """The given doc ids the index doesn't hold at the current INDEX_VERSION
    (never extracted, or extracted under older normalization rules) — what a
    search hands to the background indexer and reports as still pending."""
    ensure_schema(data_conn)
    current = {r[0] for r in data_conn.execute(
        "SELECT doc_id FROM pdf_fts_docs WHERE ver = ?", (INDEX_VERSION,))}
    return [d for d in doc_ids if d not in current]


def search_pdf(data_conn: sqlite3.Connection, match: str, limit: int,
               docs) -> list[tuple[str, int, str]]:
    """bm25-ranked ``(doc_id, page, snippet)`` hits for an FTS MATCH, limited
    to the doc ids in ``docs`` (a scope — rows of papers deleted or out of
    scope linger in the index and are skipped). A malformed MATCH is no
    results, not an error."""
    if not match or limit <= 0:
        return []
    ensure_schema(data_conn)
    found = []
    try:
        cur = data_conn.execute(
            f"SELECT doc_id, page, snippet(pdf_fts, 2, '', '', '…', {SNIPPET_TOKENS}) FROM pdf_fts "
            "WHERE pdf_fts MATCH ? ORDER BY rank LIMIT ?", (match, limit * 3))
        for doc_id, page, snippet in cur:
            if doc_id not in docs:
                continue
            found.append((doc_id, page, snippet))
            if len(found) >= limit:
                break
    except sqlite3.OperationalError:
        pass
    return found

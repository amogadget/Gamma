"""One-time normalization of old data shapes (idempotent).

Gamma has no migration framework: schemas are ``CREATE TABLE IF NOT EXISTS``
on connect plus lazy ``ALTER TABLE``. Old rows used to be tolerated forever by
read-side shims, so every renamed property or syntax lived twice in the code.
This module is the replacement: ONE pass, run by ``python manage.py migrate``
and on every server start (``app._startup_maintenance``), that rewrites the
rows still carrying an old shape. Each step SQL-filters (LIKE) for the old
shape first, so a clean database costs one cheap query per step and touches
nothing; ``updated_at`` moves only on rows actually rewritten.

Design + the list of shapes: docs/dev/block_centric.md ("One-time cleanup").
"""

import json
import sqlite3

from . import config
from .blocks_store import page_for_doc
from .db import connect_pages_db, connect_users_db, page_now, shares_has_doc_id
from .logbuf import log
from .note_markup import LEGACY_WIDTH_RE, obsidian_image_sizes

# The automatic title prefix Gamma used to give uploaded PDFs. Migrated pages
# get the bare name plus an ``auto_title`` marker, so the metadata worker may
# still replace the title exactly as for new pages.
PDF_NOTES_PREFIX = "PDF Notes - "

PAGES_STEPS = ("source_url_key", "image_width", "pdf_notes_title")


def _load_props(raw) -> dict | None:
    try:
        props = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return None
    return props if isinstance(props, dict) else None


def normalize_pages_db(conn: sqlite3.Connection) -> dict:
    """Normalize one per-user pages.db. Returns ``{step: rows changed}``."""
    counts = dict.fromkeys(PAGES_STEPS, 0)
    now = page_now()

    # (1) properties.sourceUrl (camelCase, the earliest pages) → source_url.
    for block_id, raw in conn.execute(
            "SELECT id, properties FROM unified_blocks WHERE properties LIKE '%\"sourceUrl\"%'"
    ).fetchall():
        props = _load_props(raw)
        if props is None or "sourceUrl" not in props:
            continue
        old = props.pop("sourceUrl")
        if old and not props.get("source_url"):
            props["source_url"] = old
        conn.execute("UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                     (json.dumps(props), now, block_id))
        counts["source_url_key"] += 1

    # (2) Legacy Logseq image size ``![a](u){:width N}`` → Obsidian ``![a|N](u)``.
    for block_id, content in conn.execute(
            "SELECT id, content FROM unified_blocks WHERE content LIKE '%{:width%'"
    ).fetchall():
        if not LEGACY_WIDTH_RE.search(content or ""):
            continue
        conn.execute("UPDATE unified_blocks SET content = ?, updated_at = ? WHERE id = ?",
                     (obsidian_image_sizes(content), now, block_id))
        counts["image_width"] += 1

    # (3) Pages still titled "PDF Notes - <name>" without an auto_title marker.
    for block_id, content, raw in conn.execute(
            "SELECT id, content, properties FROM unified_blocks "
            "WHERE parent_id = 'root' AND content LIKE ?", (PDF_NOTES_PREFIX + "%",)
    ).fetchall():
        content = content or ""
        if not content.startswith(PDF_NOTES_PREFIX):  # LIKE is case-insensitive
            continue
        props = _load_props(raw)
        if props is None or props.get("auto_title"):
            continue
        title = content[len(PDF_NOTES_PREFIX):].strip() or "Untitled"
        props["auto_title"] = title
        conn.execute(
            "UPDATE unified_blocks SET content = ?, properties = ?, updated_at = ? WHERE id = ?",
            (title, json.dumps(props), now, block_id))
        counts["pdf_notes_title"] += 1

    conn.commit()
    return counts


def normalize_data_db(conn: sqlite3.Connection) -> dict:
    """Drop the legacy per-user tables (``annotations``, ``shares``) that
    ``unified_blocks`` and the global ``shares`` table superseded long ago.
    Returns ``{"dropped_tables": n}``."""
    existing = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('annotations', 'shares')")}
    for table in existing:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.commit()
    return {"dropped_tables": len(existing)}


def _page_for_doc(username: str, doc_id: str) -> str | None:
    """The owner's root page carrying PDF ``doc_id``, or None."""
    try:
        with connect_pages_db(username) as conn:
            row = page_for_doc(conn, doc_id)
    except (sqlite3.Error, ValueError):
        return None
    return row[0] if row else None


def normalize_users_db(conn: sqlite3.Connection) -> dict:
    """Backfill ``shares.page_id`` for rows minted when shares were keyed by
    PDF doc id; rows whose document is gone are deleted (they could never
    resolve). Once ``drop_shares_doc_id`` removed the column, an unkeyed row
    has nothing left to resolve through and is deleted.
    Returns ``{"shares_backfilled": n, "shares_deleted": n}``."""
    counts = {"shares_backfilled": 0, "shares_deleted": 0}
    doc_col = "doc_id" if shares_has_doc_id(conn) else "''"
    rows = conn.execute(
        f"SELECT token, username, {doc_col} FROM shares WHERE page_id IS NULL OR page_id = ''"
    ).fetchall()
    for token, username, doc_id in rows:
        page_id = _page_for_doc(username, doc_id) if doc_id else None
        if page_id:
            conn.execute("UPDATE shares SET page_id = ? WHERE token = ?", (page_id, token))
            counts["shares_backfilled"] += 1
        else:
            conn.execute("DELETE FROM shares WHERE token = ?", (token,))
            counts["shares_deleted"] += 1
    conn.commit()
    return counts


# The shares table without its vestigial doc_id column — what
# drop_shares_doc_id rebuilds to. Mirrors USERS_SCHEMA minus that column;
# db.py keeps creating the old shape until this step has shipped everywhere.
_SHARES_WITHOUT_DOC_ID = """CREATE TABLE shares_new (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        page_id TEXT,
        audience TEXT NOT NULL DEFAULT 'anyone',
        role TEXT NOT NULL DEFAULT 'view',
        allowed_users TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )"""


def drop_shares_doc_id(conn: sqlite3.Connection | None = None) -> bool:
    """Stage 3 (docs/dev/block_centric.md): rebuild the global ``shares``
    table without ``doc_id``. Deliberately NOT part of ``run_all()`` — run by
    hand (``python manage.py migrate --drop-share-doc-id``) only after every
    deployed binary (Docker image, desktop sidecar) ships code that no
    longer reads the column and inserts without it, since an older server
    would fail to INSERT (NOT NULL, no default). Idempotent: returns False
    when the column is already gone. A table rebuild rather than
    ``ALTER TABLE DROP COLUMN`` so it works on any SQLite version."""
    own = conn is None
    if own:
        conn = connect_users_db()
    try:
        if not shares_has_doc_id(conn):
            return False
        # Unkeyed rows can't survive without doc_id to resolve through.
        normalize_users_db(conn)
        conn.execute("DROP TABLE IF EXISTS shares_new")
        conn.execute(_SHARES_WITHOUT_DOC_ID)
        conn.execute(
            "INSERT INTO shares_new (token, username, page_id, audience, role, allowed_users, created_at) "
            "SELECT token, username, page_id, audience, role, allowed_users, created_at FROM shares")
        conn.execute("DROP TABLE shares")
        conn.execute("ALTER TABLE shares_new RENAME TO shares")
        conn.commit()
        log.info("[migrate] dropped shares.doc_id")
        return True
    finally:
        if own:
            conn.close()


def run_all() -> dict:
    """Normalize every user's pages.db + data.db under USERS_DIR, then the
    global users.db. Returns ``{"users": {name: {step: n}}, "shares": {...},
    "changed": total rows touched}``; steps that did nothing are omitted from
    a user's entry."""
    summary: dict = {"users": {}, "shares": {}, "changed": 0}
    if config.USERS_DIR.exists():
        for user_dir in sorted(config.USERS_DIR.iterdir()):
            if not user_dir.is_dir():
                continue
            counts: dict = {}
            pages_db = user_dir / "pages.db"
            if pages_db.exists():
                try:
                    with sqlite3.connect(str(pages_db)) as conn:
                        counts.update(normalize_pages_db(conn))
                except sqlite3.Error as e:
                    log.warning(f"[migrate] {user_dir.name}/pages.db: {e}")
            data_db = user_dir / "data.db"
            if data_db.exists():
                try:
                    with sqlite3.connect(str(data_db)) as conn:
                        counts.update(normalize_data_db(conn))
                except sqlite3.Error as e:
                    log.warning(f"[migrate] {user_dir.name}/data.db: {e}")
            changed = {k: v for k, v in counts.items() if v}
            if changed:
                summary["users"][user_dir.name] = changed
                summary["changed"] += sum(changed.values())
    with connect_users_db() as conn:
        share_counts = normalize_users_db(conn)
    summary["shares"] = {k: v for k, v in share_counts.items() if v}
    summary["changed"] += sum(share_counts.values())
    return summary

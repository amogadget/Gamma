"""Normalization of old data shapes inside a workspace's databases.

The per-workspace files (``pages.db``, ``data.db``) carry no schema version:
a backup restored through ``/api/import-data`` can be as old as the first
release, and the block-content shapes below were changed without ever
keeping a read-side shim. So the same idempotent pass runs in two places —
the ``baseline`` migration step (every existing library, once) and the
backup restore (each imported file). Every step SQL-filters (``LIKE``) for
the old shape first, so a clean database costs one query per step and
touches no row; ``updated_at`` moves only on rows actually rewritten.

Adding a step here means adding it to BOTH callers implicitly — that is the
point. Steps are never removed while ``/api/import-data`` accepts backups
that may still carry the shape.
"""

import json
import sqlite3

from .db import page_now
from .note_markup import LEGACY_WIDTH_RE, obsidian_image_sizes

# The automatic title prefix Gamma used to give uploaded PDFs. Migrated pages
# get the bare name plus an ``auto_title`` marker, so the metadata worker may
# still replace the title exactly as for new pages.
PDF_NOTES_PREFIX = "PDF Notes - "

PAGES_STEPS = ("source_url_key", "image_width", "pdf_notes_title")

# Tables data.db used to hold and no longer does: `annotations` and a
# per-user `shares` (superseded by unified_blocks / the global shares table
# long ago) and `prefs` (moved to users.db user_prefs by migration step 2 —
# a restored backup's copy is meaningless in another workspace).
LEGACY_DATA_TABLES = ("annotations", "shares", "prefs")


def _load_props(raw) -> dict | None:
    try:
        props = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return None
    return props if isinstance(props, dict) else None


def normalize_pages_db(conn: sqlite3.Connection) -> dict:
    """Normalize one pages.db. Returns ``{step: rows changed}``."""
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


def normalize_data_db(conn: sqlite3.Connection, keep_prefs: bool = False) -> dict:
    """Drop the legacy tables and add the ``chats.title`` column older files
    lack. ``keep_prefs`` leaves the old ``prefs`` table for a caller that
    still has to read it (migration step 2). Returns ``{"dropped_tables": n,
    "chats_title_added": 0|1}``."""
    tables = tuple(t for t in LEGACY_DATA_TABLES if not (keep_prefs and t == "prefs"))
    placeholders = ",".join("?" * len(tables))
    existing = {r[0] for r in conn.execute(
        f"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ({placeholders})", tables)}
    for table in existing:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    added = 0
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chats'").fetchone():
        if "title" not in {r[1] for r in conn.execute("PRAGMA table_info(chats)")}:
            conn.execute("ALTER TABLE chats ADD COLUMN title TEXT NOT NULL DEFAULT ''")
            added = 1
    conn.commit()
    return {"dropped_tables": len(existing), "chats_title_added": added}

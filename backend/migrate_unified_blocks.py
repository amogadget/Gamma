"""
One-time migration: pages + blocks → unified_blocks.

Run once:
    cd /home/ubuntu/pdf-share/backend && python migrate_unified_blocks.py

Idempotent: skips if unified_blocks already has rows.
"""

import sqlite3
import json
from collections import defaultdict
from datetime import datetime
from fractional_indexing import generate_n_keys_between

PAGES_DB = "/home/ubuntu/pdf-share/backend/pages.db"


def now():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def migrate():
    with sqlite3.connect(PAGES_DB) as conn:
        # Create unified_blocks table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS unified_blocks (
                id         TEXT PRIMARY KEY,
                parent_id  TEXT REFERENCES unified_blocks(id),
                position   TEXT NOT NULL,
                content    TEXT NOT NULL DEFAULT '',
                properties TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ub_parent ON unified_blocks(parent_id, position)"
        )
        conn.commit()

        count = conn.execute("SELECT COUNT(*) FROM unified_blocks").fetchone()[0]
        if count > 0:
            print(f"unified_blocks already has {count} rows — skipping migration.")
            return

        ts = now()

        # Root block
        conn.execute(
            "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
            "VALUES ('root', NULL, 'a0', '', '{}', ?, ?)",
            (ts, ts),
        )

        # Migrate pages → children of root
        pages = conn.execute(
            "SELECT id, title, position, doc_id, source_url, summary, updated_at FROM pages ORDER BY position ASC"
        ).fetchall()

        page_ids = set()
        for page_id, title, position, doc_id, source_url, summary, updated_at in pages:
            props = {}
            if doc_id:
                props["doc_id"] = doc_id
            if source_url:
                props["source_url"] = source_url
            if summary:
                props["summary"] = summary
            pos = position or "a0"
            conn.execute(
                "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                "VALUES (?, 'root', ?, ?, ?, ?, ?)",
                (page_id, pos, title or "", json.dumps(props), updated_at or ts, updated_at or ts),
            )
            page_ids.add(page_id)

        # Migrate existing blocks — group by new parent to assign fractional positions
        all_blocks = conn.execute(
            "SELECT id, page_id, parent_id, position, content, properties, created_at, updated_at "
            "FROM blocks ORDER BY page_id, position ASC"
        ).fetchall()

        # group[new_parent_id] = sorted list of block rows
        groups = defaultdict(list)
        for row in all_blocks:
            id_, page_id, parent_id, position, content, properties, created_at, updated_at = row
            new_parent = parent_id if parent_id else page_id
            groups[new_parent].append(row)

        for new_parent, block_list in groups.items():
            block_list.sort(key=lambda r: r[3])  # sort by integer position
            keys = generate_n_keys_between(None, None, n=len(block_list))
            for (id_, page_id, parent_id, _, content, properties, created_at, updated_at), frac_pos in zip(block_list, keys):
                new_parent_id = parent_id if parent_id else page_id
                conn.execute(
                    "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (id_, new_parent_id, frac_pos, content or "", properties or "{}", created_at or ts, updated_at or ts),
                )

        conn.commit()
        print(f"Migrated {len(pages)} pages and {len(all_blocks)} blocks into unified_blocks (+ root).")


if __name__ == "__main__":
    migrate()

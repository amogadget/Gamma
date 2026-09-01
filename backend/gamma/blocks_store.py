"""unified_blocks table helpers shared across routers."""

import json
import secrets

from fractional_indexing import generate_key_between, generate_n_keys_between

from .db import page_now
from .storage import display_filename

BLOCK_COLUMNS = "id, parent_id, position, content, properties, created_at, updated_at"


def block_to_dict(row) -> dict:
    return {
        "id": row[0],
        "parent_id": row[1],
        "position": row[2],
        "content": row[3] or "",
        "properties": json.loads(row[4] or "{}"),
        "created_at": row[5],
        "updated_at": row[6],
    }


def last_child_position(conn, parent_id: str) -> str | None:
    row = conn.execute(
        "SELECT position FROM unified_blocks WHERE parent_id = ? ORDER BY position DESC LIMIT 1",
        (parent_id,),
    ).fetchone()
    return row[0] if row else None


def fetch_subtree(conn, block_id: str):
    """Fetch a block + all its descendants."""
    return conn.execute(
        f"""
        WITH RECURSIVE subtree AS (
            SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?
            UNION ALL
            SELECT ub.id, ub.parent_id, ub.position, ub.content, ub.properties, ub.created_at, ub.updated_at
            FROM unified_blocks ub JOIN subtree s ON ub.parent_id = s.id
        )
        SELECT {BLOCK_COLUMNS} FROM subtree
        """,
        (block_id,),
    ).fetchall()


def delete_subtree(conn, block_id: str):
    """Delete a block and all its descendants."""
    conn.execute(
        """
        WITH RECURSIVE subtree AS (
            SELECT id FROM unified_blocks WHERE id = ?
            UNION ALL
            SELECT ub.id FROM unified_blocks ub JOIN subtree s ON ub.parent_id = s.id
        )
        DELETE FROM unified_blocks WHERE id IN (SELECT id FROM subtree)
        """,
        (block_id,),
    )


def delete_children(conn, block_id: str):
    """Delete all descendants of a block, keeping the block itself."""
    conn.execute(
        """
        WITH RECURSIVE subtree AS (
            SELECT id FROM unified_blocks WHERE parent_id = ?
            UNION ALL
            SELECT ub.id FROM unified_blocks ub JOIN subtree s ON ub.parent_id = s.id
        )
        DELETE FROM unified_blocks WHERE id IN (SELECT id FROM subtree)
        """,
        (block_id,),
    )


def flatten_tree(tree, parent_id, result, now):
    """Recursively flatten a nested block tree into flat rows with fractional positions."""
    n = len(tree or [])
    if n == 0:
        return
    keys = generate_n_keys_between(None, None, n=n)
    for node, key in zip(tree, keys):
        props = node.get("properties") or {}
        if isinstance(props, str):
            try:
                props = json.loads(props)
            except Exception:
                props = {}
        node_id = node.get("id") or secrets.token_urlsafe(9)
        result.append(
            {
                "id": node_id,
                "parent_id": parent_id,
                "position": key,
                "content": node.get("content", "") or "",
                "properties": json.dumps(props),
                "created_at": node.get("created_at") or now,
                "updated_at": now,
            }
        )
        flatten_tree(node.get("children") or [], node_id, result, now)


def page_root_id(conn, block_id: str) -> str | None:
    """Walk parents up to the top-level page block that contains block_id
    (whose parent is 'root'). Returns the page id, or None if block_id is
    unknown. Cycle-guarded."""
    cur = block_id
    for _ in range(10000):
        row = conn.execute(
            "SELECT parent_id FROM unified_blocks WHERE id = ?", (cur,)
        ).fetchone()
        if not row:
            return None
        parent = row[0]
        if parent in (None, "root"):
            return cur
        cur = parent
    return None


def block_doc_id(conn, block_id: str) -> str | None:
    row = conn.execute(
        "SELECT json_extract(properties, '$.doc_id') FROM unified_blocks WHERE id = ?",
        (block_id,),
    ).fetchone()
    return row[0] if row and row[0] else None


def assert_block_in_doc(conn, block_id: str, scope_doc_id) -> None:
    """For a share-scoped request (scope_doc_id set), raise 403 unless block_id
    lives inside the page identified by scope_doc_id. No-op for full-access
    session users (scope_doc_id is None)."""
    if scope_doc_id is None:
        return
    from fastapi import HTTPException

    root = page_root_id(conn, block_id)
    if not root or block_doc_id(conn, root) != scope_doc_id:
        raise HTTPException(status_code=403, detail="not accessible via this share link")


def ancestor_chains(conn, block_ids: list[str]):
    """Return {block_id: [{id, content}, ...]} ancestor chains (root-first, excluding 'root')
    and {block_id: page_root_id} for a set of blocks, in one recursive CTE."""
    if not block_ids:
        return {}, {}
    placeholders = ",".join("?" * len(block_ids))
    rows = conn.execute(
        f"""
        WITH RECURSIVE chain AS (
            SELECT id AS descendant_id, parent_id, 0 AS depth
            FROM unified_blocks WHERE id IN ({placeholders})
            UNION ALL
            SELECT c.descendant_id, u.parent_id, c.depth + 1
            FROM unified_blocks u
            JOIN chain c ON u.id = c.parent_id
            WHERE u.parent_id IS NOT NULL AND u.parent_id != 'root'
        )
        SELECT c.descendant_id, u.id, u.content, c.depth
        FROM chain c
        JOIN unified_blocks u ON u.id = c.parent_id
        ORDER BY c.descendant_id, c.depth DESC
        """,
        block_ids,
    ).fetchall()
    ancestors_by_id: dict = {}
    page_root_by_id: dict = {}
    for descendant_id, anc_id, anc_content, _depth in rows:
        if anc_id == "root":
            continue  # "root" is a virtual parent, not a real page
        ancestors_by_id.setdefault(descendant_id, []).append({"id": anc_id, "content": anc_content})
        if descendant_id not in page_root_by_id:
            page_root_by_id[descendant_id] = anc_id
    return ancestors_by_id, page_root_by_id


def get_or_create_doc_page(conn, doc_id: str, default_title: str = "",
                           source_url: str | None = None,
                           original_filename: str | None = None) -> dict:
    """The root page holding PDF `doc_id`, created under root when absent.
    Shared by POST /api/blocks/by-doc and the extension's /api/clip.

    On an existing page this opportunistically backfills the source/filename
    markers; auto_title is only set when the page still carries the exact
    title this call considers automatic, so a re-upload can never mark a
    user's custom title as replaceable by the metadata worker."""
    row = conn.execute(
        f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
        (doc_id,),
    ).fetchone()
    if row:
        props = json.loads(row[4] or "{}")
        changed = False
        if source_url and not props.get("source_url"):
            props["source_url"] = source_url
            changed = True
        original = display_filename(original_filename)
        if original and not props.get("original_filename"):
            props["original_filename"] = original
            changed = True
        if not props.get("auto_title") and row[3] == (default_title or "").strip():
            props["auto_title"] = row[3]
            changed = True
        if changed:
            now = page_now()
            conn.execute(
                "UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                (json.dumps(props), now, row[0]),
            )
            conn.commit()
            row = (*row[:4], json.dumps(props), *row[5:])
        return block_to_dict(row)

    block_id = secrets.token_urlsafe(9)
    original = display_filename(original_filename)
    # Upload callers provide original_filename; its leaf is the authoritative
    # automatic title even if a browser leaked a relative path into the default.
    title = original or (default_title or "").strip() or "Untitled"
    now = page_now()
    last_pos = last_child_position(conn, "root")
    new_pos = generate_key_between(last_pos, None)
    # auto_title is a compare-and-swap marker consumed by metadata_fetch:
    # metadata may replace this value, but an explicit rename clears the
    # marker first (see ub_update_block in routers/blocks.py).
    props = {"doc_id": doc_id, "auto_title": title}
    if source_url:
        props["source_url"] = source_url
    if original:
        props["original_filename"] = original
    conn.execute(
        "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
        "VALUES (?, 'root', ?, ?, ?, ?, ?)",
        (block_id, new_pos, title, json.dumps(props), now, now),
    )
    conn.commit()
    return {
        "id": block_id, "parent_id": "root", "position": new_pos,
        "content": title, "properties": props, "created_at": now, "updated_at": now,
    }

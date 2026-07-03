"""unified_blocks table helpers shared across routers."""

import json
import secrets

from fractional_indexing import generate_n_keys_between

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
        result.append({
            "id": node_id,
            "parent_id": parent_id,
            "position": key,
            "content": node.get("content", "") or "",
            "properties": json.dumps(props),
            "created_at": node.get("created_at") or now,
            "updated_at": now,
        })
        flatten_tree(node.get("children") or [], node_id, result, now)


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

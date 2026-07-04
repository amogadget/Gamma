"""Unified blocks API (/api/blocks/*) and block search."""

import json
import re
import secrets
import sqlite3

from fastapi import APIRouter, HTTPException, Request
from fractional_indexing import generate_key_between
from pydantic import BaseModel

from ..auth import require_user, resolve_user
from ..blocks_store import (
    BLOCK_COLUMNS,
    ancestor_chains,
    block_to_dict,
    delete_children,
    delete_subtree,
    fetch_subtree,
    flatten_tree,
    last_child_position,
)
from ..db import page_now, user_db_path, user_uploads_dir
from ..storage import cleanup_orphan_uploads

router = APIRouter(prefix="/api", tags=["blocks"])


class UBCreateRequest(BaseModel):
    parent_id: str
    content: str = ""
    properties: dict = {}
    before: str | None = None   # fractional position of the sibling before this one
    after: str | None = None    # fractional position of the sibling after this one


class UBUpdateRequest(BaseModel):
    content: str | None = None
    properties: dict | None = None


class UBReorderRequest(BaseModel):
    parent_id: str | None = None   # if provided, also reparents the block
    before: str | None = None
    after: str | None = None


class UBByDocCreate(BaseModel):
    default_title: str
    source_url: str | None = None


class UBPutChildrenRequest(BaseModel):
    blocks: list


def _search_pattern(q: str, case: bool, whole: bool, regex: bool):
    """Compile the VSCode-style search options into a regex (None = invalid)."""
    body = q if regex else re.escape(q)
    if whole:
        body = rf"\b(?:{body})\b"
    try:
        return re.compile(body, 0 if case else re.IGNORECASE)
    except re.error:
        return None


@router.get("/block-search")
async def block_search(request: Request, q: str = "", ids: str = "", limit: int = 10,
                       case: int = 0, whole: int = 0, regex: int = 0):
    results = []
    with sqlite3.connect(user_db_path(require_user(request), "pages.db")) as conn:
        if ids:
            id_list = [i.strip() for i in ids.split(",") if i.strip()]
            if not id_list:
                return {"blocks": []}
            placeholders = ",".join("?" * len(id_list))
            rows = conn.execute(
                f"SELECT id, content, parent_id FROM unified_blocks WHERE id IN ({placeholders})",
                id_list,
            ).fetchall()
        elif case or whole or regex:
            # Option-aware search: SQLite LIKE can't express these, so scan in Python
            pattern = _search_pattern(q, bool(case), bool(whole), bool(regex))
            if pattern is None:
                return {"blocks": [], "error": "invalid regex"}
            rows = [r for r in conn.execute(
                "SELECT id, content, parent_id FROM unified_blocks "
                "WHERE content != '' ORDER BY updated_at DESC",
            ) if pattern.search(r[1] or "")][:limit]
        else:
            rows = conn.execute(
                """
                SELECT id, content, parent_id
                FROM unified_blocks
                WHERE content LIKE ? AND content != ''
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (f"%{q}%", limit),
            ).fetchall()
        if not rows:
            return {"blocks": []}

        ancestors_by_id, page_root_by_id = ancestor_chains(conn, [r[0] for r in rows])

        for block_id, content, _parent_id in rows:
            block = {"id": block_id, "content": content}
            ancestors = ancestors_by_id.get(block_id)
            if ancestors:
                block["ancestors"] = ancestors
                block["page_root_id"] = page_root_by_id.get(block_id, block_id)
                block["page_title"] = ancestors[0]["content"]
            else:
                block["page_root_id"] = block_id
                block["page_title"] = content
            results.append(block)
    return {"blocks": results}


class BlockReplaceRequest(BaseModel):
    query: str
    replacement: str = ""
    case: bool = False
    whole: bool = False
    regex: bool = False


@router.post("/blocks-replace")
async def blocks_replace(payload: BlockReplaceRequest, request: Request):
    """Search-and-replace across all block contents (VSCode-style options)."""
    if not payload.query:
        raise HTTPException(status_code=400, detail="empty query")
    pattern = _search_pattern(payload.query, payload.case, payload.whole, payload.regex)
    if pattern is None:
        raise HTTPException(status_code=400, detail="invalid regex")
    replacement = payload.replacement if payload.regex else payload.replacement.replace("\\", "\\\\")
    now = page_now()
    changed = 0
    with sqlite3.connect(user_db_path(require_user(request), "pages.db")) as conn:
        rows = conn.execute(
            "SELECT id, content FROM unified_blocks WHERE content != '' AND id != 'root'"
        ).fetchall()
        for block_id, content in rows:
            try:
                new_content = pattern.sub(replacement, content)
            except re.error:
                raise HTTPException(status_code=400, detail="invalid replacement pattern")
            if new_content != content:
                conn.execute(
                    "UPDATE unified_blocks SET content = ?, updated_at = ? WHERE id = ?",
                    (new_content, now, block_id),
                )
                changed += 1
        conn.commit()
    return {"ok": True, "changed": changed}


# Route order matters: static-prefix routes must come before /{block_id}

@router.get("/blocks/by-doc/{doc_id}")
async def ub_get_by_doc(doc_id: str, request: Request):
    with sqlite3.connect(user_db_path(resolve_user(request), "pages.db")) as conn:
        row = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
            (doc_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="block not found for doc_id")
    return block_to_dict(row)


@router.post("/blocks/by-doc/{doc_id}")
async def ub_get_or_create_by_doc(doc_id: str, payload: UBByDocCreate, request: Request):
    with sqlite3.connect(user_db_path(resolve_user(request), "pages.db")) as conn:
        row = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
            (doc_id,),
        ).fetchone()
        if row:
            # Opportunistic backfill of source_url
            if payload.source_url:
                props = json.loads(row[4] or "{}")
                if not props.get("source_url"):
                    props["source_url"] = payload.source_url
                    now = page_now()
                    conn.execute(
                        "UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                        (json.dumps(props), now, row[0]),
                    )
                    conn.commit()
            return block_to_dict(row)

        # Create new block under root
        block_id = secrets.token_urlsafe(9)
        title = (payload.default_title or "").strip() or "Untitled"
        now = page_now()
        last_pos = last_child_position(conn, "root")
        new_pos = generate_key_between(last_pos, None)
        props = {"doc_id": doc_id}
        if payload.source_url:
            props["source_url"] = payload.source_url
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


@router.get("/blocks/{block_id}/children")
async def ub_get_children(block_id: str, request: Request):
    with sqlite3.connect(user_db_path(resolve_user(request), "pages.db")) as conn:
        if block_id != "root":
            if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
                raise HTTPException(status_code=404, detail="block not found")
        rows = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = ? ORDER BY position ASC",
            (block_id,),
        ).fetchall()
    return {"children": [block_to_dict(r) for r in rows]}


@router.get("/blocks/{block_id}/subtree")
async def ub_get_subtree(block_id: str, request: Request):
    with sqlite3.connect(user_db_path(resolve_user(request), "pages.db")) as conn:
        rows = fetch_subtree(conn, block_id)
    if not rows:
        raise HTTPException(status_code=404, detail="block not found")
    # Build a full id→node map, wire children, then return the root node by id
    by_id: dict = {}
    for r in rows:
        node = block_to_dict(r)
        node["children"] = []
        by_id[r[0]] = node
    for node in by_id.values():
        parent = by_id.get(node["parent_id"])
        if parent:
            parent["children"].append(node)
    for node in by_id.values():
        node["children"].sort(key=lambda n: n["position"])
    return {"block": by_id.get(block_id)}


@router.get("/blocks/{block_id}/backlinks")
async def ub_get_backlinks(block_id: str, request: Request):
    """Return all blocks that reference `block_id` via [[block_id]] syntax."""
    with sqlite3.connect(user_db_path(resolve_user(request), "pages.db")) as conn:
        rows = conn.execute(
            "SELECT id, content, parent_id FROM unified_blocks "
            "WHERE id != ? AND content LIKE ? "
            "ORDER BY updated_at DESC LIMIT 50",
            (block_id, f"%[[{block_id}]]%"),
        ).fetchall()
        if not rows:
            return {"backlinks": []}

        ancestors_by_id, page_root_by_id = ancestor_chains(conn, [r[0] for r in rows])

        results = []
        for bid, content, _parent_id in rows:
            ancestors = ancestors_by_id.get(bid)
            results.append({
                "id": bid,
                "content": content,
                "page_root_id": page_root_by_id.get(bid, bid),
                "page_title": ancestors[0]["content"] if ancestors else content,
            })
    return {"backlinks": results}


@router.get("/blocks/{block_id}")
async def ub_get_block(block_id: str, request: Request):
    with sqlite3.connect(user_db_path(resolve_user(request), "pages.db")) as conn:
        row = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?",
            (block_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="block not found")
    return block_to_dict(row)


@router.post("/blocks")
async def ub_create_block(payload: UBCreateRequest, request: Request):
    block_id = secrets.token_urlsafe(9)
    now = page_now()
    with sqlite3.connect(user_db_path(require_user(request), "pages.db")) as conn:
        if payload.parent_id != "root":
            if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (payload.parent_id,)).fetchone():
                raise HTTPException(status_code=404, detail="parent block not found")
        try:
            new_pos = generate_key_between(payload.before, payload.after)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid before/after: {e}")
        conn.execute(
            "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (block_id, payload.parent_id, new_pos, payload.content,
             json.dumps(payload.properties), now, now),
        )
        conn.commit()
    return {
        "id": block_id, "parent_id": payload.parent_id, "position": new_pos,
        "content": payload.content, "properties": payload.properties,
        "created_at": now, "updated_at": now,
    }


@router.put("/blocks/{block_id}")
async def ub_update_block(block_id: str, payload: UBUpdateRequest, request: Request):
    now = page_now()
    with sqlite3.connect(user_db_path(require_user(request), "pages.db")) as conn:
        row = conn.execute(
            "SELECT properties FROM unified_blocks WHERE id = ?", (block_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="block not found")
        sets = ["updated_at = ?"]
        values: list = [now]
        if payload.content is not None:
            sets.append("content = ?")
            values.append(payload.content)
        if payload.properties is not None:
            existing = json.loads(row[0] or "{}")
            existing.update(payload.properties)
            sets.append("properties = ?")
            values.append(json.dumps(existing))
        values.append(block_id)
        conn.execute(f"UPDATE unified_blocks SET {', '.join(sets)} WHERE id = ?", values)
        conn.commit()
    return {"ok": True, "updated_at": now}


@router.delete("/blocks/{block_id}")
async def ub_delete_block(block_id: str, request: Request):
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot delete root block")
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        delete_subtree(conn, block_id)
        conn.commit()
        removed = cleanup_orphan_uploads(conn, user_uploads_dir(user))
    return {"ok": True, "id": block_id, "removed_uploads": removed}


@router.put("/blocks/{block_id}/children")
async def ub_put_children(block_id: str, payload: UBPutChildrenRequest, request: Request):
    """Replace all children of a block with the provided nested tree."""
    now = page_now()
    rows: list = []
    flatten_tree(payload.blocks, block_id, rows, now)
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        delete_children(conn, block_id)
        for r in rows:
            conn.execute(
                "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (r["id"], r["parent_id"], r["position"], r["content"],
                 r["properties"], r["created_at"], r["updated_at"]),
            )
        conn.execute("UPDATE unified_blocks SET updated_at = ? WHERE id = ?", (now, block_id))
        conn.commit()
        removed = cleanup_orphan_uploads(conn, user_uploads_dir(user))
    return {"ok": True, "count": len(rows), "updated_at": now, "removed_uploads": removed}


@router.post("/blocks/{block_id}/reorder")
async def ub_reorder_block(block_id: str, payload: UBReorderRequest, request: Request):
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot reorder root block")
    with sqlite3.connect(user_db_path(require_user(request), "pages.db")) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        try:
            new_pos = generate_key_between(payload.before, payload.after)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid before/after: {e}")
        sets = ["position = ?", "updated_at = ?"]
        values: list = [new_pos, page_now()]
        if payload.parent_id is not None:
            sets.append("parent_id = ?")
            values.append(payload.parent_id)
        values.append(block_id)
        conn.execute(f"UPDATE unified_blocks SET {', '.join(sets)} WHERE id = ?", values)
        conn.commit()
    return {"ok": True, "id": block_id, "position": new_pos}

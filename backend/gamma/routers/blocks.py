"""Unified blocks API (/api/blocks/*) and block search."""

import json
import re
import secrets

from fastapi import APIRouter, HTTPException, Request
from fractional_indexing import generate_key_between
from pydantic import BaseModel

from ..auth import require_ws, require_ws_writer, resolve_ws, share_scope_page
from ..blocks_store import (
    BLOCK_COLUMNS,
    ancestor_chains,
    assert_block_in_page,
    block_to_dict,
    delete_children,
    delete_subtree,
    fetch_subtree,
    flatten_tree,
    get_or_create_doc_page,
    page_for_doc,
    page_root_id,
)
from .. import block_index, collab
from ..db import connect_pages_db, page_now, ws_uploads_dir
from ..markdown_export import build_tree
from ..native_ink import (
    NativeScopeError,
    guard_generic_insert,
    native_kind,
    preserve_native_properties,
)
from ..ops import OpError, commit_ops, latest_seq, note_reload, record_ops
from ..storage import cleanup_orphan_uploads, display_filename
from ..textnorm import fuzzy_pattern

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
    original_filename: str | None = None
    folder: str | None = None       # files a NEWLY created page (ignored when the page exists)


class UBPutChildrenRequest(BaseModel):
    blocks: list


def _block_kind(parent_id: str, properties: str) -> str:
    """Classify a search hit for the UI: page title, PDF link region,
    highlight, or plain note."""
    if parent_id == "root":
        return "page"
    try:
        props = json.loads(properties) if properties else {}
    except (ValueError, TypeError):
        props = {}
    if props.get("link_url") or props.get("link_page_id"):
        return "link"
    if props.get("highlight_id"):
        return "highlight"
    return "note"


def _repair_upload_path_titles(conn) -> int:
    """Repair titles created while directory paths leaked into filenames.

    This is deliberately compare-and-swap-like: original_filename is always
    reduced to a leaf, but content changes only when it exactly matches the
    old generated Markdown stem or PDF auto_title. User-renamed pages cannot
    match those guards.
    """
    repaired = 0
    rows = conn.execute(
        "SELECT id, content, properties FROM unified_blocks "
        "WHERE parent_id = 'root' AND json_extract(properties, '$.original_filename') IS NOT NULL"
    ).fetchall()
    for block_id, content, props_json in rows:
        try:
            props = json.loads(props_json or "{}")
        except (TypeError, ValueError):
            continue
        raw = str(props.get("original_filename") or "").replace("\\", "/").strip()
        leaf = display_filename(raw)
        if not leaf or leaf == raw:
            continue
        next_content = content
        if props.get("markdown_import"):
            old_stem = re.sub(r"\.(?:md|markdown)$", "", raw, flags=re.I)
            if content == old_stem:
                next_content = re.sub(r"\.(?:md|markdown)$", "", leaf, flags=re.I)
        elif props.get("auto_title") == content and display_filename(content) == leaf:
            next_content = leaf
            props["auto_title"] = leaf
        props["original_filename"] = leaf
        conn.execute(
            "UPDATE unified_blocks SET content = ?, properties = ? WHERE id = ?",
            (next_content, json.dumps(props), block_id),
        )
        repaired += int(next_content != content)
    if rows:
        conn.commit()
    return repaired


@router.get("/block-search")
async def block_search(request: Request, q: str = "", ids: str = "", limit: int = 10,
                       case: int = 0, whole: int = 0, regex: int = 0):
    results = []
    with connect_pages_db(require_ws(request)) as conn:
        if ids:
            id_list = [i.strip() for i in ids.split(",") if i.strip()]
            if not id_list:
                return {"blocks": []}
            placeholders = ",".join("?" * len(id_list))
            rows = conn.execute(
                f"SELECT id, content, parent_id, properties FROM unified_blocks WHERE id IN ({placeholders})",
                id_list,
            ).fetchall()
        elif not q and not regex:
            # Empty query: recently edited blocks, so the [[ref]] popup (and
            # the "/link" slash command) can suggest something before the
            # user types a filter.
            rows = conn.execute(
                "SELECT id, content, parent_id, properties FROM unified_blocks "
                "WHERE content != '' AND id != 'root' ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            # Scan in Python: separator-tolerant matching ("3000" hits
            # "3,000-qubit") and the VSCode-style options can't be expressed
            # as SQLite LIKE, and per-user note DBs are small.
            pattern = fuzzy_pattern(q, bool(case), bool(whole), bool(regex))
            if pattern is None:
                return {"blocks": [], "error": "invalid regex" if regex else "empty query"}
            rows = [r for r in conn.execute(
                "SELECT id, content, parent_id, properties FROM unified_blocks "
                "WHERE content != '' ORDER BY updated_at DESC",
            ) if pattern.search(r[1] or "")][:limit]
        if not rows:
            return {"blocks": []}

        ancestors_by_id, page_root_by_id = ancestor_chains(conn, [r[0] for r in rows])

        for block_id, content, parent_id, properties in rows:
            block = {"id": block_id, "content": content,
                     "kind": _block_kind(parent_id, properties)}
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


# Route order matters: static-prefix routes must come before /{block_id}

# Lookup / create BY ATTACHMENT: the page whose PDF is `doc_id`. Text-only
# pages are created by POST /api/pages (routers/pages.py).

@router.get("/blocks/by-doc/{doc_id}")
async def ub_get_by_doc(doc_id: str, request: Request):
    scope = share_scope_page(request)
    with connect_pages_db(resolve_ws(request)) as conn:
        row = page_for_doc(conn, doc_id, BLOCK_COLUMNS)
    # A share may only learn about its own page — refuse before revealing
    # whether any other doc id exists.
    if scope is not None and (not row or row[0] != scope):
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    if not row:
        raise HTTPException(status_code=404, detail="block not found for doc_id")
    return block_to_dict(row)


@router.post("/blocks/by-doc/{doc_id}")
async def ub_get_or_create_by_doc(doc_id: str, payload: UBByDocCreate, request: Request):
    # The page carrying this PDF, created when absent (PDF ingest from the
    # app and the extension, and "Open as document" on a PDF file block) — a
    # write, so it requires a real session (never the ?share= read principal).
    with connect_pages_db(require_ws(request, write=True)) as conn:
        return get_or_create_doc_page(
            conn, doc_id, payload.default_title, payload.source_url, payload.original_filename,
            folder=payload.folder or "")


@router.get("/blocks/{block_id}/children")
async def ub_get_children(block_id: str, request: Request):
    scope = share_scope_page(request)
    if scope is not None and block_id == "root":
        # A share link may not enumerate the owner's library root.
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    with connect_pages_db(resolve_ws(request)) as conn:
        if block_id != "root":
            if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
                raise HTTPException(status_code=404, detail="block not found")
        assert_block_in_page(conn, block_id, scope)
        if block_id == "root":
            _repair_upload_path_titles(conn)
        rows = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = ? ORDER BY position ASC",
            (block_id,),
        ).fetchall()
        previews = _page_previews(conn) if block_id == "root" else None
    children = [block_to_dict(r) for r in rows]
    if previews is not None:
        for child in children:
            child["preview"] = previews.get(child["id"], "")
    return {"children": children}


PREVIEW_CHARS = 240
_PREVIEW_BLOCKS = 5


def _page_previews(conn) -> dict:
    """{page_id: preview} for the library listing — the first ~PREVIEW_CHARS
    characters of each page's first few non-highlight child blocks, joined
    with " · ". One window query over all pages' direct children (the listing
    is hot; never N+1). Pages without children are absent (→ "")."""
    rows = conn.execute(
        f"""
        SELECT parent_id, content FROM (
            SELECT c.parent_id, c.content,
                   ROW_NUMBER() OVER (PARTITION BY c.parent_id ORDER BY c.position) AS rn
            FROM unified_blocks c
            JOIN unified_blocks p ON p.id = c.parent_id AND p.parent_id = 'root'
            WHERE c.content != ''
              AND json_extract(c.properties, '$.highlight_id') IS NULL
        ) WHERE rn <= {_PREVIEW_BLOCKS}
        ORDER BY parent_id, rn
        """
    ).fetchall()
    previews: dict = {}
    for page_id, content in rows:
        current = previews.get(page_id, "")
        if len(current) >= PREVIEW_CHARS:
            continue
        piece = " ".join((content or "").split())
        previews[page_id] = (current + " · " + piece) if current else piece
    return {k: v[:PREVIEW_CHARS] for k, v in previews.items()}


@router.get("/blocks/{block_id}/subtree")
async def ub_get_subtree(block_id: str, request: Request):
    """The block with its whole subtree. For a page, ``seq`` is the op log's
    position this tree reflects — the live session catches up from it."""
    scope = share_scope_page(request)
    with connect_pages_db(resolve_ws(request)) as conn:
        assert_block_in_page(conn, block_id, scope)
        rows = fetch_subtree(conn, block_id)
        seq = latest_seq(conn, block_id) if rows and rows[0][1] == "root" else None
    if not rows:
        raise HTTPException(status_code=404, detail="block not found")
    out = {"block": build_tree(rows, block_id)}
    if seq is not None:
        out["seq"] = seq
    return out


@router.get("/blocks/{block_id}/backlinks")
async def ub_get_backlinks(block_id: str, request: Request):
    """Return all blocks that reference `block_id` via [[block_id]] syntax."""
    # Backlinks span the whole library by nature, so a per-document share link
    # can't use them without leaking other pages.
    if share_scope_page(request) is not None:
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    with connect_pages_db(resolve_ws(request)) as conn:
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
    scope = share_scope_page(request)
    with connect_pages_db(resolve_ws(request)) as conn:
        assert_block_in_page(conn, block_id, scope)
        row = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?",
            (block_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="block not found")
    return block_to_dict(row)


def _ops(ws: str, page_id: str, ops: list[dict], request: Request, scope) -> dict:
    """Apply ops to a page on behalf of the request: a share editor is
    confined to the shared page, every op error is its HTTP status."""
    if scope is not None and scope != page_id:
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    try:
        return commit_ops(ws, page_id, ops, actor=request.state.user or "",
                          share_scoped=scope is not None)
    except OpError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@router.post("/blocks")
async def ub_create_block(payload: UBCreateRequest, request: Request):
    block_id = secrets.token_urlsafe(9)
    ws = require_ws_writer(request)
    scope = share_scope_page(request)
    if payload.parent_id == "root":
        # A new page: not an op on any page. Share editors never get here.
        if scope is not None:
            raise HTTPException(status_code=403, detail="not accessible via this share link")
        try:
            guard_generic_insert(payload.properties)
        except NativeScopeError as e:
            raise HTTPException(status_code=409, detail=str(e))
        now = page_now()
        with connect_pages_db(ws) as conn:
            try:
                new_pos = generate_key_between(payload.before, payload.after)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"invalid before/after: {e}")
            conn.execute(
                "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                "VALUES (?, 'root', ?, ?, ?, ?, ?)",
                (block_id, new_pos, payload.content, json.dumps(payload.properties), now, now))
            conn.commit()
        return {"id": block_id, "parent_id": "root", "position": new_pos, "content": payload.content,
                "properties": payload.properties, "created_at": now, "updated_at": now}
    with connect_pages_db(ws) as conn:
        page_id = page_root_id(conn, payload.parent_id)
    if not page_id:
        raise HTTPException(status_code=404, detail="parent block not found")
    try:
        position = generate_key_between(payload.before, payload.after)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid before/after: {e}")
    result = _ops(ws, page_id, [{"op": "insert", "id": block_id, "parent": payload.parent_id,
                                   "position": position, "content": payload.content,
                                   "props": payload.properties}], request, scope)
    applied = result["ops"][0]
    return {"id": block_id, "parent_id": payload.parent_id, "position": applied["position"],
            "content": payload.content, "properties": payload.properties,
            "created_at": result["at"], "updated_at": result["at"]}


@router.put("/blocks/{block_id}")
async def ub_update_block(block_id: str, payload: UBUpdateRequest, request: Request):
    """Content and/or a properties PATCH (a null value deletes the key)."""
    ws = require_ws_writer(request)
    scope = share_scope_page(request)
    with connect_pages_db(ws) as conn:
        page_id = page_root_id(conn, block_id)
    if not page_id:
        raise HTTPException(status_code=404, detail="block not found")
    op = {"op": "set", "id": block_id}
    if payload.content is not None:
        op["content"] = payload.content
    if payload.properties is not None:
        op["props"] = payload.properties
    result = _ops(ws, page_id, [op], request, scope)
    return {"ok": True, "updated_at": result["at"], "seq": result["seq"]}


@router.delete("/blocks/{block_id}")
async def ub_delete_block(block_id: str, request: Request):
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot delete root block")
    ws = require_ws_writer(request)
    scope = share_scope_page(request)
    with connect_pages_db(ws) as conn:
        page_id = page_root_id(conn, block_id)
        if not page_id:
            raise HTTPException(status_code=404, detail="block not found")
        if page_id == block_id:
            # Deleting a page: not an op on the page's blocks. Its room (if
            # any) is told to reload, which surfaces the 404.
            if scope is not None:
                raise HTTPException(status_code=403, detail="share editors cannot delete the shared page")
            deleted_ids = [r[0] for r in fetch_subtree(conn, block_id)]
            delete_subtree(conn, block_id)
            conn.commit()
            removed = cleanup_orphan_uploads(conn, ws_uploads_dir(ws))
            block_index.purge_page_data(ws, conn, deleted_ids)
            collab.publish_reload(ws, block_id)
            return {"ok": True, "id": block_id, "removed_uploads": removed}
    result = _ops(ws, page_id, [{"op": "delete", "id": block_id}], request, scope)
    return {"ok": True, "id": block_id, "removed_uploads": result["removed_uploads"]}


@router.put("/blocks/{block_id}/children")
async def ub_put_children(block_id: str, payload: UBPutChildrenRequest, request: Request):
    """Replace all children of a block with the provided nested tree (bulk
    paths — imports, tests; the editor sends ops). The page's room is told
    to reload."""
    now = page_now()
    rows: list = []
    flatten_tree(payload.blocks, block_id, rows, now)
    ws = require_ws_writer(request)
    scope = share_scope_page(request)
    with connect_pages_db(ws) as conn:
        if not conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone():
            raise HTTPException(status_code=404, detail="block not found")
        assert_block_in_page(conn, block_id, scope)
        # A subtree replace sends the client's copy of the subtree. It owns the
        # text, the children and unrelated properties — never a native payload,
        # which a stale copy would otherwise roll back, and never a brand-new
        # native one (gamma/native_ink.py).
        for r in rows:
            old = conn.execute("SELECT content, properties FROM unified_blocks WHERE id = ?",
                               (r["id"],)).fetchone()
            try:
                r["properties"] = json.dumps(preserve_native_properties(
                    json.loads(old[1] or "{}") if old else {},
                    old[0] if old else "",
                    json.loads(r["properties"] or "{}"), r["content"]))
            except NativeScopeError as e:
                raise HTTPException(status_code=409, detail=str(e))
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
        removed = cleanup_orphan_uploads(conn, ws_uploads_dir(ws))
        page_id = page_root_id(conn, block_id)
        if page_id != block_id:
            block_index.mark_page_dirty(ws, page_id)
        if page_id and page_id != "root":
            note_reload(ws, conn, page_id, request.state.user or "")
    return {"ok": True, "count": len(rows), "updated_at": now, "removed_uploads": removed}


@router.post("/blocks/{block_id}/reorder")
async def ub_reorder_block(block_id: str, payload: UBReorderRequest, request: Request):
    """Move a block: within its page (an op) or to another page
    (``parent_id`` there — the source room sees a delete, the target
    room reloads)."""
    if block_id == "root":
        raise HTTPException(status_code=400, detail="cannot reorder root block")
    ws = require_ws_writer(request)
    scope = share_scope_page(request)
    if scope is not None and (block_id == scope or payload.parent_id == "root"):
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    try:
        new_pos = generate_key_between(payload.before, payload.after)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid before/after: {e}")
    with connect_pages_db(ws) as conn:
        # Keep subtree validation and a cross-page move in one write lock.
        conn.execute("BEGIN IMMEDIATE")
        src_page = page_root_id(conn, block_id)
        if not src_page:
            raise HTTPException(status_code=404, detail="block not found")
        if src_page == block_id:
            raise HTTPException(status_code=400, detail="pages are reordered through the library, not here")
        row = conn.execute("SELECT parent_id FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        parent = payload.parent_id or row[0]
        dst_page = page_root_id(conn, parent)
        if not dst_page:
            raise HTTPException(status_code=404, detail="parent block not found")
        if dst_page != src_page:
            if scope is not None:
                raise HTTPException(status_code=403, detail="not accessible via this share link")
            subtree = fetch_subtree(conn, block_id)
            if parent in {r[0] for r in subtree}:
                raise HTTPException(status_code=400, detail="cannot move a block into its own subtree")
            if any(native_kind(json.loads(r[4] or "{}")) is not None for r in subtree):
                raise HTTPException(status_code=409, detail="native annotations and recordings must stay in their PDF page")
            now = page_now()
            conn.execute(
                "UPDATE unified_blocks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?",
                (parent, new_pos, now, block_id))
            conn.execute("UPDATE unified_blocks SET updated_at = ? WHERE id IN (?, ?)",
                         (now, src_page, dst_page))
            actor = request.state.user or ""
            record_ops(ws, conn, src_page, [{"op": "delete", "id": block_id}], actor=actor)
            note_reload(ws, conn, dst_page, actor)
            block_index.mark_page_dirty(ws, src_page)
            block_index.mark_page_dirty(ws, dst_page)
            return {"ok": True, "id": block_id, "position": new_pos}
    result = _ops(ws, src_page, [{"op": "move", "id": block_id, "parent": parent,
                                    "position": new_pos}], request, scope)
    return {"ok": True, "id": block_id, "position": result["ops"][0]["position"]}

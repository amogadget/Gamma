"""Collaboration endpoints: the op batch write, the op-log catch-up read,
and the per-page websocket (presence + fan-out). See gamma/ops.py for the
op vocabulary and gamma/collab.py for the rooms; docs/dev/collab.md for the
whole picture."""

import json
import secrets

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from .. import collab
from ..auth import (SESSION_COOKIE, require_ws_writer, requested_ws, resolve_ws, session_lookup,
                    share_access, share_lookup, share_scope_page, workspace_access)
from ..db import connect_pages_db
from ..ops import OpError, OpsRequest, commit_ops, latest_seq, ops_since

router = APIRouter(prefix="/api", tags=["collab"])


def _scope_page(request: Request, page_id: str):
    scope = share_scope_page(request)
    if scope is not None and scope != page_id:
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    return scope


@router.post("/pages/{page_id}/ops")
async def post_ops(page_id: str, payload: OpsRequest, request: Request):
    """Apply a batch of block ops to a page: ``{client, ops}`` →
    ``{seq, at, ops}`` with the ops as applied (positions the server had to
    re-key carry their final value). A workspace editor or an edit share."""
    ws = require_ws_writer(request)
    scope = _scope_page(request, page_id)
    ops = [op.model_dump(exclude_unset=True) for op in payload.ops]
    try:
        result = commit_ops(ws, page_id, ops, actor=request.state.user or "",
                            client=payload.client[:32], share_scoped=scope is not None)
    except OpError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    return {"seq": result["seq"], "at": result["at"], "ops": result["ops"],
            "removed_uploads": result["removed_uploads"]}


@router.get("/pages/{page_id}/ops")
async def get_ops(page_id: str, request: Request, since: int = 0):
    """The page's op log after ``since`` (a reconnecting client's catch-up):
    ``{seq, batches: [{seq, actor, client, at, ops}]}``; 410 when the log was
    pruned past ``since`` — reload the tree instead."""
    ws = resolve_ws(request)
    _scope_page(request, page_id)
    with connect_pages_db(ws) as conn:
        row = conn.execute(
            "SELECT parent_id FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
        if not row or row[0] != "root":
            raise HTTPException(status_code=404, detail="page not found")
        batches, pruned = ops_since(conn, page_id, since)
        seq = latest_seq(conn, page_id)
    if pruned:
        raise HTTPException(status_code=410, detail="op log pruned — reload the page")
    return {"seq": seq, "batches": batches}


def _socket_access(sock: WebSocket, page_id: str):
    """Who may join a page's room: ``(workspace, viewer_user, name, can_edit,
    seq)`` or None. The HTTP middleware never sees a websocket, so the
    session cookie, the workspace (``?ws=`` or the account's default) and
    the share token are resolved here with the same rules as HTTP
    (``auth.share_access``): a member joins with their workspace role; a
    share token admits its audience, view or edit."""
    sess = session_lookup(sock.cookies.get(SESSION_COOKIE))
    sock.state.user = sess[0] if sess else None
    sock.state.is_guest = bool(sess and sess[1])
    sock.state.is_admin = bool(sess and sess[2])
    token = sock.query_params.get("share") or ""
    if token:
        share = share_lookup(token)
        if not share or share["page_id"] != page_id:
            return None
        level, _reason = share_access(share, sock)
        if not level:
            return None
        ws, can_edit = share["workspace_id"], level == "edit"
    elif sock.state.user:
        ws, role = workspace_access(sock.state.user, requested_ws(sock), sess[3])
        if not role:
            return None
        can_edit = role != "viewer"
    else:
        return None
    with connect_pages_db(ws) as conn:
        row = conn.execute(
            "SELECT parent_id FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
        if not row or row[0] != "root":
            return None
        seq = latest_seq(conn, page_id)
    return ws, sock.state.user or "", sock.state.user or "Anonymous", can_edit, seq


@router.websocket("/ws/page/{page_id}")
async def page_socket(sock: WebSocket, page_id: str):
    """The page's live channel. Server → client: ``hello {client, color,
    seq, peers}`` on join, ``join {peer}`` / ``leave {client}``, ``cursor
    {client, block, anchor, head}``, ``ops {seq, actor, client, at, ops}``
    for every applied batch, ``reload`` for changes ops can't express.
    Client → server: ``cursor {block, anchor, head}`` only — writes are
    ``POST /pages/{id}/ops``."""
    access = _socket_access(sock, page_id)
    if not access:
        await sock.close(code=4403)
        return
    ws, user, name, can_edit, seq = access
    await sock.accept()
    client = (sock.query_params.get("client") or secrets.token_urlsafe(6))[:32]
    room = collab.room_for(ws, page_id)
    color = room.next_color() if room else 0
    peer = collab.Peer(ws=sock, client=client, user=user, name=name, color=color, can_edit=can_edit)
    room = collab.join(ws, page_id, peer)
    await sock.send_text(json.dumps({"t": "hello", "client": client, "color": color, "seq": seq,
                                     "peers": room.presence()}))
    await room.broadcast(json.dumps({"t": "join", "peer": peer.public()}), exclude=client)
    try:
        while True:
            msg = await sock.receive_json()
            if not isinstance(msg, dict):
                continue
            if msg.get("t") == "cursor":
                peer.block = str(msg.get("block") or "")[:64]
                peer.anchor = int(msg.get("anchor", -1)) if msg.get("anchor") is not None else -1
                peer.head = int(msg.get("head", -1)) if msg.get("head") is not None else -1
                await room.broadcast(json.dumps({
                    "t": "cursor", "client": client, "block": peer.block,
                    "anchor": peer.anchor, "head": peer.head}), exclude=client)
    except (WebSocketDisconnect, RuntimeError, ValueError, TypeError):
        pass
    finally:
        # Announce through publish (its own task on the loop), never by
        # awaiting here: a handler being torn down may be inside a cancelled
        # scope, and a cancelled send would leave the others with a ghost peer.
        collab.leave(room, client)
        collab.publish(ws, page_id, {"t": "leave", "client": client})

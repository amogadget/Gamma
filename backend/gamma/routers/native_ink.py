"""Native (iPad) annotation endpoints: ``/api/assets`` plus the ink,
replay-preview, audio and note block writers.

These are the routes the native client speaks; the upstream handwriting
feature keeps its own route untouched (``gamma/routers/ink.py`` —
``POST /api/upload-ink``, ``properties.ink_url``). Everything shared by the two —
the payload schemas, the asset store and the reserved-property rules — lives in
``gamma/native_ink.py``, including the explicit per-endpoint permission rules.

Two upstream invariants drive the shape of every writer here, and are the whole
reason this is not a copy of the standalone version:

- **Workspace scope.** The workspace comes from ``require_ws_writer`` /
  ``resolve_ws`` (``?ws=`` / ``X-Gamma-Workspace`` / the account's default), and
  every path — ``pages.db``, ``uploads/`` — is that workspace's. ``?user=`` is
  never read. An edit share (``?share=``) may write, but only inside its own
  page (``share_scope_page``); a view share, a viewer and an anonymous visitor
  are refused.
- **One block write path.** A save is one batch of ``gamma/ops.py`` ops applied
  under the workspace's write lock: the validation, the CAS check and the write
  happen in ONE transaction (so ``expected_revision`` cannot be raced), the
  page logs a ``page_ops`` row, and ``after_commit`` fans the batch out to the
  page's collaboration room and sweeps orphaned uploads. Web clients that have
  the page open see a native annotation appear live, exactly as they see any
  other edit.

``allow_native=True`` on those batches is what lets these endpoints write the
reserved properties that a generic writer is refused (``native_ink.py``); it is
a server-side argument, never something a request can set, so a client cannot
borrow it over the page-ops endpoint.
"""

import json

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from ..auth import require_ws_writer, resolve_ws, share_scope_page
from ..blocks_store import BLOCK_COLUMNS, block_to_dict, page_root_id
from ..db import connect_pages_db
from ..native_ink import (
    ASSET_CONTENT_TYPES,
    ASSET_MAX_BYTES,
    AUDIO_REF_RE,
    AudioSave,
    InkSave,
    NativeAssetError,
    NativeAssetInvalid,
    NativeAssetMissing,
    NativeNoteSave,
    ReplayAsset,
    ReplayPreviewSave,
    asset_path,
    asset_ref,
    is_canonical_uuid,
    load_replay,
    png_dimensions,
    replay_source_digest,
    store_asset,
)
from ..ops import OpError, after_commit, apply_ops, props_patch

router = APIRouter(prefix="/api", tags=["ink"])

# Served media type per stored extension. PKDrawing stays opaque binary: the
# server neither decodes nor labels Apple's serialization as anything else.
ASSET_MEDIA_TYPES = {
    "png": "image/png",
    "m4a": "audio/mp4",
    "inkjson": "application/json",
    "pkdrawing": "application/octet-stream",
}


def block_row(conn, block_id: str):
    return conn.execute(
        f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()


def current_block(conn, block_id: str) -> tuple[dict | None, dict]:
    """``(block, properties)`` of an existing block, else ``(None, {})``."""
    row = block_row(conn, block_id)
    if row is None:
        return None, {}
    return block_to_dict(row), json.loads(row[4] or "{}")


def require_pdf_page(conn, parent_id: str) -> str:
    """The parent must be an existing top-level Gamma PDF page — the same
    anchor every annotation kind hangs from. Returns its id (itself)."""
    row = conn.execute("SELECT parent_id, properties FROM unified_blocks WHERE id = ?",
                       (parent_id,)).fetchone()
    if not row:
        raise HTTPException(404, "parent block not found")
    if row[0] != "root" or not json.loads(row[1] or "{}").get("doc_id"):
        raise HTTPException(409, "parent must be an existing Gamma PDF page")
    return parent_id


def request_page_scope(request: Request, page_id: str) -> str | None:
    """The share scope of the request, after checking this page is inside it.

    A share token names one page; an edit share may annotate that page and
    nothing else. Full-access members get None."""
    scope = share_scope_page(request)
    if scope is not None and scope != page_id:
        raise HTTPException(403, "not accessible via this share link")
    return scope


def require_uuid(block_id: str, what: str = "block_id") -> None:
    if not is_canonical_uuid(block_id):
        raise HTTPException(422, f"{what} must be a canonical lowercase UUID")


def require_asset(ws: str, ref: str, missing: str) -> None:
    """The referenced file must already be stored (clients upload bytes first,
    then save the block; on 404 they re-upload)."""
    try:
        path = asset_path(ws, ref.rsplit("/", 1)[-1])
    except NativeAssetError:
        raise HTTPException(404, missing)
    if not path.is_file():
        raise HTTPException(404, missing)


def read_replay(ws: str, ref: str) -> ReplayAsset:
    try:
        return load_replay(ws, ref)
    except NativeAssetMissing as e:
        raise HTTPException(404, str(e))
    except NativeAssetInvalid as e:
        raise HTTPException(400, str(e))


def commit_native_batch(ws: str, conn, page_id: str, ops: list[dict], request: Request, scope: str | None) -> dict:
    """Apply one native batch through the shared write path: one transaction,
    one op-log row, the page's room notified, orphans swept."""
    try:
        result = apply_ops(conn, page_id, ops, actor=request.state.user or "",
                           client="native", share_scoped=scope is not None, allow_native=True)
    except OpError as e:
        raise HTTPException(e.status, e.detail)
    return after_commit(ws, conn, result)


# --- assets -------------------------------------------------------------------


@router.post("/assets")
def upload_asset(request: Request, file: UploadFile = File(...)):
    """Store one native asset under its full sha256 (``NATIVE_ASSET_NAME_RE``).

    Multipart ``file``. ``.pkdrawing`` accepts ``application/octet-stream`` or
    ``application/x-pkdrawing`` and is opaque (Linux cannot validate Apple's
    serialization, and pretending to would be a lie); ``.png`` requires
    ``image/png`` and a structurally valid PNG; ``.m4a`` requires ``audio/mp4``
    or ``audio/x-m4a`` and a plausible ISO-BMFF ``ftyp`` box (audio stays
    opaque — decoding happens on the client); ``.inkjson`` requires
    ``application/json`` and the strict ``gamma-ink-replay-v1`` schema.

    → ``{filename, url, size, already_existed}``, URL ``/api/assets/<filename>``
    (also readable through ``/api/uploads/<filename>``). Re-uploading stored
    bytes adds no quota. Native files are never auto-swept. Requires an editor
    or owner of the resolved workspace (or an edit share); the bytes land in
    that workspace's uploads directory and count against its quota."""
    ws = require_ws_writer(request)
    name = file.filename or ""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if ext not in ASSET_CONTENT_TYPES or content_type not in ASSET_CONTENT_TYPES[ext]:
        raise HTTPException(400, "only PNG, PKDrawing, M4A, or ink replay assets are supported")
    # Bounded read: an oversized body is refused without being buffered whole.
    contents = file.file.read(ASSET_MAX_BYTES + 1)
    if len(contents) > ASSET_MAX_BYTES:
        raise HTTPException(413, "asset too large")
    if not contents:
        raise HTTPException(400, "empty asset")
    if ext == "inkjson":
        try:
            ReplayAsset.model_validate(json.loads(contents.decode("utf-8")))
        except (UnicodeDecodeError, ValueError, TypeError):
            raise HTTPException(400, "invalid ink replay JSON")
    elif ext == "m4a":
        if len(contents) < 16 or contents[4:8] != b"ftyp":
            raise HTTPException(400, "invalid M4A (missing ftyp)")
    elif ext == "png":
        try:
            png_dimensions(contents)
        except ValueError:
            raise HTTPException(400, "invalid PNG")
    try:
        filename, already_existed = store_asset(ws, contents, ext)
    except NativeAssetError as e:
        raise HTTPException(400, str(e))
    return {"filename": filename, "url": asset_ref(filename),
            "size": len(contents), "already_existed": already_existed}


def asset_response(filename: str, request: Request) -> FileResponse:
    """Serve a stored native asset, or raise the right refusal.

    The workspace is the request's (a share token resolves to its own); for a
    ``?share=`` request the asset must additionally be referenced inside that
    share's page subtree, so a token cannot walk the rest of the workspace by
    guessing content hashes. Private caching on purpose: the bytes are the
    user's, and the legacy ``/api/uploads`` policy (a month, public) is for
    content-addressed files every member may already fetch.

    Shared by ``GET /api/assets/{filename}`` and the ``/api/uploads/{filename}``
    alias, so both names answer with identical bytes and headers."""
    ws = resolve_ws(request)
    scope_page_id = share_scope_page(request)
    try:
        path = asset_path(ws, filename)
    except NativeAssetError:
        raise HTTPException(404, "asset not found")
    if scope_page_id is not None and not asset_in_page(ws, scope_page_id, filename):
        raise HTTPException(404, "asset not found")
    if not path.is_file():
        raise HTTPException(404, "asset not found")
    ext = filename.rsplit(".", 1)[-1]
    return FileResponse(path, media_type=ASSET_MEDIA_TYPES.get(ext, "application/octet-stream"), headers={
        "Cache-Control": "private, no-cache",
        "Vary": "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": f'inline; filename="{filename}"',
    })


def asset_in_page(ws: str, page_id: str, filename: str) -> bool:
    """Match an explicit asset URL, not a pasted filename or digest alone."""
    native_ref = f"%/api/assets/{filename}%"
    upload_ref = f"%/api/uploads/{filename}%"
    with connect_pages_db(ws) as conn:
        row = conn.execute(
            "WITH RECURSIVE subtree AS ("
            "  SELECT id, content, properties FROM unified_blocks WHERE id = ?"
            "  UNION ALL"
            "  SELECT b.id, b.content, b.properties FROM unified_blocks b"
            "    JOIN subtree s ON b.parent_id = s.id"
            ") SELECT 1 FROM subtree WHERE content LIKE ? OR properties LIKE ? "
            "OR content LIKE ? OR properties LIKE ? LIMIT 1",
            (page_id, native_ref, native_ref, upload_ref, upload_ref)).fetchone()
    return row is not None


# GET and HEAD, like the uploads route: a client asks HEAD for an asset's size
# (and content type) before fetching it, and FileResponse answers a HEAD with
# the headers alone.
@router.api_route("/assets/{filename}", methods=["GET", "HEAD"])
def get_asset(filename: str, request: Request):
    """One stored native asset. A workspace member (any role) may read it; with
    ``?share=`` the file must belong to the shared page's subtree. 401 without a
    session, 403 for a share that does not permit this viewer, 404 when the
    asset does not exist or is out of the share's scope. ``/api/uploads/<same
    name>`` answers identically."""
    return asset_response(filename, request)


# --- ink ----------------------------------------------------------------------


@router.put("/blocks/{block_id}/ink")
def save_ink(block_id: str, payload: InkSave, request: Request):
    """Create or update one native PencilKit annotation block.

    Idempotent by construction: an exact replay of the stored payload returns
    the current block WITHOUT incrementing ``ink_revision`` — even when its
    ``expected_revision`` is stale — so a client that lost the response can
    retry safely. Otherwise ``expected_revision`` (0 = create-only) must equal
    the stored ``ink_revision`` or the save is refused with 409 and
    ``{message, current_revision}``; without it, the save is last-write-wins.

    ``parent_id`` names the anchoring PDF page. Existing annotations may be
    nested anywhere within that page by the outliner: updates verify page
    membership and preserve the actual parent instead of moving the block.
    Updates preserve content, children, order, the creation timestamp and
    unrelated properties; the recorded geometry is replaced as a whole. An
    omitted ``replay_asset`` keeps the stored replay only when the drawing is
    unchanged (a new drawing invalidates it); explicit ``null`` clears it.
    Assets must already be uploaded (404 otherwise), and a replay's
    ``source_sha256`` must match the drawing's digest.

    → the ordinary full block (``{id, parent_id, position, content, properties,
    created_at, updated_at}``) with ``type: "pdf_ink"``, the payload fields and
    ``ink_revision`` starting at 1. Writes are one ops batch, so the page's
    room sees the annotation immediately."""
    require_uuid(block_id)
    ws = require_ws_writer(request)
    ink = payload.model_dump(exclude={"parent_id", "expected_revision", "replay_asset"})
    if "replay_asset" in payload.model_fields_set:
        ink["replay_asset"] = payload.replay_asset
    ink["type"] = "pdf_ink"
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        page_id = require_pdf_page(conn, payload.parent_id)
        scope = request_page_scope(request, page_id)
        existing, props = current_block(conn, block_id)
        revision = props.get("ink_revision", 0)
        if existing:
            if (page_root_id(conn, block_id) != page_id or props.get("type") != "pdf_ink"
                    or props.get("pdf_page") != payload.pdf_page
                    or not isinstance(revision, int) or isinstance(revision, bool) or revision < 1
                    or any(props.get(key) for key in
                           ("highlight_id", "link_url", "link_page_id", "doc_id"))):
                raise HTTPException(409, "block ID belongs to another block or annotation scope")
            if "replay_asset" not in payload.model_fields_set:
                ink["replay_asset"] = (props.get("replay_asset")
                                       if props.get("ink_asset") == payload.ink_asset else None)
            if all(props.get(key) == value for key, value in ink.items()):
                return existing  # lost-response retry: no new revision, no new timestamp
        if payload.expected_revision is not None and payload.expected_revision != revision:
            raise HTTPException(409, {"message": "ink revision conflict",
                                      "current_revision": revision})
        require_asset(ws, payload.ink_asset,
                       "asset not found; upload assets before saving ink")
        require_asset(ws, payload.preview_asset,
                       "asset not found; upload assets before saving ink")
        replay_ref = ink.get("replay_asset")
        if replay_ref:
            replay = read_replay(ws, replay_ref)
            if replay.source_sha256 != replay_source_digest(payload.ink_asset):
                raise HTTPException(422, "replay asset source digest does not match ink asset")
        new_props = {**props, **ink}
        if new_props.get("replay_asset") is None:
            new_props.pop("replay_asset", None)
        new_props["ink_revision"] = revision + 1
        if existing:
            ops = [{"op": "set", "id": block_id, "props": props_patch(props, new_props)}]
        else:
            # A new annotation appends, with empty content, like any other
            # server-created block.
            ops = [{"op": "insert", "id": block_id, "parent": payload.parent_id,
                    "content": "", "props": new_props}]
        commit_native_batch(ws, conn, page_id, ops, request, scope)
        row = block_row(conn, block_id)
    return block_to_dict(row)


@router.put("/blocks/{block_id}/replay-preview")
def save_replay_preview(block_id: str, payload: ReplayPreviewSave, request: Request):
    """Attach a replay generated later to an existing ink annotation.

    Only ``{ink_asset, replay_asset}``. The block must already be a ``pdf_ink``
    block and ``ink_asset`` must be its CURRENT drawing, so a late replay can
    never be attached to a redrawn annotation; the replay's ``source_sha256``
    must match that drawing. Nothing but ``replay_asset`` is touched —
    ``ink_revision``, content, children and other properties are unchanged —
    and re-sending the attached reference is a no-op that returns the block."""
    require_uuid(block_id)
    ws = require_ws_writer(request)
    expected_source = replay_source_digest(payload.ink_asset)
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing, props = current_block(conn, block_id)
        if existing is None:
            raise HTTPException(404, "ink block not found")
        page_id = page_root_id(conn, block_id)
        if not page_id:
            raise HTTPException(404, "ink block not found")
        scope = request_page_scope(request, page_id)
        if props.get("type") != "pdf_ink":
            raise HTTPException(409, "block is not a PDF ink annotation")
        if props.get("ink_asset") != payload.ink_asset:
            raise HTTPException(409, "ink source does not match current annotation")
        replay = read_replay(ws, payload.replay_asset)
        if replay.source_sha256 != expected_source:
            raise HTTPException(409, "replay asset source digest does not match ink asset")
        if props.get("replay_asset") == payload.replay_asset:
            return existing
        commit_native_batch(ws, conn, page_id,
                [{"op": "set", "id": block_id, "props": {"replay_asset": payload.replay_asset}}],
                request, scope)
        row = block_row(conn, block_id)
    return block_to_dict(row)


# --- audio --------------------------------------------------------------------


@router.put("/blocks/{block_id}/audio")
def save_audio(block_id: str, payload: AudioSave, request: Request):
    """Create or update one native recording block (audio is a block of its
    own, not one per stroke).

    ``segments`` is the client's own list — canonical UUID, a local
    ``/api/assets/<64hex>.m4a`` reference and a positive duration, at most 24
    hours and 1,000 segments in total. The server derives each segment's
    cumulative ``start_time`` and the block's ``duration``.

    ``replay_events`` is optional for compatibility: omitting it preserves a
    stored timeline, explicit ``[]`` clears it. Every event needs a unique
    canonical UUID, a ``segment_id`` from this same payload, ``end >= start``
    and a positive ``pdf_page``; ``stroke`` events also need ``block_id`` and
    ``stroke_id``, ``note`` events a ``block_id``, ``page`` events neither.
    Block references are WEAK: the server neither resolves nor discloses
    another workspace's data through them.

    Idempotency and ``expected_revision`` follow the ink endpoint, comparing
    the client-owned segment fields (and the timeline when one is sent) so an
    exact retry after the first save stays a no-op. → the full block with
    ``type: "audio"``, ``audio_revision``, ``audio_state``, ``segments``,
    ``duration`` and, when sent, ``replay_events``."""
    require_uuid(block_id)
    ws = require_ws_writer(request)
    ids = [s.id for s in payload.segments]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, "audio segment IDs must be unique")
    if any(not is_canonical_uuid(sid) for sid in ids):
        raise HTTPException(422, "segment IDs must be canonical lowercase UUIDs")
    total = sum(s.duration for s in payload.segments)
    if total > 24 * 60 * 60:
        raise HTTPException(422, "audio duration exceeds 24 hour limit")
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        page_id = require_pdf_page(conn, payload.parent_id)
        scope = request_page_scope(request, page_id)
        existing, props = current_block(conn, block_id)
        revision = props.get("audio_revision", 0)
        if existing and (page_root_id(conn, block_id) != page_id or props.get("type") != "audio"
                         or not isinstance(revision, int) or isinstance(revision, bool)
                         or revision < 1):
            raise HTTPException(409, "block ID belongs to another block or audio scope")
        incoming = [{"id": s.id, "asset": s.asset, "duration": s.duration}
                    for s in payload.segments]
        incoming_replay = ([event.model_dump(exclude_none=True) for event in payload.replay_events]
                           if payload.replay_events is not None else None)
        old_segments = props.get("segments", [])
        # Stored segments carry the derived start_time, so only the client-owned
        # fields are compared: an exact retry stays idempotent after the first
        # save. An omitted replay_events field is an old client and preserves
        # the stored timeline.
        comparable_old = [{k: s.get(k) for k in ("id", "asset", "duration")}
                          for s in old_segments if isinstance(s, dict)]
        timeline_same = (incoming_replay is None or props.get("replay_events", []) == incoming_replay)
        if existing and props.get("audio_state") == payload.audio_state \
                and comparable_old == incoming and timeline_same:
            return existing
        if payload.expected_revision is not None and payload.expected_revision != revision:
            raise HTTPException(409, {"message": "audio revision conflict",
                                      "current_revision": revision})
        for seg in payload.segments:
            if not AUDIO_REF_RE.fullmatch(seg.asset):
                raise HTTPException(422, "expected a local M4A asset URL")
            require_asset(ws, seg.asset,
                          "audio asset not found; upload assets before saving audio")
        start = 0.0
        segments = []
        for seg in payload.segments:
            segments.append({"id": seg.id, "asset": seg.asset,
                             "duration": seg.duration, "start_time": start})
            start += seg.duration
        new_props = {**props, "type": "audio", "audio_revision": revision + 1,
                     "audio_state": payload.audio_state, "segments": segments, "duration": total}
        if payload.replay_events is not None:
            new_props["replay_events"] = incoming_replay
        if existing:
            ops = [{"op": "set", "id": block_id, "props": props_patch(props, new_props)}]
        else:
            ops = [{"op": "insert", "id": block_id, "parent": payload.parent_id,
                    "content": "", "props": new_props}]
        commit_native_batch(ws, conn, page_id, ops, request, scope)
        row = block_row(conn, block_id)
    return block_to_dict(row)


# --- native notes -------------------------------------------------------------


def _note_anchor(conn, block_id: str, parent_id: str) -> str:
    """Walk from ``parent_id`` up to the ink annotation this note belongs to,
    returning the ink block's page id.

    Only a bounded chain of marked native notes may lead to an ink block:
    plain text blocks, cycles, detached ink and non-PDF roots are refused, so a
    note can never take ownership of an unrelated block's UUID."""
    ancestor_id = parent_id
    seen = {block_id}
    for depth in range(64):
        if ancestor_id in seen:
            raise HTTPException(409, "invalid note ancestor cycle")
        seen.add(ancestor_id)
        ancestor = conn.execute("SELECT parent_id, properties FROM unified_blocks WHERE id = ?",
                                (ancestor_id,)).fetchone()
        if not ancestor:
            raise HTTPException(404 if depth == 0 else 409, "note ancestor not found")
        ancestor_props = json.loads(ancestor[1] or "{}")
        if ancestor_props.get("type") == "pdf_ink":
            # The outliner may nest the ink group within its PDF page. Notes
            # still belong to that group, not to its immediate visual parent.
            page_id = page_root_id(conn, ancestor_id)
            page = conn.execute("SELECT parent_id, properties FROM unified_blocks WHERE id = ?",
                                (page_id,)).fetchone() if page_id else None
            if not page or page[0] != "root" or not json.loads(page[1] or "{}").get("doc_id"):
                raise HTTPException(409, "ink ancestor must belong to a Gamma PDF page")
            return page_id
        if (ancestor_props.get("native_note") is not True
                or any(ancestor_props.get(key) for key in
                       ("type", "highlight_id", "link_url", "link_page_id", "doc_id"))):
            raise HTTPException(409, "parent must be ink or a native note beneath ink")
        ancestor_id = ancestor[0]
    raise HTTPException(409, "note nesting limit exceeded")


@router.put("/blocks/{block_id}/note")
def save_native_note(block_id: str, payload: NativeNoteSave, request: Request):
    """Idempotent native child-note upsert — the durable outbox path for notes
    written offline against an annotation.

    ``parent_id`` must be an existing ``pdf_ink`` block or a ``native_note:``
    descendant of one, within 64 levels, no cycles, no plain-text intermediary.
    Creates with ``{native_note: true, note_revision: 1}``; an unchanged
    content replay returns the block; ``expected_revision`` otherwise gates the
    write (a conflict returns 409 with ``{message, current_revision}``).
    Updates preserve children and other properties, and the block stays an
    ordinary Gamma block — its own note children included.

    A Web text edit of the same block also moves ``note_revision``
    (``gamma/ops.py``), so a queued save computed against the old revision
    conflicts instead of overwriting it."""
    require_uuid(block_id)
    ws = require_ws_writer(request)
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        page_id = _note_anchor(conn, block_id, payload.parent_id)
        scope = request_page_scope(request, page_id)
        existing, props = current_block(conn, block_id)
        revision = props.get("note_revision", 0)
        if existing:
            if (existing["parent_id"] != payload.parent_id or props.get("native_note") is not True
                    or not isinstance(revision, int) or isinstance(revision, bool) or revision < 1
                    or any(props.get(key) for key in
                           ("type", "highlight_id", "link_url", "link_page_id", "doc_id"))):
                raise HTTPException(409, "block ID belongs to another block or note scope")
            if existing["content"] == payload.content:
                return existing
        if payload.expected_revision is not None and payload.expected_revision != revision:
            raise HTTPException(409, {"message": "note revision conflict",
                                      "current_revision": revision})
        new_props = {**props, "native_note": True, "note_revision": revision + 1}
        if existing:
            ops = [{"op": "set", "id": block_id, "content": payload.content,
                    "props": props_patch(props, new_props)}]
        else:
            ops = [{"op": "insert", "id": block_id, "parent": payload.parent_id,
                    "content": payload.content, "props": new_props}]
        commit_native_batch(ws, conn, page_id, ops, request, scope)
        row = block_row(conn, block_id)
    return block_to_dict(row)

"""Block operations — THE write path for a page's blocks.

A page's notes change through small, typed operations rather than a whole-
tree replace, so several clients (two browsers of one account, share editors)
can edit one page at once and only the touched rows move:

- ``set {id, content?, base?, props?}`` — ``content`` replaces the text;
  with ``base`` (the text the client's change was computed from) it is
  applied as a patch when the block changed meanwhile, so two people
  editing different spans of one block both keep their edit
  (gamma/textmerge.py; the applied op carries the merged text). ``props``
  is a PATCH (``{key: value | null}``, null deletes), so unrelated
  properties never conflict (Figma's property-level rule).
- ``insert {id, parent, position?, content, props}`` — the client mints the
  id and the fractional position; a position that collides with a sibling is
  re-keyed here and the applied op carries the final value. Re-inserting a
  known id (a retried batch) is a move + set, never an error.
- ``move {id, parent, position?}`` — cycle-checked, same collision rule.
- ``delete {id}`` — the subtree.

Every touched block (and every insert parent) must be inside the page; the
page root may only be ``set`` (a share editor: content only — rename — never
its properties), never moved or deleted. Only touched rows get
``updated_at``; the page root is stamped once per batch (home-feed order,
the notes index fingerprint). One batch is one transaction and one row of
the per-page op log (``page_ops``, ``seq`` counting up per page) — live
clients follow the log over the page's websocket (gamma/collab.py), a
reconnecting one reads it back with ``ops_since``.

``ws`` everywhere below is the workspace id (docs/dev/workspaces.md), ``actor``
the account making the change. Server-side writers (the block endpoints, AI
tools, page rename/attach, metadata, the native iPad endpoints) go through
``apply_ops`` too, so everything a page's viewers see
comes from one code path and one log.

Native annotations (``gamma/native_ink.py``) are ordinary blocks with reserved
properties, so their fields are guarded HERE, on the single write path: a
generic ``set.props`` may not touch them (409), a generic insert may not invent
them, and a Web text edit of a native note moves ``note_revision`` so a queued
offline save conflicts instead of overwriting it. The native endpoints
themselves pass ``allow_native=True`` — a server-side argument, never a request
field — which is what distinguishes an authorized native write from a client
op trying the same patch.

**Restoring a deleted native block.** The guard would otherwise make the Web's
own Ctrl+Z impossible: an undo re-inserts the block it deleted, payload and
all, and once the delete has committed there is no row left to compare against
(``_Batch.native_safe_props``). So a delete RECORDS what it removed — for the
native rows only, the id, text and properties, attached to the delete entry in
this page's own op log (``{"op": "delete", "id": X, "deleted": [...]}``,
``_Batch.delete``). A later generic insert of the same id in the same page is
checked against that record (``_Batch.recorded_deletion`` →
``native_ink.restored_native_properties``): the writer must reproduce the
recorded payload exactly, and what the server stores comes from the RECORD, so a
restore can never mint a manifest, an asset set or a new revision. No record
means no restore — an invented id, another page, another workspace and a
different payload are all still 409, which is the forgery rule above, unchanged.

This is the Web undoing its own deletion, not a general resurrection: the native
write endpoints never consult the record, so a queued iPad update of a block
somebody deleted on purpose stays what it is — a revision conflict
(``routers/native_ink.py``).

The record is provenance, not history for readers: ``_wire_ops`` strips it from
the HTTP response, the room fan-out and ``ops_since``, so clients (and a share
viewer who joins after the deletion) see exactly the ``{"op": "delete", "id"}``
they always saw. Its lifetime is the page's op log and nothing more: a page keeps
``KEEP_OPS`` batches (``PRUNE_EVERY`` between prune checks), so a RESTORE ONLY
WORKS WHILE THE DELETION IS STILL IN THAT WINDOW. A page under heavy editing
reaches the bound, and the older half of a long session's undo stack then gets a
409 instead of restoring — which is why this is a best-effort recovery of the
recent past, not a guarantee (docs/dev/collab.md).
"""

import json
import re
import sqlite3
from typing import Annotated, Literal, Union

from fractional_indexing import FIError, generate_key_between, validate_order_key
from pydantic import BaseModel, Field

from . import block_index, collab, textmerge
from .blocks_store import delete_subtree, fetch_subtree, last_child_position
from .db import connect_pages_db, page_now, ws_uploads_dir
from .native_ink import (
    NativeScopeError,
    guard_generic_insert,
    guard_generic_update,
    native_claim_keys,
    native_kind,
    note_revision_bump,
    preserve_native_properties,
    restored_native_properties,
)
from .storage import cleanup_orphan_uploads

MAX_OPS = 500
MAX_CONTENT = 200_000
KEEP_OPS = 2000      # log rows kept per page
PRUNE_EVERY = 64     # prune check cadence (every Nth seq)
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# A block's text/properties reference an uploaded file under one of two URL
# forms: /api/uploads/<name> for everything the app writes, /api/assets/<name>
# for native annotations (also readable under /api/uploads). Both mean "this
# file is still referenced", so the orphan sweep must consider both.
_UPLOAD_REF_MARKERS = ("/api/uploads/", "/api/assets/")


def _mentions_upload(text: str | None) -> bool:
    """Does this content/properties blob reference an uploaded file?"""
    return any(marker in (text or "") for marker in _UPLOAD_REF_MARKERS)


def _deleted_native_snapshot(row) -> dict | None:
    """The provenance a delete records for one removed row, or None.

    ``row`` is a ``fetch_subtree`` row (``blocks_store.BLOCK_COLUMNS`` order).
    Only a block whose properties claim a native payload is recorded: those are
    the blocks a generic insert may not otherwise re-create, so they are the
    only ones a restore has to be able to prove. The snapshot is built from the
    DATABASE row that is about to be deleted, never from request data."""
    try:
        props = json.loads(row[4] or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(props, dict) or native_kind(props) is None:
        return None
    return {"id": row[0], "parent": row[1], "content": row[3] or "", "properties": props}


def _recorded_deletion(conn, page_id: str, block_id: str) -> dict | None:
    """The newest deletion of ``block_id`` this PAGE's log recorded, or None.

    Server-internal on purpose, and deliberately not a general "resurrect this
    id" primitive: it serves the one generic write that undoes the Web's own
    deletion. The native write endpoints do NOT consult it, because a queued
    iPad update of a block somebody deleted on purpose must stay an explicit
    revision conflict — a stale client may not silently bring an annotation
    back (``routers/native_ink.py``'s CAS, unchanged).

    The match is exact, and it is finished in SQL: the newest log row holding a
    ``delete`` entry whose recorded snapshot carries this id (``deleted[].id``).
    A row that merely *mentions* the id — a note quoting it, an audio
    manifest's ``replay_events[].block_id``, a property value — can neither
    satisfy it nor push the real record out of a window, because there is no
    window: the walk is bounded by the page's log itself (``KEEP_OPS`` rows,
    a couple of milliseconds for a full walk at that bound on the dev machine,
    and usually the first row checked)."""
    try:
        rows = conn.execute(
            "SELECT je.value FROM page_ops po, json_each(po.ops) AS je "
            "WHERE po.page_id = ? "
            "  AND json_extract(je.value, '$.op') = 'delete' "
            "  AND EXISTS (SELECT 1 FROM json_each(json_extract(je.value, '$.deleted')) AS d "
            "              WHERE json_extract(d.value, '$.id') = ?) "
            "ORDER BY po.seq DESC LIMIT 1",
            (page_id, block_id)).fetchall()
    except sqlite3.OperationalError as e:
        # A log row nothing we wrote produced (a hand-edited or foreign
        # pages.db) cannot be read as JSON. "No record" is the fail-closed
        # answer: the insert is then refused like any other unrecorded one.
        if "malformed JSON" not in str(e):
            raise
        return None
    for (raw,) in rows:
        try:
            entry = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(entry, dict):
            continue
        for snap in entry.get("deleted") or ():
            if (isinstance(snap, dict) and snap.get("id") == block_id
                    and isinstance(snap.get("properties"), dict)):
                return snap
    return None


def _wire_ops(applied: list) -> list:
    """The ops as CLIENTS receive them: a delete's restore provenance stays in
    the page's own log, never in a response, a socket message or a catch-up
    batch. Every other op passes through untouched."""
    return [{k: v for k, v in op.items() if k != "deleted"}
            if isinstance(op, dict) and "deleted" in op else op
            for op in applied]


class OpError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class SetOp(BaseModel):
    op: Literal["set"]
    id: str
    content: str | None = None
    base: str | None = None  # the text `content` was edited from (three-way merge)
    props: dict | None = None


class InsertOp(BaseModel):
    op: Literal["insert"]
    id: str
    parent: str
    position: str | None = None
    content: str = ""
    props: dict = Field(default_factory=dict)


class MoveOp(BaseModel):
    op: Literal["move"]
    id: str
    parent: str
    position: str | None = None


class DeleteOp(BaseModel):
    op: Literal["delete"]
    id: str


Op = Annotated[Union[SetOp, InsertOp, MoveOp, DeleteOp], Field(discriminator="op")]


class CursorState(BaseModel):
    """The writer's caret at the moment it sent the batch (see collab.py)."""
    block: str = ""
    anchor: int = -1
    head: int = -1


class OpsRequest(BaseModel):
    client: str = ""
    ops: list[Op]
    cursor: CursorState | None = None


def props_patch(old: dict, new: dict) -> dict:
    """The ``set.props`` patch turning ``old`` into ``new`` (keys gone from
    ``new`` become null). Lets writers that compute a full property dict
    express it as an op."""
    patch = {k: v for k, v in new.items() if old.get(k) != v or k not in old}
    for k in old:
        if k not in new:
            patch[k] = None
    return patch


class _Batch:
    """One apply_ops call: the page, the timestamp, an ancestry cache."""

    def __init__(self, conn, page_id: str, now: str, share_scoped: bool, cursor: dict | None = None,
                 allow_native: bool = False):
        self.conn = conn
        self.page_id = page_id
        self.now = now
        self.share_scoped = share_scoped
        self.cursor = cursor  # the writer's caret, remapped when its block's text is merged
        # Server-authoritative: the native annotation endpoints own the reserved
        # properties (gamma/native_ink.py). Never read from a request.
        self.allow_native = allow_native
        self._page_of: dict[str, str | None] = {page_id: page_id}
        self.applied: list[dict] = []
        self.deleted: list[str] = []
        self.sweep = False  # an upload reference may have gone away

    def page_of(self, block_id: str) -> str | None:
        """The page a block lives in (None: unknown block). Memoized per
        batch — walks parent links, one query per unseen level."""
        chain = []
        cur = block_id
        while cur not in self._page_of:
            row = self.conn.execute(
                "SELECT parent_id FROM unified_blocks WHERE id = ?", (cur,)).fetchone()
            if not row:
                self._page_of[cur] = None
                break
            chain.append(cur)
            if row[0] in (None, "root"):
                self._page_of[cur] = cur
                break
            cur = row[0]
        page = self._page_of[cur]
        for b in chain:
            self._page_of[b] = page
        return page

    def require_in_page(self, block_id: str, what: str = "block") -> None:
        page = self.page_of(block_id)
        if page is None:
            raise OpError(404, f"no such {what}: {block_id}")
        if page != self.page_id:
            raise OpError(403, f"{what} {block_id} is outside this page")

    def free_position(self, parent: str, position: str | None, block_id: str) -> str:
        if position is None:
            return generate_key_between(last_child_position(self.conn, parent), None)
        try:
            validate_order_key(position)
        except FIError as e:
            raise OpError(400, f"invalid position: {e}")
        clash = self.conn.execute(
            "SELECT 1 FROM unified_blocks WHERE parent_id = ? AND position = ? AND id != ?",
            (parent, position, block_id)).fetchone()
        if not clash:
            return position
        nxt = self.conn.execute(
            "SELECT MIN(position) FROM unified_blocks WHERE parent_id = ? AND position > ? AND id != ?",
            (parent, position, block_id)).fetchone()[0]
        return generate_key_between(position, nxt)

    def check_parent(self, parent: str, block_id: str | None) -> None:
        if parent == "root":
            raise OpError(403, "ops never create or move pages")
        self.require_in_page(parent, "parent")
        if block_id and (parent == block_id
                         or parent in {r[0] for r in fetch_subtree(self.conn, block_id)}):
            raise OpError(400, "cannot move a block into its own subtree")

    # --- the four ops --------------------------------------------------------

    def set(self, op: dict) -> None:
        block_id = op["id"]
        row = self.conn.execute(
            "SELECT content, properties FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        if not row:
            raise OpError(404, f"no such block: {block_id}")
        self.require_in_page(block_id)
        content, patch = op.get("content"), op.get("props")
        if content is None and patch is None:
            return
        if patch and block_id == self.page_id and self.share_scoped:
            raise OpError(403, "share editors cannot change page settings")
        if content is not None and len(content) > MAX_CONTENT:
            raise OpError(413, "content too long")
        base = op.get("base")
        if (content is not None and base is not None and len(base) <= MAX_CONTENT
                and base != (row[0] or "") and base != content):
            # Someone else changed the block since this client read it:
            # apply the client's edit as a patch on the current text.
            merged, _clean = textmerge.merge(base, content, row[0] or "")
            cur = self.cursor
            if cur and cur.get("block") == block_id and merged != content:
                cur["anchor"] = textmerge.map_offset(content, merged, cur.get("anchor", -1)) if cur.get("anchor", -1) >= 0 else -1
                cur["head"] = textmerge.map_offset(content, merged, cur.get("head", -1)) if cur.get("head", -1) >= 0 else -1
            content = merged
        props = json.loads(row[1] or "{}")
        if patch is not None and not self.allow_native:
            # Reserved native properties are owned by the ink/audio/note
            # endpoints: a web autosave must not overwrite a recording's
            # manifest or clear a replay (deletion counts too).
            try:
                guard_generic_update(props, patch)
            except NativeScopeError as e:
                raise OpError(409, str(e))
        echo = {"op": "set", "id": block_id}
        sets, values = ["updated_at = ?"], [self.now]
        if content is not None:
            sets.append("content = ?")
            values.append(content)
            echo["content"] = content
            # An explicit title write is user intent: drop the automatic-title
            # marker so a slow metadata lookup can't overwrite the rename.
            if props.pop("auto_title", None) is not None and not (patch and "auto_title" in patch):
                patch = {**(patch or {}), "auto_title": None}
            # A native note's text IS its native payload, so a Web edit moves
            # the revision the offline outbox compares against: a queued save
            # must conflict (409) instead of silently overwriting this edit.
            if props.get("native_note") is True and content != (row[0] or ""):
                try:
                    revision = note_revision_bump(props, content, row[0] or "")
                except NativeScopeError as e:
                    raise OpError(409, str(e))
                props["note_revision"] = revision
                patch = {**(patch or {}), "note_revision": revision}
            if _mentions_upload(row[0]) and content != row[0]:
                self.sweep = True
        if patch is not None:
            for k, v in patch.items():
                if v is None:
                    props.pop(k, None)
                else:
                    props[k] = v
            echo["props"] = patch
            if _mentions_upload(row[1]) or "doc_id" in patch:
                self.sweep = True
        sets.append("properties = ?")
        values.append(json.dumps(props))
        values.append(block_id)
        self.conn.execute(f"UPDATE unified_blocks SET {', '.join(sets)} WHERE id = ?", values)
        self.applied.append(echo)

    def recorded_deletion(self, block_id: str) -> dict | None:
        """The deletion record for ``block_id`` in THIS page (see
        ``_recorded_deletion``, which does the lookup — page-scoped, exact,
        bounded by this page's own log)."""
        return _recorded_deletion(self.conn, self.page_id, block_id)

    def native_safe_props(self, block_id: str, existing, content: str, props: dict) -> dict:
        """The props a generic insert/retry may store for ``block_id``.

        A block that already HAS a native payload keeps it — an insert that
        converges on an existing id (a retried batch, a client re-inserting a
        block) must not roll the annotation back to whatever copy the client
        happened to send. A brand-new block may not claim one either, with a
        single exception: an id THIS PAGE's log records as a deleted native
        block, which is the Web's Ctrl+Z re-inserting what it deleted. That
        restores the recorded payload (``native_ink.restored_native_properties``
        verifies it and decides what of the writer's own survives) instead of
        trusting the client's copy; everything else — including the same payload
        under an id no delete ever recorded — is still a forgery and 409."""
        if self.allow_native:
            return props
        if not existing:
            # Only a block CLAIMING a native payload needs the page's record: an
            # ordinary insert (no such key) is settled by the guard alone and
            # never reads the log.
            if native_claim_keys(props):
                snapshot = self.recorded_deletion(block_id)
                if snapshot is not None:
                    try:
                        return restored_native_properties(snapshot, props, content)
                    except NativeScopeError as e:
                        raise OpError(409, str(e))
            try:
                guard_generic_insert(props)
            except NativeScopeError as e:
                raise OpError(409, str(e))
            return props
        row = self.conn.execute(
            "SELECT content, properties FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        previous = json.loads(row[1] or "{}") if row else {}
        if native_kind(previous) is None:
            try:
                guard_generic_insert(props)
            except NativeScopeError as e:
                raise OpError(409, str(e))
            return props
        try:
            return preserve_native_properties(previous, row[0], props, content)
        except NativeScopeError as e:
            raise OpError(409, str(e))

    def insert(self, op: dict) -> None:
        block_id, parent = op["id"], op["parent"]
        if not _ID_RE.match(block_id or ""):
            raise OpError(400, f"invalid block id: {block_id!r}")
        content = op.get("content") or ""
        if len(content) > MAX_CONTENT:
            raise OpError(413, "content too long")
        existing = self.conn.execute(
            "SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        self.check_parent(parent, block_id if existing else None)
        position = self.free_position(parent, op.get("position"), block_id)
        props = self.native_safe_props(block_id, existing, content, op.get("props") or {})
        if existing:
            # A retried batch, or a client re-inserting a block it dropped
            # earlier: converge on the requested state instead of failing.
            self.require_in_page(block_id)
            if block_id == self.page_id:
                raise OpError(400, "the page itself cannot be inserted")
            self.conn.execute(
                "UPDATE unified_blocks SET parent_id = ?, position = ?, content = ?, "
                "properties = ?, updated_at = ? WHERE id = ?",
                (parent, position, content, json.dumps(props), self.now, block_id))
        else:
            self.conn.execute(
                "INSERT INTO unified_blocks (id, parent_id, position, content, properties, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (block_id, parent, position, content, json.dumps(props), self.now, self.now))
            self._page_of[block_id] = self.page_id
        self.applied.append({"op": "insert", "id": block_id, "parent": parent,
                             "position": position, "content": content, "props": props})

    def move(self, op: dict) -> None:
        block_id, parent = op["id"], op["parent"]
        self.require_in_page(block_id)
        if block_id == self.page_id:
            raise OpError(403, "the page itself cannot be moved")
        self.check_parent(parent, block_id)
        position = self.free_position(parent, op.get("position"), block_id)
        self.conn.execute(
            "UPDATE unified_blocks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?",
            (parent, position, self.now, block_id))
        self.applied.append({"op": "move", "id": block_id, "parent": parent, "position": position})

    def delete(self, op: dict) -> None:
        block_id = op["id"]
        page = self.page_of(block_id)
        if page is None:
            return  # already gone: a retried or concurrent delete
        if page != self.page_id:
            raise OpError(403, f"block {block_id} is outside this page")
        if block_id == self.page_id:
            raise OpError(403, "the page itself cannot be deleted through ops")
        rows = fetch_subtree(self.conn, block_id)
        ids = [r[0] for r in rows]
        # What this delete removes, for the native rows only: the provenance a
        # generic insert needs to undo it (module docstring). Read from the rows
        # themselves, before they go; a request can neither add to nor shape it.
        recorded = [snap for snap in (_deleted_native_snapshot(r) for r in rows) if snap]
        delete_subtree(self.conn, block_id)
        for i in ids:
            self._page_of[i] = None
        self.deleted.extend(ids)
        self.sweep = True
        entry = {"op": "delete", "id": block_id}
        if recorded:
            entry["deleted"] = recorded
        self.applied.append(entry)


def _log(conn, page_id: str, actor: str, client: str, now: str, applied: list) -> int:
    seq = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM page_ops WHERE page_id = ?", (page_id,)).fetchone()[0]
    conn.execute(
        "INSERT INTO page_ops (page_id, seq, actor, client, at, ops) VALUES (?, ?, ?, ?, ?, ?)",
        (page_id, seq, actor, client, now, json.dumps(applied)))
    if seq % PRUNE_EVERY == 0:
        conn.execute("DELETE FROM page_ops WHERE page_id = ? AND seq <= ?", (page_id, seq - KEEP_OPS))
    return seq


def apply_ops(conn, page_id: str, ops: list[dict], *, actor: str, client: str = "",
              share_scoped: bool = False, cursor: dict | None = None,
              allow_native: bool = False) -> dict:
    """Apply one batch inside one transaction (committed here) and log it.
    Returns ``{page_id, seq, at, actor, client, ops (as applied), deleted_ids,
    sweep, cursor?}`` — hand it to ``after_commit`` for the derived-data work
    and the room fan-out. ``cursor`` (``{block, anchor, head}``, the writer's
    caret in the text it sent) comes back remapped into the text actually
    stored when a merge changed it. Raises ``OpError`` (nothing written) on a
    bad op. ``allow_native`` (server-side writers only: the native annotation
    endpoints) permits the reserved native properties, which a generic patch
    is refused."""
    if not ops:
        raise OpError(400, "no ops")
    if len(ops) > MAX_OPS:
        raise OpError(413, f"too many ops in one batch (>{MAX_OPS})")
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")  # the write lock up front: seq is per page
    try:
        root = conn.execute(
            "SELECT parent_id FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
        if not root or root[0] != "root":
            raise OpError(404, "page not found")
        now = page_now()
        cursor = dict(cursor) if cursor else None
        batch = _Batch(conn, page_id, now, share_scoped, cursor, allow_native)
        for op in ops:
            kind = op.get("op")
            if kind == "set":
                batch.set(op)
            elif kind == "insert":
                batch.insert(op)
            elif kind == "move":
                batch.move(op)
            elif kind == "delete":
                batch.delete(op)
            else:
                raise OpError(400, f"unknown op: {kind!r}")
        conn.execute("UPDATE unified_blocks SET updated_at = ? WHERE id = ?", (now, page_id))
        seq = _log(conn, page_id, actor, client, now, batch.applied)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    result = {"page_id": page_id, "seq": seq, "at": now, "actor": actor, "client": client,
              "ops": _wire_ops(batch.applied), "deleted_ids": batch.deleted, "sweep": batch.sweep}
    if cursor is not None:
        result["cursor"] = cursor
    return result


def after_commit(ws: str, conn, result: dict) -> dict:
    """Derived data after a committed batch: the orphan-upload sweep when a
    reference may have gone, the data.db purge for deleted blocks, and the
    fan-out to the page's room. Adds ``removed_uploads`` to the result."""
    result["removed_uploads"] = (
        cleanup_orphan_uploads(conn, ws_uploads_dir(ws)) if result["sweep"] else [])
    if result["deleted_ids"]:
        block_index.purge_page_data(ws, conn, result["deleted_ids"])
    collab.publish_ops(ws, result)
    return result


def commit_ops(ws: str, page_id: str, ops: list[dict], *, actor: str, client: str = "",
               share_scoped: bool = False, cursor: dict | None = None,
               allow_native: bool = False) -> dict:
    """``apply_ops`` + ``after_commit`` on a fresh connection. ``cursor``
    (``{block, anchor, head}``): the writer's caret in the text the batch
    produces, fanned out with the batch so peers place it against the same
    text (a standalone presence message would reach them first, in
    offsets their copy doesn't have yet)."""
    with connect_pages_db(ws) as conn:
        result = apply_ops(conn, page_id, ops, actor=actor, client=client,
                           share_scoped=share_scoped, cursor=cursor,
                           allow_native=allow_native)
        return after_commit(ws, conn, result)


def record_ops(ws: str, conn, page_id: str, ops: list[dict], *, actor: str) -> int:
    """Log + publish ops a writer performed with its own SQL (a cross-page
    move, whose two halves are a delete on one page and an arrival on the
    other). Commits."""
    now = page_now()
    seq = _log(conn, page_id, actor, "", now, ops)
    conn.commit()
    collab.publish(ws, page_id, {"t": "ops", "seq": seq, "at": now, "actor": actor,
                                   "client": "", "ops": ops})
    return seq


def note_reload(ws: str, conn, page_id: str, actor: str) -> int:
    """``log_reload`` + commit + fan-out, for writers that rewrote a page's
    tree wholesale (the subtree replace, imports into an existing page)."""
    seq = log_reload(conn, page_id, actor)
    conn.commit()
    collab.publish_reload(ws, page_id, seq)
    return seq


def log_reload(conn, page_id: str, actor: str) -> int:
    """Log a change ops can't express (a subtree replace, an import into an
    existing page) so a catching-up client knows to refetch. Caller commits
    and publishes (``collab.publish_reload``)."""
    return _log(conn, page_id, actor, "", page_now(), [{"op": "reload"}])


def latest_seq(conn, page_id: str) -> int:
    return conn.execute(
        "SELECT COALESCE(MAX(seq), 0) FROM page_ops WHERE page_id = ?", (page_id,)).fetchone()[0]


def ops_since(conn, page_id: str, since: int) -> tuple[list[dict], bool]:
    """``(batches after seq, pruned)`` — pruned means the log no longer
    reaches back to ``since`` and the client must reload the tree. A delete's
    restore provenance is stripped here too: it is the server's own record, and
    it is kept in the log row, not handed to whoever reads the log back."""
    low = conn.execute(
        "SELECT MIN(seq) FROM page_ops WHERE page_id = ?", (page_id,)).fetchone()[0]
    if low is not None and since < low - 1:
        return [], True
    rows = conn.execute(
        "SELECT seq, actor, client, at, ops FROM page_ops WHERE page_id = ? AND seq > ? ORDER BY seq",
        (page_id, since)).fetchall()
    return [{"seq": r[0], "actor": r[1], "client": r[2], "at": r[3],
             "ops": _wire_ops(json.loads(r[4]))}
            for r in rows], False

"""Block operations — THE write path for a page's blocks.

A page's notes change through small, typed operations rather than a whole-
tree replace, so several clients (two browsers of one account, share editors)
can edit one page at once and only the touched rows move:

- ``set {id, content?, props?}`` — ``content`` is one last-writer-wins
  value; ``props`` is a PATCH (``{key: value | null}``, null deletes), so
  unrelated properties never conflict (Figma's property-level rule).
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

Server-side writers (the block endpoints, AI tools, page rename/attach,
metadata) go through ``apply_ops`` too, so everything a page's viewers see
comes from one code path and one log.
"""

import json
import re
from typing import Annotated, Literal, Union

from fractional_indexing import FIError, generate_key_between, validate_order_key
from pydantic import BaseModel, Field

from . import block_index, collab
from .blocks_store import delete_subtree, fetch_subtree, last_child_position
from .db import connect_pages_db, page_now, user_uploads_dir
from .storage import cleanup_orphan_uploads

MAX_OPS = 500
MAX_CONTENT = 200_000
KEEP_OPS = 2000      # log rows kept per page
PRUNE_EVERY = 64     # prune check cadence (every Nth seq)
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class OpError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class SetOp(BaseModel):
    op: Literal["set"]
    id: str
    content: str | None = None
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


class OpsRequest(BaseModel):
    client: str = ""
    ops: list[Op]


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

    def __init__(self, conn, page_id: str, now: str, share_scoped: bool):
        self.conn = conn
        self.page_id = page_id
        self.now = now
        self.share_scoped = share_scoped
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
        props = json.loads(row[1] or "{}")
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
            if "/api/uploads/" in (row[0] or "") and content != row[0]:
                self.sweep = True
        if patch is not None:
            for k, v in patch.items():
                if v is None:
                    props.pop(k, None)
                else:
                    props[k] = v
            echo["props"] = patch
            if "/api/uploads/" in (row[1] or "") or "doc_id" in patch:
                self.sweep = True
        sets.append("properties = ?")
        values.append(json.dumps(props))
        values.append(block_id)
        self.conn.execute(f"UPDATE unified_blocks SET {', '.join(sets)} WHERE id = ?", values)
        self.applied.append(echo)

    def insert(self, op: dict) -> None:
        block_id, parent = op["id"], op["parent"]
        if not _ID_RE.match(block_id or ""):
            raise OpError(400, f"invalid block id: {block_id!r}")
        content = op.get("content") or ""
        if len(content) > MAX_CONTENT:
            raise OpError(413, "content too long")
        props = op.get("props") or {}
        existing = self.conn.execute(
            "SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        self.check_parent(parent, block_id if existing else None)
        position = self.free_position(parent, op.get("position"), block_id)
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
        ids = [r[0] for r in fetch_subtree(self.conn, block_id)]
        delete_subtree(self.conn, block_id)
        for i in ids:
            self._page_of[i] = None
        self.deleted.extend(ids)
        self.sweep = True
        self.applied.append({"op": "delete", "id": block_id})


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
              share_scoped: bool = False) -> dict:
    """Apply one batch inside one transaction (committed here) and log it.
    Returns ``{page_id, seq, at, actor, client, ops (as applied), deleted_ids,
    sweep}`` — hand it to ``after_commit`` for the derived-data work and the
    room fan-out. Raises ``OpError`` (nothing written) on a bad op."""
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
        batch = _Batch(conn, page_id, now, share_scoped)
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
    return {"page_id": page_id, "seq": seq, "at": now, "actor": actor, "client": client,
            "ops": batch.applied, "deleted_ids": batch.deleted, "sweep": batch.sweep}


def after_commit(user: str, conn, result: dict) -> dict:
    """Derived data after a committed batch: the orphan-upload sweep when a
    reference may have gone, the data.db purge for deleted blocks, and the
    fan-out to the page's room. Adds ``removed_uploads`` to the result."""
    result["removed_uploads"] = (
        cleanup_orphan_uploads(conn, user_uploads_dir(user)) if result["sweep"] else [])
    if result["deleted_ids"]:
        block_index.purge_page_data(user, conn, result["deleted_ids"])
    collab.publish_ops(user, result)
    return result


def commit_ops(user: str, page_id: str, ops: list[dict], *, actor: str = "", client: str = "",
               share_scoped: bool = False) -> dict:
    """``apply_ops`` + ``after_commit`` on a fresh connection."""
    with connect_pages_db(user) as conn:
        result = apply_ops(conn, page_id, ops, actor=actor or user, client=client,
                           share_scoped=share_scoped)
        return after_commit(user, conn, result)


def record_ops(user: str, conn, page_id: str, ops: list[dict], *, actor: str) -> int:
    """Log + publish ops a writer performed with its own SQL (a cross-page
    move, whose two halves are a delete on one page and an arrival on the
    other). Commits."""
    now = page_now()
    seq = _log(conn, page_id, actor, "", now, ops)
    conn.commit()
    collab.publish(user, page_id, {"t": "ops", "seq": seq, "at": now, "actor": actor,
                                   "client": "", "ops": ops})
    return seq


def note_reload(user: str, conn, page_id: str, actor: str) -> int:
    """``log_reload`` + commit + fan-out, for writers that rewrote a page's
    tree wholesale (the subtree replace, imports into an existing page)."""
    seq = log_reload(conn, page_id, actor)
    conn.commit()
    collab.publish_reload(user, page_id, seq)
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
    reaches back to ``since`` and the client must reload the tree."""
    low = conn.execute(
        "SELECT MIN(seq) FROM page_ops WHERE page_id = ?", (page_id,)).fetchone()[0]
    if low is not None and since < low - 1:
        return [], True
    rows = conn.execute(
        "SELECT seq, actor, client, at, ops FROM page_ops WHERE page_id = ? AND seq > ? ORDER BY seq",
        (page_id, since)).fetchall()
    return [{"seq": r[0], "actor": r[1], "client": r[2], "at": r[3], "ops": json.loads(r[4])}
            for r in rows], False

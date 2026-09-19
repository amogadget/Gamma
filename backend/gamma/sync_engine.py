"""Mirrors: a local workspace kept in step with a workspace on another Gamma
server (docs/dev/mirror.md).

The remote is the authority. One round (``sync_workspace``) asks both
change feeds (``/api/sync/changes``, local and remote) which pages moved,
then reconciles each page three ways from the tree it held at the last
round (``sync_pages.base``):

- remote-only change: the remote's diff is applied locally;
- local-only change: the local diff is pushed, with ``base`` texts so the
  remote merges against anything that landed there meanwhile;
- both: the remote diff is applied locally first (the local server's own
  three-way text merge keeps the local keystrokes), then what still differs
  is pushed, the remote tree is fetched back and becomes the new base.

An edit beats a delete, in both directions: a subtree the remote deleted
stays when it was edited here (and is re-inserted there by the push), and
a subtree deleted here comes back when the remote edited inside it. Every
such decision and every text merge that changed a block is a row of
``sync_conflicts`` for the person to look at; sync never blocks on one.
Pages deleted on one side and untouched on the other are deleted on the
other; deleted-and-edited pages come back.

Files travel by content hash: uploads a page references are fetched when
missing here and uploaded when missing there, so a re-run never duplicates.

Writes on the remote carry the mirror's write-scope integration token
(``Authorization: Bearer``), so they land under the account that made the
mirror. Local writes go through ``commit_ops`` with client ``"sync"``, which
is how the local change feed's re-listing of them costs nothing (they diff
to no-op) and how the page's live viewers see them arrive.
"""

import json
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config, pdf_meta, workspaces
from .blocks_store import create_page, fetch_subtree
from .db import connect_pages_db, connect_users_db, page_now, ws_uploads_dir
from .logbuf import log
from .ops import MAX_OPS, OpError, commit_ops, delete_page
from .publisher_sessions import cipher
from .routers.sync import changes as local_changes
from .sync_tree import (ancestors, diff, snapshot_from_rows, snapshot_from_tree, subtree_ids, tree_order,
                        upload_refs)

SYNC_LOG_KEEP = 500        # rows of sync_log kept per mirror
CLIENT = "sync"            # the op-log client of every local write the engine makes
ACTOR = "mirror"           # ...and its actor (the remote's per-op authors are not carried over)
MODES = ("two-way", "pull")
default_fetch = None       # the tests point this at an in-process TestClient; None = urllib
UPLOAD_NAME_RE = re.compile(r"^[0-9a-f]{8,64}\.[a-z0-9]{1,8}$")
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class RemoteError(Exception):
    def __init__(self, status: int, detail: str = ""):
        super().__init__(f"{status}: {detail}" if detail else str(status))
        self.status, self.detail = status, detail


class Remote:
    """A thin HTTP client for one remote workspace. ``fetch(method, path,
    body, headers) -> (status, bytes)`` is the transport — urllib in
    production, a TestClient wrapper in the tests."""

    def __init__(self, url: str, ws: str, token: str, fetch=None):
        self.url = url.rstrip("/")
        self.ws = ws
        self.token = token
        self.fetch = fetch or default_fetch or self._urllib_fetch

    def _urllib_fetch(self, method, path, body, headers):
        req = urllib.request.Request(self.url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise RemoteError(0, f"cannot reach {self.url}: {e}") from e

    def request(self, method, path, *, body=None, content_type=None, ok=(200,)):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if self.ws:
            headers["X-Gamma-Workspace"] = self.ws
        if content_type:
            headers["Content-Type"] = content_type
        status, data = self.fetch(method, path, body, headers)
        if status not in ok:
            try:
                detail = json.loads(data.decode("utf-8")).get("detail", "")
            except Exception:
                detail = (data or b"")[:200].decode("utf-8", "replace")
            raise RemoteError(status, str(detail))
        return status, data

    def get(self, path, ok=(200,)):
        status, data = self.request("GET", path, ok=ok)
        return json.loads(data) if data and status == 200 else (status if status != 200 else None)

    def post(self, path, payload, ok=(200, 201)):
        _, data = self.request("POST", path, body=json.dumps(payload).encode("utf-8"),
                               content_type="application/json", ok=ok)
        return json.loads(data) if data else None

    def delete(self, path, ok=(200, 404)):
        self.request("DELETE", path, ok=ok)

    def head_ok(self, path) -> bool:
        status, _ = self.request("HEAD", path, ok=(200, 404))
        return status == 200

    def get_bytes(self, path) -> bytes:
        _, data = self.request("GET", path)
        return data

    def post_file(self, path, name: str, data: bytes):
        boundary = "gammaMirror" + str(int(time.time() * 1000))
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
        _, out = self.request("POST", path, body=body, content_type=f"multipart/form-data; boundary={boundary}")
        return json.loads(out) if out else None


# --- the registry -----------------------------------------------------------------

_COLS = "workspace_id, remote_url, remote_ws, remote_name, token, owner, mode, remote_cursor, local_cursor, status, created_at"


def _row_info(row, *, with_token=False) -> dict:
    info = {"workspace_id": row[0], "remote_url": row[1], "remote_ws": row[2], "remote_name": row[3],
            "owner": row[5], "mode": row[6], "remote_cursor": row[7], "local_cursor": row[8],
            "status": json.loads(row[9] or "{}"), "created_at": row[10]}
    if with_token:
        info["token"] = cipher().decrypt(row[4].encode("ascii")).decode("utf-8")
    return info


def get_mirror(ws: str, *, with_token: bool = False) -> dict | None:
    with connect_users_db() as conn:
        row = conn.execute(f"SELECT {_COLS} FROM mirrors WHERE workspace_id = ?", (ws,)).fetchone()
    return _row_info(row, with_token=with_token) if row else None


def list_mirrors(owner: str) -> list[dict]:
    with connect_users_db() as conn:
        rows = conn.execute(f"SELECT {_COLS} FROM mirrors WHERE owner = ? ORDER BY created_at", (owner,)).fetchall()
    return [_row_info(r) for r in rows]


def _save(ws: str, **fields) -> None:
    if "status" in fields and not isinstance(fields["status"], str):
        fields["status"] = json.dumps(fields["status"])
    sets = ", ".join(f"{k} = ?" for k in fields)
    with connect_users_db() as conn:
        conn.execute(f"UPDATE mirrors SET {sets} WHERE workspace_id = ?", (*fields.values(), ws))
        conn.commit()


def whoami(remote: Remote) -> dict:
    """The remote's view of the token: ``{user, workspace: {id, name}, role,
    scope}`` (``GET /api/sync/whoami``)."""
    return remote.get("/api/sync/whoami")


def create_mirror(owner: str, remote_url: str, token: str, *, name: str = "", mode: str = "two-way",
                  fetch=None) -> dict:
    """Make a local workspace of ``owner``'s that mirrors the remote
    workspace the token belongs to. Talks to the remote first (``whoami``),
    so a bad URL or token fails before anything is created. Returns the
    mirror's info (run ``sync_workspace`` for the first fill)."""
    remote_url = (remote_url or "").strip().rstrip("/")
    if not re.match(r"^https?://[^/\s]+(/[^\s]*)?$", remote_url):
        raise ValueError("the server address must be an http(s) URL")
    if mode not in MODES:
        raise ValueError("mode must be two-way or pull")
    token = (token or "").strip()
    if not token.startswith("gamma_"):
        raise ValueError("that is not a Gamma integration token")
    try:
        me = whoami(Remote(remote_url, "", token, fetch))
    except RemoteError as e:
        if e.status in (401, 403):
            raise ValueError("the remote did not accept the token") from e
        raise
    if not me or not me.get("workspace"):
        raise ValueError("the remote did not recognise the token")
    remote_ws, remote_name = me["workspace"]["id"], me["workspace"].get("name") or "Workspace"
    if mode == "two-way" and (me.get("scope") != "write" or me.get("role") == "viewer"):
        mode = "pull"
    with connect_users_db() as conn:
        if conn.execute("SELECT 1 FROM mirrors WHERE owner = ? AND remote_url = ? AND remote_ws = ?",
                        (owner, remote_url, remote_ws)).fetchone():
            raise ValueError("you already mirror that workspace")
    info = workspaces.create(name or f"{remote_name} (offline copy)", owner)
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO mirrors (workspace_id, remote_url, remote_ws, remote_name, token, owner, mode, "
            "remote_cursor, local_cursor, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)",
            (info["id"], remote_url, remote_ws, remote_name, cipher().encrypt(token.encode("utf-8")).decode("ascii"),
             owner, mode, json.dumps({"remote_user": me.get("user"), "remote_role": me.get("role")}), page_now()))
        conn.commit()
    return get_mirror(info["id"])


def remove_mirror(ws: str) -> None:
    """Stop mirroring: the workspace stays as an ordinary local one; its
    sync state is dropped."""
    with connect_users_db() as conn:
        conn.execute("DELETE FROM mirrors WHERE workspace_id = ?", (ws,))
        conn.commit()
    with connect_pages_db(ws) as conn:
        conn.execute("DELETE FROM sync_pages")
        conn.execute("DELETE FROM sync_conflicts")
        conn.execute("DELETE FROM sync_log")
        conn.commit()


# --- conflicts -----------------------------------------------------------------------

def _conflict(conn, page_id: str, block_id: str, kind: str, mine="", theirs="", result="") -> None:
    conn.execute(
        "INSERT INTO sync_conflicts (page_id, block_id, kind, mine, theirs, result, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (page_id, block_id, kind, mine or "", theirs or "", result or "", page_now()))
    conn.commit()


def _note(ws: str, page_id: str, action: str, title: str = "") -> None:
    """One sync_log row: what a round did to a page (``pulled``, ``pushed``,
    ``created here``, ``created there``, ``deleted here``, ``deleted
    there``, ``restored here``, ``restored there``)."""
    with connect_pages_db(ws) as conn:
        if not title:
            row = conn.execute("SELECT content FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
            title = (row[0] if row else "") or ""
        conn.execute("INSERT INTO sync_log (at, page_id, title, action) VALUES (?, ?, ?, ?)",
                     (page_now(), page_id, title[:200], action))
        conn.execute("DELETE FROM sync_log WHERE id <= (SELECT MAX(id) FROM sync_log) - ?", (SYNC_LOG_KEEP,))
        conn.commit()


def list_log(ws: str, limit: int = 50) -> list[dict]:
    """The newest sync_log rows: ``[{id, at, page_id, title, action,
    exists}]`` (``exists``: the page is still here, so it can be opened)."""
    with connect_pages_db(ws) as conn:
        rows = conn.execute(
            "SELECT l.id, l.at, l.page_id, l.title, l.action, "
            "EXISTS (SELECT 1 FROM unified_blocks b WHERE b.id = l.page_id) FROM sync_log l "
            "ORDER BY l.id DESC LIMIT ?", (max(1, min(int(limit or 50), 500)),)).fetchall()
    return [{**dict(zip(("id", "at", "page_id", "title", "action"), r[:5])), "exists": bool(r[5])} for r in rows]


def open_conflicts(ws: str) -> int:
    with connect_pages_db(ws) as conn:
        return conn.execute("SELECT COUNT(*) FROM sync_conflicts WHERE resolved = 0").fetchone()[0]


def list_conflicts(ws: str, *, resolved: bool = False) -> list[dict]:
    with connect_pages_db(ws) as conn:
        rows = conn.execute(
            "SELECT c.id, c.page_id, c.block_id, c.kind, c.mine, c.theirs, c.result, c.at, c.resolved, "
            "(SELECT content FROM unified_blocks WHERE id = c.page_id) FROM sync_conflicts c "
            "WHERE c.resolved = ? ORDER BY c.id DESC LIMIT 500", (1 if resolved else 0,)).fetchall()
    return [dict(zip(("id", "page_id", "block_id", "kind", "mine", "theirs", "result", "at", "resolved",
                      "page_title"), r)) for r in rows]


def resolve_conflict(ws: str, conflict_id: int, choice: str) -> dict | None:
    """``keep`` marks it seen; ``mine`` / ``theirs`` write that text into the
    block (a normal local edit, pushed by the next round)."""
    if choice not in ("keep", "mine", "theirs"):
        raise ValueError("choice must be keep, mine or theirs")
    with connect_pages_db(ws) as conn:
        row = conn.execute("SELECT page_id, block_id, kind, mine, theirs FROM sync_conflicts WHERE id = ?",
                           (conflict_id,)).fetchone()
        if not row:
            return None
        page_id, block_id, kind, mine, theirs = row
        conn.execute("UPDATE sync_conflicts SET resolved = 1 WHERE id = ?", (conflict_id,))
        conn.commit()
        exists = conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
    if choice != "keep" and kind == "merged" and exists:
        commit_ops(ws, page_id, [{"op": "set", "id": block_id, "content": mine if choice == "mine" else theirs}],
                   actor=ACTOR)
    return {"id": conflict_id, "resolved": True}


# --- uploads ----------------------------------------------------------------------------

def _pull_files(ws: str, remote: Remote, names: set[str], report: dict) -> None:
    uploads = ws_uploads_dir(ws)
    uploads.mkdir(parents=True, exist_ok=True)
    for name in sorted(names):
        if not UPLOAD_NAME_RE.match(name) or (uploads / name).exists():
            continue
        try:
            data = remote.get_bytes(f"/api/uploads/{name}")
        except RemoteError as e:
            if e.status == 404:
                continue  # the remote lost it too; the reference stays dangling on both
            raise
        (uploads / name).write_bytes(data)
        report["files_pulled"] += 1
        if name.endswith(".pdf"):
            pdf_meta.schedule(ws, name[:-4])


def _push_files(ws: str, remote: Remote, names: set[str], report: dict) -> None:
    uploads = ws_uploads_dir(ws)
    for name in sorted(names):
        path = uploads / name
        if not UPLOAD_NAME_RE.match(name) or not path.is_file() or remote.head_ok(f"/api/uploads/{name}"):
            continue
        data = path.read_bytes()
        out = remote.post_file("/api/uploads" if name.endswith(".pdf") else "/api/upload-file", name, data)
        got = (out or {}).get("source_url") or (out or {}).get("url") or ""
        if not got.endswith("/" + name):
            log.warning(f"[mirror] {ws}: uploaded {name} but the remote stored it as {got!r}")
        report["files_pushed"] += 1


# --- one page ------------------------------------------------------------------------------

def _local_snapshot(conn, page_id: str) -> dict | None:
    rows = fetch_subtree(conn, page_id)
    if not rows or rows[0][1] != "root":
        return None
    return snapshot_from_rows(rows)


def _state(conn, page_id: str) -> dict | None:
    row = conn.execute("SELECT remote_seq, base FROM sync_pages WHERE page_id = ?", (page_id,)).fetchone()
    return {"remote_seq": row[0], "base": json.loads(row[1] or "{}")} if row else None


def _save_state(conn, page_id: str, remote_seq: int, base: dict) -> None:
    conn.execute("INSERT OR REPLACE INTO sync_pages (page_id, remote_seq, base, synced_at) VALUES (?, ?, ?, ?)",
                 (page_id, remote_seq, json.dumps(base), page_now()))
    conn.commit()


def _drop_state(conn, page_id: str) -> None:
    conn.execute("DELETE FROM sync_pages WHERE page_id = ?", (page_id,))
    conn.commit()


def _remote_tree(remote: Remote, page_id: str) -> tuple[dict | None, int]:
    """``(snapshot, seq)`` of the remote page, ``(None, 0)`` when it is gone."""
    try:
        out = remote.get(f"/api/blocks/{page_id}/subtree")
    except RemoteError as e:
        if e.status == 404:
            return None, 0
        raise
    return snapshot_from_tree(out["block"]), int(out.get("seq") or 0)


def _apply_local(ws: str, page_id: str, ops: list[dict]) -> list[dict]:
    """Apply ops to the local page in MAX_OPS chunks; the applied (echoed)
    ops back."""
    applied = []
    for i in range(0, len(ops), MAX_OPS):
        applied.extend(commit_ops(ws, page_id, ops[i:i + MAX_OPS], actor=ACTOR, client=CLIENT)["ops"])
    return applied


def _push(remote: Remote, page_id: str, ops: list[dict]) -> None:
    for i in range(0, len(ops), MAX_OPS):
        remote.post(f"/api/pages/{page_id}/ops", {"client": CLIENT, "ops": ops[i:i + MAX_OPS]})


def _reconcile_remote_ops(conn, page_id: str, base: dict, local: dict, remote: dict) -> list[dict]:
    """The remote's diff from base, adjusted so an edit beats a delete:
    remote deletes of subtrees edited here are dropped, and subtrees
    deleted here that the remote edited inside come back whole."""
    remote_ops = diff(base, remote, page_id)
    local_ops = diff(base, local, page_id)
    local_edited = {op["id"] for op in local_ops if op["op"] in ("set", "move", "insert")}
    local_edited |= {op["parent"] for op in local_ops if op["op"] == "insert"}
    touched_here = set()
    for bid in local_edited:
        touched_here.add(bid)
        touched_here.update(ancestors(local, bid))
    local_deleted = [op["id"] for op in local_ops if op["op"] == "delete"]
    remote_touched = {op["id"] for op in remote_ops if op["op"] in ("set", "move", "insert")}
    remote_touched |= {op["parent"] for op in remote_ops if op["op"] in ("insert", "move")}

    out, restored, restored_tops = [], set(), []
    for top in local_deleted:
        if top not in remote:
            continue  # the remote let it go too
        gone = subtree_ids(base, top)

        def inside(bid):
            return bid in gone or any(a in gone for a in ancestors(remote, bid))

        if any(inside(bid) for bid in remote_touched):
            restored |= subtree_ids(remote, top)
            restored_tops.append(top)
    if restored:
        # re-insert the remote's version of each restored subtree, in tree order
        for bid in tree_order(remote, page_id):
            if bid in restored:
                r = remote[bid]
                parent = r["parent"] if (r["parent"] in local or r["parent"] in restored) else page_id
                out.append({"op": "insert", "id": bid, "parent": parent, "position": r["position"],
                            "content": r["content"], "props": dict(r["props"])})
        for top in restored_tops:
            _conflict(conn, page_id, top, "restored_remote_edit", theirs=remote[top]["content"],
                      result="kept the other side's version of a subtree deleted here")
    for op in remote_ops:
        bid = op["id"]
        if bid in restored:
            continue  # already re-inserted whole
        if op["op"] == "delete" and (bid in touched_here or any(x in touched_here for x in subtree_ids(local, bid))):
            _conflict(conn, page_id, bid, "kept_local_edit", mine=local.get(bid, {}).get("content", ""),
                      result="kept a subtree edited here that the other side deleted")
            continue
        if op["op"] in ("set", "move") and bid not in local:
            continue  # gone here, not restored: the other side's change to it is dropped
        if op["op"] in ("insert", "move") and op["parent"] not in local and op["parent"] not in restored \
                and not any(o["op"] == "insert" and o["id"] == op["parent"] for o in out):
            op = {**op, "parent": page_id}  # its parent is gone here: land at the page's top level
        out.append(op)
    return out


def _sync_page(ws: str, remote: Remote, page_id: str, *, remote_seq_hint: int | None, remote_gone: bool,
               local_gone: bool, mode: str, report: dict) -> None:
    with connect_pages_db(ws) as conn:
        state = _state(conn, page_id)
        local = _local_snapshot(conn, page_id)
    base = state["base"] if state else {}
    push_allowed = mode == "two-way"

    # --- page-level: one side deleted it
    if remote_gone and not local_gone:
        if local is None:
            with connect_pages_db(ws) as conn:
                _drop_state(conn, page_id)
            return
        if state and diff(base, local, page_id):
            if push_allowed:
                _create_remote_page(remote, page_id, local)
                _push_files(ws, remote, upload_refs(local.values()), report)
                _push(remote, page_id, diff({page_id: local[page_id]}, local, page_id, with_base=False))
                remote_after, seq = _remote_tree(remote, page_id)
                with connect_pages_db(ws) as conn:
                    _save_state(conn, page_id, seq, remote_after or local)
                    _conflict(conn, page_id, page_id, "page_restored", mine=local[page_id]["content"],
                              result="the other side deleted this page; it was edited here, so it came back there")
                _note(ws, page_id, "restored there", local[page_id]["content"])
                report["pages_pushed"] += 1
            return
        title = local[page_id]["content"]
        with connect_pages_db(ws) as conn:
            delete_page(ws, conn, page_id, actor=ACTOR)
            _drop_state(conn, page_id)
        _note(ws, page_id, "deleted here", title)
        report["pages_deleted"] += 1
        return
    if local_gone and local is None:
        if not state:
            return  # never synced: nothing to undo on the other side
        remote_tree, seq = _remote_tree(remote, page_id)
        if remote_tree is None:
            with connect_pages_db(ws) as conn:
                _drop_state(conn, page_id)
            return
        if seq == state["remote_seq"] and push_allowed:
            remote.delete(f"/api/blocks/{page_id}")
            with connect_pages_db(ws) as conn:
                _drop_state(conn, page_id)
            _note(ws, page_id, "deleted there", remote_tree[page_id]["content"])
            report["pages_pushed"] += 1
            return
        # the remote edited it since (or we may not delete there): it comes back here
        with connect_pages_db(ws) as conn:
            create_page(conn, remote_tree[page_id]["content"], remote_tree[page_id]["props"], block_id=page_id)
        _pull_files(ws, remote, upload_refs(remote_tree.values()), report)
        _apply_local(ws, page_id, diff({page_id: remote_tree[page_id]}, remote_tree, page_id, with_base=False))
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_tree)
            _conflict(conn, page_id, page_id, "page_restored_from_remote", theirs=remote_tree[page_id]["content"],
                      result="this page was deleted here but edited on the other side, so it came back")
        _note(ws, page_id, "restored here", remote_tree[page_id]["content"])
        report["pages_pulled"] += 1
        return

    # --- both exist (or the remote one is new here / the local one is new there)
    remote_changed = state is None or (remote_seq_hint is not None and remote_seq_hint != state["remote_seq"])
    if remote_changed:
        remote_tree, seq = _remote_tree(remote, page_id)
    else:
        remote_tree, seq = base, state["remote_seq"]
    if remote_tree is None:
        if state is None and local is not None and push_allowed:
            # new here, unknown there: it goes over whole
            _create_remote_page(remote, page_id, local)
            _push_files(ws, remote, upload_refs(local.values()), report)
            _push(remote, page_id, diff({page_id: local[page_id]}, local, page_id, with_base=False))
            remote_after, seq = _remote_tree(remote, page_id)
            with connect_pages_db(ws) as conn:
                _save_state(conn, page_id, seq, remote_after or local)
            _note(ws, page_id, "created there", local[page_id]["content"])
            report["pages_pushed"] += 1
        # else: the feed said it changed, but it is gone now (deleted after the feed): next round's tombstone
        return
    if local is None:
        # new here: create it and lay the remote tree in
        with connect_pages_db(ws) as conn:
            create_page(conn, remote_tree[page_id]["content"], remote_tree[page_id]["props"], block_id=page_id)
        _pull_files(ws, remote, upload_refs(remote_tree.values()), report)
        _apply_local(ws, page_id, diff({page_id: remote_tree[page_id]}, remote_tree, page_id, with_base=False))
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_tree)
        _note(ws, page_id, "created here", remote_tree[page_id]["content"])
        report["pages_pulled"] += 1
        return

    # 1. what the remote changed (from base), applied here with the local merge rules
    with connect_pages_db(ws) as conn:
        remote_ops = _reconcile_remote_ops(conn, page_id, base, local, remote_tree) if remote_changed else []
    if remote_ops:
        _pull_files(ws, remote, upload_refs(remote_ops), report)
        sent = {op["id"]: op for op in remote_ops if op["op"] == "set" and "content" in op}
        applied = _apply_local(ws, page_id, remote_ops)
        with connect_pages_db(ws) as conn:
            for op in applied:
                if op["op"] == "set" and "content" in op and op["id"] in sent \
                        and op["content"] != sent[op["id"]]["content"]:
                    _conflict(conn, page_id, op["id"], "merged", mine=local[op["id"]]["content"],
                              theirs=sent[op["id"]]["content"], result=op["content"])
        _note(ws, page_id, "pulled", remote_tree[page_id]["content"])
        report["pages_pulled"] += 1
    # 2. what still differs here goes there
    with connect_pages_db(ws) as conn:
        local_now = _local_snapshot(conn, page_id) or local
    push_ops = diff(remote_tree, local_now, page_id) if push_allowed else []
    if push_ops:
        _push_files(ws, remote, upload_refs(push_ops), report)
        _push(remote, page_id, push_ops)
        remote_after, seq = _remote_tree(remote, page_id)
        if remote_after is None:
            return
        # the remote's answer (re-keyed positions, its merges) lands here, merged over any typing since
        settle = diff(local_now, remote_after, page_id)
        if settle:
            _apply_local(ws, page_id, settle)
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_after)
        _note(ws, page_id, "pushed", local_now[page_id]["content"])
        report["pages_pushed"] += 1
    else:
        # the base is always the remote's tree: what is not there is a local
        # edit (pull mode never pushes it, but a later merge keeps it)
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_tree)


def _create_remote_page(remote: Remote, page_id: str, local: dict) -> None:
    root = local[page_id]
    try:
        remote.post("/api/pages", {"id": page_id, "title": root["content"], "properties": root["props"]})
    except RemoteError as e:
        if e.status != 409:
            raise


# --- one round -----------------------------------------------------------------------------

def _lock(ws: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(ws, threading.Lock())


def _feed_all(remote: Remote, cursor: str) -> tuple[dict, dict, str]:
    """Walk the remote feed to the end: ``({page_id: seq}, {page_id:
    deleted_at}, cursor)``."""
    pages, deleted = {}, {}
    for _ in range(200):
        out = remote.get(f"/api/sync/changes?since={urllib.parse.quote(cursor)}&limit=1000")
        for p in out["pages"]:
            pages[p["id"]] = p["seq"]
        for d in out["deleted"]:
            deleted[d["id"]] = d["deleted_at"]
        cursor = out["cursor"]
        if not out["more"]:
            break
    return pages, deleted, cursor


def _local_feed_all(ws: str, cursor: str) -> tuple[set, set, str]:
    pages, deleted = set(), set()
    with connect_pages_db(ws) as conn:
        for _ in range(200):
            out = local_changes(conn, cursor, 1000)
            pages.update(p["id"] for p in out["pages"])
            deleted.update(d["id"] for d in out["deleted"])
            cursor = out["cursor"]
            if not out["more"]:
                break
    return pages, deleted, cursor


def sync_workspace(ws: str, *, fetch=None) -> dict:
    """One round for the mirror ``ws``. Returns the status saved on the
    mirror (``{last_sync, last_error, pages_pulled, pages_pushed, ...}``).
    Rounds for one workspace never overlap; a second caller waits."""
    mirror = get_mirror(ws, with_token=True)
    if not mirror:
        raise ValueError("not a mirror")
    lock = _lock(ws)
    with lock:
        return _round(ws, mirror, fetch)


def _round(ws: str, mirror: dict, fetch) -> dict:
    remote = Remote(mirror["remote_url"], mirror["remote_ws"], mirror["token"], fetch)
    first = not mirror["status"].get("last_sync")  # the first fill (or one that never completed)
    status = {**mirror["status"], "running": True, "started_at": page_now(), "progress": None}
    status.pop("interrupted", None)
    _save(ws, status=status)
    report = {"pages_pulled": 0, "pages_pushed": 0, "pages_deleted": 0, "files_pulled": 0,
              "files_pushed": 0, "errors": []}
    mode = mirror["mode"]
    try:
        me = whoami(remote)
        role = me.get("role") if me else None
        if mode == "two-way" and (me.get("scope") != "write" or role == "viewer"):
            report["errors"].append("the token or your role on the remote is read-only: pulling only")
            mode = "pull"
        remote_pages, remote_deleted, remote_cursor = _feed_all(remote, mirror["remote_cursor"])
        local_pages, local_deleted, local_cursor = _local_feed_all(ws, mirror["local_cursor"])
        if mode != "two-way":
            local_pages, local_deleted = set(), set()
        todo = {}
        for page_id in set(remote_pages) | set(remote_deleted) | local_pages | local_deleted:
            todo[page_id] = {"seq": remote_pages.get(page_id),
                             "remote_gone": page_id in remote_deleted and page_id not in remote_pages,
                             "local_gone": page_id in local_deleted and page_id not in local_pages}
        # pages a previous round could not finish come back with the flags they had then
        # (the cursors have moved past them, so the feeds alone would not list them again)
        for page_id, flags in (mirror["status"].get("retry") or {}).items():
            todo.setdefault(page_id, flags)
        failed = {}
        for n, page_id in enumerate(sorted(todo)):
            flags = todo[page_id]
            # the pill and the popover read this while the round runs: "21 of 79 pages"
            status["progress"] = {"done": n, "total": len(todo), "page": _title_of(ws, page_id),
                                  "first": first, "at": page_now()}
            _save(ws, status=status)
            try:
                _sync_page(ws, remote, page_id, remote_seq_hint=flags["seq"], remote_gone=flags["remote_gone"],
                           local_gone=flags["local_gone"], mode=mode, report=report)
            except Exception as e:  # noqa: BLE001 — one page must not sink the round; it is retried next time
                failed[page_id] = flags
                report["errors"].append(f"{page_id}: {e}")
                log.warning(f"[mirror] {ws}: page {page_id}: {e}")
        # cursors move only when the round could talk to the remote at all
        _save(ws, remote_cursor=remote_cursor, local_cursor=local_cursor)
        status = {**status, **report, "running": False, "last_sync": page_now(), "mode": mode,
                  "remote_role": role, "remote_user": me.get("user") if me else None,
                  "last_error": report["errors"][0] if report["errors"] else "", "retry": failed}
    except Exception as e:  # noqa: BLE001 — whatever happens, the running flag comes down
        status = {**status, "running": False, "last_error": str(e), "last_attempt": page_now()}
        log.warning(f"[mirror] {ws}: {e}")
    status.pop("errors", None)
    status.pop("progress", None)
    _save(ws, status=status)
    return status


def _title_of(ws: str, page_id: str) -> str:
    with connect_pages_db(ws) as conn:
        row = conn.execute("SELECT content FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
    return ((row[0] if row else "") or "")[:120]


def sync_in_background(ws: str) -> None:
    def run():
        try:
            sync_workspace(ws)
        except Exception as e:  # noqa: BLE001 — a background round reports, never dies silently
            log.warning(f"[mirror] {ws}: {e}")

    threading.Thread(target=run, name=f"mirror-{ws}", daemon=True).start()


def reset_interrupted() -> None:
    """At startup: a mirror the previous process left ``running`` (the server
    was stopped in the middle of a round) is not running any more; the
    round's progress is dropped and the next round picks up where it was —
    nothing is lost, a round is idempotent."""
    with connect_users_db() as conn:
        for ws, raw in conn.execute("SELECT workspace_id, status FROM mirrors").fetchall():
            status = json.loads(raw or "{}")
            if not status.get("running"):
                continue
            status.update(running=False, interrupted=True)
            status.pop("progress", None)
            conn.execute("UPDATE mirrors SET status = ? WHERE workspace_id = ?", (json.dumps(status), ws))
            log.warning(f"[mirror] {ws}: the last round was interrupted; it continues at the next one")
        conn.commit()


FIRST_PASS_S = 5  # the loop's first round after startup (a copy interrupted mid-fill continues at once)


def start_loop() -> None:
    """Every ``config.sync_interval_s()`` seconds, one round per mirror,
    the first one ``FIRST_PASS_S`` after startup. Started once at app
    startup; off when the interval is 0 (the interrupted flags are still
    reset)."""
    reset_interrupted()
    interval = config.sync_interval_s()
    if interval <= 0:
        return

    def run():
        wait = min(FIRST_PASS_S, interval)
        while True:
            time.sleep(wait)
            wait = interval
            try:
                with connect_users_db() as conn:
                    ids = [r[0] for r in conn.execute("SELECT workspace_id FROM mirrors").fetchall()]
            except Exception as e:  # noqa: BLE001 — the loop must survive anything
                log.warning(f"[mirror] loop: {e}")
                continue
            for ws in ids:
                try:
                    sync_workspace(ws)
                except Exception as e:  # noqa: BLE001
                    log.warning(f"[mirror] {ws}: {e}")

    threading.Thread(target=run, name="mirror-loop", daemon=True).start()

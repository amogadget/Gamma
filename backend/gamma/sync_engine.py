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

import io
import json
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config, ops, pdf_meta, workspaces
from fractional_indexing import generate_key_between

from .blocks_store import create_page, fetch_subtree, page_root_id
from .db import connect_pages_db, connect_users_db, page_now, ws_uploads_dir
from .logbuf import log
from .native_ink import NativeScopeError, guard_generic_insert, guard_generic_update, native_kind
from .ops import MAX_OPS, OpError, after_commit, apply_ops, commit_ops, delete_page
from .publisher_sessions import cipher
from .routers.sync import changes as local_changes
from .sync_tree import (ancestors, diff, snapshot_from_rows, snapshot_from_tree, subtree_ids, tree_order,
                        upload_refs)

SYNC_LOG_KEEP = 500        # rows of sync_log kept per mirror
CLIENT = "sync"            # the op-log client of every local write the engine makes
ACTOR = "mirror"           # ...and its actor (the remote's per-op authors are not carried over)
MODES = ("two-way", "pull", "off")   # off = detached: the link (token, cursors, bases) is kept, no round runs
ADOPT = ("theirs", "mine")           # whose version a never-reconciled page takes (a linked workspace, a force)
DEBOUNCE_S = 1.0                     # a local edit → a round once things have been quiet this long (the loop wakes for it)
TICK_S = 1                           # the loop's clock
STREAM_CHUNK = 256 * 1024
default_fetch = None       # the tests point this at an in-process TestClient; None = urllib
UPLOAD_NAME_RE = re.compile(r"^[0-9a-f]{8,64}\.[a-z0-9]{1,8}$")
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class RemoteError(Exception):
    def __init__(self, status: int, detail: str = ""):
        super().__init__(f"{status}: {detail}" if detail else str(status))
        self.status, self.detail = status, detail


class PageDeferred(Exception):
    """A page the round leaves for the next one without calling it an
    error: its push was refused because a block it holds lives in another
    page on the remote (a cross-page move there), which the other page's
    round of this same pass settles."""


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
        status, data = self.fetch(method, path, body, self._headers(content_type))
        if status not in ok:
            try:
                detail = json.loads(data.decode("utf-8")).get("detail", "")
            except Exception:
                detail = (data or b"")[:200].decode("utf-8", "replace")
            raise RemoteError(status, str(detail))
        return status, data

    def get(self, path):
        _, data = self.request("GET", path)
        return json.loads(data) if data else None

    def post(self, path, payload, ok=(200, 201)):
        _, data = self.request("POST", path, body=json.dumps(payload).encode("utf-8"),
                               content_type="application/json", ok=ok)
        return json.loads(data) if data else None

    def delete(self, path, ok=(200, 404)):
        self.request("DELETE", path, ok=ok)

    def head_ok(self, path) -> bool:
        status, _ = self.request("HEAD", path, ok=(200, 404))
        return status == 200

    def _headers(self, content_type=None):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if self.ws:
            headers["X-Gamma-Workspace"] = self.ws
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    def _streaming(self) -> bool:
        return self.fetch == self._urllib_fetch

    def _open(self, req, timeout: int):
        """``urlopen`` for the streaming paths, every failure a RemoteError
        (``_urllib_fetch`` keeps an HTTP error's status and body instead, for
        ``request`` to read the detail from)."""
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            raise RemoteError(e.code, (e.read() or b"")[:200].decode("utf-8", "replace")) from e
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise RemoteError(0, f"cannot reach {self.url}: {e}") from e

    def get_bytes(self, path, progress=None) -> bytes:
        """A file's bytes; ``progress(done, total)`` as they arrive (total 0
        when the remote sends no length). Only the real transport streams —
        the tests' in-process one reports once, at the end."""
        if not self._streaming():
            _, data = self.request("GET", path)
            if progress:
                progress(len(data), len(data))
            return data
        req = urllib.request.Request(self.url + path, headers=self._headers())
        with self._open(req, 60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            chunks, done = [], 0
            while True:
                chunk = resp.read(STREAM_CHUNK)
                if not chunk:
                    break
                chunks.append(chunk)
                done += len(chunk)
                if progress:
                    progress(done, total)
            return b"".join(chunks)

    def post_file(self, path, name: str, data: bytes, progress=None):
        boundary = "gammaMirror" + str(int(time.time() * 1000))
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
        content_type = f"multipart/form-data; boundary={boundary}"
        if not self._streaming():
            _, out = self.request("POST", path, body=body, content_type=content_type)
            if progress:
                progress(len(data), len(data))
            return json.loads(out) if out else None
        total = len(body)

        class Reader(io.BytesIO):
            def read(self, n=-1):
                chunk = super().read(n)
                if progress:
                    progress(min(self.tell(), len(data)), len(data))
                return chunk

        headers = self._headers(content_type)
        headers["Content-Length"] = str(total)
        req = urllib.request.Request(self.url + path, data=Reader(body), method="POST", headers=headers)
        with self._open(req, 600) as resp:
            out = resp.read()
        return json.loads(out) if out else None


# --- the registry -----------------------------------------------------------------

_COLS = ("workspace_id, remote_url, remote_ws, remote_name, token, owner, mode, remote_cursor, local_cursor, "
         "status, created_at, poll_s, on_change")


def _row_info(row, *, with_token=False) -> dict:
    info = {"workspace_id": row[0], "remote_url": row[1], "remote_ws": row[2], "remote_name": row[3],
            "owner": row[5], "mode": row[6], "remote_cursor": row[7], "local_cursor": row[8],
            "status": json.loads(row[9] or "{}"), "created_at": row[10],
            "poll_s": int(row[11] if row[11] is not None else 30), "on_change": bool(row[12] if row[12] is not None else 1)}
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


def _seal(token: str) -> str:
    """The token as stored: Fernet-encrypted with the data directory's key."""
    return cipher().encrypt(token.encode("utf-8")).decode("ascii")


def _clear_bases(ws: str) -> None:
    """Forget every page's base tree: the next round has nothing to merge
    from and adopts one side's version (a link, a re-link elsewhere, a force)."""
    with connect_pages_db(ws) as conn:
        conn.execute("DELETE FROM sync_pages")
        conn.commit()


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


def _check_remote(remote_url: str, token: str, mode: str, fetch) -> tuple[str, dict, str]:
    """Validate the address and the token against the remote's ``whoami``:
    ``(remote_url, me, mode)`` — the mode dropped to ``pull`` when the token
    or the role may not write."""
    remote_url = (remote_url or "").strip().rstrip("/")
    if not re.match(r"^https?://[^/\s]+(/[^\s]*)?$", remote_url):
        raise ValueError("the server address must be an http(s) URL")
    if mode not in ("two-way", "pull"):
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
    if mode == "two-way" and (me.get("scope") != "write" or me.get("role") == "viewer"):
        mode = "pull"
    return remote_url, me, mode


def create_mirror(owner: str, remote_url: str, token: str, *, name: str = "", mode: str = "two-way",
                  fetch=None, workspace_id: str = "", adopt: str = "theirs") -> dict:
    """Make a local workspace of ``owner``'s that mirrors the remote
    workspace the token belongs to — or link ``workspace_id``, an existing
    personal workspace of the owner's (an imported backup, a copy detached
    and forgotten): its pages that exist on both sides have no common base,
    so the first round adopts ``adopt``'s version of each and records what
    differed as ``diverged`` conflicts. Talks to the remote first
    (``whoami``), so a bad URL or token fails before anything is created.
    Returns the mirror's info (run ``sync_workspace`` for the first fill)."""
    if adopt not in ADOPT:
        raise ValueError("adopt must be theirs or mine")
    remote_url, me, mode = _check_remote(remote_url, token, mode, fetch)
    token = token.strip()
    remote_ws, remote_name = me["workspace"]["id"], me["workspace"].get("name") or "Workspace"
    with connect_users_db() as conn:
        if conn.execute("SELECT 1 FROM mirrors WHERE owner = ? AND remote_url = ? AND remote_ws = ? AND mode != 'off'",
                        (owner, remote_url, remote_ws)).fetchone():
            raise ValueError("you already mirror that workspace")
    status = {"remote_user": me.get("user"), "remote_role": me.get("role")}
    if workspace_id:
        info = workspaces.get(workspace_id)
        if not info or info["kind"] != "personal" or workspaces.role_of(workspace_id, owner) != "owner":
            raise ValueError("that is not a workspace of yours")
        if get_mirror(workspace_id):
            raise ValueError("that workspace already mirrors something — detach or forget it first")
        status["adopt"] = adopt
        _clear_bases(workspace_id)
    else:
        info = workspaces.create(name or f"{remote_name} (offline copy)", owner)
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO mirrors (workspace_id, remote_url, remote_ws, remote_name, token, owner, mode, "
            "remote_cursor, local_cursor, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)",
            (info["id"], remote_url, remote_ws, remote_name, _seal(token), owner, mode, json.dumps(status), page_now()))
        conn.commit()
    return get_mirror(info["id"])


def set_cadence(ws: str, *, poll_s: int | None = None, on_change: bool | None = None,
                mode: str | None = None) -> dict:
    """How a copy keeps in step: ``poll_s`` (a round every so many seconds,
    0 = only Sync now), ``on_change`` (a round ``DEBOUNCE_S`` after a local
    edit), ``mode`` (two-way / pull)."""
    fields = {}
    if poll_s is not None:
        fields["poll_s"] = max(0, min(int(poll_s), 86400))
    if on_change is not None:
        fields["on_change"] = 1 if on_change else 0
    if mode is not None:
        if mode not in ("two-way", "pull"):
            raise ValueError("mode must be two-way or pull")
        fields["mode"] = mode
        # a receive-only round moves the local cursor past edits it did not
        # push: back in two-way, the next round looks at every page changed
        # here since the beginning (one tree compare each) and pushes them
        current = get_mirror(ws)
        if current and current["mode"] == "pull" and mode == "two-way":
            fields["local_cursor"] = ""
    if fields:
        _save(ws, **fields)
    return get_mirror(ws)


def detach_mirror(ws: str) -> dict:
    """Detach: no round runs, the workspace is an ordinary one again, but
    the link — token, cursors, every page's base — is kept, so a later
    ``relink_mirror`` continues with a proper three-way merge of what both
    sides did meanwhile."""
    mirror = get_mirror(ws)
    if not mirror:
        raise ValueError("not a mirror")
    status = {**mirror["status"], "running": False, "detached_at": page_now(), "detached_mode": mirror["mode"]}
    status.pop("progress", None)
    _save(ws, mode="off", status=status)
    return get_mirror(ws)


def relink_mirror(ws: str, *, token: str = "", remote_url: str = "", adopt: str = "theirs", fetch=None) -> dict:
    """Link a detached copy again. Without a token the stored one is
    checked against the remote; a new token (or address) that points at the
    same remote workspace keeps the saved bases — anything else starts over
    with the ``adopt`` policy. Returns the mirror; the caller runs a round."""
    mirror = get_mirror(ws, with_token=True)
    if not mirror:
        raise ValueError("not a mirror")
    if adopt not in ADOPT:
        raise ValueError("adopt must be theirs or mine")
    wanted = mirror["status"].get("detached_mode") or "two-way"
    if wanted not in ("two-way", "pull"):
        wanted = "two-way"
    remote_url, me, mode = _check_remote(remote_url or mirror["remote_url"], token or mirror["token"], wanted, fetch)
    token = (token or mirror["token"]).strip()
    remote_ws, remote_name = me["workspace"]["id"], me["workspace"].get("name") or "Workspace"
    status = {k: v for k, v in mirror["status"].items() if k not in ("detached_at", "detached_mode", "last_error")}
    status.update(remote_user=me.get("user"), remote_role=me.get("role"))
    fields = {"mode": mode, "remote_url": remote_url, "remote_ws": remote_ws, "remote_name": remote_name,
              "token": _seal(token)}
    if remote_url != mirror["remote_url"] or remote_ws != mirror["remote_ws"]:
        # a different original: the saved bases mean nothing, its pages are adopted
        _clear_bases(ws)
        fields.update(remote_cursor="", local_cursor="")
        status["adopt"] = adopt
    _save(ws, status=status, **fields)
    return get_mirror(ws)


def force_sync(ws: str, direction: str) -> None:
    """Make one side identical to the other, whatever happened: ``pull``
    replaces this copy with the original (its own pages and edits go, the
    texts they had are kept in ``diverged`` conflicts), ``push`` replaces the
    original with this copy. Every page is reconciled from scratch under the
    adopt policy and pages the losing side alone has are deleted there. The
    round runs in the background."""
    if direction not in ("pull", "push"):
        raise ValueError("direction must be pull or push")
    mirror = get_mirror(ws)
    if not mirror:
        raise ValueError("not a mirror")
    if mirror["mode"] == "off":
        raise ValueError("the copy is detached — link it again first")
    if direction == "push" and mirror["mode"] != "two-way":
        raise ValueError("a read-only copy cannot replace the original")
    _clear_bases(ws)
    status = {**mirror["status"], "adopt": "theirs" if direction == "pull" else "mine", "prune": True}
    _save(ws, remote_cursor="", local_cursor="", status=status)
    sync_in_background(ws)


def remove_mirror(ws: str) -> None:
    """Forget the link: the workspace stays as an ordinary local one; its
    sync state is dropped (a detached copy keeps it — see ``detach_mirror``)."""
    with connect_users_db() as conn:
        conn.execute("DELETE FROM mirrors WHERE workspace_id = ?", (ws,))
        conn.commit()
    with connect_pages_db(ws) as conn:
        conn.execute("DELETE FROM sync_pages")
        conn.execute("DELETE FROM sync_conflicts")
        conn.execute("DELETE FROM sync_log")
        conn.commit()


# --- conflicts -----------------------------------------------------------------------

def _conflict(conn, page_id: str, block_id: str, kind: str, mine="", theirs="", result="", base="") -> None:
    """One row to look at. ``base`` is the text before either side edited it
    (a ``merged`` block), so the resolver can show what each side did."""
    conn.execute(
        "INSERT INTO sync_conflicts (page_id, block_id, kind, mine, theirs, result, base, at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (page_id, block_id, kind, mine or "", theirs or "", result or "", base or "", page_now()))
    conn.commit()


def _stats(ops: list[dict], before: dict | None = None) -> dict:
    """The git-style counts of a batch of ops on one page: ``add`` blocks
    inserted, ``del`` blocks removed (a delete takes its subtree — counted
    from ``before``, the tree the ops applied to), ``mod`` blocks whose text,
    props or place changed (a set or move on a block the batch did not
    insert)."""
    add = {op["id"] for op in ops if op["op"] == "insert"}
    removed = set()
    for op in ops:
        if op["op"] == "delete":
            if before is not None and op["id"] not in before:
                continue  # already gone here (deleted on both sides): nothing removed
            removed |= subtree_ids(before, op["id"]) if before else {op["id"]}
    mod = {op["id"] for op in ops if op["op"] in ("set", "move")} - add - removed
    return {"add": len(add), "del": len(removed), "mod": len(mod)}


def _whole(tree: dict, key: str) -> dict:
    """The counts of a page that came or went whole: its blocks under the
    root, all ``add`` or all ``del``."""
    return {"add": 0, "del": 0, "mod": 0, key: max(0, len(tree) - 1)}


CHANGES_CAP = 40   # block changes kept per log row
TEXT_CAP = 240     # characters of a block's text kept per change


def _clip(text) -> str:
    text = text or ""
    return text if len(text) <= TEXT_CAP else text[:TEXT_CAP] + "…"


def _changes(ops: list[dict], before: dict | None = None) -> list[dict]:
    """What a batch of ops did, block by block, for the log's diff view:
    ``{k: add | del | mod | props | move, id, text, old?}`` — the new text
    (``old`` the text before, for ``mod``), the removed text for ``del``
    (one entry per block of a deleted subtree), the block's text for a
    property or place change. Capped at ``CHANGES_CAP`` entries."""
    before = before or {}
    inserted = {op["id"] for op in ops if op["op"] == "insert"}
    out: list[dict] = []
    for op in ops:
        if len(out) >= CHANGES_CAP:
            break
        bid = op["id"]
        if op["op"] == "insert":
            out.append({"k": "add", "id": bid, "text": _clip(op.get("content", ""))})
        elif op["op"] == "delete":
            if bid not in before:
                continue  # already gone here: nothing to show
            ids = subtree_ids(before, bid)
            for d in sorted(ids, key=lambda i: (i != bid, i)):
                if len(out) >= CHANGES_CAP:
                    break
                out.append({"k": "del", "id": d, "text": _clip((before.get(d) or {}).get("content", ""))})
        elif op["op"] == "set" and bid not in inserted:
            old = (before.get(bid) or {}).get("content", "")
            if "content" in op:
                if op["content"] != old:
                    out.append({"k": "mod", "id": bid, "old": _clip(old), "text": _clip(op["content"])})
            else:
                out.append({"k": "props", "id": bid, "text": _clip(old)})
        elif op["op"] == "move" and bid not in inserted:
            out.append({"k": "move", "id": bid, "text": _clip((before.get(bid) or {}).get("content", ""))})
    return out


def _whole_changes(tree: dict, key: str, root: str) -> list[dict]:
    """The changes of a page that came or went whole: every block under
    the root as one ``add`` / ``del``."""
    return [{"k": key, "id": bid, "text": _clip(b.get("content", ""))}
            for bid, b in tree.items() if bid != root][:CHANGES_CAP]


def _note(ws: str, page_id: str, action: str, title: str = "", *, stats: dict | None = None,
          changes: list[dict] | None = None, report: dict | None = None) -> None:
    """One sync_log row: what a round did to a page (``pulled``, ``pushed``,
    ``created here``, ``created there``, ``deleted here``, ``deleted
    there``, ``restored here``, ``restored there``, ``replaced here`` /
    ``there``) with its block counts, which also add up on the round's
    ``report`` (``blocks_added`` / ``blocks_removed`` / ``blocks_changed``),
    and with ``changes``, what each edit did (``_changes``), stored in the
    same JSON."""
    if report is not None and stats:
        report["blocks_added"] = report.get("blocks_added", 0) + stats["add"]
        report["blocks_removed"] = report.get("blocks_removed", 0) + stats["del"]
        report["blocks_changed"] = report.get("blocks_changed", 0) + stats["mod"]
    title = title or _title_of(ws, page_id)
    with connect_pages_db(ws) as conn:
        blob = {**stats, "changes": changes} if stats and changes else stats
        conn.execute("INSERT INTO sync_log (at, page_id, title, action, stats) VALUES (?, ?, ?, ?, ?)",
                     (page_now(), page_id, title[:200], action, json.dumps(blob) if blob else ""))
        conn.execute("DELETE FROM sync_log WHERE id <= (SELECT MAX(id) FROM sync_log) - ?", (SYNC_LOG_KEEP,))
        conn.commit()


def list_log(ws: str, limit: int = 50) -> list[dict]:
    """The newest sync_log rows: ``[{id, at, page_id, title, action, stats,
    changes, exists}]`` (``stats``: ``{add, del, mod}`` block counts, ``{}``
    for a row from before they were kept; ``changes``: what each edit did,
    block by block (``_changes``), ``[]`` when none were kept; ``exists``:
    the page is still here, so it can be opened)."""
    with connect_pages_db(ws) as conn:
        rows = conn.execute(
            "SELECT l.id, l.at, l.page_id, l.title, l.action, l.stats, "
            "EXISTS (SELECT 1 FROM unified_blocks b WHERE b.id = l.page_id) FROM sync_log l "
            "ORDER BY l.id DESC LIMIT ?", (max(1, min(int(limit or 50), 500)),)).fetchall()
    out = []
    for r in rows:
        try:
            stats = json.loads(r[5]) if r[5] else {}
        except ValueError:
            stats = {}
        changes = stats.pop("changes", []) if isinstance(stats, dict) else []
        out.append({**dict(zip(("id", "at", "page_id", "title", "action"), r[:5])), "stats": stats,
                    "changes": changes, "exists": bool(r[6])})
    return out


def open_conflicts(ws: str) -> int:
    with connect_pages_db(ws) as conn:
        return conn.execute("SELECT COUNT(*) FROM sync_conflicts WHERE resolved = 0").fetchone()[0]


def list_conflicts(ws: str, *, resolved: bool = False, page_id: str = "") -> list[dict]:
    """The decisions to look at (or the looked-at ones), newest first, one
    page's only when ``page_id`` is given."""
    with connect_pages_db(ws) as conn:
        rows = conn.execute(
            "SELECT c.id, c.page_id, c.block_id, c.kind, c.mine, c.theirs, c.result, c.at, c.resolved, "
            "(SELECT content FROM unified_blocks WHERE id = c.page_id), c.base FROM sync_conflicts c "
            "WHERE c.resolved = ? AND (? = '' OR c.page_id = ?) ORDER BY c.id DESC LIMIT 500",
            (1 if resolved else 0, page_id, page_id)).fetchall()
    return [dict(zip(("id", "page_id", "block_id", "kind", "mine", "theirs", "result", "at", "resolved",
                      "page_title", "base"), r)) for r in rows]


def resolve_conflict(ws: str, conflict_id: int, choice: str) -> dict | None:
    """``keep`` marks it seen; ``mine`` / ``theirs`` write that text into the
    block (a normal local edit, pushed by the next round)."""
    if choice not in ("keep", "mine", "theirs"):
        raise ValueError("choice must be keep, mine or theirs")
    with connect_pages_db(ws) as conn:
        row = conn.execute("SELECT page_id, block_id, kind, mine, theirs, result FROM sync_conflicts WHERE id = ?",
                           (conflict_id,)).fetchone()
        if not row:
            return None
        page_id, block_id, kind, mine, theirs, result = row
        conn.execute("UPDATE sync_conflicts SET resolved = 1 WHERE id = ?", (conflict_id,))
        conn.commit()
        exists = conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
    if choice != "keep" and kind in ("merged", "diverged") and exists:
        # written as an edit from the text the conflict recorded: whatever was
        # typed into the block since is merged over the chosen version, not lost
        op = {"op": "set", "id": block_id, "content": mine if choice == "mine" else theirs}
        if result:
            op["base"] = result
        commit_ops(ws, page_id, [op], actor=ACTOR)
    return {"id": conflict_id, "resolved": True}


# --- uploads ----------------------------------------------------------------------------

def _pull_files(ws: str, remote: Remote, names: set[str], report: dict) -> None:
    uploads = ws_uploads_dir(ws)
    uploads.mkdir(parents=True, exist_ok=True)
    for name in sorted(names):
        if not UPLOAD_NAME_RE.match(name) or (uploads / name).exists():
            continue
        prog = report.get("progress")
        try:
            data = remote.get_bytes(f"/api/uploads/{name}",
                                    progress=(lambda d, t: prog(name, d, t, "down")) if prog else None)
        except RemoteError as e:
            if e.status == 404:
                continue  # the remote lost it too; the reference stays dangling on both
            raise
        (uploads / name).write_bytes(data)
        report["files_pulled"] += 1
        if name.endswith(".pdf"):
            pdf_meta.schedule(ws, name[:-4])


def missing_uploads(ws: str) -> set[str]:
    """The upload names the workspace's blocks reference (content, props, a
    page's ``doc_id``) that are not in its uploads folder."""
    with connect_pages_db(ws) as conn:
        rows = conn.execute("SELECT content, properties FROM unified_blocks").fetchall()
    blocks = []
    for content, props in rows:
        try:
            blocks.append({"content": content or "", "props": json.loads(props or "{}")})
        except ValueError:
            blocks.append({"content": content or "", "props": {}})
    uploads = ws_uploads_dir(ws)
    return {n for n in upload_refs(blocks) if UPLOAD_NAME_RE.match(n) and not (uploads / n).exists()}


def _push_files(ws: str, remote: Remote, names: set[str], report: dict) -> None:
    uploads = ws_uploads_dir(ws)
    for name in sorted(names):
        path = uploads / name
        if not UPLOAD_NAME_RE.match(name) or not path.is_file() or remote.head_ok(f"/api/uploads/{name}"):
            continue
        data = path.read_bytes()
        prog = report.get("progress")
        out = remote.post_file("/api/uploads" if name.endswith(".pdf") else "/api/upload-file", name, data,
                               progress=(lambda d, t: prog(name, d, t, "up")) if prog else None)
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


def _relocated(ws: str, page_id: str, ops: list[dict]) -> list[dict]:
    """Inserts of blocks that live in another page here: the remote moved
    them to this page (or this copy edited them after the remote moved
    them). The block leaves its page here first — the remote's place wins —
    and keeps the text it has here, which the push then sends on."""
    # Reject an unsupported native batch BEFORE relocating its first ordinary
    # block. Otherwise a later native refusal would strand earlier source
    # deletions: the target batch has not been applied yet. This is a bounded
    # native preflight, not a replacement for the op path's validation.
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        for op in ops:
            if op["op"] == "insert":
                home = page_root_id(conn, op["id"])
                if home and home != page_id:
                    subtree = fetch_subtree(conn, op["id"])
                    if any(native_kind(json.loads(r[4] or "{}")) is not None for r in subtree):
                        raise OpError(409, "native annotations and recordings must stay in their PDF page")
                if home != page_id:
                    # No generic mirror creation/resurrection of native data,
                    # even when no local row exists to inspect.
                    try:
                        guard_generic_insert(op.get("props"))
                    except NativeScopeError as e:
                        raise OpError(409, str(e)) from e
            elif op["op"] == "set":
                row = conn.execute("SELECT properties FROM unified_blocks WHERE id = ?",
                                   (op["id"],)).fetchone()
                try:
                    guard_generic_update(json.loads(row[0] or "{}") if row else {}, op.get("props"))
                except NativeScopeError as e:
                    raise OpError(409, str(e)) from e
    out = []
    for op in ops:
        if op["op"] == "insert":
            with connect_pages_db(ws) as conn:
                # The native subtree check and source deletion share the write
                # lock: a concurrent native writer cannot add a child between
                # validation and deletion. Inspect stored rows, not remote props
                # (which may be stale or omit the native payload entirely).
                conn.execute("BEGIN IMMEDIATE")
                home = page_root_id(conn, op["id"])
                if home and home != page_id:
                    subtree = fetch_subtree(conn, op["id"])
                    if any(native_kind(json.loads(r[4] or "{}")) is not None for r in subtree):
                        raise OpError(409, "native annotations and recordings must stay in their PDF page")
                    row = conn.execute("SELECT content FROM unified_blocks WHERE id = ?", (op["id"],)).fetchone()
                    result = apply_ops(conn, home, [{"op": "delete", "id": op["id"]}],
                                       actor=ACTOR, client=CLIENT)
                    after_commit(ws, conn, result)
                    if row and (row[0] or "") != op.get("content", ""):
                        op = {**op, "content": row[0] or ""}
        out.append(op)
    return out


def _parked(ws: str, page_id: str, ops: list[dict]) -> list[dict]:
    """Moves whose target key a sibling holds that the same batch moves
    away: the server re-keys a colliding block on arrival, which would leave
    this side's keys drifting from the remote's every round. The holder parks
    on a fresh key at the end first, so every move lands where it says."""
    moves = [op for op in ops if op["op"] == "move"]
    if not moves:
        return ops
    with connect_pages_db(ws) as conn:
        snap = _local_snapshot(conn, page_id) or {}
    at = {(b["parent"], b["position"]): bid for bid, b in snap.items() if bid != page_id}
    moving = {op["id"] for op in moves}
    taken = {b["position"] for bid, b in snap.items() if bid != page_id} | {op["position"] for op in moves}
    last = max(taken) if taken else None
    parked = []
    for op in moves:
        holder = at.get((op["parent"], op["position"]))
        if holder and holder != op["id"] and holder in moving:
            last = generate_key_between(last, None)
            parked.append({"op": "move", "id": holder, "parent": snap[holder]["parent"], "position": last})
    return parked + ops


def _apply_local(ws: str, page_id: str, ops: list[dict]) -> list[dict]:
    """Apply ops to the local page in MAX_OPS chunks; the applied (echoed)
    ops back. Blocks arriving from another page here move over
    (``_relocated``), colliding moves park first (``_parked``)."""
    ops = _parked(ws, page_id, _relocated(ws, page_id, ops))
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
        if op["op"] in ("set", "move", "delete") and bid not in local:
            continue  # gone here, not restored: the other side's change to it is dropped (a delete of
            # a block already gone — deleted on both sides, or moved to another page here — is done)
        if op["op"] in ("insert", "move") and op["parent"] not in local and op["parent"] not in restored \
                and not any(o["op"] == "insert" and o["id"] == op["parent"] for o in out):
            op = {**op, "parent": page_id}  # its parent is gone here: land at the page's top level
        out.append(op)
    return out


def _pull_whole(ws: str, remote: Remote, page_id: str, remote_tree: dict, seq: int, report: dict, action: str) -> None:
    """A page that comes here whole (new here, or restored): created under
    its id, the remote tree laid in, its files fetched, the state saved."""
    with connect_pages_db(ws) as conn:
        create_page(conn, remote_tree[page_id]["content"], remote_tree[page_id]["props"], block_id=page_id)
    _pull_files(ws, remote, upload_refs(remote_tree.values()), report)
    _apply_local(ws, page_id, diff({page_id: remote_tree[page_id]}, remote_tree, page_id, with_base=False))
    with connect_pages_db(ws) as conn:
        _save_state(conn, page_id, seq, remote_tree)
    _note(ws, page_id, action, remote_tree[page_id]["content"], stats=_whole(remote_tree, "add"),
          changes=_whole_changes(remote_tree, "add", page_id), report=report)
    report["pages_pulled"] += 1


def _push_whole(ws: str, remote: Remote, page_id: str, local: dict, report: dict, action: str) -> None:
    """A page that goes there whole (new there, or restored): created under
    its id, the local tree pushed, its files uploaded, the remote's answer
    saved as the base."""
    _create_remote_page(remote, page_id, local)
    _push_files(ws, remote, upload_refs(local.values()), report)
    _push(remote, page_id, diff({page_id: local[page_id]}, local, page_id, with_base=False))
    remote_after, seq = _remote_tree(remote, page_id)
    with connect_pages_db(ws) as conn:
        _save_state(conn, page_id, seq, remote_after or local)
    _note(ws, page_id, action, local[page_id]["content"], stats=_whole(local, "add"),
          changes=_whole_changes(local, "add", page_id), report=report)
    report["pages_pushed"] += 1


def _delete_here(ws: str, page_id: str, local: dict, report: dict) -> None:
    with connect_pages_db(ws) as conn:
        delete_page(ws, conn, page_id, actor=ACTOR, client=CLIENT)
        _drop_state(conn, page_id)
    _note(ws, page_id, "deleted here", local[page_id]["content"], stats=_whole(local, "del"),
          changes=_whole_changes(local, "del", page_id), report=report)
    report["pages_deleted"] += 1


def _delete_there(ws: str, remote: Remote, page_id: str, remote_tree: dict, report: dict) -> None:
    remote.delete(f"/api/blocks/{page_id}")
    with connect_pages_db(ws) as conn:
        _drop_state(conn, page_id)
    _note(ws, page_id, "deleted there", remote_tree[page_id]["content"], stats=_whole(remote_tree, "del"),
          changes=_whole_changes(remote_tree, "del", page_id), report=report)
    report["pages_pushed"] += 1


def _sync_page(ws: str, remote: Remote, page_id: str, *, remote_seq_hint: int | None, remote_gone: bool,
               local_gone: bool, mode: str, report: dict) -> None:
    with connect_pages_db(ws) as conn:
        state = _state(conn, page_id)
        local = _local_snapshot(conn, page_id)
    base = state["base"] if state else {}
    push_allowed = mode == "two-way"
    adopt, prune = report.get("adopt") or "theirs", bool(report.get("prune"))
    if prune:
        # a force: tombstones say nothing on either side (the per-page state
        # was cleared, so "deleted here, never synced" would skip a page the
        # copy removed) — what the winner has comes over whole, and a page
        # only the loser has is deleted there (the two branches below)
        local_gone = remote_gone = False

    # --- page-level: one side deleted it
    if remote_gone and not local_gone:
        if local is None:
            with connect_pages_db(ws) as conn:
                _drop_state(conn, page_id)
            return
        if state and diff(base, local, page_id):
            if push_allowed:
                _push_whole(ws, remote, page_id, local, report, "restored there")
                with connect_pages_db(ws) as conn:
                    _conflict(conn, page_id, page_id, "page_restored", mine=local[page_id]["content"],
                              result="the other side deleted this page; it was edited here, so it came back there")
            return
        _delete_here(ws, page_id, local, report)
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
            _delete_there(ws, remote, page_id, remote_tree, report)
            return
        # the remote edited it since (or we may not delete there): it comes back here
        _pull_whole(ws, remote, page_id, remote_tree, seq, report, "restored here")
        with connect_pages_db(ws) as conn:
            _conflict(conn, page_id, page_id, "page_restored_from_remote", theirs=remote_tree[page_id]["content"],
                      result="this page was deleted here but edited on the other side, so it came back")
        return

    # --- both exist (or the remote one is new here / the local one is new there)
    remote_changed = state is None or (remote_seq_hint is not None and remote_seq_hint != state["remote_seq"])
    if remote_changed:
        remote_tree, seq = _remote_tree(remote, page_id)
    else:
        remote_tree, seq = base, state["remote_seq"]
    if remote_tree is None:
        if state is None and local is not None and prune and adopt == "theirs":
            # a force pull: a page the original does not have goes
            _delete_here(ws, page_id, local, report)
            return
        if state is None and local is not None and push_allowed:
            # new here, unknown there: it goes over whole
            _push_whole(ws, remote, page_id, local, report, "created there")
        # else: the feed said it changed, but it is gone now (deleted after the feed): next round's tombstone
        return
    if local is None and prune and adopt == "mine" and push_allowed:
        # a force push: a page this copy does not have goes from the original
        _delete_there(ws, remote, page_id, remote_tree, report)
        return
    if local is None:
        # new here: create it and lay the remote tree in
        _pull_whole(ws, remote, page_id, remote_tree, seq, report, "created here")
        return

    if state is None:
        # both exist and were never reconciled (a linked workspace, a force, a
        # round cut short between a page's creation and its state): there is
        # no base to merge from, so one side's version is taken whole
        _adopt_page(ws, remote, page_id, local, remote_tree, seq, adopt if push_allowed else "theirs", report)
        return

    # 1. what the remote changed (from base), applied here with the local merge rules
    with connect_pages_db(ws) as conn:
        remote_ops = _reconcile_remote_ops(conn, page_id, base, local, remote_tree) if remote_changed else []
    if remote_changed:
        # the whole tree's files, not only the changed blocks': a round cut short
        # after the page landed but before its PDF did is repaired here
        _pull_files(ws, remote, upload_refs(remote_tree.values()), report)
        sent = {op["id"]: op for op in remote_ops if op["op"] == "set" and "content" in op}
        applied = _apply_local(ws, page_id, remote_ops)
        with connect_pages_db(ws) as conn:
            for op in applied:
                if op["op"] == "set" and "content" in op and op["id"] in sent \
                        and op["content"] != sent[op["id"]]["content"]:
                    _conflict(conn, page_id, op["id"], "merged", mine=local[op["id"]]["content"],
                              theirs=sent[op["id"]]["content"], result=op["content"],
                              base=((base or {}).get(op["id"]) or {}).get("content", ""))
        _note(ws, page_id, "pulled", remote_tree[page_id]["content"], stats=_stats(remote_ops, local),
              changes=_changes(remote_ops, local), report=report)
        report["pages_pulled"] += 1
    # 2. what still differs here goes there
    with connect_pages_db(ws) as conn:
        local_now = _local_snapshot(conn, page_id) or local
    push_ops = diff(remote_tree, local_now, page_id) if push_allowed else []
    if push_ops:
        _push_files(ws, remote, upload_refs(push_ops), report)
        try:
            _push(remote, page_id, push_ops)
        except RemoteError as e:
            if e.status == 403 and "outside this page" in (e.detail or ""):
                # a block of ours now lives in another page there (moved
                # there meanwhile): that page's round moves it here too, and
                # this page is looked at again next round
                raise PageDeferred(f"{page_id}: a block moved to another page on the remote; retried next round")
            raise
        remote_after, seq = _remote_tree(remote, page_id)
        if remote_after is None:
            return
        # the remote's answer (re-keyed positions, its merges) lands here, merged over any typing since
        settle = diff(local_now, remote_after, page_id)
        if settle:
            _apply_local(ws, page_id, settle)
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_after)
        _note(ws, page_id, "pushed", local_now[page_id]["content"], stats=_stats(push_ops, remote_tree),
              changes=_changes(push_ops, remote_tree), report=report)
        report["pages_pushed"] += 1
    else:
        # the base is always the remote's tree: what is not there is a local
        # edit (pull mode never pushes it, but a later merge keeps it)
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_tree)


def _adopt_page(ws: str, remote: Remote, page_id: str, local: dict, remote_tree: dict, seq: int,
                policy: str, report: dict) -> None:
    """A page both sides have but that was never reconciled: ``policy``'s
    version (``theirs`` = the original's, ``mine`` = this copy's) becomes the
    page on both sides; every block whose text differed is a ``diverged``
    conflict carrying both texts, so nothing is lost and Use mine / Use
    theirs still work afterwards."""
    if local == remote_tree:
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_tree)
        return
    differed = sorted(bid for bid in set(local) & set(remote_tree) if local[bid]["content"] != remote_tree[bid]["content"])
    if policy == "mine":
        push_ops = diff(remote_tree, local, page_id, with_base=False)
        _push_files(ws, remote, upload_refs(push_ops), report)
        _push(remote, page_id, push_ops)
        remote_after, seq = _remote_tree(remote, page_id)
        with connect_pages_db(ws) as conn:
            _save_state(conn, page_id, seq, remote_after or local)
            for bid in differed:
                _conflict(conn, page_id, bid, "diverged", mine=local[bid]["content"],
                          theirs=remote_tree[bid]["content"], result=local[bid]["content"])
        _note(ws, page_id, "replaced there", local[page_id]["content"], stats=_stats(push_ops, remote_tree),
              changes=_changes(push_ops, remote_tree), report=report)
        report["pages_pushed"] += 1
        return
    ops_ = diff(local, remote_tree, page_id, with_base=False)
    _pull_files(ws, remote, upload_refs(remote_tree.values()), report)
    if ops_:
        _apply_local(ws, page_id, ops_)
    with connect_pages_db(ws) as conn:
        _save_state(conn, page_id, seq, remote_tree)
        for bid in differed:
            _conflict(conn, page_id, bid, "diverged", mine=local[bid]["content"],
                      theirs=remote_tree[bid]["content"], result=remote_tree[bid]["content"])
    _note(ws, page_id, "replaced here", remote_tree[page_id]["content"], stats=_stats(ops_, local),
          changes=_changes(ops_, local), report=report)
    report["pages_pulled"] += 1


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
    if mirror["mode"] == "off":
        return mirror["status"]  # detached: nothing runs until it is linked again
    remote = Remote(mirror["remote_url"], mirror["remote_ws"], mirror["token"], fetch)
    first = not mirror["status"].get("last_sync")  # the first fill (or one that never completed)
    started = time.monotonic()  # local writes up to here are this round's to push
    status = {**mirror["status"], "running": True, "started_at": page_now(), "progress": None}
    status.pop("interrupted", None)
    _save(ws, status=status)
    report = {"pages_pulled": 0, "pages_pushed": 0, "pages_deleted": 0, "files_pulled": 0,
              "files_pushed": 0, "blocks_added": 0, "blocks_removed": 0, "blocks_changed": 0,
              "errors": [], "adopt": mirror["status"].get("adopt"),
              "prune": bool(mirror["status"].get("prune"))}
    last_file_save = [0.0]

    def file_progress(name, done, total, direction):
        # the popover's file line ("↓ paper.pdf 3.2 / 14 MB"): saved at most a few times a second
        now = time.monotonic()
        if done < total and now - last_file_save[0] < 0.3:
            return
        last_file_save[0] = now
        status["progress"] = {**(status.get("progress") or {}),
                              "file": {"name": name, "done": done, "total": total, "dir": direction}}
        _save(ws, status=status)

    report["progress"] = file_progress
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
            except PageDeferred as e:
                failed[page_id] = flags  # next round, quietly
                log.info(f"[mirror] {ws}: {e}")
            except Exception as e:  # noqa: BLE001 — one page must not sink the round; it is retried next time
                failed[page_id] = flags
                report["errors"].append(f"{page_id}: {e}")
                log.warning(f"[mirror] {ws}: page {page_id}: {e}")
        # files the copy's pages reference but its uploads folder lacks (an
        # interrupted round, a file lost on disk): fetched again every round
        _pull_files(ws, remote, missing_uploads(ws), report)
        # cursors move only when the round could talk to the remote at all
        _save(ws, remote_cursor=remote_cursor, local_cursor=local_cursor)
        report = {k: v for k, v in report.items() if k not in ("adopt", "prune", "progress")}
        status = {**status, **report, "running": False, "last_sync": page_now(), "mode": mode,
                  "remote_role": role, "remote_user": me.get("user") if me else None,
                  "last_error": report["errors"][0] if report["errors"] else "", "retry": failed}
        if not failed:
            # a link's or a force's policy is spent once every page went through
            status.pop("adopt", None)
            status.pop("prune", None)
        if not report["errors"] and _dirty.get(ws, float("inf")) <= started:
            _dirty.pop(ws, None)  # everything written before the round started went out with it
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
_pending: dict[str, float] = {}   # ws -> earliest monotonic time a requested round may run
_last_run: dict[str, float] = {}  # ws -> monotonic time of the last round the loop started
_wants_change: dict[str, bool] = {}  # ws -> a round after a local edit (mode on, on_change set)
_dirty: dict[str, float] = {}     # ws -> monotonic time of the last local write no round has pushed yet
_wake = threading.Event()         # set by request_sync so the loop looks again at once


def request_sync(ws: str, delay: float = DEBOUNCE_S) -> None:
    """A round for ``ws`` once things have been quiet for ``delay`` seconds
    (the loop wakes for it; every further request within the delay pushes it
    back — a typing burst is one round)."""
    _pending[ws] = time.monotonic() + delay
    _wake.set()


def has_local_changes(ws: str) -> bool:
    """Whether a local write happened since the last round that could push
    it (the pill's "edits waiting" state). In memory: a restart runs a round
    anyway."""
    return ws in _dirty


def _on_commit(ws: str, client: str) -> None:
    """``ops.commit_listeners``: a local write marks the copy dirty and, in
    a copy set to sync on change, asks for a round; the engine's own writes
    (client ``sync``) do neither."""
    if client == CLIENT:
        return
    _dirty[ws] = time.monotonic()
    if _wants_change.get(ws):
        request_sync(ws)


ops.commit_listeners.append(_on_commit)


def _refresh_wants() -> list[tuple]:
    with connect_users_db() as conn:
        rows = conn.execute("SELECT workspace_id, mode, poll_s, on_change FROM mirrors").fetchall()
    _wants_change.clear()
    for ws, mode, _, on_change in rows:
        _wants_change[ws] = mode != "off" and bool(on_change)
    return rows


def due_now(ws: str, mode: str, poll_s: int, now: float) -> bool:
    """Whether the loop runs ``ws`` this tick: a requested round whose
    quiet time is over, or the mirror's own cadence come round (``poll_s``
    0 = never by itself)."""
    if mode == "off":
        return False
    if ws in _pending and _pending[ws] <= now:
        return True
    return poll_s > 0 and now - _last_run.get(ws, float("-inf")) >= poll_s


def start_loop() -> None:
    """The engine's clock: every ``TICK_S`` seconds, each mirror that is due
    — its own ``poll_s`` come round, or a local edit ``DEBOUNCE_S`` ago
    (``request_sync``) — gets a round; the first pass ``FIRST_PASS_S`` after
    startup. Started once at app startup; ``GAMMA_SYNC_INTERVAL=0`` turns the
    loop off (the tests; the interrupted flags are still reset)."""
    reset_interrupted()
    if config.sync_interval_s() <= 0:
        return

    def run():
        time.sleep(FIRST_PASS_S)
        while True:
            try:
                rows = _refresh_wants()
            except Exception as e:  # noqa: BLE001 — the loop must survive anything
                log.warning(f"[mirror] loop: {e}")
                time.sleep(TICK_S)
                continue
            now = time.monotonic()
            for ws, mode, poll_s, _ in rows:
                if not due_now(ws, mode, int(poll_s or 0), now):
                    continue
                _pending.pop(ws, None)
                _last_run[ws] = now
                try:
                    sync_workspace(ws)
                except Exception as e:  # noqa: BLE001
                    log.warning(f"[mirror] {ws}: {e}")
            # sleep until the next tick, or until the earliest requested round is due, or a request comes in
            now = time.monotonic()
            wait = TICK_S
            for due in _pending.values():
                wait = min(wait, max(0.05, due - now))
            _wake.wait(wait)
            _wake.clear()

    threading.Thread(target=run, name="mirror-loop", daemon=True).start()

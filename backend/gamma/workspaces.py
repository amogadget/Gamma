"""Workspaces and membership — the model behind every "whose data" decision.

A workspace is a library: ``workspaces/<id>/`` holds its pages.db, data.db
and uploads. Accounts and workspaces are separate things joined by
``workspace_members``. Two kinds (``workspaces.kind``):

- **personal** — one account's own library. Every account gets one when it
  is created and may create more (work, life, play); the account is its
  single member and owner, nothing else joins it (page share links still
  let others in per page). Personal workspaces are what count against the
  account's storage quota. One of them is the account's **default**
  (``users.default_workspace``): where a request lands when it names no
  workspace (the browser extension, older clients), and the fallback when
  another workspace is left or deleted. The first one created is the
  default; any other personal one can be made default; the last personal
  workspace cannot be deleted.
- **shared** — created by server admins for any owner. Members with roles
  (``owner`` manages members, renames, deletes and restores backups;
  ``editor`` reads and writes; ``viewer`` reads), an **access** setting
  (``private``: members only; ``public``: every signed-in account on the
  server is in at ``public_role`` — not a membership, nothing to leave —
  while invited members keep their own role) and an optional storage cap
  of its own (``quota_mb``). Only admins set access, quota and kind.

Server admins pass every management check of every workspace without being
members (recovery, and the Settings → Workspaces pane), but read a
workspace's pages only as a member or through public access.

Requests pick their workspace with ``?ws=`` or the ``X-Gamma-Workspace``
header (gamma/auth.py ``require_ws``); the frontend keeps the id in the URL.
"""

import secrets
import shutil
import sqlite3

from .config import WORKSPACES_DIR
from .db import connect_users_db, page_now, safe_ws_id, ws_dir, ws_uploads_dir
from .logbuf import log
from .seed import create_workspace_files

ROLES = ("owner", "editor", "viewer")
RANK = {"viewer": 1, "editor": 2, "owner": 3}
KINDS = ("personal", "shared")
ACCESS = ("private", "public")
PUBLIC_ROLES = ("viewer", "editor")  # what a public workspace hands every account
MAX_NAME_LEN = 80
MAX_WORKSPACES_PER_USER = 50

_COLS = "id, name, created_by, created_at, kind, access, public_role, quota_mb"


def new_workspace_id() -> str:
    return secrets.token_urlsafe(9)


def clean_name(name) -> str:
    return " ".join(str(name or "").split())[:MAX_NAME_LEN]


def _info(row) -> dict:
    return {"id": row[0], "name": row[1], "created_by": row[2], "created_at": row[3],
            "kind": row[4], "access": row[5], "public_role": row[6], "quota_mb": row[7]}


def _row(conn, ws: str):
    return conn.execute(f"SELECT {_COLS} FROM workspaces WHERE id = ?", (ws,)).fetchone()


def get(ws: str) -> dict | None:
    with connect_users_db() as conn:
        row = _row(conn, ws)
    return _info(row) if row else None


def _members_of(conn, ws: str) -> list[tuple]:
    return conn.execute(
        "SELECT username, role FROM workspace_members WHERE workspace_id = ? ORDER BY added_at", (ws,)).fetchall()


def _personal_owner(conn, ws: str) -> str:
    row = conn.execute(
        "SELECT m.username FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id "
        "WHERE w.id = ? AND w.kind = 'personal' ORDER BY m.added_at LIMIT 1", (ws,)).fetchone()
    return row[0] if row else ""


def personal_owner(ws: str) -> str:
    """The account a personal workspace belongs to, or "" for a shared one."""
    with connect_users_db() as conn:
        return _personal_owner(conn, ws)


def _personal_ids(conn, username: str) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id "
        "WHERE w.kind = 'personal' AND m.username = ? ORDER BY w.created_at", (username,))]


def personal_workspaces(username: str) -> list[str]:
    """The account's personal workspace ids, oldest first."""
    with connect_users_db() as conn:
        return _personal_ids(conn, username)


def role_of(ws: str, username: str) -> str | None:
    """The account's role in the workspace: its membership, else the public
    role of a public workspace (any non-guest account), else None."""
    if not ws or not username:
        return None
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT m.role, w.access, w.public_role, u.is_guest FROM workspaces w "
            "JOIN users u ON u.username = ? "
            "LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.username = u.username "
            "WHERE w.id = ?", (username, ws)).fetchone()
    if not row:
        return None
    role, access, public_role, is_guest = row
    if role in ROLES:
        return role
    if access == "public" and public_role in PUBLIC_ROLES and not is_guest:
        return public_role
    return None


def at_least(role: str | None, needed: str) -> bool:
    return bool(role) and RANK[role] >= RANK[needed]


def list_for_user(username: str) -> list[dict]:
    """Every workspace the account can open — its memberships plus, for a
    non-guest account, every public workspace: ``[{id, name, kind, role,
    access, public_role, created_by, created_at, members, personal,
    default}]``, personal ones first (the default at the top), then by
    name. ``members`` counts explicit members."""
    with connect_users_db() as conn:
        me = conn.execute(
            "SELECT default_workspace, is_guest FROM users WHERE username = ?", (username,)).fetchone()
        rows = conn.execute(
            f"SELECT {_COLS}, "
            "(SELECT role FROM workspace_members m WHERE m.workspace_id = w.id AND m.username = ?), "
            "(SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) "
            "FROM workspaces w WHERE w.access = 'public' "
            "OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.username = ?)",
            (username, username)).fetchall()
    default, is_guest = (me[0], me[1]) if me else ("", 1)
    out = []
    for r in rows:
        info = _info(r)
        role = r[8] if r[8] in ROLES else (info["public_role"] if info["access"] == "public" and not is_guest else None)
        if not role:
            continue
        out.append({**info, "role": role, "members": r[9], "personal": info["kind"] == "personal",
                    "default": info["id"] == default})
    out.sort(key=lambda w: (not w["personal"], not w["default"], w["name"].lower()))
    return out


def members(ws: str) -> list[dict]:
    with connect_users_db() as conn:
        rows = conn.execute(
            "SELECT username, role, added_by, added_at FROM workspace_members WHERE workspace_id = ? "
            "ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, username",
            (ws,)).fetchall()
    return [{"username": r[0], "role": r[1], "added_by": r[2], "added_at": r[3]} for r in rows]


def membership_count(username: str) -> int:
    """Count explicit memberships; public access consumes no membership slot."""
    with connect_users_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM workspace_members WHERE username = ?", (username,)).fetchone()[0]


def default_workspace(username: str) -> str:
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT default_workspace FROM users WHERE username = ?", (username,)).fetchone()
    return row[0] if row else ""


def _check_access(access: str, public_role: str) -> None:
    if access not in ACCESS:
        raise ValueError("access must be private or public")
    if public_role not in PUBLIC_ROLES:
        raise ValueError("the public role must be viewer or editor")


def _check_account(conn, username: str) -> None:
    row = conn.execute("SELECT is_guest FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        raise ValueError(f"unknown user: {username}")
    if row[0]:
        raise ValueError("the guest account cannot join workspaces")


def create(name: str, owner: str, *, kind: str = "personal", by: str | None = None,
           access: str = "private", public_role: str = "viewer", quota_mb: int | None = None,
           welcome: bool = False, ws_id: str | None = None) -> dict:
    """A new workspace with its files, ``owner`` as its owner (``by`` — who
    created it, default the owner — is recorded as ``created_by``). A
    personal workspace ignores access and quota. Raises ValueError on an
    unknown owner or a bad setting (the guest may own only its personal
    workspace — the API refuses it as an owner, see ``accounts``). Commits."""
    ws_id = ws_id or new_workspace_id()
    safe_ws_id(ws_id)
    name = clean_name(name) or "Workspace"
    if kind not in KINDS:
        raise ValueError("kind must be personal or shared")
    if kind == "personal":
        access, public_role, quota_mb = "private", "viewer", None
    _check_access(access, public_role)
    now = page_now()
    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (owner,)).fetchone():
            raise ValueError(f"unknown user: {owner}")
    create_workspace_files(ws_id, welcome=welcome)
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO workspaces (id, name, created_by, created_at, kind, access, public_role, quota_mb) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (ws_id, name, by or owner, now, kind, access, public_role, quota_mb))
        conn.execute("INSERT INTO workspace_members (workspace_id, username, role, added_by, added_at) "
                     "VALUES (?, ?, 'owner', ?, ?)", (ws_id, owner, by or owner, now))
        conn.commit()
    return get(ws_id)


def ensure_personal(username: str, *, welcome: bool = False) -> str:
    """The account's default workspace id, created (and recorded on the
    users row) when it has none or its files are gone."""
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT default_workspace FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        raise ValueError(f"no such user: {username}")
    ws_id = row[0]
    if ws_id and not (ws_dir(ws_id) / "pages.db").is_file():
        create_workspace_files(ws_id, welcome=welcome)  # repair a missing directory
    if ws_id:
        return ws_id
    ws_id = (personal_workspaces(username) or [None])[0] or create(username, username, welcome=welcome)["id"]
    with connect_users_db() as conn:
        conn.execute("UPDATE users SET default_workspace = ? WHERE username = ?", (ws_id, username))
        conn.commit()
    return ws_id


def set_default(username: str, ws: str) -> None:
    """Make one of the account's personal workspaces its default."""
    update(ws, {}, default_for=username)


def rename(ws: str, name: str) -> dict:
    return update(ws, {"name": name})


def set_access(ws: str, access: str, public_role: str) -> dict:
    """Private (members only) or public (every signed-in account gets
    ``public_role``). Shared workspaces only."""
    return update(ws, {"access": access, "public_role": public_role})


def set_quota(ws: str, quota_mb: int | None) -> dict:
    """A shared workspace's own upload cap in MB (None = unlimited). A
    personal workspace is metered through its account instead."""
    return update(ws, {"quota_mb": quota_mb})


def set_kind(ws: str, kind: str) -> dict:
    """Convert between the kinds. Personal → shared: the owner stays owner,
    the workspace stops counting against them; if it was their default the
    default moves to another personal workspace (refused when it is their
    last). Shared → personal: needs exactly one member, who becomes its
    account; access resets to private and the workspace quota is cleared."""
    return update(ws, {"kind": kind})


def update(ws: str, changes: dict, *, default_for: str = "") -> dict:
    """Apply a workspace edit atomically, including kind and default changes.

    Validate against the resulting kind. Any failure rolls back the whole
    edit; callers must authorize all supplied fields before calling this.
    The write lock also keeps the membership/default checks consistent.
    """
    with connect_users_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _row(conn, ws)
        if not row:
            raise ValueError("workspace not found")
        info = _info(row)
        kind = changes.get("kind", info["kind"])
        if kind not in KINDS:
            raise ValueError("kind must be personal or shared")
        if "name" in changes:
            info["name"] = clean_name(changes["name"])
            if not info["name"]:
                raise ValueError("workspace name cannot be empty")
        people = _members_of(conn, ws)
        if kind != info["kind"] and kind == "personal":
            if len(people) != 1:
                raise ValueError("only a workspace with a single member can become personal")
            _check_account(conn, people[0][0])
            conn.execute("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ?", (ws,))
            info.update(access="private", public_role="viewer", quota_mb=None)
        elif kind != info["kind"]:
            owner = people[0][0] if people else ""
            others = [w for w in _personal_ids(conn, owner) if w != ws] if owner else []
            if owner and not others:
                raise ValueError(f"this is {owner}'s only personal workspace")
            if owner and conn.execute("SELECT 1 FROM users WHERE username = ? AND default_workspace = ?",
                                      (owner, ws)).fetchone():
                conn.execute("UPDATE users SET default_workspace = ? WHERE username = ?", (others[0], owner))
        info["kind"] = kind
        if "access" in changes or "public_role" in changes:
            if kind == "personal":
                raise ValueError("a personal workspace is always private")
            info["access"] = changes.get("access", info["access"])
            info["public_role"] = changes.get("public_role", info["public_role"])
            _check_access(info["access"], info["public_role"])
        if "quota_mb" in changes:
            if kind == "personal":
                raise ValueError("a personal workspace uses its account's storage quota")
            info["quota_mb"] = changes["quota_mb"]
        if default_for:
            if kind != "personal" or len(people) != 1 or people[0][0] != default_for:
                raise ValueError("only one of your personal workspaces can be your default")
            conn.execute("UPDATE users SET default_workspace = ? WHERE username = ?", (ws, default_for))
        conn.execute(
            "UPDATE workspaces SET name = ?, kind = ?, access = ?, public_role = ?, quota_mb = ? WHERE id = ?",
            (info["name"], kind, info["access"], info["public_role"], info["quota_mb"], ws))
        conn.commit()
    return info


def set_member(ws: str, username: str, role: str, by: str) -> None:
    """Add or change one membership (shared workspaces). Raises ValueError
    on a bad role, an unknown / guest account, a personal workspace, or
    demoting the last owner."""
    if role not in ROLES:
        raise ValueError("role must be owner, editor or viewer")
    with connect_users_db() as conn:
        if _personal_owner(conn, ws):
            raise ValueError("a personal workspace has no other members — share a page, or ask an admin for a shared workspace")
        _check_account(conn, username)
        if role != "owner" and _is_last_owner(conn, ws, username):
            raise ValueError("a workspace needs at least one owner")
        conn.execute(
            "INSERT INTO workspace_members (workspace_id, username, role, added_by, added_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, username) DO UPDATE SET role = excluded.role",
            (ws, username, role, by, page_now()))
        conn.commit()


def remove_member(ws: str, username: str) -> None:
    """Drop a membership (also "leave"). The last owner cannot go, a
    personal workspace has nobody to remove, and public access is not a
    membership — there is nothing to remove."""
    with connect_users_db() as conn:
        if _personal_owner(conn, ws):
            raise ValueError("a personal workspace cannot be left; delete it instead")
        if _is_last_owner(conn, ws, username):
            raise ValueError("a workspace needs at least one owner")
        if not conn.execute("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND username = ?",
                            (ws, username)).fetchone():
            raise ValueError(f"{username} is not a member of this workspace")
        conn.execute("DELETE FROM workspace_members WHERE workspace_id = ? AND username = ?",
                     (ws, username))
        conn.commit()


def _is_last_owner(conn, ws: str, username: str) -> bool:
    owners = [r[0] for r in conn.execute(
        "SELECT username FROM workspace_members WHERE workspace_id = ? AND role = 'owner'", (ws,))]
    return owners == [username]


def delete(ws: str) -> str:
    """Remove the workspace: its rows (memberships, shares, per-workspace
    prefs) and its directory. An account's last personal workspace is
    refused; deleting its default moves the default to the oldest other
    personal one. Returns a warning when the directory could not be
    removed (Windows file locks)."""
    with connect_users_db() as conn:
        owner = _personal_owner(conn, ws)
        if owner:
            others = [w for w in _personal_ids(conn, owner) if w != ws]
            if not others:
                raise ValueError("your last personal workspace cannot be deleted; delete the account instead")
            conn.execute("UPDATE users SET default_workspace = ? WHERE username = ? AND default_workspace = ?",
                         (others[0], owner, ws))
        _delete_rows(conn, ws)
        conn.commit()
    return remove_files(ws)


def _delete_rows(conn, ws: str) -> None:
    conn.execute("DELETE FROM integration_tokens WHERE workspace_id = ?", (ws,))
    conn.execute("DELETE FROM workspace_members WHERE workspace_id = ?", (ws,))
    conn.execute("DELETE FROM shares WHERE workspace_id = ?", (ws,))
    conn.execute("DELETE FROM user_prefs WHERE workspace_id = ?", (ws,))
    conn.execute("DELETE FROM workspaces WHERE id = ?", (ws,))


def remove_files(ws: str) -> str:
    """rmtree the workspace directory (and its stored backups); returns ""
    or a warning."""
    from . import ws_backup  # local: ws_backup imports seed → db

    ws_backup.remove_all(ws)
    try:
        path = ws_dir(ws)
    except ValueError:
        return ""
    if not path.exists():
        return ""
    try:
        shutil.rmtree(str(path))
        return ""
    except OSError as e:
        log.warning(f"[workspaces] could not remove {path}: {e}")
        return (f"the workspace's files could not be removed ({e}); "
                f"delete workspaces/{ws}/ by hand")


def delete_account_workspaces(username: str) -> list[str]:
    """When an account goes: its personal workspaces are deleted; it leaves
    every shared workspace, and the ones where it was the only owner are
    deleted too (their other members lose them — the admin UI says so
    before). Returns the deleted workspace ids."""
    deleted = []
    with connect_users_db() as conn:
        mine = [r[0] for r in conn.execute(
            "SELECT workspace_id FROM workspace_members WHERE username = ?", (username,))]
        for ws in mine:
            kind = conn.execute("SELECT kind FROM workspaces WHERE id = ?", (ws,)).fetchone()
            owners = [r[0] for r in conn.execute(
                "SELECT username FROM workspace_members WHERE workspace_id = ? AND role = 'owner'", (ws,))]
            if (kind and kind[0] == "personal") or owners == [username]:
                deleted.append(ws)
        conn.execute("DELETE FROM workspace_members WHERE username = ?", (username,))
        conn.execute("DELETE FROM integration_tokens WHERE username = ?", (username,))
        conn.execute("DELETE FROM publisher_sessions WHERE username = ?", (username,))
        for ws in deleted:
            _delete_rows(conn, ws)
        conn.execute("DELETE FROM user_prefs WHERE username = ?", (username,))
        conn.commit()
    for ws in deleted:
        remove_files(ws)
    return deleted


def find_page(username: str, page_id: str) -> str | None:
    """Which of the account's workspaces holds this page (a deep link
    without ``ws``); None when none does."""
    from .db import connect_pages_db  # local: keeps this module light for auth

    for w in list_for_user(username):
        try:
            with connect_pages_db(w["id"]) as conn:
                if conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (page_id,)).fetchone():
                    return w["id"]
        except (sqlite3.Error, ValueError):
            continue
    return None


def all_workspaces() -> list[dict]:
    """Admin listing: every workspace with its kind, access, members and
    upload size; ``personal`` names the account a personal one belongs to
    ("" when shared), ``default`` whether it is that account's default."""
    with connect_users_db() as conn:
        rows = conn.execute(f"SELECT {_COLS} FROM workspaces ORDER BY created_at").fetchall()
        defaults = {r[0] for r in conn.execute("SELECT default_workspace FROM users")}
        owners = {}
        for ws, user in conn.execute(
                "SELECT w.id, m.username FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id "
                "WHERE w.kind = 'personal' ORDER BY m.added_at"):
            owners.setdefault(ws, user)
    out = []
    for r in rows:
        info = _info(r)
        uploads = ws_uploads_dir(info["id"])
        size = sum(f.stat().st_size for f in uploads.iterdir() if f.is_file()) if uploads.is_dir() else 0
        out.append({**info, "personal": owners.get(info["id"], "") if info["kind"] == "personal" else "",
                    "default": info["id"] in defaults, "used_bytes": size, "members": members(info["id"])})
    return out


def accounts() -> list[dict]:
    """The account directory for invite / owner pickers: every non-guest
    account, ``[{username, is_admin}]`` by name."""
    with connect_users_db() as conn:
        rows = conn.execute(
            "SELECT username, is_admin FROM users WHERE is_guest = 0 ORDER BY username COLLATE NOCASE").fetchall()
    return [{"username": r[0], "is_admin": bool(r[1])} for r in rows]


def orphan_dirs() -> list[str]:
    """Directories under workspaces/ that no workspaces row names."""
    if not WORKSPACES_DIR.is_dir():
        return []
    with connect_users_db() as conn:
        known = {r[0] for r in conn.execute("SELECT id FROM workspaces")}
    return sorted(d.name for d in WORKSPACES_DIR.iterdir() if d.is_dir() and d.name not in known)

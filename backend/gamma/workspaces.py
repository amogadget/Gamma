"""Workspaces and membership — the model behind every "whose data" decision.

A workspace is a library: ``workspaces/<id>/`` holds its pages.db, data.db
and uploads. Accounts and workspaces are separate things joined by
``workspace_members``:

- every account gets a personal workspace when it is created (its
  ``users.default_workspace``): where requests that name no workspace land,
  and the one the account can never leave or delete;
- any non-guest account may create more and invite other accounts to them
  (Notion-style: members with a role, nothing public — page share links
  remain the way to let outsiders in);
- roles: ``owner`` manages members, renames, deletes and restores backups;
  ``editor`` reads and writes; ``viewer`` reads. Server admins pass the
  owner checks of every workspace (recovery when an owner is gone).

Requests pick their workspace with ``?ws=`` or the ``X-Gamma-Workspace``
header (gamma/auth.py ``require_ws``); the frontend keeps the id in the URL.
Storage limits are the workspace's billing account's (``billing_user``):
whoever created it, as long as they are still an owner.
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
MAX_NAME_LEN = 80
MAX_WORKSPACES_PER_USER = 50


def new_workspace_id() -> str:
    return secrets.token_urlsafe(9)


def clean_name(name) -> str:
    return " ".join(str(name or "").split())[:MAX_NAME_LEN]


def _row(conn, ws: str):
    return conn.execute(
        "SELECT id, name, created_by, created_at FROM workspaces WHERE id = ?", (ws,)).fetchone()


def get(ws: str) -> dict | None:
    with connect_users_db() as conn:
        row = _row(conn, ws)
    return {"id": row[0], "name": row[1], "created_by": row[2], "created_at": row[3]} if row else None


def role_of(ws: str, username: str) -> str | None:
    """The account's role in the workspace, or None (not a member)."""
    if not ws or not username:
        return None
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT role FROM workspace_members WHERE workspace_id = ? AND username = ?",
            (ws, username)).fetchone()
    return row[0] if row and row[0] in ROLES else None


def at_least(role: str | None, needed: str) -> bool:
    return bool(role) and RANK[role] >= RANK[needed]


def list_for_user(username: str) -> list[dict]:
    """Every workspace the account belongs to: ``[{id, name, role,
    created_by, created_at, members}]``, personal first, then by name."""
    with connect_users_db() as conn:
        default = conn.execute(
            "SELECT default_workspace FROM users WHERE username = ?", (username,)).fetchone()
        rows = conn.execute(
            "SELECT w.id, w.name, m.role, w.created_by, w.created_at, "
            "(SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) "
            "FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id "
            "WHERE m.username = ?", (username,)).fetchall()
    default = default[0] if default else ""
    out = [{"id": r[0], "name": r[1], "role": r[2], "created_by": r[3], "created_at": r[4],
            "members": r[5], "personal": r[0] == default} for r in rows]
    out.sort(key=lambda w: (not w["personal"], w["name"].lower()))
    return out


def members(ws: str) -> list[dict]:
    with connect_users_db() as conn:
        rows = conn.execute(
            "SELECT username, role, added_by, added_at FROM workspace_members WHERE workspace_id = ? "
            "ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, username",
            (ws,)).fetchall()
    return [{"username": r[0], "role": r[1], "added_by": r[2], "added_at": r[3]} for r in rows]


def default_workspace(username: str) -> str:
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT default_workspace FROM users WHERE username = ?", (username,)).fetchone()
    return row[0] if row else ""


def create(name: str, owner: str, *, welcome: bool = False, ws_id: str | None = None) -> dict:
    """A new workspace with its files, ``owner`` as its owner. Commits."""
    ws_id = ws_id or new_workspace_id()
    safe_ws_id(ws_id)
    name = clean_name(name) or "Workspace"
    now = page_now()
    create_workspace_files(ws_id, welcome=welcome)
    with connect_users_db() as conn:
        conn.execute("INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
                     (ws_id, name, owner, now))
        conn.execute("INSERT INTO workspace_members (workspace_id, username, role, added_by, added_at) "
                     "VALUES (?, ?, 'owner', ?, ?)", (ws_id, owner, owner, now))
        conn.commit()
    return {"id": ws_id, "name": name, "created_by": owner, "created_at": now}


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
    ws_id = create(username, username, welcome=welcome)["id"]
    with connect_users_db() as conn:
        conn.execute("UPDATE users SET default_workspace = ? WHERE username = ?", (ws_id, username))
        conn.commit()
    return ws_id


def rename(ws: str, name: str) -> dict:
    name = clean_name(name)
    if not name:
        raise ValueError("workspace name cannot be empty")
    with connect_users_db() as conn:
        conn.execute("UPDATE workspaces SET name = ? WHERE id = ?", (name, ws))
        conn.commit()
    return get(ws)


def set_member(ws: str, username: str, role: str, by: str) -> None:
    """Add or change one membership. Raises ValueError on a bad role, an
    unknown / guest account, or demoting the last owner."""
    if role not in ROLES:
        raise ValueError("role must be owner, editor or viewer")
    with connect_users_db() as conn:
        row = conn.execute("SELECT is_guest FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise ValueError(f"unknown user: {username}")
        if row[0]:
            raise ValueError("the guest account cannot join workspaces")
        if role != "owner" and _is_last_owner(conn, ws, username):
            raise ValueError("a workspace needs at least one owner")
        conn.execute(
            "INSERT INTO workspace_members (workspace_id, username, role, added_by, added_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, username) DO UPDATE SET role = excluded.role",
            (ws, username, role, by, page_now()))
        conn.commit()


def remove_member(ws: str, username: str) -> None:
    """Drop a membership (also "leave"). The last owner cannot go, and
    nobody leaves their personal workspace."""
    with connect_users_db() as conn:
        if _is_last_owner(conn, ws, username):
            raise ValueError("a workspace needs at least one owner")
        row = conn.execute(
            "SELECT default_workspace FROM users WHERE username = ?", (username,)).fetchone()
        if row and row[0] == ws:
            raise ValueError("you cannot leave your personal workspace")
        conn.execute("DELETE FROM workspace_members WHERE workspace_id = ? AND username = ?",
                     (ws, username))
        conn.commit()


def _is_last_owner(conn, ws: str, username: str) -> bool:
    owners = [r[0] for r in conn.execute(
        "SELECT username FROM workspace_members WHERE workspace_id = ? AND role = 'owner'", (ws,))]
    return owners == [username]


def delete(ws: str) -> str:
    """Remove the workspace: its rows (memberships, shares, per-workspace
    prefs) and its directory. A personal workspace is refused. Returns a
    warning when the directory could not be removed (Windows file locks)."""
    with connect_users_db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE default_workspace = ?", (ws,)).fetchone():
            raise ValueError("a personal workspace cannot be deleted; delete the account instead")
        conn.execute("DELETE FROM workspace_members WHERE workspace_id = ?", (ws,))
        conn.execute("DELETE FROM shares WHERE workspace_id = ?", (ws,))
        conn.execute("DELETE FROM user_prefs WHERE workspace_id = ?", (ws,))
        conn.execute("DELETE FROM workspaces WHERE id = ?", (ws,))
        conn.commit()
    return remove_files(ws)


def remove_files(ws: str) -> str:
    """rmtree the workspace directory; returns "" or a warning."""
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
    """When an account goes: leave every shared workspace; delete the ones
    where it was the only owner (their other members lose them — the
    admin UI says so before). Returns the deleted workspace ids."""
    deleted = []
    with connect_users_db() as conn:
        mine = [r[0] for r in conn.execute(
            "SELECT workspace_id FROM workspace_members WHERE username = ?", (username,))]
        for ws in mine:
            owners = [r[0] for r in conn.execute(
                "SELECT username FROM workspace_members WHERE workspace_id = ? AND role = 'owner'", (ws,))]
            if owners == [username]:
                deleted.append(ws)
        conn.execute("DELETE FROM workspace_members WHERE username = ?", (username,))
        for ws in deleted:
            conn.execute("DELETE FROM workspace_members WHERE workspace_id = ?", (ws,))
            conn.execute("DELETE FROM shares WHERE workspace_id = ?", (ws,))
            conn.execute("DELETE FROM user_prefs WHERE workspace_id = ?", (ws,))
            conn.execute("DELETE FROM workspaces WHERE id = ?", (ws,))
        conn.execute("DELETE FROM user_prefs WHERE username = ?", (username,))
        conn.commit()
    for ws in deleted:
        remove_files(ws)
    return deleted


def billing_user(ws: str) -> str:
    """Whose storage limits a workspace counts against: its creator while
    they are still an owner, else any owner, else the creator anyway."""
    with connect_users_db() as conn:
        row = _row(conn, ws)
        if not row:
            return ""
        creator = row[2]
        owners = [r[0] for r in conn.execute(
            "SELECT username FROM workspace_members WHERE workspace_id = ? AND role = 'owner' "
            "ORDER BY added_at", (ws,))]
    if creator in owners or not owners:
        return creator
    return owners[0]


def billed_to(username: str) -> list[str]:
    """The workspaces whose uploads count against this account's quota."""
    with connect_users_db() as conn:
        rows = conn.execute(
            "SELECT w.id, w.created_by FROM workspaces w JOIN workspace_members m "
            "ON m.workspace_id = w.id AND m.role = 'owner' WHERE m.username = ?", (username,)).fetchall()
    return [ws for ws, _ in rows if billing_user(ws) == username]


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
    """Admin listing: every workspace with its members and upload size."""
    with connect_users_db() as conn:
        rows = conn.execute("SELECT id, name, created_by, created_at FROM workspaces ORDER BY created_at").fetchall()
        personal = {r[0] for r in conn.execute("SELECT default_workspace FROM users")}
    out = []
    for ws_id, name, created_by, created_at in rows:
        uploads = ws_uploads_dir(ws_id)
        size = sum(f.stat().st_size for f in uploads.iterdir() if f.is_file()) if uploads.is_dir() else 0
        out.append({"id": ws_id, "name": name, "created_by": created_by, "created_at": created_at,
                    "personal": ws_id in personal, "used_bytes": size, "members": members(ws_id)})
    return out


def orphan_dirs() -> list[str]:
    """Directories under workspaces/ that no workspaces row names."""
    if not WORKSPACES_DIR.is_dir():
        return []
    with connect_users_db() as conn:
        known = {r[0] for r in conn.execute("SELECT id FROM workspaces")}
    return sorted(d.name for d in WORKSPACES_DIR.iterdir() if d.is_dir() and d.name not in known)

"""Admin-only user management: the GUI mirror of manage.py.

Admin is a privilege flag (users.is_admin), not a special account name. Grant
the first one via `python manage.py set-admin <user> on` or the Docker
GAMMA_ADMIN_USER bootstrap; after that admins manage everyone from Settings.

Safety rails: the guest account can only be inspected (it is reset daily and
has no password), you cannot delete your own account, and the last remaining
admin cannot be demoted or deleted — so the instance can never lock itself out.

Accounts and workspaces are separate (gamma/workspaces.py): creating an
account creates its personal workspace, deleting one removes the workspaces
it alone owned, renaming touches rows only (workspace directories are named
by id, never by account).
"""

import os
import re
import sqlite3
from urllib.parse import urlsplit

import bcrypt
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import backups, workspaces
from ..auth import require_admin
from ..db import connect_users_db
from ..logbuf import tail as _log_tail
from ..seed import create_account
from ..server_settings import (
    QUOTA_MB_MAX,
    QUOTA_MB_MIN,
    UPLOAD_MB_MAX,
    UPLOAD_MB_MIN,
    get_defaults,
    public_url_settings,
    set_public_url,
    validate_public_url,
    set_default_max_upload_mb,
    set_default_quota_mb,
    usage_bytes,
    validate_quota_mb,
    validate_upload_mb,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
MAX_PASSWORD_LEN = 128


def _user_list(conn: sqlite3.Connection, with_usage: bool = False) -> list:
    """with_usage stats every upload of every account's workspaces — only
    the GET listing pays for it; mutation responses omit used_bytes and the
    client keeps its last known values."""
    rows = conn.execute(
        "SELECT username, is_guest, is_admin, created_at, max_upload_mb, quota_mb, default_workspace "
        "FROM users ORDER BY created_at"
    ).fetchall()
    return [{"username": u, "is_guest": bool(g), "is_admin": bool(a), "created_at": c,
             "max_upload_mb": mu, "quota_mb": q,  # overrides; null = server default
             "default_workspace": dw,
             **({"used_bytes": usage_bytes(u)} if with_usage else {})}
            for u, g, a, c, mu, q, dw in rows]


def _get_user(conn: sqlite3.Connection, username: str):
    return conn.execute(
        "SELECT username, is_guest, is_admin FROM users WHERE username = ?", (username,)
    ).fetchone()


def _admin_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1 AND is_guest = 0").fetchone()[0]


def _check_password(password: str) -> str:
    password = str(password or "")
    if not password or len(password) > MAX_PASSWORD_LEN:
        raise HTTPException(status_code=400, detail="password must be 1-128 characters")
    return password


@router.get("/logs")
async def get_logs(request: Request, after: int = 0):
    """Scrubbed in-memory server log (see gamma.logbuf) for the Settings →
    Diagnostics panel. `after` is the last seq the client has seen, so the UI
    polls incrementally. Admin-only: log lines reveal other users' activity."""
    require_admin(request)
    return {"entries": _log_tail(after)}


@router.get("/settings")
async def get_settings(request: Request):
    """Server-wide default storage limits (per-user overrides live on the
    users list) for the admin rows in the Settings dialog."""
    require_admin(request)
    return {**get_defaults(), **public_url_settings(),
            "max_upload_mb_range": [UPLOAD_MB_MIN, UPLOAD_MB_MAX],
            "quota_mb_range": [QUOTA_MB_MIN, QUOTA_MB_MAX]}


class SettingsUpdateRequest(BaseModel):
    public_url: str | None = None
    max_upload_mb: int | None = None
    quota_mb: int | None = None  # 0 = unlimited


@router.put("/settings")
async def update_settings(payload: SettingsUpdateRequest, request: Request):
    require_admin(request)
    try:
        if payload.public_url is not None:
            origin = request.headers.get("origin")
            if (request.headers.get("sec-fetch-site") == "cross-site"
                    or (origin and urlsplit(origin).netloc.lower() != request.url.netloc.lower())):
                raise HTTPException(403, "Cross-origin server settings changes are not allowed.")
            validate_public_url(payload.public_url)
        # Validate the complete request before persisting any setting.
        if payload.max_upload_mb is not None:
            validate_upload_mb(payload.max_upload_mb)
        if payload.quota_mb is not None:
            validate_quota_mb(payload.quota_mb)
        if payload.public_url is not None:
            set_public_url(payload.public_url)
        if payload.max_upload_mb is not None:
            set_default_max_upload_mb(payload.max_upload_mb)
        if payload.quota_mb is not None:
            set_default_quota_mb(payload.quota_mb)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {**get_defaults(), **public_url_settings()}


@router.get("/users")
async def list_users(request: Request):
    me = require_admin(request)
    with connect_users_db() as conn:
        return {"users": _user_list(conn, with_usage=True), "me": me}


@router.get("/workspaces")
async def list_workspaces(request: Request):
    """Every workspace on the server with its members and upload size, plus
    directories under workspaces/ that no row names (leftovers to inspect)."""
    require_admin(request)
    return {"workspaces": workspaces.all_workspaces(), "orphans": workspaces.orphan_dirs()}


# --- server backups (gamma/backups.py) ---------------------------------------

@router.get("/backups")
async def list_backups(request: Request):
    """Every snapshot under backups/ (name, time, label, schema version,
    files, size, whether uploads were included)."""
    require_admin(request)
    return {"backups": backups.list_backups()}


class BackupCreateRequest(BaseModel):
    label: str = "manual"
    uploads: bool = False


# Sync def: copying a library's uploads can take a while.
@router.post("/backups")
def create_backup(payload: BackupCreateRequest, request: Request):
    require_admin(request)
    try:
        return backups.create(payload.label.strip() or "manual", uploads=payload.uploads)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _named_backup(name: str) -> dict:
    b = backups.info(name)
    if not b:
        raise HTTPException(status_code=404, detail="no such backup")
    return b


# Sync def: zipping runs in the threadpool.
@router.get("/backups/{name}/download")
def download_backup(name: str, request: Request):
    require_admin(request)
    _named_backup(name)
    tmp = backups.zip_backup(name)
    return FileResponse(str(tmp), media_type="application/zip", filename=f"gamma-backup-{name}.zip",
                        background=BackgroundTask(os.unlink, str(tmp)))


@router.delete("/backups/{name}")
async def delete_backup(name: str, request: Request):
    require_admin(request)
    _named_backup(name)
    backups.delete(name)
    return {"ok": True}


class UserCreateRequest(BaseModel):
    username: str
    password: str
    is_admin: bool = False


@router.post("/users")
async def create_user(payload: UserCreateRequest, request: Request):
    require_admin(request)
    username = payload.username.strip()
    if not _USERNAME_RE.match(username):
        raise HTTPException(status_code=400,
                            detail="username must be 1-64 chars of letters, digits, '_', '.', '-'")
    password = _check_password(payload.password)
    with connect_users_db() as conn:
        if _get_user(conn, username):
            raise HTTPException(status_code=409, detail="user already exists")
    create_account(username, password, is_admin=payload.is_admin)
    with connect_users_db() as conn:
        return {"users": _user_list(conn)}


class UserUpdateRequest(BaseModel):
    password: str | None = None   # set a new password (revokes the user's sessions)
    is_admin: bool | None = None  # grant/revoke the admin privilege
    # storage-limit overrides: omitted = unchanged, explicit null = inherit the
    # server default again (model_fields_set tells the two apart)
    max_upload_mb: int | None = None
    quota_mb: int | None = None   # 0 = unlimited


@router.put("/users/{username}")
async def update_user(username: str, payload: UserUpdateRequest, request: Request):
    require_admin(request)
    with connect_users_db() as conn:
        row = _get_user(conn, username)
        if not row:
            raise HTTPException(status_code=404, detail="user not found")
        if row[1] and (payload.password is not None or payload.is_admin is not None):
            # storage limits ARE settable on the guest (a public account is
            # exactly where a quota matters); credentials/privileges are not
            raise HTTPException(status_code=400, detail="the guest account has no password or privileges")
        if payload.password is not None:
            password = _check_password(payload.password)
            pwhash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            conn.execute("UPDATE users SET password_hash = ? WHERE username = ?", (pwhash, username))
            # Revoke existing sessions so a changed/leaked password can't be
            # ridden by an already-open session (incl. an attacker's).
            conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
            conn.execute("DELETE FROM integration_tokens WHERE username = ?", (username,))
        if payload.is_admin is not None:
            if not payload.is_admin and row[2] and _admin_count(conn) <= 1:
                raise HTTPException(status_code=400, detail="cannot demote the last admin")
            conn.execute("UPDATE users SET is_admin = ? WHERE username = ?",
                         (1 if payload.is_admin else 0, username))
        try:
            if "max_upload_mb" in payload.model_fields_set:
                value = None if payload.max_upload_mb is None else validate_upload_mb(payload.max_upload_mb)
                conn.execute("UPDATE users SET max_upload_mb = ? WHERE username = ?", (value, username))
            if "quota_mb" in payload.model_fields_set:
                value = None if payload.quota_mb is None else validate_quota_mb(payload.quota_mb)
                conn.execute("UPDATE users SET quota_mb = ? WHERE username = ?", (value, username))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        conn.commit()
        return {"users": _user_list(conn)}


class UserRenameRequest(BaseModel):
    new_username: str


def rename_account_rows(conn: sqlite3.Connection, old: str, new: str) -> None:
    """Every row that names an account (shared by the GUI and manage.py).
    Sessions and share tokens keep working — nobody is logged out, including
    the renamed user. Workspace directories are named by id, so no files move."""
    conn.execute("UPDATE users SET username = ? WHERE username = ?", (new, old))
    conn.execute("UPDATE sessions SET username = ? WHERE username = ?", (new, old))
    conn.execute("UPDATE integration_tokens SET username = ? WHERE username = ?", (new, old))
    conn.execute("UPDATE shares SET created_by = ? WHERE created_by = ?", (new, old))
    conn.execute("UPDATE workspace_members SET username = ? WHERE username = ?", (new, old))
    conn.execute("UPDATE workspace_members SET added_by = ? WHERE added_by = ?", (new, old))
    conn.execute("UPDATE workspaces SET created_by = ? WHERE created_by = ?", (new, old))
    conn.execute("UPDATE workspaces SET name = ? WHERE name = ? AND created_by = ?", (new, old, new))
    conn.execute("UPDATE user_prefs SET username = ? WHERE username = ?", (new, old))
    # Invited-people lists on shares ("carol:edit,dave:view") name accounts too.
    for token, allowed in conn.execute("SELECT token, allowed_users FROM shares WHERE allowed_users != ''").fetchall():
        parts = [p.strip() for p in allowed.split(",") if p.strip()]
        changed = [(new + p[len(old):]) if p == old or p.startswith(old + ":") else p for p in parts]
        if changed != parts:
            conn.execute("UPDATE shares SET allowed_users = ? WHERE token = ?", (",".join(changed), token))


@router.post("/users/{username}/rename")
async def rename_user(username: str, payload: UserRenameRequest, request: Request):
    """Rename an account (sessions and share tokens keep working — nobody is
    logged out, including the renamed user)."""
    require_admin(request)
    new = payload.new_username.strip()
    if not _USERNAME_RE.match(new):
        raise HTTPException(status_code=400,
                            detail="username must be 1-64 chars of letters, digits, '_', '.', '-'")
    with connect_users_db() as conn:
        row = _get_user(conn, username)
        if not row:
            raise HTTPException(status_code=404, detail="user not found")
        if row[1]:
            raise HTTPException(status_code=400, detail="the guest account cannot be renamed")
        if new == username:
            return {"users": _user_list(conn)}
        if _get_user(conn, new):
            raise HTTPException(status_code=409, detail="user already exists")
        rename_account_rows(conn, username, new)
        conn.commit()
        return {"users": _user_list(conn), "renamed": {"from": username, "to": new}}


@router.delete("/users/{username}")
async def delete_user(username: str, request: Request):
    """Delete an account. Its memberships go; the workspaces it alone owned
    (its personal one included) are deleted with their files — the response
    names them."""
    me = require_admin(request)
    if username == me:
        raise HTTPException(status_code=400, detail="cannot delete your own account")
    with connect_users_db() as conn:
        row = _get_user(conn, username)
        if not row:
            raise HTTPException(status_code=404, detail="user not found")
        if row[1]:
            raise HTTPException(status_code=400, detail="the guest account resets itself daily; it cannot be deleted")
        if row[2] and _admin_count(conn) <= 1:
            raise HTTPException(status_code=400, detail="cannot delete the last admin")
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.commit()
    deleted = workspaces.delete_account_workspaces(username)
    with connect_users_db() as conn:
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
        users = _user_list(conn)
    return {"users": users, "deleted_workspaces": deleted, "warning": ""}

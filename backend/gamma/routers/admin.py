"""Admin-only user management: the GUI mirror of manage.py.

Admin is a privilege flag (users.is_admin), not a special account name. Grant
the first one via `python manage.py set-admin <user> on` or the Docker
GAMMA_ADMIN_USER bootstrap; after that admins manage everyone from Settings.

Safety rails: the guest account can only be inspected (it is reset daily and
has no password), you cannot delete your own account, and the last remaining
admin cannot be demoted or deleted — so the instance can never lock itself out.
"""

import gc
import re
import shutil
import sqlite3

import bcrypt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_admin
from ..config import USERS_DIR
from ..db import connect_users_db, page_now
from ..logbuf import tail as _log_tail
from ..seed import create_user_dbs
from ..server_settings import (
    QUOTA_MB_MAX,
    QUOTA_MB_MIN,
    UPLOAD_MB_MAX,
    UPLOAD_MB_MIN,
    get_defaults,
    set_default_max_upload_mb,
    set_default_quota_mb,
    usage_bytes,
    validate_quota_mb,
    validate_upload_mb,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")  # names a data directory
MAX_PASSWORD_LEN = 128


def _user_list(conn: sqlite3.Connection) -> list:
    rows = conn.execute(
        "SELECT username, is_guest, is_admin, created_at, max_upload_mb, quota_mb "
        "FROM users ORDER BY created_at"
    ).fetchall()
    return [{"username": u, "is_guest": bool(g), "is_admin": bool(a), "created_at": c,
             "max_upload_mb": mu, "quota_mb": q,  # overrides; null = server default
             "used_bytes": usage_bytes(u)}
            for u, g, a, c, mu, q in rows]


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
    return {**get_defaults(),
            "max_upload_mb_range": [UPLOAD_MB_MIN, UPLOAD_MB_MAX],
            "quota_mb_range": [QUOTA_MB_MIN, QUOTA_MB_MAX]}


class SettingsUpdateRequest(BaseModel):
    max_upload_mb: int | None = None
    quota_mb: int | None = None  # 0 = unlimited


@router.put("/settings")
async def update_settings(payload: SettingsUpdateRequest, request: Request):
    require_admin(request)
    try:
        if payload.max_upload_mb is not None:
            set_default_max_upload_mb(payload.max_upload_mb)
        if payload.quota_mb is not None:
            set_default_quota_mb(payload.quota_mb)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return get_defaults()


@router.get("/users")
async def list_users(request: Request):
    me = require_admin(request)
    with connect_users_db() as conn:
        return {"users": _user_list(conn), "me": me}


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
        pwhash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        conn.execute(
            "INSERT INTO users (username, password_hash, is_guest, is_admin, created_at) VALUES (?, ?, 0, ?, ?)",
            (username, pwhash, 1 if payload.is_admin else 0, page_now()),
        )
        conn.commit()
        users = _user_list(conn)
    create_user_dbs(username)
    return {"users": users}


class UserUpdateRequest(BaseModel):
    password: str | None = None   # set a new password (never invalidates sessions)
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


@router.post("/users/{username}/rename")
async def rename_user(username: str, payload: UserRenameRequest, request: Request):
    """Rename an account (sessions and share tokens keep working — nobody is
    logged out, including the renamed user).

    The data directory is moved FIRST: on Windows a lingering SQLite handle
    can lock it, and failing before touching the database leaves everything
    consistent. Only after the move succeed do the rows change."""
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

        old_dir, new_dir = USERS_DIR / username, USERS_DIR / new
        if old_dir.exists():
            gc.collect()  # frees GC-delayed SQLite handles that would lock the move on Windows
            try:
                old_dir.rename(new_dir)
            except OSError:
                raise HTTPException(
                    status_code=409,
                    detail="the account's files are in use (someone is working in it right now) — "
                           "try again in a moment, or run manage.py rename-user with the server stopped")
        try:
            conn.execute("UPDATE users SET username = ? WHERE username = ?", (new, username))
            conn.execute("UPDATE sessions SET username = ? WHERE username = ?", (new, username))
            conn.execute("UPDATE shares SET username = ? WHERE username = ?", (new, username))
            conn.commit()
        except Exception:
            if new_dir.exists() and not old_dir.exists():
                new_dir.rename(old_dir)  # roll the move back so nothing is half-renamed
            raise
        return {"users": _user_list(conn), "renamed": {"from": username, "to": new}}


@router.delete("/users/{username}")
async def delete_user(username: str, request: Request):
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
        conn.execute("DELETE FROM shares WHERE username = ?", (username,))
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
        users = _user_list(conn)
    warning = ""
    user_dir = USERS_DIR / username
    if user_dir.exists():
        try:
            shutil.rmtree(str(user_dir))
        except OSError as e:
            # Windows: a lingering SQLite handle can lock the directory. The
            # account is gone either way; the files just need a manual sweep.
            warning = f"account deleted, but its data directory could not be removed ({e}); delete users/{username}/ manually"
    return {"users": users, "warning": warning}

"""Login, logout, session inspection, guest login, and workspace backups as
downloads / uploads (export, export-all, import-data — the zip itself is
gamma/ws_backup.py)."""

import os
import secrets
import shutil
import tempfile
import zipfile
from pathlib import Path

import bcrypt
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import ratelimit, workspaces, ws_backup
from ..auth import require_user, requested_ws, set_session_cookie
from ..ratelimit import client_ip
from ..db import connect_users_db, page_now, ws_dir
from ..seed import ensure_guest_user

router = APIRouter(prefix="/api", tags=["auth"])


# Zipping a big library takes a while and the client sees no bytes until the
# zip is done — this side-channel lets the UI poll a percent meanwhile. Plain
# dict keyed by workspace: worker thread writes, poll requests read
# (GIL-safe); a stale entry from a crashed export is simply overwritten.
_export_progress: dict[str, dict] = {}


def _target_ws(request: Request, ws: str | None, user: str | None, needed: str) -> str:
    """The workspace a backup call applies to. ``?ws=`` names one (else the
    request's usual workspace); ``?user=`` — admins only — means that
    account's personal workspace (the Settings → Users rows). The caller
    must hold ``needed`` (viewer / editor / owner) in it; server admins
    pass every check, because a backup is how they rescue an account."""
    me = require_user(request)
    if user and user != me:
        if not request.state.is_admin:
            raise HTTPException(status_code=403, detail="admin privilege required")
        target = workspaces.default_workspace(user)
        if not target:
            raise HTTPException(status_code=404, detail="no such user")
        return target
    target = ws or requested_ws(request) or request.state.default_ws
    if not workspaces.get(target):
        raise HTTPException(status_code=404, detail="workspace not found")
    if request.state.is_admin:
        return target
    role = workspaces.role_of(target, me)
    if not role:
        raise HTTPException(status_code=404, detail="workspace not found")
    if not workspaces.at_least(role, needed):
        raise HTTPException(status_code=403, detail=f"only a workspace {needed} can do that")
    return target


def _is_guest_workspace(ws: str) -> bool:
    return ws == workspaces.default_workspace("guest")


@router.get("/export-progress")
def export_progress(request: Request, ws: str | None = None, user: str | None = None):
    target = _target_ws(request, ws, user, "viewer")
    return _export_progress.get(target) or {"active": False, "total": 0, "done": 0}


# Sync endpoint on purpose: zipping a large library runs in the threadpool.
@router.get("/export")
def export_data(request: Request, uploads: int = 1, ws: str | None = None, user: str | None = None):
    """Full backup of a workspace as a zip (gamma/ws_backup.py): consistent
    SQLite snapshots plus every uploaded file; `uploads=0` skips the files
    for a small database-only backup. Restoring = /api/import-data into any
    workspace. Defaults to the request's workspace; any member may export
    it, and admins any workspace (?ws=) or account (?user=)."""
    target = _target_ws(request, ws, user, "viewer")
    if not ws_dir(target).exists():
        raise HTTPException(status_code=404, detail="no data for this workspace yet")
    prog = {"active": True, "total": 0, "done": 0}
    _export_progress[target] = prog
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        ws_backup.write_zip(target, Path(tmp.name), uploads=bool(uploads), by=request.state.user, progress=prog)
    except Exception:
        os.unlink(tmp.name)
        raise
    finally:
        prog["active"] = False
    kind = "" if uploads else "-db"
    return FileResponse(tmp.name, media_type="application/zip",
                        filename=f"gamma-export{kind}-{_slug(target)}-{page_now()[:10]}.zip",
                        background=BackgroundTask(os.unlink, tmp.name))


def _slug(ws: str) -> str:
    name = (workspaces.get(ws) or {}).get("name", "")
    return "".join(c if c.isalnum() else "-" for c in name).strip("-")[:40] or ws


# Sync on purpose, like /export.
@router.get("/export-all")
def export_all(request: Request, uploads: int = 1):
    """Every personal workspace of the session account in one zip — one
    /api/export zip per workspace inside (``<name>-<id>.zip``), each of
    which restores on its own through /api/import-data."""
    me = require_user(request)
    if request.state.is_guest:
        raise HTTPException(status_code=403, detail="the guest account has nothing to export as a whole")
    mine = workspaces.personal_workspaces(me)
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_STORED) as bundle:  # the inner zips are compressed
            for target in mine:
                inner = Path(tmp.name + "." + target + ".zip")
                try:
                    ws_backup.write_zip(target, inner, uploads=bool(uploads), by=me)
                    bundle.write(inner, f"{_slug(target)}-{target}.zip")
                finally:
                    inner.unlink(missing_ok=True)
    except Exception:
        os.unlink(tmp.name)
        raise
    kind = "" if uploads else "-db"
    return FileResponse(tmp.name, media_type="application/zip",
                        filename=f"gamma-export-all{kind}-{me}-{page_now()[:10]}.zip",
                        background=BackgroundTask(os.unlink, tmp.name))


# Sync on purpose: unzip + sqlite restore runs in the threadpool.
@router.post("/import-data")
def import_data(request: Request, file: UploadFile = File(...), mode: str = "replace",
                ws: str | None = None, user: str | None = None):
    """Restore an /api/export zip into a workspace (the request's, ``?ws=``,
    or — admins only — the personal workspace of ``?user=``): mode=replace
    (default, owners) swaps the databases, mode=merge (editors) adds what is
    missing — gamma/ws_backup.restore_zip. Nothing can be imported into the
    guest workspace: it is shared, and one visitor could wipe it for
    everyone."""
    if mode not in ("replace", "merge"):
        raise HTTPException(status_code=400, detail="mode must be 'replace' or 'merge'")
    target = _target_ws(request, ws, user, "owner" if mode == "replace" else "editor")
    if _is_guest_workspace(target):
        raise HTTPException(status_code=403, detail="the guest workspace cannot import backups")
    with tempfile.TemporaryDirectory(prefix="gamma-import-") as td:
        zpath = Path(td) / "backup.zip"
        with open(zpath, "wb") as out:
            shutil.copyfileobj(file.file, out)
        try:
            return {"ok": True, **ws_backup.restore_zip(target, zpath, mode)}
        except ws_backup.BackupError as e:
            raise HTTPException(status_code=400, detail=str(e))


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(payload: LoginRequest, request: Request):
    # Throttle guessing: per-IP and per-username fixed windows. bcrypt is slow
    # by design, but that alone doesn't stop distributed/patient guessing.
    ip = client_ip(request)
    ratelimit.check(f"login:ip:{ip}", max_hits=10, window_seconds=300)
    ratelimit.check(f"login:user:{payload.username}", max_hits=10, window_seconds=300)
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT username, password_hash, is_guest FROM users WHERE username = ?",
            (payload.username,),
        ).fetchone()
    if not row or row[2]:  # guest accounts have no password
        raise HTTPException(status_code=401, detail="invalid credentials")
    if not bcrypt.checkpw(payload.password.encode(), row[1].encode()):
        raise HTTPException(status_code=401, detail="invalid credentials")
    ratelimit.reset(f"login:ip:{ip}")
    ratelimit.reset(f"login:user:{payload.username}")
    token = secrets.token_urlsafe(32)
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
            (token, row[0], page_now()),
        )
        conn.commit()
    resp = JSONResponse({"ok": True, "username": row[0]})
    set_session_cookie(resp, token, request)
    return resp


@router.post("/logout")
async def logout(request: Request):
    token = request.cookies.get("session")
    if token:
        with connect_users_db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("session")
    return resp


@router.get("/session")
async def get_session(request: Request):
    """Who am I, plus the workspaces I belong to (``workspaces``: [{id,
    name, role, personal, members}]) and my default one — enough for the
    frontend to pick a workspace and paint the switcher without another
    round trip."""
    user = request.state.user
    if not user:
        return {"user": None}
    return {"user": user, "is_guest": request.state.is_guest, "is_admin": request.state.is_admin,
            "default_workspace": request.state.default_ws or workspaces.ensure_personal(user),
            "workspaces": workspaces.list_for_user(user)}


@router.get("/accounts")
async def list_accounts(request: Request):
    """The account directory — ``{accounts: [{username, is_admin}]}``, every
    non-guest account by name — for the invite and owner pickers. Any
    signed-in non-guest account may read it (a self-hosted server's
    members know each other; the guest sees nothing)."""
    require_user(request)
    if request.state.is_guest:
        raise HTTPException(status_code=403, detail="the guest account cannot list accounts")
    return {"accounts": workspaces.accounts()}


@router.post("/login-guest")
async def login_guest(request: Request):
    from datetime import datetime, timezone

    # Each call mints a permanent session row; cap the rate so a public instance
    # can't be flooded into unbounded session-table growth.
    ratelimit.check(f"guest:ip:{client_ip(request)}", max_hits=20, window_seconds=300)
    ensure_guest_user()  # the account row and its workspace (files repaired if missing)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    token = secrets.token_urlsafe(32)
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, username, guest_date, created_at) VALUES (?, 'guest', ?, ?)",
            (token, today, page_now()),
        )
        conn.commit()
    resp = JSONResponse({"ok": True, "username": "guest"})
    set_session_cookie(resp, token, request)
    return resp

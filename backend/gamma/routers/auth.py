"""Login, logout, session inspection, guest login, and workspace backups
(export / restore)."""

import json
import os
import secrets
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path

import bcrypt
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fractional_indexing import generate_n_keys_between
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import ratelimit, workspaces
from ..auth import require_user, requested_ws, set_session_cookie
from ..ratelimit import client_ip
from ..blocks_store import BLOCK_COLUMNS, fetch_subtree, last_child_position
from ..db import connect_users_db, page_now, ws_dir
from ..normalize import normalize_data_db, normalize_pages_db
from ..seed import create_workspace_files, ensure_guest_user

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
    """Full backup of a workspace as a zip: consistent SQLite snapshots (via
    the sqlite backup API, safe while the app is running) plus every uploaded
    file. `uploads=0` skips the uploaded files for a small database-only
    backup. Restoring = /api/import-data into any workspace.

    Defaults to the request's workspace; any member may export it, and
    admins any workspace (?ws=) or account (?user=)."""
    target = _target_ws(request, ws, user, "viewer")
    root = ws_dir(target)
    if not root.exists():
        raise HTTPException(status_code=404, detail="no data for this workspace yet")

    # Input bytes to process, known up front — the basis for the percent.
    upload_files = []
    uploads_dir = root / "uploads"
    if uploads and uploads_dir.exists():
        upload_files = sorted(f for f in uploads_dir.iterdir() if f.is_file())
    db_files = [root / n for n in ("pages.db", "data.db") if (root / n).exists()]
    prog = {"active": True,
            "total": sum(f.stat().st_size for f in db_files + upload_files),
            "done": 0}
    _export_progress[target] = prog

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
            for src in db_files:
                snap = Path(tmp.name + "." + src.name)
                # sqlite3's context manager commits but does NOT close — on
                # Windows the open handle would block unlink, so close explicitly.
                src_conn = sqlite3.connect(str(src))
                dst_conn = sqlite3.connect(str(snap))
                try:
                    src_conn.backup(dst_conn)
                finally:
                    src_conn.close()
                    dst_conn.close()
                z.write(snap, src.name)
                snap.unlink()
                prog["done"] += src.stat().st_size
            for f in upload_files:
                z.write(f, f"uploads/{f.name}")
                prog["done"] += f.stat().st_size
            info = workspaces.get(target) or {}
            z.writestr("manifest.json", json.dumps({
                "format": "gamma-backup-1",
                "workspace": target,
                "workspace_name": info.get("name", ""),
                "user": workspaces.billing_user(target),  # whose storage it counts against
                "exported_by": request.state.user,
                "exported_at": page_now(),
                "uploads": bool(uploads),
            }, indent=2))
    except Exception:
        os.unlink(tmp.name)
        raise
    finally:
        prog["active"] = False
    kind = "" if uploads else "-db"
    name = (workspaces.get(target) or {}).get("name", "")
    slug = "".join(c if c.isalnum() else "-" for c in name).strip("-")[:40] or target
    filename = f"gamma-export{kind}-{slug}-{page_now()[:10]}.zip"
    return FileResponse(tmp.name, media_type="application/zip", filename=filename,
                        background=BackgroundTask(os.unlink, tmp.name))


def _merge_backup(root: Path, tdir: Path) -> dict:
    """Additive import: pages from the backup that don't exist locally (by
    block id, or by doc_id for PDF pages) are appended to the library; pages
    that do exist are left untouched (live data always wins). Chats merge the
    same way; nothing else in the backup's data.db is touched."""
    pages_added = pages_skipped = chats_added = 0
    snap = tdir / "pages.db"
    if snap.exists():
        src = sqlite3.connect(str(snap))
        dst = sqlite3.connect(str(root / "pages.db"))
        try:
            normalize_pages_db(src)
            live_ids = {r[0] for r in dst.execute("SELECT id FROM unified_blocks")}
            live_docs = {r[0] for r in dst.execute(
                "SELECT json_extract(properties, '$.doc_id') FROM unified_blocks "
                "WHERE parent_id = 'root' AND json_extract(properties, '$.doc_id') IS NOT NULL")}
            new_roots = []
            for row in src.execute(
                f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = 'root' "
                "ORDER BY position ASC").fetchall():
                doc_id = json.loads(row[4] or "{}").get("doc_id")
                if row[0] in live_ids or (doc_id and doc_id in live_docs):
                    pages_skipped += 1
                    continue
                new_roots.append(row)
            if new_roots:
                keys = generate_n_keys_between(last_child_position(dst, "root"), None, n=len(new_roots))
                for row, key in zip(new_roots, keys):
                    for srow in fetch_subtree(src, row[0]):
                        vals = list(srow)
                        if vals[0] == row[0]:
                            vals[2] = key  # append after the existing root pages
                        # Ids are random tokens: a collision means the very same
                        # block came in twice (e.g. re-importing a backup) — keep ours.
                        dst.execute(
                            f"INSERT OR IGNORE INTO unified_blocks ({BLOCK_COLUMNS}) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?)", vals)
                    pages_added += 1
                dst.commit()
        finally:
            src.close()
            dst.close()

    snap = tdir / "data.db"
    if snap.exists():
        src = sqlite3.connect(str(snap))
        dst = sqlite3.connect(str(root / "data.db"))
        try:
            src_tables = {r[0] for r in src.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")}
            if "chats" in src_tables:
                dst.execute("CREATE TABLE IF NOT EXISTS chats "
                            "(block_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL, "
                            "title TEXT NOT NULL DEFAULT '')")
                for row in src.execute("SELECT block_id, messages, updated_at FROM chats"):
                    cur = dst.execute(
                        "INSERT OR IGNORE INTO chats (block_id, messages, updated_at) VALUES (?, ?, ?)", row)
                    chats_added += cur.rowcount
                dst.commit()
        finally:
            src.close()
            dst.close()
    return {"pages_added": pages_added, "pages_skipped": pages_skipped, "chats_added": chats_added}


# Sync on purpose: unzip + sqlite restore runs in the threadpool.
@router.post("/import-data")
def import_data(request: Request, file: UploadFile = File(...), mode: str = "replace",
                ws: str | None = None, user: str | None = None):
    """Restore an /api/export zip into a workspace (the request's, ``?ws=``,
    or — admins only — the personal workspace of ``?user=``).

    mode=replace (default, owners only): pages.db and data.db are REPLACED
    (via the sqlite backup API, so the swap is transactional and safe while
    the app is serving) and normalized (gamma/normalize.py — a backup can be
    older than the current shapes). mode=merge (editors): additive — see
    _merge_backup. In both modes uploads are merged in (filenames are
    content hashes, so identical files never conflict and nothing existing
    gets overwritten). Everything is validated before any live data is
    touched. Nothing can be imported into the guest workspace: it is shared,
    and one visitor could wipe it for everyone."""
    if mode not in ("replace", "merge"):
        raise HTTPException(status_code=400, detail="mode must be 'replace' or 'merge'")
    target = _target_ws(request, ws, user, "owner" if mode == "replace" else "editor")
    if _is_guest_workspace(target):
        raise HTTPException(status_code=403, detail="the guest workspace cannot import backups")

    with tempfile.TemporaryDirectory(prefix="gamma-import-") as td:
        tdir = Path(td)
        zpath = tdir / "backup.zip"
        with open(zpath, "wb") as out:
            shutil.copyfileobj(file.file, out)
        try:
            zf = zipfile.ZipFile(zpath)
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="not a zip file")

        with zf:
            names = set(zf.namelist())
            if "manifest.json" in names:
                try:
                    fmt = json.loads(zf.read("manifest.json")).get("format")
                except Exception:
                    fmt = None
                if fmt != "gamma-backup-1":
                    raise HTTPException(status_code=400, detail="unsupported backup format")
            if "pages.db" not in names:
                raise HTTPException(status_code=400, detail="not a Gamma backup (no pages.db in the zip)")
            for dbname in ("pages.db", "data.db"):
                if dbname in names:
                    with zf.open(dbname) as src, open(tdir / dbname, "wb") as out:
                        shutil.copyfileobj(src, out)
            (tdir / "uploads").mkdir()
            upload_names = []
            for n in sorted(names):
                base = os.path.basename(n)
                # Accept flat uploads/<file> entries only — the exporter never
                # writes nested paths or dotfiles (also a zip-slip guard).
                if n != f"uploads/{base}" or not base or base.startswith("."):
                    continue
                with zf.open(n) as src, open(tdir / "uploads" / base, "wb") as out:
                    shutil.copyfileobj(src, out)
                upload_names.append(base)

        # Validate before touching live data. data.db needs no table check:
        # every access path applies DATA_SCHEMA (IF NOT EXISTS) on connect.
        for dbname, required_table in (("pages.db", "unified_blocks"), ("data.db", None)):
            snap = tdir / dbname
            if not snap.exists():
                continue
            try:
                conn = sqlite3.connect(str(snap))
                try:
                    tables = {r[0] for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'")}
                finally:
                    conn.close()
            except sqlite3.DatabaseError:
                raise HTTPException(status_code=400,
                                    detail=f"{dbname} in the zip is not a valid SQLite database")
            if required_table and required_table not in tables:
                raise HTTPException(status_code=400,
                                    detail=f"{dbname} in the zip has no {required_table} table")

        root = ws_dir(target)
        if not (root / "pages.db").exists():
            create_workspace_files(target)

        if mode == "merge":
            result = _merge_backup(root, tdir)
        else:
            restored = []
            for dbname in ("pages.db", "data.db"):
                snap = tdir / dbname
                if not snap.exists():
                    continue
                src_conn = sqlite3.connect(str(snap))
                dst_conn = sqlite3.connect(str(root / dbname))
                try:
                    src_conn.backup(dst_conn)
                    # The backup may predate today's shapes.
                    if dbname == "pages.db":
                        normalize_pages_db(dst_conn)
                    else:
                        normalize_data_db(dst_conn)
                finally:
                    src_conn.close()
                    dst_conn.close()
                restored.append(dbname)
            result = {"restored": restored}

        dest_uploads = root / "uploads"
        dest_uploads.mkdir(parents=True, exist_ok=True)
        uploads_added = 0
        for base in upload_names:
            target_file = dest_uploads / base
            if not target_file.exists():
                shutil.copyfile(tdir / "uploads" / base, target_file)
                uploads_added += 1

    return {"ok": True, "mode": mode, "workspace": target, **result,
            "uploads_in_backup": len(upload_names), "uploads_added": uploads_added}


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

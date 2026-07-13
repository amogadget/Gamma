"""Login, logout, session inspection, guest login, and data export/import."""

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
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from ..auth import require_user, set_session_cookie
from ..config import USERS_DIR
from ..db import connect_users_db, page_now
from ..seed import create_user_dbs, ensure_guest_user, reset_guest_data

router = APIRouter(prefix="/api", tags=["auth"])


# Sync endpoint on purpose: zipping a large library runs in the threadpool.
@router.get("/export")
def export_data(request: Request):
    """Full backup of the requesting user's data as a zip: consistent SQLite
    snapshots (via the sqlite backup API, safe while the app is running) plus
    every uploaded file. Restoring = unpacking into users/<name>/."""
    user = require_user(request)
    user_dir = Path(USERS_DIR) / user
    if not user_dir.exists():
        raise HTTPException(status_code=404, detail="no data for this user yet")

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
            for dbname in ("pages.db", "data.db"):
                src = user_dir / dbname
                if not src.exists():
                    continue
                snap = Path(tmp.name + "." + dbname)
                # sqlite3's context manager commits but does NOT close — on
                # Windows the open handle would block unlink, so close explicitly.
                src_conn = sqlite3.connect(str(src))
                dst_conn = sqlite3.connect(str(snap))
                try:
                    src_conn.backup(dst_conn)
                finally:
                    src_conn.close()
                    dst_conn.close()
                z.write(snap, dbname)
                snap.unlink()
            uploads = user_dir / "uploads"
            if uploads.exists():
                for f in sorted(uploads.iterdir()):
                    if f.is_file():
                        z.write(f, f"uploads/{f.name}")
            z.writestr("manifest.json", json.dumps({
                "format": "gamma-backup-1",
                "user": user,
                "exported_at": page_now(),
            }, indent=2))
    except Exception:
        os.unlink(tmp.name)
        raise
    filename = f"gamma-export-{user}-{page_now()[:10]}.zip"
    return FileResponse(tmp.name, media_type="application/zip", filename=filename,
                        background=BackgroundTask(os.unlink, tmp.name))


# Sync on purpose: unzip + sqlite restore runs in the threadpool.
@router.post("/import-data")
def import_data(request: Request, file: UploadFile = File(...)):
    """Restore an /api/export zip into the requesting user's workspace.

    pages.db and data.db are REPLACED (via the sqlite backup API, so the swap
    is transactional and safe while the app is serving); uploads are merged in
    (filenames are content hashes, so identical files never conflict and
    nothing existing gets overwritten). Everything is validated before any
    live data is touched. Guests can't import: one visitor could wipe the
    shared demo workspace for everyone."""
    user = require_user(request)
    if request.state.is_guest:
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

        user_dir = Path(USERS_DIR) / user
        if not (user_dir / "pages.db").exists():
            create_user_dbs(user)
        restored = []
        for dbname in ("pages.db", "data.db"):
            snap = tdir / dbname
            if not snap.exists():
                continue
            src_conn = sqlite3.connect(str(snap))
            dst_conn = sqlite3.connect(str(user_dir / dbname))
            try:
                src_conn.backup(dst_conn)
            finally:
                src_conn.close()
                dst_conn.close()
            restored.append(dbname)

        dest_uploads = user_dir / "uploads"
        dest_uploads.mkdir(parents=True, exist_ok=True)
        uploads_added = 0
        for base in upload_names:
            target = dest_uploads / base
            if not target.exists():
                shutil.copyfile(tdir / "uploads" / base, target)
                uploads_added += 1

    return {"ok": True, "restored": restored,
            "uploads_in_backup": len(upload_names), "uploads_added": uploads_added}


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(payload: LoginRequest):
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT username, password_hash, is_guest FROM users WHERE username = ?",
            (payload.username,),
        ).fetchone()
    if not row or row[2]:  # guest accounts have no password
        raise HTTPException(status_code=401, detail="invalid credentials")
    if not bcrypt.checkpw(payload.password.encode(), row[1].encode()):
        raise HTTPException(status_code=401, detail="invalid credentials")
    token = secrets.token_urlsafe(32)
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
            (token, row[0], page_now()),
        )
        conn.commit()
    resp = JSONResponse({"ok": True, "username": row[0]})
    set_session_cookie(resp, token)
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
    user = request.state.user
    if not user:
        return {"user": None}
    return {"user": user, "is_guest": request.state.is_guest, "is_admin": request.state.is_admin}


@router.post("/login-guest")
async def login_guest():
    from datetime import datetime, timezone

    ensure_guest_user()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    token = secrets.token_urlsafe(32)
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, username, guest_date, created_at) VALUES (?, 'guest', ?, ?)",
            (token, today, page_now()),
        )
        conn.commit()
    # Ensure guest databases exist
    if not (USERS_DIR / "guest" / "pages.db").exists():
        reset_guest_data()
    resp = JSONResponse({"ok": True, "username": "guest"})
    set_session_cookie(resp, token)
    return resp

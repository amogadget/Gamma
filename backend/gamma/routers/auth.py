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
from fractional_indexing import generate_n_keys_between
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from ..auth import require_user, set_session_cookie
from ..blocks_store import BLOCK_COLUMNS, fetch_subtree, last_child_position
from ..config import USERS_DIR
from ..db import connect_users_db, page_now
from ..seed import create_user_dbs, ensure_guest_user, reset_guest_data

router = APIRouter(prefix="/api", tags=["auth"])


# Zipping a big library takes a while and the client sees no bytes until the
# zip is done — this side-channel lets the UI poll a percent meanwhile. Plain
# dict keyed by user: worker thread writes, poll requests read (GIL-safe);
# a stale entry from a crashed export is simply overwritten by the next one.
_export_progress: dict[str, dict] = {}


@router.get("/export-progress")
def export_progress(request: Request):
    user = require_user(request)
    return _export_progress.get(user) or {"active": False, "total": 0, "done": 0}


# Sync endpoint on purpose: zipping a large library runs in the threadpool.
@router.get("/export")
def export_data(request: Request, uploads: int = 1):
    """Full backup of the requesting user's data as a zip: consistent SQLite
    snapshots (via the sqlite backup API, safe while the app is running) plus
    every uploaded file. `uploads=0` skips the uploaded files for a small
    database-only backup. Restoring = unpacking into users/<name>/."""
    user = require_user(request)
    user_dir = Path(USERS_DIR) / user
    if not user_dir.exists():
        raise HTTPException(status_code=404, detail="no data for this user yet")

    # Input bytes to process, known up front — the basis for the percent.
    upload_files = []
    uploads_dir = user_dir / "uploads"
    if uploads and uploads_dir.exists():
        upload_files = sorted(f for f in uploads_dir.iterdir() if f.is_file())
    db_files = [user_dir / n for n in ("pages.db", "data.db") if (user_dir / n).exists()]
    prog = {"active": True, "total": sum(f.stat().st_size for f in db_files + upload_files), "done": 0}
    _export_progress[user] = prog

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
            z.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "format": "gamma-backup-1",
                        "user": user,
                        "exported_at": page_now(),
                        "uploads": bool(uploads),
                    },
                    indent=2,
                ),
            )
    except Exception:
        os.unlink(tmp.name)
        raise
    finally:
        prog["active"] = False
    kind = "" if uploads else "-db"
    filename = f"gamma-export{kind}-{user}-{page_now()[:10]}.zip"
    return FileResponse(
        tmp.name, media_type="application/zip", filename=filename, background=BackgroundTask(os.unlink, tmp.name)
    )


def _merge_backup(user_dir: Path, tdir: Path) -> dict:
    """Additive import: pages from the backup that don't exist locally (by
    block id, or by doc_id for PDF pages) are appended to the library; pages
    that do exist are left untouched (live data always wins). Chats merge the
    same way; prefs (open tabs, AI provider keys) are never touched."""
    pages_added = pages_skipped = chats_added = 0
    snap = tdir / "pages.db"
    if snap.exists():
        src = sqlite3.connect(str(snap))
        dst = sqlite3.connect(str(user_dir / "pages.db"))
        try:
            live_ids = {r[0] for r in dst.execute("SELECT id FROM unified_blocks")}
            live_docs = {
                r[0]
                for r in dst.execute(
                    "SELECT json_extract(properties, '$.doc_id') FROM unified_blocks "
                    "WHERE parent_id = 'root' AND json_extract(properties, '$.doc_id') IS NOT NULL"
                )
            }
            new_roots = []
            for row in src.execute(
                f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE parent_id = 'root' ORDER BY position ASC"
            ).fetchall():
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
                            f"INSERT OR IGNORE INTO unified_blocks ({BLOCK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)", vals
                        )
                    pages_added += 1
                dst.commit()
        finally:
            src.close()
            dst.close()

    snap = tdir / "data.db"
    if snap.exists():
        src = sqlite3.connect(str(snap))
        dst = sqlite3.connect(str(user_dir / "data.db"))
        try:
            src_tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            if "chats" in src_tables:
                dst.execute(
                    "CREATE TABLE IF NOT EXISTS chats "
                    "(block_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL)"
                )
                for row in src.execute("SELECT block_id, messages, updated_at FROM chats"):
                    cur = dst.execute(
                        "INSERT OR IGNORE INTO chats (block_id, messages, updated_at) VALUES (?, ?, ?)", row
                    )
                    chats_added += cur.rowcount
                dst.commit()
        finally:
            src.close()
            dst.close()
    return {"pages_added": pages_added, "pages_skipped": pages_skipped, "chats_added": chats_added}


# Sync on purpose: unzip + sqlite restore runs in the threadpool.
@router.post("/import-data")
def import_data(request: Request, file: UploadFile = File(...), mode: str = "replace"):
    """Restore an /api/export zip into the requesting user's workspace.

    mode=replace (default): pages.db and data.db are REPLACED (via the sqlite
    backup API, so the swap is transactional and safe while the app is
    serving). mode=merge: additive — see _merge_backup. In both modes uploads
    are merged in (filenames are content hashes, so identical files never
    conflict and nothing existing gets overwritten). Everything is validated
    before any live data is touched. Guests can't import: one visitor could
    wipe the shared demo workspace for everyone."""
    user = require_user(request)
    if request.state.is_guest:
        raise HTTPException(status_code=403, detail="the guest workspace cannot import backups")
    if mode not in ("replace", "merge"):
        raise HTTPException(status_code=400, detail="mode must be 'replace' or 'merge'")

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
                    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                finally:
                    conn.close()
            except sqlite3.DatabaseError:
                raise HTTPException(status_code=400, detail=f"{dbname} in the zip is not a valid SQLite database")
            if required_table and required_table not in tables:
                raise HTTPException(status_code=400, detail=f"{dbname} in the zip has no {required_table} table")

        user_dir = Path(USERS_DIR) / user
        if not (user_dir / "pages.db").exists():
            create_user_dbs(user)

        if mode == "merge":
            result = _merge_backup(user_dir, tdir)
        else:
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
            result = {"restored": restored}

        dest_uploads = user_dir / "uploads"
        dest_uploads.mkdir(parents=True, exist_ok=True)
        uploads_added = 0
        for base in upload_names:
            target = dest_uploads / base
            if not target.exists():
                shutil.copyfile(tdir / "uploads" / base, target)
                uploads_added += 1

    return {"ok": True, "mode": mode, **result, "uploads_in_backup": len(upload_names), "uploads_added": uploads_added}


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

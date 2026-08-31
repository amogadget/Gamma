"""Login, logout, session inspection, guest login, and data export/import."""

import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
import tempfile
import time
import zipfile
from pathlib import Path

import bcrypt
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fractional_indexing import generate_n_keys_between
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import ratelimit
from ..auth import require_user, set_session_cookie
from ..ratelimit import client_ip
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
_IMPORT_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
_IMPORT_MAX_ENTRIES = 10_010
_IMPORT_MAX_UNCOMPRESSED_BYTES = 1280 * 1024 * 1024
_IMPORT_MAX_DB_BYTES = 256 * 1024 * 1024
_IMPORT_MAX_MANIFEST_BYTES = 1024 * 1024
_IMPORT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
_IMPORT_MAX_SECONDS = 120
_IMPORT_CHUNK_BYTES = 1024 * 1024
_GAMMA_IMPORT_MAX_PAGES = 500
_GAMMA_IMPORT_MAX_BLOCKS = 100_000
_IMPORT_UPLOAD_RE = re.compile(
    r"^[0-9a-fA-F]{8,64}(?:-flat)?\.(?:pdf|png|jpe?g|gif|webp|svg|bmp)$"
)
_IMPORT_UPLOAD_REF_RE = re.compile(r"/api/uploads/([^\s\"')\]}>,]+)")


def _copy_limited(source, output, limit: int, deadline: float) -> int:
    """Copy a stream while enforcing bytes and wall-clock work limits."""
    total = 0
    while True:
        if time.monotonic() > deadline:
            raise HTTPException(status_code=413, detail="backup import work limit exceeded")
        chunk = source.read(_IMPORT_CHUNK_BYTES)
        if not chunk:
            return total
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail="backup import is too large")
        output.write(chunk)


def _validated_backup_members(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    """Validate every archive member before extracting any of them."""
    infos = archive.infolist()
    if len(infos) > _IMPORT_MAX_ENTRIES:
        raise HTTPException(status_code=413, detail="too many files in backup")
    members = {}
    total_size = 0
    upload_size = 0
    for info in infos:
        name = info.filename
        if name in members:
            raise HTTPException(status_code=400, detail="duplicate filename in backup")
        if (
            not name
            or name.startswith("/")
            or "\\" in name
            or info.is_dir()
            or any(part in {"", ".", ".."} for part in name.split("/"))
        ):
            raise HTTPException(status_code=400, detail="invalid filename in backup")
        mode = (info.external_attr >> 16) & 0o170000
        if mode == stat.S_IFLNK or info.flag_bits & 0x1:
            raise HTTPException(status_code=400, detail="unsafe file in backup")
        if name not in {"manifest.json", "pages.db", "data.db"}:
            if not name.startswith("uploads/") or name.count("/") != 1:
                raise HTTPException(status_code=400, detail="unexpected file in backup")
            upload_name = name.split("/", 1)[1]
            if not _IMPORT_UPLOAD_RE.fullmatch(upload_name):
                raise HTTPException(status_code=400, detail="invalid upload filename in backup")
            upload_size += info.file_size
        if name in {"pages.db", "data.db"} and info.file_size > _IMPORT_MAX_DB_BYTES:
            raise HTTPException(status_code=413, detail=f"{name} in backup is too large")
        if name == "manifest.json" and info.file_size > _IMPORT_MAX_MANIFEST_BYTES:
            raise HTTPException(status_code=413, detail="manifest in backup is too large")
        total_size += info.file_size
        if total_size > _IMPORT_MAX_UNCOMPRESSED_BYTES:
            raise HTTPException(status_code=413, detail="expanded backup is too large")
        if upload_size > _IMPORT_MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="uploads in backup are too large")
        members[name] = info
    return members


def _target_user(request: Request, target: str | None) -> tuple[str, bool]:
    """The account an export/import applies to, as (username, is_guest).

    Normally the session user. Admins may name any account with ?user= — the
    Settings > Users pane offers each row a Data button — but a backup carries
    every note and PDF of an account, so nobody else can ever name one but
    their own.
    """
    user = require_user(request)
    if target and target != user:
        if not request.state.is_admin:
            raise HTTPException(status_code=403, detail="admin privilege required")
        with connect_users_db() as conn:
            row = conn.execute(
                "SELECT username, is_guest FROM users WHERE username = ?", (target,)
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="no such user")
        return row[0], bool(row[1])
    return user, bool(request.state.is_guest)


@router.get("/export-progress")
def export_progress(request: Request, user: str | None = None):
    who, _ = _target_user(request, user)
    return _export_progress.get(who) or {"active": False, "total": 0, "done": 0}


# Sync endpoint on purpose: zipping a large library runs in the threadpool.
@router.get("/export")
def export_data(request: Request, uploads: int = 1, user: str | None = None):
    """Full backup of an account's data as a zip: consistent SQLite snapshots
    (via the sqlite backup API, safe while the app is running) plus every
    uploaded file. `uploads=0` skips the uploaded files for a small
    database-only backup. Restoring = unpacking into users/<name>/.

    Defaults to the requesting user; admins can back up any account (?user=)."""
    user, _ = _target_user(request, user)
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


def _validate_scoped_backup(
    tdir: Path,
    manifest: dict,
    upload_names: list[str],
    deadline: float,
):
    """Validate scoped DB contents before additive merge touches live data."""
    scope = manifest.get("scope")
    uploads = manifest.get("uploads")
    if not isinstance(scope, dict) or not isinstance(uploads, dict):
        raise HTTPException(status_code=400, detail="invalid scoped backup manifest")
    scope_type = scope.get("type")
    folder = scope.get("folder")
    manifest_page_ids = scope.get("page_ids")
    folder_parts = folder.split("/") if isinstance(folder, str) else []
    valid_folder = bool(
        folder_parts
        and len(folder) <= 512
        and folder == folder.strip().strip("/")
        and all(part and part not in {".", ".."} for part in folder_parts)
        and not any(ord(char) < 32 for char in folder)
    )
    if (
        scope_type not in {"page", "folder"}
        or (scope_type == "page" and folder is not None)
        or (scope_type == "folder" and not valid_folder)
        or not isinstance(manifest_page_ids, list)
        or not all(isinstance(value, str) for value in manifest_page_ids)
        or len(set(manifest_page_ids)) != len(manifest_page_ids)
        or scope.get("pages") != len(manifest_page_ids)
    ):
        raise HTTPException(status_code=400, detail="invalid scoped backup scope")
    included = uploads.get("included")
    missing = uploads.get("missing")
    if (
        not isinstance(included, list)
        or not isinstance(missing, list)
        or not all(_IMPORT_UPLOAD_RE.fullmatch(value or "") for value in included + missing)
        or len(set(included)) != len(included)
        or len(set(missing)) != len(missing)
        or set(included) & set(missing)
        or set(included) != set(upload_names)
    ):
        raise HTTPException(status_code=400, detail="invalid scoped upload manifest")

    pages_path = tdir / "pages.db"
    with sqlite3.connect(f"file:{pages_path}?mode=ro", uri=True) as connection:
        connection.execute("PRAGMA query_only = ON")
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise HTTPException(status_code=400, detail="pages.db failed integrity check")
        objects = {
            (row[0], row[1])
            for row in connection.execute(
                "SELECT type, name FROM sqlite_master "
                "WHERE name NOT LIKE 'sqlite_%'"
            )
        }
        if any(kind in {"trigger", "view"} for kind, _ in objects):
            raise HTTPException(status_code=400, detail="unsafe schema in scoped pages.db")
        tables = {name for kind, name in objects if kind == "table"}
        if tables != {"unified_blocks"}:
            raise HTTPException(status_code=400, detail="unexpected table in scoped pages.db")
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(unified_blocks)")
        }
        required = {
            "id", "parent_id", "position", "content", "properties",
            "created_at", "updated_at",
        }
        if not required <= columns:
            raise HTTPException(status_code=400, detail="invalid scoped pages.db schema")
        rows = connection.execute(
            "SELECT id, parent_id, content, properties FROM unified_blocks "
            "LIMIT ?",
            (_GAMMA_IMPORT_MAX_BLOCKS + 1,),
        ).fetchall()
    if len(rows) > _GAMMA_IMPORT_MAX_BLOCKS:
        raise HTTPException(status_code=413, detail="too many blocks in scoped backup")
    if time.monotonic() > deadline:
        raise HTTPException(status_code=413, detail="backup import work limit exceeded")
    parents = {}
    root_ids = []
    referenced_uploads = set()
    for block_id, parent_id, content, properties_text in rows:
        if (
            not isinstance(block_id, str)
            or not block_id
            or len(block_id) > 256
            or block_id in parents
            or not isinstance(parent_id, str)
        ):
            raise HTTPException(status_code=400, detail="invalid block id in scoped backup")
        try:
            properties = json.loads(properties_text or "{}")
        except (TypeError, json.JSONDecodeError):
            raise HTTPException(status_code=400, detail="invalid block properties in scoped backup")
        if not isinstance(properties, dict):
            raise HTTPException(status_code=400, detail="invalid block properties in scoped backup")
        for text in (content or "", properties_text or ""):
            matches = _IMPORT_UPLOAD_REF_RE.findall(text)
            if "/api/uploads/" in text and not matches:
                raise HTTPException(
                    status_code=400,
                    detail="invalid upload reference in scoped backup",
                )
            if any(not _IMPORT_UPLOAD_RE.fullmatch(name) for name in matches):
                raise HTTPException(
                    status_code=400,
                    detail="invalid upload reference in scoped backup",
                )
            referenced_uploads.update(matches)
        doc_id = properties.get("doc_id")
        if doc_id:
            pdf_name = f"{doc_id}.pdf"
            if not _IMPORT_UPLOAD_RE.fullmatch(pdf_name):
                raise HTTPException(status_code=400, detail="invalid document id in scoped backup")
            referenced_uploads.add(pdf_name)
        parents[block_id] = parent_id
        if parent_id == "root":
            root_ids.append(block_id)
    if referenced_uploads != set(included) | set(missing):
        raise HTTPException(
            status_code=400,
            detail="scoped upload manifest does not match pages.db",
        )
    if len(root_ids) > _GAMMA_IMPORT_MAX_PAGES or set(root_ids) != set(manifest_page_ids):
        raise HTTPException(status_code=400, detail="scoped page manifest does not match pages.db")
    for block_id, parent_id in parents.items():
        if parent_id != "root" and parent_id not in parents:
            raise HTTPException(status_code=400, detail="orphan block in scoped backup")
    state = {}
    for block_id in parents:
        current = block_id
        trail = []
        while current != "root" and state.get(current, 0) == 0:
            state[current] = 1
            trail.append(current)
            current = parents[current]
        if current != "root" and state.get(current) == 1:
            raise HTTPException(status_code=400, detail="block cycle in scoped backup")
        for value in trail:
            state[value] = 2

    data_path = tdir / "data.db"
    if not data_path.exists():
        return
    with sqlite3.connect(f"file:{data_path}?mode=ro", uri=True) as connection:
        connection.execute("PRAGMA query_only = ON")
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise HTTPException(status_code=400, detail="data.db failed integrity check")
        objects = {
            (row[0], row[1])
            for row in connection.execute(
                "SELECT type, name FROM sqlite_master "
                "WHERE name NOT LIKE 'sqlite_%'"
            )
        }
        if objects != {("table", "chats")}:
            raise HTTPException(status_code=400, detail="unexpected schema in scoped data.db")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(chats)")}
        if not {"block_id", "messages", "updated_at"} <= columns:
            raise HTTPException(status_code=400, detail="invalid scoped data.db schema")
        chat_rows = connection.execute("SELECT block_id, messages FROM chats").fetchall()
    page_ids = set(manifest_page_ids)
    folder_key = f"home:{folder}" if folder else None
    for chat_id, messages in chat_rows:
        allowed = chat_id in page_ids or bool(
            folder_key
            and (chat_id == folder_key or chat_id.startswith(folder_key + "/"))
        )
        if not allowed:
            raise HTTPException(status_code=400, detail="out-of-scope chat in scoped backup")
        try:
            parsed = json.loads(messages)
        except (TypeError, json.JSONDecodeError):
            raise HTTPException(status_code=400, detail="invalid chat in scoped backup")
        if not isinstance(parsed, list):
            raise HTTPException(status_code=400, detail="invalid chat in scoped backup")


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
def import_data(request: Request, file: UploadFile = File(...), mode: str = "replace",
                user: str | None = None):
    """Restore an /api/export zip into an account's workspace (the requesting
    user's, or — admins only — the one named by ?user=).

    mode=replace (default): pages.db and data.db are REPLACED (via the sqlite
    backup API, so the swap is transactional and safe while the app is
    serving). mode=merge: additive — see _merge_backup. In both modes uploads
    are merged in (filenames are content hashes, so identical files never
    conflict and nothing existing gets overwritten). Everything is validated
    before any live data is touched. Nothing can be imported into the guest
    workspace: it is shared, and one visitor could wipe it for everyone."""
    user, target_is_guest = _target_user(request, user)
    if target_is_guest:
        raise HTTPException(status_code=403, detail="the guest workspace cannot import backups")
    if mode not in ("replace", "merge"):
        raise HTTPException(status_code=400, detail="mode must be 'replace' or 'merge'")

    deadline = time.monotonic() + _IMPORT_MAX_SECONDS
    with tempfile.TemporaryDirectory(prefix="gamma-import-") as td:
        tdir = Path(td)
        zpath = tdir / "backup.zip"
        with open(zpath, "wb") as out:
            _copy_limited(file.file, out, _IMPORT_MAX_ARCHIVE_BYTES, deadline)
        try:
            zf = zipfile.ZipFile(zpath)
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="not a zip file")

        with zf:
            members = _validated_backup_members(zf)
            names = set(members)
            manifest = {}
            if "manifest.json" in names:
                try:
                    manifest = json.loads(zf.read("manifest.json"))
                    fmt = manifest.get("format")
                except Exception:
                    fmt = None
                if fmt != "gamma-backup-1":
                    raise HTTPException(status_code=400, detail="unsupported backup format")
                if manifest.get("kind") not in {None, "scoped"}:
                    raise HTTPException(status_code=400, detail="unsupported backup kind")
                if manifest.get("kind") == "scoped" and mode != "merge":
                    raise HTTPException(
                        status_code=400,
                        detail="scoped Gamma exports must be imported with mode=merge",
                    )
            if "pages.db" not in names:
                raise HTTPException(status_code=400, detail="not a Gamma backup (no pages.db in the zip)")
            for dbname in ("pages.db", "data.db"):
                if dbname in names:
                    with zf.open(members[dbname]) as src, open(tdir / dbname, "wb") as out:
                        _copy_limited(src, out, _IMPORT_MAX_DB_BYTES, deadline)
            (tdir / "uploads").mkdir()
            upload_names = []
            extracted_upload_bytes = 0
            for name in sorted(names):
                if not name.startswith("uploads/"):
                    continue
                base = name.split("/", 1)[1]
                with zf.open(members[name]) as src, open(tdir / "uploads" / base, "wb") as out:
                    extracted_upload_bytes += _copy_limited(
                        src,
                        out,
                        _IMPORT_MAX_UPLOAD_BYTES - extracted_upload_bytes,
                        deadline,
                    )
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

        if manifest.get("kind") == "scoped":
            _validate_scoped_backup(tdir, manifest, upload_names, deadline)

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
    user = request.state.user
    if not user:
        return {"user": None}
    return {"user": user, "is_guest": request.state.is_guest, "is_admin": request.state.is_admin}


@router.post("/login-guest")
async def login_guest(request: Request):
    from datetime import datetime, timezone

    # Each call mints a permanent session row; cap the rate so a public instance
    # can't be flooded into unbounded session-table growth.
    ratelimit.check(f"guest:ip:{client_ip(request)}", max_hits=20, window_seconds=300)
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
    set_session_cookie(resp, token, request)
    return resp

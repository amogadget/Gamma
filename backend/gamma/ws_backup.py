"""One workspace's backup: the ``gamma-backup-1`` zip, and the snapshots of
it the server keeps.

The zip is what ``GET /api/export`` downloads and ``POST /api/import-data``
restores: consistent copies of ``pages.db`` and ``data.db`` (taken with the
SQLite backup API, so safe while the app serves), every file under
``uploads/`` when asked, and a ``manifest.json``. ``write_zip`` writes one,
``restore_zip`` applies one (replace or merge) — the two halves of every
backup path in the app, so a stored snapshot, a downloaded export and a
page export all restore the same way.

Stored snapshots (``backups/workspaces/<ws>/<time>-<label>.zip``) are what
Settings → Backups manages: taken by a workspace owner (or for every
workspace of an account at once), listed, downloaded, restored in place,
deleted. Each is a FULL copy — no incremental chain, so any one of them
restores on its own and deleting one never breaks another; the price is
size, bounded by ``MAX_PER_WORKSPACE`` manual snapshots and the databases-only
choice. Automatic snapshots have separate retention in ``backup_schedule.py``.
Snapshots are not metered against anyone's quota (they live outside
``uploads/``) and are not part of admin server snapshots (``gamma/backups.py``
copies the databases and uploads, not ``backups/``); deleting a workspace
deletes its snapshots.
"""

import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path

from . import config
from .blocks_store import BLOCK_COLUMNS, fetch_subtree, last_child_position
from .db import page_now, safe_ws_id, ws_dir
from .normalize import normalize_data_db, normalize_pages_db
from .seed import create_workspace_files

FORMAT = "gamma-backup-1"
MAX_PER_WORKSPACE = 20
NAME_RE = re.compile(r"^\d{8}-\d{6}-[A-Za-z0-9_.-]{1,40}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")


class BackupError(ValueError):
    """A bad zip, a bad name, or a full store — the API maps it to 400."""


# --- the zip ----------------------------------------------------------------------

def write_zip(ws: str, dest: Path, *, uploads: bool = True, by: str = "", label: str = "",
              progress: dict | None = None, scheduled: bool = False, task_id: str = "") -> dict:
    """Write the workspace's backup zip to ``dest``. ``progress`` (a dict the
    caller shares with a poller) gets ``total`` / ``done`` byte counts.
    Returns the manifest."""
    from . import workspaces  # local: workspaces imports seed, which imports db

    root = ws_dir(ws)
    upload_files = []
    uploads_dir = root / "uploads"
    if uploads and uploads_dir.exists():
        upload_files = sorted(f for f in uploads_dir.iterdir() if f.is_file())
    db_files = [root / n for n in ("pages.db", "data.db") if (root / n).exists()]
    if progress is not None:
        progress.update(total=sum(f.stat().st_size for f in db_files + upload_files), done=0)
    info = workspaces.get(ws) or {}
    manifest = {
        "format": FORMAT,
        "workspace": ws,
        "workspace_name": info.get("name", ""),
        "kind": info.get("kind", ""),
        "user": workspaces.personal_owner(ws) or next(  # whose it is
            (m["username"] for m in workspaces.members(ws) if m["role"] == "owner"), ""),
        "exported_by": by,
        "exported_at": page_now(),
        "label": label,
        "scheduled": scheduled,
        "task_id": task_id,
        "uploads": bool(uploads),
        "upload_files": len(upload_files),
    }
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for src in db_files:
            snap = Path(str(dest) + "." + src.name)
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
            if progress is not None:
                progress["done"] += src.stat().st_size
        for f in upload_files:
            z.write(f, f"uploads/{f.name}")
            if progress is not None:
                progress["done"] += f.stat().st_size
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
    return manifest


def read_manifest(path: Path) -> dict:
    """The manifest of a backup zip, or {} when it has none."""
    try:
        with zipfile.ZipFile(path) as z:
            return json.loads(z.read("manifest.json"))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return {}


# --- restore -------------------------------------------------------------------------

def restore_zip(ws: str, zpath: Path, mode: str = "replace") -> dict:
    """Apply a backup zip to the workspace.

    ``replace``: pages.db and data.db are REPLACED (via the sqlite backup
    API, so the swap is transactional and safe while the app is serving) and
    normalized (a backup can be older than the current shapes). ``merge``:
    additive — pages (and chats) the workspace does not have are appended,
    everything it has stays. In both modes uploads are merged in (filenames
    are content hashes: identical files never conflict, nothing existing is
    overwritten). Everything is validated before any live data is touched;
    raises BackupError on a bad zip."""
    if mode not in ("replace", "merge"):
        raise BackupError("mode must be 'replace' or 'merge'")
    with tempfile.TemporaryDirectory(prefix="gamma-restore-") as td:
        tdir = Path(td)
        upload_names = _unpack(zpath, tdir)
        _validate(tdir)
        root = ws_dir(ws)
        if not (root / "pages.db").exists():
            create_workspace_files(ws)
        if mode == "merge":
            result = _merge(root, tdir)
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
    return {"mode": mode, "workspace": ws, **result,
            "uploads_in_backup": len(upload_names), "uploads_added": uploads_added}


def _unpack(zpath: Path, tdir: Path) -> list[str]:
    try:
        zf = zipfile.ZipFile(zpath)
    except zipfile.BadZipFile:
        raise BackupError("not a zip file")
    with zf:
        names = set(zf.namelist())
        if "manifest.json" in names:
            try:
                fmt = json.loads(zf.read("manifest.json")).get("format")
            except Exception:
                fmt = None
            if fmt != FORMAT:
                raise BackupError("unsupported backup format")
        if "pages.db" not in names:
            raise BackupError("not a Gamma backup (no pages.db in the zip)")
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
    return upload_names


def _validate(tdir: Path) -> None:
    # data.db needs no table check: every access path applies DATA_SCHEMA
    # (IF NOT EXISTS) on connect.
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
            raise BackupError(f"{dbname} in the zip is not a valid SQLite database")
        if required_table and required_table not in tables:
            raise BackupError(f"{dbname} in the zip has no {required_table} table")


def _merge(root: Path, tdir: Path) -> dict:
    """Additive import: pages from the backup that don't exist locally (by
    block id, or by doc_id for PDF pages) are appended to the library; pages
    that do exist are left untouched (live data always wins). Chats merge the
    same way; nothing else in the backup's data.db is touched."""
    from fractional_indexing import generate_n_keys_between

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
            src_tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
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


# --- stored snapshots -------------------------------------------------------------------

def store_dir(ws: str) -> Path:
    return config.BACKUPS_DIR / "workspaces" / safe_ws_id(ws)


def backup_path(ws: str, name: str) -> Path | None:
    """The snapshot file for a validated name (None for a bad name — names
    come from the client)."""
    if not NAME_RE.match(name or ""):
        return None
    return store_dir(ws) / f"{name}.zip"


def info(ws: str, name: str) -> dict | None:
    path = backup_path(ws, name)
    if not path or not path.is_file():
        return None
    m = read_manifest(path)
    return {"name": name, "size_bytes": path.stat().st_size, "created_at": m.get("exported_at", ""),
            "label": m.get("label", ""), "uploads": bool(m.get("uploads")),
            "upload_files": m.get("upload_files", 0), "by": m.get("exported_by", ""),
            "scheduled": bool(m.get("scheduled")), "task_id": m.get("task_id", "")}


def list_backups(ws: str) -> list[dict]:
    """The workspace's snapshots, newest first."""
    d = store_dir(ws)
    if not d.is_dir():
        return []
    out = [info(ws, f.stem) for f in sorted(d.glob("*.zip"), reverse=True)]
    return [b for b in out if b]


def create(ws: str, *, label: str = "manual", uploads: bool = True, by: str = "", scheduled: bool = False, task_id: str = "") -> dict:
    """Take a snapshot. Raises BackupError on a bad label or a full store."""
    if not LABEL_RE.match(label or ""):
        raise BackupError("label must be 1-40 chars of letters, digits, _ . -")
    if not scheduled and sum(not b["scheduled"] for b in list_backups(ws)) >= MAX_PER_WORKSPACE:
        raise BackupError(f"this workspace already has {MAX_PER_WORKSPACE} backups — delete one first")
    d = store_dir(ws)
    d.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if (d / f"{stamp}-{label}.zip").exists():
        time.sleep(1)
        stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"{stamp}-{label}"
    dest = d / f"{name}.zip"
    tmp = dest.with_suffix(".zip.part")
    try:
        write_zip(ws, tmp, uploads=uploads, by=by, label=label, scheduled=scheduled, task_id=task_id)
        tmp.replace(dest)  # never a half-written snapshot in the listing
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return info(ws, name)


def delete(ws: str, name: str) -> bool:
    path = backup_path(ws, name)
    if not path or not path.is_file():
        return False
    path.unlink()
    return True


def remove_all(ws: str) -> None:
    """Drop the workspace's snapshot directory (with the workspace)."""
    try:
        d = store_dir(ws)
    except ValueError:
        return
    if d.is_dir():
        shutil.rmtree(str(d), ignore_errors=True)

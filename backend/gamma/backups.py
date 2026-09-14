"""Server backups: snapshots of the whole data directory under ``backups/``.

A backup is a directory ``backups/<time>-<label>/`` holding a copy of every
SQLite file (taken with the backup API, so it is consistent while the server
runs) at its relative path, optionally the ``uploads/`` directories too, and
a ``manifest.json``. Two producers, one shape:

- the migration runner takes one (databases only) before upgrading the
  data directory (``gamma/migrations.py``);
- admins take them from Settings → Advanced or ``manage.py backups
  --create`` (with or without uploads), download them as a zip, delete them.

Restoring is a copy-back over the data directory with the server stopped
(``manage.py backups --restore``): a whole-directory operation, deliberately
not an HTTP endpoint. Per-workspace backups — the snapshots users take from
Settings → Backups and the ``/api/export`` zips — are ``gamma/ws_backup.py``,
a different thing; this module does not copy ``backups/``.
"""

import json
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path

from . import config
from .db import page_now

KEEP_BACKUPS = 3        # snapshots the migration runner keeps around
NAME_RE = re.compile(r"^\d{8}-\d{6}-[A-Za-z0-9_.-]{1,40}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")


def _snapshot(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(str(src))) as s, closing(sqlite3.connect(str(dst))) as d:
        s.backup(d)


def _db_files() -> list[Path]:
    """Every SQLite file in the data directory, whichever layout it is in."""
    files = []
    if config.USERS_DB.exists():
        files.append(config.USERS_DB)
    for root in (config.LEGACY_USERS_DIR, config.WORKSPACES_DIR):
        if root.is_dir():
            for d in sorted(root.iterdir()):
                for name in ("pages.db", "data.db"):
                    if (d / name).is_file():
                        files.append(d / name)
    return files


def _upload_dirs() -> list[Path]:
    dirs = []
    for root in (config.LEGACY_USERS_DIR, config.WORKSPACES_DIR):
        if root.is_dir():
            for d in sorted(root.iterdir()):
                if (d / "uploads").is_dir():
                    dirs.append(d / "uploads")
    return dirs


def create(label: str, uploads: bool = False, prune: bool = False) -> dict:
    """Snapshot the data directory into ``backups/<time>-<label>/`` (relative
    paths kept) with a manifest. ``uploads`` copies the upload files too.
    ``prune`` afterwards keeps only the newest KEEP_BACKUPS (the migration
    runner's policy; hand-made backups are never pruned automatically).
    Returns the backup's info dict."""
    from .migrations import data_version  # local: migrations imports this module

    if not LABEL_RE.match(label or ""):
        raise ValueError("label must be 1-40 chars of letters, digits, _ . -")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = config.BACKUPS_DIR / f"{stamp}-{label}"
    if target.exists():
        time.sleep(1)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = config.BACKUPS_DIR / f"{stamp}-{label}"
    files = []
    for src in _db_files():
        rel = src.relative_to(config.DATA_DIR)
        _snapshot(src, target / rel)
        files.append(rel.as_posix())
    upload_files = 0
    if uploads:
        for src in _upload_dirs():
            rel = src.relative_to(config.DATA_DIR)
            shutil.copytree(src, target / rel, dirs_exist_ok=True)
            upload_files += sum(1 for f in src.iterdir() if f.is_file())
    target.mkdir(parents=True, exist_ok=True)
    (target / "manifest.json").write_text(json.dumps({
        "created_at": page_now(), "label": label, "schema_version": data_version(),
        "files": files, "uploads": bool(uploads), "upload_files": upload_files,
        "note": "Snapshot of the Gamma data directory (gamma/backups.py). Restore with "
                "`manage.py backups --restore <name>` while the server is stopped.",
    }, indent=2), encoding="utf-8")
    if prune:
        prune_backups()
    return info(target.name)


def _dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def info(name: str) -> dict | None:
    path = backup_path(name)
    if not path or not path.is_dir():
        return None
    out = {"name": name, "path": str(path), "size_bytes": _dir_size(path)}
    try:
        out.update(json.loads((path / "manifest.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return out


def list_backups() -> list[dict]:
    """Every backup, oldest first."""
    if not config.BACKUPS_DIR.is_dir():
        return []
    return [b for b in (info(d.name) for d in sorted(config.BACKUPS_DIR.iterdir()) if d.is_dir()) if b]


def backup_path(name: str) -> Path | None:
    """The backup directory for a validated name (None for a bad name — the
    name comes from the client on the admin endpoints)."""
    if not NAME_RE.match(name or ""):
        return None
    return config.BACKUPS_DIR / name


def delete(name: str) -> bool:
    path = backup_path(name)
    if not path or not path.is_dir():
        return False
    shutil.rmtree(str(path), ignore_errors=True)
    return True


def prune_backups(keep: int | None = None) -> list[str]:
    """Delete all but the newest ``keep`` (default KEEP_BACKUPS) backups;
    returns what was removed."""
    keep = KEEP_BACKUPS if keep is None else keep
    removed = []
    backups = list_backups()
    for old in backups[:max(0, len(backups) - keep)]:
        shutil.rmtree(old["path"], ignore_errors=True)
        removed.append(old["name"])
    return removed


def zip_backup(name: str) -> Path:
    """Zip a backup into a temp file (the caller deletes it after sending)."""
    path = backup_path(name)
    if not path or not path.is_dir():
        raise FileNotFoundError(name)
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(path.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(path).as_posix())
    return Path(tmp.name)


def restore(name: str) -> dict:
    """Copy a backup's files back over the data directory (server STOPPED —
    open handles would see torn writes). Files the backup lacks stay as they
    are; uploads come back only from a backup that carried them. Returns
    ``{"files": n}``."""
    path = backup_path(name)
    if not path or not path.is_dir():
        raise FileNotFoundError(name)
    count = 0
    for f in path.rglob("*"):
        if not f.is_file() or f.name == "manifest.json":
            continue
        dest = config.DATA_DIR / f.relative_to(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # WAL/SHM sidecars of the live file would replay stale pages over the
        # restored database: drop them with it.
        if dest.suffix == ".db":
            for suffix in ("-wal", "-shm"):
                side = dest.with_name(dest.name + suffix)
                if side.exists():
                    side.unlink()
        shutil.copyfile(f, dest)
        count += 1
    return {"files": count}

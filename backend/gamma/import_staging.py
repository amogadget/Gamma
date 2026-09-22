"""Short-lived import uploads shared by preview and commit.

Tokens are bound to an account and workspace. A filesystem claim prevents
double submission across workers; successful reports survive a dropped response.
No library content is written until commit. Cancelled/expired uploads are removed.
"""
import hashlib
import json
import re
import secrets
import shutil
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from . import config

TTL = 2 * 60 * 60
MAX_BYTES = 1024 * 1024 * 1024
TOKEN_RE = re.compile(r"^[a-f0-9]{40}$")


def _root():
    instance = hashlib.sha256(str(config.DATA_DIR).encode()).hexdigest()[:16]
    root = Path(tempfile.gettempdir()) / f"gamma-import-reviews-{instance}"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _remove(path):
    # Only random token directories immediately inside our private staging root.
    if path.parent == _root() and TOKEN_RE.fullmatch(path.name):
        shutil.rmtree(path, ignore_errors=True)


def create(file, *, user, ws, source, folder, strip):
    root = _root()
    for path in root.iterdir():
        try:
            if path.is_dir() and time.time() - path.stat().st_mtime > TTL:
                _remove(path)
        except FileNotFoundError:
            pass
    token = secrets.token_hex(20)
    path = root / token
    path.mkdir()
    metadata = {"user": user, "ws": ws, "source": source, "folder": folder,
                "strip": strip, "filename": file.filename, "created": time.time()}
    try:
        count = 0
        with (path / "upload").open("wb") as dest:
            while chunk := file.file.read(1024 * 1024):
                count += len(chunk)
                if count > MAX_BYTES:
                    raise HTTPException(status_code=413, detail="import upload exceeds 1 GB")
                dest.write(chunk)
        (path / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    except Exception:
        _remove(path)
        raise
    return token


def get(token, user, ws):
    if not TOKEN_RE.fullmatch(token):
        raise HTTPException(status_code=404, detail="import review not found")
    path = _root() / token
    try:
        metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(status_code=404, detail="import review not found")
    if metadata["user"] != user or metadata["ws"] != ws:
        raise HTTPException(status_code=404, detail="import review not found")
    if time.time() - metadata["created"] > TTL:
        raise HTTPException(status_code=410, detail="import review expired; choose the file again")
    return path, metadata


@contextmanager
def claim(token, user, ws):
    path, metadata = get(token, user, ws)
    lock = path / "running"
    try:
        lock.mkdir()
    except FileExistsError:
        raise HTTPException(status_code=409, detail="this import is already running")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="import review not found")
    try:
        yield path, metadata
    finally:
        lock.rmdir()


def discard(token, user, ws):
    with claim(token, user, ws) as (path, _):
        # Remove payload while claimed; the small token directory follows.
        for name in ("upload", "metadata.json", "result.json"):
            (path / name).unlink(missing_ok=True)
    _remove(path)

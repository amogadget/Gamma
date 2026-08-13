"""Background flattening of MRC scans, and the swap once one is ready.

Uploads and proxy-saved PDFs are queued here. A single worker thread handles
them one at a time — flattening renders every page, so running several at once
would just make the box thrash.

The swap is done by rewriting `properties.source_url` on the blocks that point
at the document, from `<doc_id>.pdf` to `<doc_id>-flat.pdf`. Until that happens
readers keep getting the original, which is the point: the flattened copy only
becomes visible once it exists in full. Rewriting the URL rather than the file
is deliberate — uploads are served `immutable` for a month, so bytes swapped in
under the same name would never reach a browser that had already cached them.

`properties.doc_id` is left alone. Highlights, the search index and AI context
all key off it, and the flattened copy keeps the original's text layer, so
nothing downstream needs to know this happened.
"""

import json
import queue
import sqlite3
import threading

from .db import user_db_path, user_uploads_dir
from .flatten_mrc import flatten, needs_flattening
from .logbuf import log

FLAT_SUFFIX = "-flat"

_q: "queue.Queue[tuple[str, str]]" = queue.Queue()
_worker: threading.Thread | None = None
_lock = threading.Lock()
_seen: set[tuple[str, str]] = set()  # jobs queued or done this process
_state = {"total": 0, "done": 0, "current": "", "flattened": 0}


def flat_path(user: str, doc_id: str):
    return user_uploads_dir(user) / f"{doc_id}{FLAT_SUFFIX}.pdf"


def source_path(user: str, doc_id: str):
    return user_uploads_dir(user) / f"{doc_id}.pdf"


def progress() -> dict:
    with _lock:
        active = bool(_worker and _worker.is_alive() and _state["done"] < _state["total"])
        return {**_state, "active": active}


def _point_blocks_at(user: str, doc_id: str):
    """Swap source_url over to the flattened copy for every block using it."""
    flat_url = f"/api/uploads/{doc_id}{FLAT_SUFFIX}.pdf"
    try:
        with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
            rows = conn.execute(
                "SELECT id, properties FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?", (doc_id,)
            ).fetchall()
            for bid, props in rows:
                try:
                    p = json.loads(props or "{}")
                except Exception:
                    continue
                if p.get("source_url") == flat_url:
                    continue
                p["source_url"] = flat_url
                conn.execute("UPDATE unified_blocks SET properties = ? WHERE id = ?", (json.dumps(p), bid))
            conn.commit()
    except Exception as e:
        log.warning(f"[flatten] could not repoint blocks for {doc_id}: {e}")


def _prepare_dims(user: str, doc_id: str):
    """Precompute the page-size list readers need to lay the document out.

    Walking a 332-page scan takes ~1.2 s; doing it here means the first person
    to open the paper does not wait for it.
    """
    from .routers.pageimage import ensure_dims  # local: routers import upward

    path = source_path(user, doc_id)
    if path.exists():
        ensure_dims(user, doc_id, path)


def _run_one(user: str, doc_id: str):
    src = source_path(user, doc_id)
    dst = flat_path(user, doc_id)
    if dst.exists():
        _point_blocks_at(user, doc_id)
        _prepare_dims(user, f"{doc_id}{FLAT_SUFFIX}")
        return
    if not src.exists():
        return
    if not needs_flattening(src):
        _prepare_dims(user, doc_id)  # served as-is, so it needs its own dims
        return
    tmp = dst.with_suffix(".part")
    log.info(f"[flatten] {user}/{doc_id}: flattening")
    try:
        ok = flatten(src, tmp)
        if not ok:
            tmp.unlink(missing_ok=True)
            return
        tmp.replace(dst)  # only ever visible complete
        with _lock:
            _state["flattened"] += 1
        _point_blocks_at(user, doc_id)
        # Readers will be sent to the flattened copy, so that is the one whose
        # page sizes need to be ready.
        _prepare_dims(user, f"{doc_id}{FLAT_SUFFIX}")
        log.info(f"[flatten] {user}/{doc_id}: done ({dst.stat().st_size // (1024 * 1024)} MB)")
    except Exception as e:
        tmp.unlink(missing_ok=True)
        log.warning(f"[flatten] {user}/{doc_id} failed: {e}")


def _loop():
    while True:
        user, doc_id = _q.get()
        try:
            with _lock:
                _state["current"] = doc_id
            _run_one(user, doc_id)
        finally:
            with _lock:
                _state["done"] += 1
                _state["current"] = ""
            _q.task_done()


def schedule(user: str, doc_id: str):
    """Queue a document. Cheap and idempotent — safe to call on every upload."""
    global _worker
    if not user or not doc_id:
        return
    key = (user, doc_id)
    with _lock:
        if key in _seen:
            return
        _seen.add(key)
        _state["total"] += 1
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_loop, name="flatten", daemon=True)
            _worker.start()
    _q.put(key)


def schedule_all(user: str) -> int:
    """Queue every upload this user has. Returns how many were queued."""
    uploads = user_uploads_dir(user)
    if not uploads.exists():
        return 0
    n = 0
    for f in sorted(uploads.iterdir()):
        if f.suffix.lower() != ".pdf" or f.stem.endswith(FLAT_SUFFIX):
            continue
        if flat_path(user, f.stem).exists():
            continue
        schedule(user, f.stem)
        n += 1
    return n

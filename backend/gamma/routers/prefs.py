"""Per-account UI preferences: a tiny JSON key-value store in users.db
(``user_prefs``).

Lets browser state that should follow the account (open tabs, ...) sync
across devices: last write wins, `updated_at` tells clients whether the
stored copy is newer than what they have. Most keys are stored per account
AND workspace (open tabs name that workspace's pages); the keys in
``db.USER_PREF_KEYS`` (appearance, the AI provider entries) follow the
account everywhere. Session-only — share links never read or write prefs.
Values are opaque JSON blobs; keep them small.

The `ai-settings` key holds the user's AI provider API keys and is reserved:
it is only reachable through /api/ai/settings, which masks the keys — these
generic endpoints must never serve it raw.

Also here: /api/page-snaps — the recents-card cover thumbnails (small JPEG
data URLs the client captures from the rendered viewer). Same "UI state that
follows the account" idea, but far over the prefs size cap, so they get their
own table in the workspace's data.db (shared by its members) with a
per-entry newest-wins write and a hard count cap.
"""

import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..ai_settings import AI_SETTINGS_PREF_KEY
from ..auth import require_user, require_ws
from ..db import (
    delete_page_snap,
    get_page_snaps,
    get_pref,
    safe_doc_id,
    set_page_snap,
    set_pref,
)

router = APIRouter(prefix="/api", tags=["prefs"])

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_VALUE_BYTES = 64 * 1024  # tabs/folders are a few KB; anything bigger is a bug


def _check_key(key: str):
    if not _KEY_RE.match(key or "") or key == AI_SETTINGS_PREF_KEY:
        raise HTTPException(status_code=400, detail="invalid pref key")


class PrefWriteRequest(BaseModel):
    value: Any = None  # any JSON value


@router.get("/prefs/{key}")
async def read_pref(key: str, request: Request):
    user = require_user(request)
    _check_key(key)
    value, updated_at = get_pref(user, key, require_ws(request))
    return {"key": key, "value": value, "updated_at": updated_at}


@router.put("/prefs/{key}")
async def write_pref(key: str, payload: PrefWriteRequest, request: Request):
    user = require_user(request)
    _check_key(key)
    if len(json.dumps(payload.value)) > MAX_VALUE_BYTES:
        raise HTTPException(status_code=413, detail="pref value too large")
    updated_at = set_pref(user, key, payload.value, require_ws(request))
    return {"key": key, "updated_at": updated_at}


# --- Page snapshots (recents-card covers) ---------------------------------

# 320×480 max at JPEG q0.55 is a few tens of KB base64; anything bigger is a
# bug (the frontend's SNAP_WIDTH/SNAP_MAX_HEIGHT/SNAP_QUALITY in App.jsx must
# stay comfortably under this).
MAX_SNAP_CHARS = 200 * 1024


def _check_snap_id(page_id: str):
    """Page ids come from the client; the doc-id shape guard covers them."""
    try:
        safe_doc_id(page_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid page id")


class SnapWriteRequest(BaseModel):
    img: str = ""
    at: str = ""  # capture time (ISO, client clock) — newest wins across devices


# Sync endpoints: they move up-to-200KB blobs through sqlite — FastAPI's
# threadpool keeps the event loop free (same rule as the other blocking routes).
@router.get("/page-snaps")
def read_page_snaps(request: Request, after: str = ""):
    """All stored covers, or (with ?after=<iso>) only ones newer than that —
    the cheap focus-pull form: clients send their newest local `at`."""
    return {"snaps": get_page_snaps(require_ws(request), after=after)}


@router.put("/page-snaps/{page_id}")
def write_page_snap(page_id: str, payload: SnapWriteRequest, request: Request):
    ws = require_ws(request)
    _check_snap_id(page_id)
    img = payload.img or ""
    if not img.startswith("data:image/jpeg;base64,"):
        raise HTTPException(status_code=400, detail="expected a JPEG data URL")
    if len(img) > MAX_SNAP_CHARS:
        raise HTTPException(status_code=413, detail="snapshot too large")
    at = set_page_snap(ws, page_id, img, at=payload.at)
    return {"page_id": page_id, "at": at}


@router.delete("/page-snaps/{page_id}")
def remove_page_snap(page_id: str, request: Request):
    ws = require_ws(request)
    _check_snap_id(page_id)
    delete_page_snap(ws, page_id)
    return {"ok": True}

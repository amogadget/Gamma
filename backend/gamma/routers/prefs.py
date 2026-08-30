"""Per-user UI preferences: a tiny JSON key-value store in data.db.

Lets browser state that should follow the account (open tabs, ...) sync
across devices: last write wins, `updated_at` tells clients whether the
stored copy is newer than what they have. Session-only — share links never
read or write prefs. Values are opaque JSON blobs; keep them small.

The `ai-settings` key holds the user's AI provider API keys and is reserved:
it is only reachable through /api/ai/settings, which masks the keys — these
generic endpoints must never serve it raw.

Also here: /api/page-snaps — the recents-card cover thumbnails (small JPEG
data URLs the client captures from the rendered viewer). Same "UI state that
follows the account" idea, but far over the prefs size cap, so they get their
own data.db table with a per-entry newest-wins write and a hard count cap.
"""

import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..ai_settings import AI_SETTINGS_PREF_KEY
from ..auth import require_user
from ..db import delete_page_snap, get_page_snaps, get_pref, set_page_snap, set_pref

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
    value, updated_at = get_pref(user, key)
    return {"key": key, "value": value, "updated_at": updated_at}


@router.put("/prefs/{key}")
async def write_pref(key: str, payload: PrefWriteRequest, request: Request):
    user = require_user(request)
    _check_key(key)
    if len(json.dumps(payload.value)) > MAX_VALUE_BYTES:
        raise HTTPException(status_code=413, detail="pref value too large")
    updated_at = set_pref(user, key, payload.value)
    return {"key": key, "updated_at": updated_at}


# --- Page snapshots (recents-card covers) ---------------------------------

# 320×480 max at JPEG q0.55 is a few tens of KB base64; anything bigger is a bug.
MAX_SNAP_CHARS = 200 * 1024
# Guards the page-id key (block ids come from the client). Mirrors db._DOC_ID_RE.
_SNAP_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


def _check_snap_id(page_id: str):
    if page_id in (".", "..") or not _SNAP_ID_RE.match(page_id or ""):
        raise HTTPException(status_code=400, detail="invalid page id")


class SnapWriteRequest(BaseModel):
    img: str = ""
    at: str = ""  # capture time (ISO, client clock) — newest wins across devices


@router.get("/page-snaps")
async def read_page_snaps(request: Request, after: str = ""):
    """All stored covers, or (with ?after=<iso>) only ones newer than that —
    the cheap focus-pull form: clients send their newest local `at`."""
    user = require_user(request)
    return {"snaps": get_page_snaps(user, after=after)}


@router.put("/page-snaps/{page_id}")
async def write_page_snap(page_id: str, payload: SnapWriteRequest, request: Request):
    user = require_user(request)
    _check_snap_id(page_id)
    img = payload.img or ""
    if not img.startswith("data:image/jpeg;base64,"):
        raise HTTPException(status_code=400, detail="expected a JPEG data URL")
    if len(img) > MAX_SNAP_CHARS:
        raise HTTPException(status_code=413, detail="snapshot too large")
    at = set_page_snap(user, page_id, img, at=payload.at)
    return {"page_id": page_id, "at": at}


@router.delete("/page-snaps/{page_id}")
async def remove_page_snap(page_id: str, request: Request):
    user = require_user(request)
    _check_snap_id(page_id)
    delete_page_snap(user, page_id)
    return {"ok": True}

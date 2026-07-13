"""Per-user UI preferences: a tiny JSON key-value store in data.db.

Lets browser state that should follow the account (open tabs, ...) sync
across devices: last write wins, `updated_at` tells clients whether the
stored copy is newer than what they have. Session-only — share links never
read or write prefs. Values are opaque JSON blobs; keep them small.

The `ai-settings` key holds the user's AI provider API keys and is reserved:
it is only reachable through /api/ai/settings, which masks the keys — these
generic endpoints must never serve it raw.
"""

import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..ai_settings import AI_SETTINGS_PREF_KEY
from ..auth import require_user
from ..db import get_pref, set_pref

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

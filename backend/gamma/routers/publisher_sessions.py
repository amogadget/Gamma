"""Write-only credentials API; listing exposes connection metadata only."""

import json

from fastapi import APIRouter, HTTPException, Request

from .. import publisher_sessions as sessions
from ..auth import _is_https, read_body, require_personal_user
from ..server_settings import LOOPBACK_HOSTS

router = APIRouter(prefix="/api/publisher-sessions", tags=["publisher sessions"])


def _user(request: Request) -> str:
    user = require_personal_user(request, "Publisher sessions require a personal Gamma account")
    if request.query_params.get("share"):
        raise HTTPException(403, "Publisher sessions require a personal Gamma account")
    return user


@router.get("")
def status(request: Request):
    return {"sessions": sessions.list_sessions(_user(request)),
            "publisher_roots": sessions.PUBLISHER_ROOTS}


@router.post("")
async def connect(request: Request):
    user = _user(request)
    if not _is_https(request) and request.url.hostname not in LOOPBACK_HOSTS:
        raise HTTPException(400, "Connect publisher sessions over HTTPS or localhost")
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise HTTPException(415, "Send publisher sessions as JSON")
    body = await read_body(request, 256 * 1024, "Publisher session is too large")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("Invalid request")
        return sessions.save(user, payload.get("host"), payload.get("cookies"))
    except (ValueError, TypeError):
        # Never echo validation input: it contains credentials.
        raise HTTPException(400, "Invalid publisher cookies or unsupported host") from None


@router.delete("/{host}")
def disconnect(host: str, request: Request):
    sessions.disconnect(_user(request), host)
    return {"ok": True}

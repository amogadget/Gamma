"""The mirror API (docs/dev/mirror.md): make a local workspace that follows
a workspace on another Gamma server, run a round, read its status and the
merges it decided on its own. Session-only, the mirror's owner only."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import sync_engine, workspaces
from ..auth import require_personal_user

router = APIRouter(prefix="/api/mirrors", tags=["mirrors"])


class MirrorCreate(BaseModel):
    remote_url: str = Field(min_length=1, max_length=500)
    token: str = Field(min_length=1, max_length=200)
    name: str = ""
    mode: str = Field(default="two-way", pattern="^(two-way|pull)$")


class Resolution(BaseModel):
    choice: str = Field(pattern="^(keep|mine|theirs)$")


def _me(request: Request) -> str:
    return require_personal_user(request, "Sign in with a personal account to keep an offline copy.")


def _mine(request: Request, ws: str) -> dict:
    user = _me(request)
    mirror = sync_engine.get_mirror(ws)
    if not mirror or mirror["owner"] != user:
        raise HTTPException(status_code=404, detail="no such mirror")
    return mirror


def _info(mirror: dict) -> dict:
    info = workspaces.get(mirror["workspace_id"])
    return {**mirror, "name": info["name"] if info else ""}


@router.get("")
def list_mirrors(request: Request):
    """``{mirrors: [{workspace_id, name, remote_url, remote_ws, remote_name,
    mode, status, ...}]}`` — the caller's."""
    return {"mirrors": [_info(m) for m in sync_engine.list_mirrors(_me(request))]}


@router.post("", status_code=201)
def create_mirror(payload: MirrorCreate, request: Request):
    """Start mirroring: ``{remote_url, token, name?, mode?}`` → the mirror.
    The token is a write-scope integration token made on the remote
    (Settings → Integrations there); a read token, or a viewer's, gives a
    pull-only copy. The first fill runs in the background."""
    user = _me(request)
    try:
        mirror = sync_engine.create_mirror(user, payload.remote_url, payload.token, name=payload.name,
                                           mode=payload.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except sync_engine.RemoteError as e:
        raise HTTPException(status_code=502, detail=f"the remote answered {e}")
    sync_engine.sync_in_background(mirror["workspace_id"])
    return _info(mirror)


@router.get("/{ws}")
def get_mirror(ws: str, request: Request):
    return _info(_mine(request, ws))


# Sync endpoints do network round trips and SQLite work: sync `def`, so the
# threadpool runs them and the event loop stays free.
@router.post("/{ws}/sync")
def run_sync(ws: str, request: Request, wait: int = 0):
    """One round now. ``wait=1`` runs it inline and answers with the round's
    status; otherwise it runs in the background and the current status is
    returned."""
    mirror = _mine(request, ws)
    if wait:
        return {"status": sync_engine.sync_workspace(ws)}
    sync_engine.sync_in_background(ws)
    return {"status": mirror["status"]}


@router.delete("/{ws}")
def delete_mirror(ws: str, request: Request):
    """Stop mirroring. The workspace stays, as an ordinary local one."""
    _mine(request, ws)
    sync_engine.remove_mirror(ws)
    return {"ok": True}


@router.get("/{ws}/conflicts")
def list_conflicts(ws: str, request: Request, resolved: int = 0):
    _mine(request, ws)
    return {"conflicts": sync_engine.list_conflicts(ws, resolved=bool(resolved))}


@router.post("/{ws}/conflicts/{conflict_id}")
def resolve_conflict(ws: str, conflict_id: int, payload: Resolution, request: Request):
    _mine(request, ws)
    out = sync_engine.resolve_conflict(ws, conflict_id, payload.choice)
    if not out:
        raise HTTPException(status_code=404, detail="no such conflict")
    return out

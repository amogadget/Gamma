"""The mirror API (docs/dev/mirror.md): make a local workspace that follows
a workspace on another Gamma server, run a round, read its status and the
merges it decided on its own. Session-only, the mirror's owner only."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import config, sync_engine, workspaces
from ..auth import require_personal_user

router = APIRouter(prefix="/api/mirrors", tags=["mirrors"])


class MirrorCreate(BaseModel):
    remote_url: str = Field(min_length=1, max_length=500)
    token: str = Field(min_length=1, max_length=200)
    name: str = ""
    mode: str = Field(default="two-way", pattern="^(two-way|pull)$")
    workspace_id: str = ""      # link an existing workspace of mine instead of making a new one
    adopt: str = Field(default="theirs", pattern="^(theirs|mine)$")


class MirrorPatch(BaseModel):
    poll_s: int | None = Field(default=None, ge=0, le=86400)
    on_change: bool | None = None
    mode: str | None = Field(default=None, pattern="^(two-way|pull)$")


class Relink(BaseModel):
    token: str = ""
    remote_url: str = ""
    adopt: str = Field(default="theirs", pattern="^(theirs|mine)$")


class Force(BaseModel):
    direction: str = Field(pattern="^(pull|push)$")


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
    return {**mirror, "name": info["name"] if info else "",
            "conflicts_open": sync_engine.open_conflicts(mirror["workspace_id"]),
            "pending_local": mirror["mode"] == "two-way" and sync_engine.has_local_changes(mirror["workspace_id"]),
            "interval_s": config.sync_interval_s(), "detached": mirror["mode"] == "off"}


@router.get("")
def list_mirrors(request: Request):
    """``{mirrors: [{workspace_id, name, remote_url, remote_ws, remote_name,
    mode, status, ...}]}`` — the caller's."""
    return {"mirrors": [_info(m) for m in sync_engine.list_mirrors(_me(request))]}


@router.post("", status_code=201)
def create_mirror(payload: MirrorCreate, request: Request):
    """Start mirroring: ``{remote_url, token, name?, mode?, workspace_id?,
    adopt?}`` → the mirror. The token is a write-scope integration token
    made on the remote (Settings → Integrations there); a read token, or a
    viewer's, gives a pull-only copy. ``workspace_id`` links an existing
    workspace of the caller's under the ``adopt`` policy. The first fill
    runs in the background."""
    user = _me(request)
    try:
        mirror = sync_engine.create_mirror(user, payload.remote_url, payload.token, name=payload.name,
                                           mode=payload.mode, workspace_id=payload.workspace_id, adopt=payload.adopt)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except sync_engine.RemoteError as e:
        raise HTTPException(status_code=502, detail=f"the remote answered {e}")
    sync_engine.sync_in_background(mirror["workspace_id"])
    return _info(mirror)


@router.get("/{ws}")
def get_mirror(ws: str, request: Request):
    return _info(_mine(request, ws))


@router.patch("/{ws}")
def update_mirror(ws: str, payload: MirrorPatch, request: Request):
    """The cadence: ``poll_s`` (0 = only by hand), ``on_change``, ``mode``."""
    _mine(request, ws)
    try:
        return _info(sync_engine.set_cadence(ws, poll_s=payload.poll_s, on_change=payload.on_change, mode=payload.mode))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{ws}/detach")
def detach(ws: str, request: Request):
    """Detach: the copy stops following; the link is kept for a re-link."""
    _mine(request, ws)
    return _info(sync_engine.detach_mirror(ws))


@router.post("/{ws}/relink")
def relink(ws: str, payload: Relink, request: Request):
    """Link a detached copy again (the stored token, or a new one); a round
    runs in the background."""
    _mine(request, ws)
    try:
        mirror = sync_engine.relink_mirror(ws, token=payload.token, remote_url=payload.remote_url, adopt=payload.adopt)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except sync_engine.RemoteError as e:
        raise HTTPException(status_code=502, detail=f"the remote answered {e}")
    sync_engine.sync_in_background(ws)
    return _info(mirror)


@router.post("/{ws}/force")
def force(ws: str, payload: Force, request: Request):
    """``pull``: replace this copy with the original; ``push``: replace the
    original with this copy. Runs in the background; texts that differed
    wait as ``diverged`` conflicts."""
    _mine(request, ws)
    try:
        sync_engine.force_sync(ws, payload.direction)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
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
        return {"status": sync_engine.sync_workspace(ws), "conflicts_open": sync_engine.open_conflicts(ws)}
    sync_engine.sync_in_background(ws)
    return {"status": mirror["status"], "conflicts_open": sync_engine.open_conflicts(ws)}


@router.delete("/{ws}")
def delete_mirror(ws: str, request: Request):
    """Forget the link. The workspace stays, as an ordinary local one."""
    _mine(request, ws)
    sync_engine.remove_mirror(ws)
    return {"ok": True}


@router.get("/{ws}/log")
def sync_log(ws: str, request: Request, limit: int = 50):
    """What the last rounds did, newest first: ``{changes: [{id, at,
    page_id, title, action, stats, changes, exists}]}`` (``stats`` the
    block counts, ``changes`` what each edit did block by block)."""
    _mine(request, ws)
    return {"changes": sync_engine.list_log(ws, limit)}


@router.get("/{ws}/conflicts")
def list_conflicts(ws: str, request: Request, resolved: int = 0, page: str = ""):
    """``{conflicts: [{id, page_id, page_title, block_id, kind, mine, theirs,
    result, at}]}`` — one page's with ``?page=``."""
    _mine(request, ws)
    return {"conflicts": sync_engine.list_conflicts(ws, resolved=bool(resolved), page_id=page)}


@router.post("/{ws}/conflicts/{conflict_id}")
def resolve_conflict(ws: str, conflict_id: int, payload: Resolution, request: Request):
    _mine(request, ws)
    out = sync_engine.resolve_conflict(ws, conflict_id, payload.choice)
    if not out:
        raise HTTPException(status_code=404, detail="no such conflict")
    return out

"""Workspaces API (/api/workspaces*): create, inspect, rename, access,
quota, delete, members.

The model and its rules live in gamma/workspaces.py; this is the HTTP skin.
Owner-only operations (rename, delete, members) also pass for server admins,
who need no membership (a lab workspace whose last owner left can be
recovered, and Settings → Workspaces manages every workspace from one
place). Access (private / public) and a shared workspace's own quota are
admin-only settings; so is creating a workspace for someone else.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import workspaces
from ..auth import require_user
from ..server_settings import validate_quota_mb, workspace_quota

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


class WorkspaceCreate(BaseModel):
    name: str
    owner: str | None = None         # admins: create it for this account
    access: str | None = None        # admins: private (default) / public
    public_role: str | None = None   # admins: viewer (default) / editor
    quota_mb: int | None = None      # admins: 0 or omitted = unlimited


class WorkspaceUpdate(BaseModel):
    name: str | None = None          # owners
    access: str | None = None        # admins
    public_role: str | None = None   # admins (with access)
    quota_mb: int | None = None      # admins; explicit null = unlimited (model_fields_set tells)


class MemberRole(BaseModel):
    role: str


def _member(request: Request, ws: str, needed: str) -> str:
    """The session user, if a member of ``ws`` with at least ``needed``
    (server admins pass every check). 404 for a workspace that does not
    exist (or that the caller may not know exists)."""
    user = require_user(request)
    if not workspaces.get(ws):
        raise HTTPException(status_code=404, detail="workspace not found")
    if request.state.is_admin:
        return user
    role = workspaces.role_of(ws, user)
    if not workspaces.at_least(role, needed):
        if role:
            raise HTTPException(status_code=403, detail=f"only a workspace {needed} can do that")
        raise HTTPException(status_code=404, detail="workspace not found")
    return user


def _admin_only(request: Request, what: str) -> None:
    if not request.state.is_admin:
        raise HTTPException(status_code=403, detail=f"only a server admin can set {what}")


def _quota(mb) -> int | None:
    """A workspace quota as stored: None for unlimited (0, null, omitted)."""
    return validate_quota_mb(mb) or None if mb else None


def _valid_owner(username: str) -> str:
    """An existing non-guest account (the directory the pickers show)."""
    if not any(a["username"] == username for a in workspaces.accounts()):
        raise HTTPException(status_code=400, detail=f"unknown user: {username}")
    return username


def _payload(ws: str, user: str) -> dict:
    """The workspace as the caller sees it: its row, the caller's role
    (None for an admin who is no member), whose personal workspace it is
    (``personal_of``, "" when shared; ``personal`` = the caller's own), and
    the explicit members."""
    info = workspaces.get(ws)
    personal_of = workspaces.personal_owner(ws)
    return {**info, "role": workspaces.role_of(ws, user), "personal_of": personal_of,
            "personal": personal_of == user, "members": workspaces.members(ws)}


@router.post("")
async def create_workspace(payload: WorkspaceCreate, request: Request):
    """A new workspace owned by the caller. Admins may name another
    ``owner`` and set ``access`` / ``public_role`` / ``quota_mb``."""
    user = require_user(request)
    if request.state.is_guest:
        raise HTTPException(status_code=403, detail="the guest account cannot create workspaces")
    name = workspaces.clean_name(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="workspace name required")
    owner = payload.owner or user
    if owner != user or payload.access or payload.public_role or payload.quota_mb:
        _admin_only(request, "an owner, access or a quota on a new workspace")
    if owner != user:
        _valid_owner(owner)
    if len(workspaces.list_for_user(owner)) >= workspaces.MAX_WORKSPACES_PER_USER:
        raise HTTPException(status_code=400, detail="too many workspaces")
    try:
        info = workspaces.create(
            name, owner, by=user, access=payload.access or "private",
            public_role=payload.public_role or "viewer", quota_mb=_quota(payload.quota_mb))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _payload(info["id"], user)


@router.get("/find-page/{page_id}")
async def find_page(page_id: str, request: Request):
    """Which of my workspaces holds this page — for a deep link that names
    no workspace. 404 when none does."""
    user = require_user(request)
    ws = workspaces.find_page(user, page_id)
    if not ws:
        raise HTTPException(status_code=404, detail="page not found in your workspaces")
    return {"workspace_id": ws}


@router.get("/{ws}")
async def get_workspace(ws: str, request: Request):
    """The workspace with its members and the storage that applies to it
    (any member; admins)."""
    user = _member(request, ws, "viewer")
    return {**_payload(ws, user), "quota": workspace_quota(ws)}


@router.put("/{ws}")
async def update_workspace(ws: str, payload: WorkspaceUpdate, request: Request):
    """Rename (owner); set access + public role, or the workspace's own
    quota (admin). Fields left out stay as they are."""
    user = _member(request, ws, "owner")
    try:
        if payload.name is not None:
            workspaces.rename(ws, payload.name)
        if payload.access is not None:
            _admin_only(request, "access")
            current = workspaces.get(ws)
            workspaces.set_access(ws, payload.access, payload.public_role or current["public_role"])
        elif payload.public_role is not None:
            _admin_only(request, "access")
            workspaces.set_access(ws, workspaces.get(ws)["access"], payload.public_role)
        if "quota_mb" in payload.model_fields_set:
            _admin_only(request, "a workspace quota")
            workspaces.set_quota(ws, _quota(payload.quota_mb))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {**_payload(ws, user), "quota": workspace_quota(ws)}


@router.delete("/{ws}")
async def delete_workspace(ws: str, request: Request):
    """Delete a shared workspace and everything in it (owner). A personal
    workspace cannot be deleted."""
    _member(request, ws, "owner")
    try:
        warning = workspaces.delete(ws)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "warning": warning}


@router.put("/{ws}/members/{username}")
async def set_member(ws: str, username: str, payload: MemberRole, request: Request):
    """Invite an account, or change a member's role (owner). Naming someone
    owner is how ownership is handed on — admins included."""
    user = _member(request, ws, "owner")
    try:
        workspaces.set_member(ws, username, payload.role, by=user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _payload(ws, user)


@router.delete("/{ws}/members/{username}")
async def remove_member(ws: str, username: str, request: Request):
    """Remove a member (owner), or leave yourself (any explicit member)."""
    user = require_user(request)
    if username != user:
        _member(request, ws, "owner")
    elif not workspaces.role_of(ws, user) and not request.state.is_admin:
        raise HTTPException(status_code=404, detail="workspace not found")
    try:
        workspaces.remove_member(ws, username)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "left": username == user}

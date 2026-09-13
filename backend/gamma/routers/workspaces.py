"""Workspaces API (/api/workspaces*): list, create, rename, delete, members.

The model and its rules live in gamma/workspaces.py; this is the HTTP skin.
Owner-only operations (rename, delete, members) also pass for server admins,
so a lab workspace whose last owner left can be recovered from Settings.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import workspaces
from ..auth import require_user
from ..server_settings import workspace_quota

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


class WorkspaceCreate(BaseModel):
    name: str


class WorkspaceRename(BaseModel):
    name: str


class MemberRole(BaseModel):
    role: str


def _member(request: Request, ws: str, needed: str) -> str:
    """The session user, if a member of ``ws`` with at least ``needed``
    (server admins pass every check). 404 for a workspace that does not
    exist (or that the caller may not know exists)."""
    user = require_user(request)
    if not workspaces.get(ws):
        raise HTTPException(status_code=404, detail="workspace not found")
    role = workspaces.role_of(ws, user)
    if request.state.is_admin and needed == "owner":
        return user
    if not workspaces.at_least(role, needed):
        if role:
            raise HTTPException(status_code=403, detail=f"only a workspace {needed} can do that")
        raise HTTPException(status_code=404, detail="workspace not found")
    return user


def _payload(ws: str, user: str) -> dict:
    info = workspaces.get(ws)
    role = workspaces.role_of(ws, user)
    return {**info, "role": role, "personal": workspaces.default_workspace(user) == ws,
            "members": workspaces.members(ws)}


@router.get("")
async def list_workspaces(request: Request):
    """``{workspaces: [{id, name, role, personal, members, created_by,
    created_at}], default}`` for the session user."""
    user = require_user(request)
    return {"workspaces": workspaces.list_for_user(user),
            "default": workspaces.default_workspace(user)}


@router.post("")
async def create_workspace(payload: WorkspaceCreate, request: Request):
    user = require_user(request)
    if request.state.is_guest:
        raise HTTPException(status_code=403, detail="the guest account cannot create workspaces")
    name = workspaces.clean_name(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="workspace name required")
    if len(workspaces.list_for_user(user)) >= workspaces.MAX_WORKSPACES_PER_USER:
        raise HTTPException(status_code=400, detail="too many workspaces")
    info = workspaces.create(name, user)
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
    """The workspace with its members and the storage that applies to it."""
    user = _member(request, ws, "viewer")
    return {**_payload(ws, user), "quota": workspace_quota(ws)}


@router.put("/{ws}")
async def rename_workspace(ws: str, payload: WorkspaceRename, request: Request):
    user = _member(request, ws, "owner")
    try:
        workspaces.rename(ws, payload.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _payload(ws, user)


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
    """Invite an account, or change a member's role (owner)."""
    user = _member(request, ws, "owner")
    try:
        workspaces.set_member(ws, username, payload.role, by=user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _payload(ws, user)


@router.delete("/{ws}/members/{username}")
async def remove_member(ws: str, username: str, request: Request):
    """Remove a member (owner), or leave yourself (any member)."""
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

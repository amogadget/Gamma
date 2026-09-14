"""Workspaces API (/api/workspaces*): create, inspect, rename, access,
quota, kind, default, delete, members.

The model and its rules live in gamma/workspaces.py; this is the HTTP skin.
Anyone creates personal workspaces for themselves; server admins create
shared ones (for any owner) and set access, quota and kind. Owner-only
operations (rename, delete, members) also pass for admins, who need no
membership (a lab workspace whose last owner left can be recovered, and
Settings → Workspaces manages every workspace from one place).
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import workspaces
from ..auth import require_user
from ..server_settings import validate_quota_mb, workspace_quota

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


class WorkspaceCreate(BaseModel):
    name: str
    kind: str | None = None          # personal (default) / shared (admins)
    owner: str | None = None         # admins: create it for this account
    access: str | None = None        # admins, shared: private (default) / public
    public_role: str | None = None   # admins, shared: viewer (default) / editor
    quota_mb: int | None = None      # admins, shared: 0 or omitted = unlimited


class WorkspaceUpdate(BaseModel):
    name: str | None = None          # owners
    default: bool | None = None      # the caller: make this personal workspace my default
    kind: str | None = None          # admins: personal / shared
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
        raise HTTPException(status_code=403, detail=f"only a server admin can {what}")


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
    (``personal_of``, "" when shared), whether it is the caller's default,
    and the explicit members."""
    info = workspaces.get(ws)
    return {**info, "role": workspaces.role_of(ws, user),
            "personal_of": workspaces.personal_owner(ws),
            "default": workspaces.default_workspace(user) == ws,
            "members": workspaces.members(ws)}


@router.post("")
async def create_workspace(payload: WorkspaceCreate, request: Request):
    """A new personal workspace of the caller's. Admins may make it
    ``shared`` (with ``access`` / ``public_role`` / ``quota_mb``) and name
    another ``owner``."""
    user = require_user(request)
    if request.state.is_guest:
        raise HTTPException(status_code=403, detail="the guest account cannot create workspaces")
    name = workspaces.clean_name(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="workspace name required")
    kind = payload.kind or "personal"
    owner = payload.owner or user
    if kind != "personal" or owner != user or payload.access or payload.public_role or payload.quota_mb:
        _admin_only(request, "create a shared workspace, name another owner, or set access and quota")
    if owner != user:
        _valid_owner(owner)
    if len(workspaces.list_for_user(owner)) >= workspaces.MAX_WORKSPACES_PER_USER:
        raise HTTPException(status_code=400, detail="too many workspaces")
    try:
        info = workspaces.create(
            name, owner, kind=kind, by=user, access=payload.access or "private",
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
    """Rename (owner); make it my default (the owner of a personal
    workspace); set kind, access + public role, or the workspace's own
    quota (admin). Fields left out stay as they are."""
    user = _member(request, ws, "owner")
    try:
        if payload.name is not None:
            workspaces.rename(ws, payload.name)
        if payload.default:
            workspaces.set_default(user, ws)
        if payload.kind is not None:
            _admin_only(request, "change a workspace's kind")
            workspaces.set_kind(ws, payload.kind)
        if payload.access is not None:
            _admin_only(request, "set access")
            workspaces.set_access(ws, payload.access, payload.public_role or workspaces.get(ws)["public_role"])
        elif payload.public_role is not None:
            _admin_only(request, "set access")
            workspaces.set_access(ws, workspaces.get(ws)["access"], payload.public_role)
        if "quota_mb" in payload.model_fields_set:
            _admin_only(request, "set a workspace quota")
            workspaces.set_quota(ws, _quota(payload.quota_mb))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {**_payload(ws, user), "quota": workspace_quota(ws)}


@router.delete("/{ws}")
async def delete_workspace(ws: str, request: Request):
    """Delete a workspace and everything in it (owner). An account's last
    personal workspace cannot be deleted; deleting the default moves the
    default to another personal one."""
    _member(request, ws, "owner")
    try:
        warning = workspaces.delete(ws)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "warning": warning}


@router.put("/{ws}/members/{username}")
async def set_member(ws: str, username: str, payload: MemberRole, request: Request):
    """Invite an account, or change a member's role (owner of a shared
    workspace). Naming someone owner is how ownership is handed on."""
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

"""Share links — one per (owner, page), Notion-style people + general access.

A share names a page's root block, so any page can be shared: papers (the
PDF, highlights and notes) and plain note pages alike. Settings:

- ``users``: the people the owner invited — ``[{"name", "role"}]``, each with
  their own ``view``/``edit``; they get in whatever the general access says.
- ``audience`` (general access): ``anyone`` (the link alone, no login),
  ``users`` (any signed-in non-guest account on this server), ``list`` (only
  the invited people).
- ``role``: what general access grants — ``view`` or ``edit``. Editing is
  confined to the page's block tree (gamma/auth.py require_writer + the
  blocks router's scope checks) and needs a signed-in editor — ``edit`` with
  ``anyone`` is refused.

The token confines reads (and edit writes) to that page's subtree and assets
(gamma/auth.py share_grant / share_scope_page).
"""

import json
import secrets
import sqlite3

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import (SHARE_AUDIENCES, SHARE_ROLES, require_user, serialize_share_users,
                    share_access, share_lookup)
from ..blocks_store import page_attachment
from ..db import connect_pages_db, connect_users_db, page_now, shares_has_doc_id

router = APIRouter(prefix="/api", tags=["shares"])


class ShareSettings(BaseModel):
    audience: str | None = None
    role: str | None = None
    users: list | None = None  # ["carol"] or [{"name": "carol", "role": "edit"}] (bare names = view)


def _settings(share: dict) -> dict:
    return {"token": share["token"], "page_id": share["page_id"], "audience": share["audience"],
            "role": share["role"], "users": share["users"]}


def _owned_share(user: str, page_id: str) -> dict | None:
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT token FROM shares WHERE username = ? AND page_id = ?", (user, page_id)
        ).fetchone()
    return share_lookup(row[0]) if row else None


def _require_page(user: str, page_id: str) -> None:
    """404/400 unless page_id is one of the user's root pages."""
    with connect_pages_db(user) as conn:
        row = conn.execute(
            "SELECT parent_id FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found")
    if row[0] != "root":
        raise HTTPException(status_code=400, detail="only pages can be shared")


def _page_doc_id(owner: str, page_id: str) -> str:
    """The id of the shared page's PDF attachment ("" without one) — derived
    from the page, never from the vestigial ``shares.doc_id`` column, so the
    viewer's response keeps its ``doc_id`` field while the column goes."""
    try:
        with connect_pages_db(owner) as conn:
            row = conn.execute(
                "SELECT properties FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
    except (sqlite3.Error, ValueError):
        return ""
    if not row:
        return ""
    try:
        attachment = page_attachment(json.loads(row[0] or "{}"))
    except ValueError:
        return ""
    return attachment["id"] if attachment else ""


def _validated(owner: str, current: dict, payload: ShareSettings) -> dict:
    audience = payload.audience if payload.audience is not None else current["audience"]
    role = payload.role if payload.role is not None else current["role"]
    users = payload.users if payload.users is not None else current["users"]
    if audience not in SHARE_AUDIENCES:
        raise HTTPException(status_code=400, detail="audience must be anyone, users or list")
    if role not in SHARE_ROLES:
        raise HTTPException(status_code=400, detail="role must be view or edit")
    if role == "edit" and audience == "anyone":
        raise HTTPException(status_code=400,
                            detail="editing needs a signed-in editor — choose signed-in users or specific people")
    cleaned: list[dict] = []
    for entry in users:
        if isinstance(entry, dict):
            name, person_role = str(entry.get("name") or "").strip(), entry.get("role") or "view"
        else:
            name, person_role = str(entry or "").strip(), "view"
        if person_role not in SHARE_ROLES:
            raise HTTPException(status_code=400, detail="a person's role must be view or edit")
        if name and name != owner and all(u["name"] != name for u in cleaned):
            cleaned.append({"name": name, "role": person_role})
    if cleaned:
        names = [u["name"] for u in cleaned]
        with connect_users_db() as conn:
            placeholders = ",".join("?" * len(names))
            known = {r[0] for r in conn.execute(
                f"SELECT username FROM users WHERE is_guest = 0 AND username IN ({placeholders})", names)}
        unknown = [n for n in names if n not in known]
        if unknown:
            raise HTTPException(status_code=400, detail=f"unknown user(s): {', '.join(unknown)}")
    return {"audience": audience, "role": role, "users": cleaned}


@router.post("/share/{page_id}")
async def create_share(page_id: str, request: Request, payload: ShareSettings | None = None):
    """Create the page's share link (defaults: anyone, view) — or, when one
    exists, return it unchanged so re-sharing never invalidates a link already
    sent around. An optional body applies settings to a NEW link only."""
    user = require_user(request)
    _require_page(user, page_id)
    existing = _owned_share(user, page_id)
    if existing:
        return _settings(existing)
    fields = _validated(user, {"audience": "anyone", "role": "view", "users": []},
                        payload or ShareSettings())
    token = secrets.token_urlsafe(12)
    with connect_users_db() as conn:
        # shares.doc_id is vestigial (NOT NULL, never read): written as ""
        # while the column exists, omitted once migrate.drop_shares_doc_id ran.
        columns = ["token", "username", "page_id", "audience", "role", "allowed_users", "created_at"]
        values = [token, user, page_id, fields["audience"], fields["role"],
                  serialize_share_users(fields["users"]), page_now()]
        if shares_has_doc_id(conn):
            columns.insert(2, "doc_id")
            values.insert(2, "")
        conn.execute(
            f"INSERT INTO shares ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
            values,
        )
        conn.commit()
    return _settings(share_lookup(token))


@router.get("/share-settings/{page_id}")
async def get_share_settings(page_id: str, request: Request):
    """The owner's view of a page's share: its settings, or ``{"token": null}``
    when the page isn't shared."""
    user = require_user(request)
    _require_page(user, page_id)
    share = _owned_share(user, page_id)
    return _settings(share) if share else {"token": None, "page_id": page_id}


@router.put("/share-settings/{page_id}")
async def update_share_settings(page_id: str, payload: ShareSettings, request: Request):
    """Change who may open the link and what they may do. The token stays."""
    user = require_user(request)
    share = _owned_share(user, page_id)
    if not share:
        raise HTTPException(status_code=404, detail="page is not shared")
    fields = _validated(user, share, payload)
    with connect_users_db() as conn:
        conn.execute(
            "UPDATE shares SET audience = ?, role = ?, allowed_users = ? WHERE token = ?",
            (fields["audience"], fields["role"], serialize_share_users(fields["users"]), share["token"]),
        )
        conn.commit()
    return _settings(share_lookup(share["token"]))


@router.delete("/share-settings/{page_id}")
async def delete_share(page_id: str, request: Request):
    """Stop sharing: the token dies; sharing again mints a new one."""
    user = require_user(request)
    with connect_users_db() as conn:
        cur = conn.execute("DELETE FROM shares WHERE username = ? AND page_id = ?", (user, page_id))
        conn.commit()
    return {"ok": True, "removed": cur.rowcount}


@router.get("/share/{token}")
async def get_share(token: str, request: Request):
    """Resolve a link for the viewer: 404 unknown, 401 when signing in could
    grant access, 403 when this signed-in account isn't allowed. Otherwise the
    page plus what this viewer may do (``can_edit``). ``doc_id`` is the
    page's PDF attachment id ("" without one), derived from the page.
    ``viewer`` / ``viewer_is_guest`` tell the share view whether to offer
    "Open in my library" (the owner) or "Add to my library" (an account that
    can import)."""
    share = share_lookup(token)
    if not share:
        raise HTTPException(status_code=404, detail="share not found")
    level, reason = share_access(share, request)
    if not level:
        if reason == "login":
            raise HTTPException(status_code=401, detail="sign in to open this shared page")
        raise HTTPException(status_code=403, detail="this page is shared with specific people only")
    return {"page_id": share["page_id"], "doc_id": _page_doc_id(share["username"], share["page_id"]),
            "username": share["username"],
            "audience": share["audience"], "role": share["role"], "can_edit": level == "edit",
            "viewer": request.state.user or "", "viewer_is_guest": bool(request.state.is_guest)}

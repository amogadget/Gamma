"""The admin API under ``/api/admin``: accounts, invites, OIDC clients,
the audit log. Only an account with ``is_admin`` (set with ``manage.py
set-admin``) and only through a portal session — never a bearer token from
a Gamma server."""

from contextlib import closing

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import accounts, db, oidc
from ..accounts import Problem
from .accounts import portal_account, send_mail, verify_message

router = APIRouter(prefix="/api/admin")


def require_admin(conn, request: Request):
    account = portal_account(conn, request)
    if not account["is_admin"]:
        raise HTTPException(403, "admin only")
    return account


def _row(account) -> dict:
    return {**accounts.public(account), "deleted_at": account["deleted_at"]}


# --- accounts -----------------------------------------------------------------

@router.get("/accounts")
def list_accounts(request: Request, q: str = "", limit: int = 50, offset: int = 0):
    limit = max(1, min(limit, 200))
    with closing(db.connect()) as conn:
        require_admin(conn, request)
        like = f"%{q.strip().lower()}%"
        rows = conn.execute("SELECT * FROM accounts WHERE username LIKE ? OR email LIKE ? OR id = ? "
                            "ORDER BY created_at DESC LIMIT ? OFFSET ?", (like, like, q.strip(), limit, offset)).fetchall()
        total = conn.execute("SELECT COUNT(*) FROM accounts WHERE username LIKE ? OR email LIKE ? OR id = ?",
                             (like, like, q.strip())).fetchone()[0]
        return {"accounts": [_row(r) for r in rows], "total": total}


@router.get("/accounts/{account_id}")
def get_account(account_id: str, request: Request):
    with closing(db.connect()) as conn:
        require_admin(conn, request)
        row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "no such account")
        audit = conn.execute("SELECT at, actor, event, detail FROM audit WHERE account_id = ? ORDER BY id DESC LIMIT 100",
                             (account_id,)).fetchall()
        return {"account": _row(row), "devices": oidc.devices(conn, account_id),
                "audit": [dict(a) for a in audit]}


class AccountPatch(BaseModel):
    plan: str | None = None
    is_admin: bool | None = None
    verified: bool | None = None
    username: str | None = None


@router.patch("/accounts/{account_id}")
def patch_account(account_id: str, body: AccountPatch, request: Request):
    with closing(db.connect()) as conn:
        admin = require_admin(conn, request)
        account = accounts.by_id(conn, account_id)
        if not account:
            raise HTTPException(404, "no such account")
        if body.plan is not None:
            accounts.set_plan(conn, account_id, body.plan, admin["id"])
        if body.is_admin is not None:
            if account_id == admin["id"] and not body.is_admin:
                raise Problem(400, "you cannot demote yourself")
            accounts.set_admin(conn, account_id, body.is_admin, admin["id"])
        if body.verified:
            accounts.mark_verified(conn, account_id)
        if body.username is not None:
            accounts.set_username(conn, account_id, body.username, admin["id"])
        conn.commit()
        return {"account": _row(accounts.by_id(conn, account_id))}


@router.post("/accounts/{account_id}/resend-verify")
def admin_resend_verify(account_id: str, request: Request):
    with closing(db.connect()) as conn:
        require_admin(conn, request)
        account = accounts.by_id(conn, account_id)
        if not account:
            raise HTTPException(404, "no such account")
        if account["email_verified_at"]:
            return {"ok": True, "already": True}
        message = verify_message(conn, account)
        conn.commit()
    send_mail(*message)
    return {"ok": True}


@router.post("/accounts/{account_id}/delete")
def admin_delete(account_id: str, request: Request):
    with closing(db.connect()) as conn:
        admin = require_admin(conn, request)
        if account_id == admin["id"]:
            raise HTTPException(400, "delete your own account from the account page")
        if not accounts.by_id(conn, account_id):
            raise HTTPException(404, "no such account")
        accounts.delete(conn, account_id, actor=admin["id"])
        conn.commit()
    return {"ok": True}


# --- invites ------------------------------------------------------------------

class InviteBody(BaseModel):
    uses: int = 1
    plan: str = "free"
    note: str = ""


@router.get("/invites")
def list_invites(request: Request):
    with closing(db.connect()) as conn:
        require_admin(conn, request)
        rows = conn.execute("SELECT * FROM invites ORDER BY created_at DESC LIMIT 500").fetchall()
        return {"invites": [dict(r) for r in rows]}


@router.post("/invites")
def create_invite(body: InviteBody, request: Request):
    with closing(db.connect()) as conn:
        admin = require_admin(conn, request)
        row = accounts.make_invite(conn, uses=body.uses, plan=body.plan, note=body.note, created_by=admin["id"])
        conn.commit()
        return {"invite": row}


@router.delete("/invites/{code}")
def delete_invite(code: str, request: Request):
    with closing(db.connect()) as conn:
        admin = require_admin(conn, request)
        cur = conn.execute("DELETE FROM invites WHERE code = ?", (code,))
        if not cur.rowcount:
            raise HTTPException(404, "no such invite")
        db.audit(conn, "invite.delete", actor=admin["id"], detail=code)
        conn.commit()
    return {"ok": True}


# --- OIDC clients -------------------------------------------------------------

class ClientBody(BaseModel):
    name: str
    kind: str
    redirect_uris: list[str]
    server_id: str = ""


@router.get("/clients")
def list_clients(request: Request):
    with closing(db.connect()) as conn:
        require_admin(conn, request)
        rows = conn.execute("SELECT client_id, kind, name, redirect_uris, server_id, created_at FROM oauth_clients "
                            "ORDER BY created_at DESC").fetchall()
        return {"clients": [dict(r) for r in rows]}


@router.post("/clients")
def create_client(body: ClientBody, request: Request):
    with closing(db.connect()) as conn:
        admin = require_admin(conn, request)
        client_id, secret = oidc.create_client(conn, name=body.name, kind=body.kind, redirect_uris=body.redirect_uris,
                                               server_id=body.server_id, actor=admin["id"])
        conn.commit()
    return {"client_id": client_id, "client_secret": secret}


@router.delete("/clients/{client_id}")
def delete_client(client_id: str, request: Request):
    with closing(db.connect()) as conn:
        admin = require_admin(conn, request)
        if not oidc.delete_client(conn, client_id, actor=admin["id"]):
            raise HTTPException(404, "no such client")
        conn.commit()
    return {"ok": True}


# --- audit --------------------------------------------------------------------

@router.get("/audit")
def audit_log(request: Request, limit: int = 200):
    with closing(db.connect()) as conn:
        require_admin(conn, request)
        rows = conn.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (max(1, min(limit, 1000)),)).fetchall()
        return {"audit": [dict(r) for r in rows]}

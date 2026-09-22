"""The portal pages (HTML). The data behind them comes from ``/api``."""

from contextlib import closing

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from .. import accounts, db, oidc, pages, sessions

router = APIRouter()
_HTML = {"Cache-Control": "no-store"}


@router.get("/", response_class=HTMLResponse)
def home(request: Request):
    with closing(db.connect()) as conn:
        account = sessions.resolve(conn, request)
        if not account:
            return RedirectResponse("/login", status_code=302)
        devices = oidc.devices(conn, account["id"])
        conn.commit()
    return HTMLResponse(pages.account_page(accounts.public(account), devices), headers=_HTML)


@router.get("/login", response_class=HTMLResponse)
def login(request: Request):
    with closing(db.connect()) as conn:
        if sessions.resolve(conn, request):
            return RedirectResponse("/", status_code=302)
    return HTMLResponse(pages.login_page(), headers=_HTML)


@router.get("/register", response_class=HTMLResponse)
def register():
    return HTMLResponse(pages.register_page(), headers=_HTML)


@router.get("/verify", response_class=HTMLResponse)
def verify(token: str = ""):
    return HTMLResponse(pages.verify_page(token), headers=_HTML)


@router.get("/email/confirm", response_class=HTMLResponse)
def email_confirm(token: str = ""):
    return HTMLResponse(pages.email_confirm_page(token), headers=_HTML)


@router.get("/reset", response_class=HTMLResponse)
def reset():
    return HTMLResponse(pages.reset_page(), headers=_HTML)


@router.get("/reset/confirm", response_class=HTMLResponse)
def reset_confirm(token: str = ""):
    return HTMLResponse(pages.reset_confirm_page(token), headers=_HTML)


@router.get("/api/health")
def health():
    return {"ok": True}

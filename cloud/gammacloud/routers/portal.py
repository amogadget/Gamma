"""The portal pages (HTML). The data behind them comes from ``/api``."""

from contextlib import closing

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from .. import accounts, db, identities, oidc, pages, providers, sessions
from .external import sign_in_page

router = APIRouter()
NO_STORE = pages.NO_STORE


def _app_page(request: Request, render):
    """An app page: ``render(account, devices, linked identities)`` gives its
    HTML, or None for a 404; signed out redirects to the login page."""
    with closing(db.connect()) as conn:
        account = sessions.resolve(conn, request)
        if not account:
            return RedirectResponse("/login", status_code=302)
        devices = oidc.devices(conn, account["id"])
        linked = identities.of_account(conn, account["id"])
        conn.commit()
    html = render(accounts.public(account), devices, linked)
    if html is None:
        return HTMLResponse(pages.error_page("Not found", "There is no such page."), status_code=404)
    return HTMLResponse(html, headers=NO_STORE)


@router.get("/", response_class=HTMLResponse)
def home(request: Request):
    return _app_page(request, lambda account, devices, _: pages.overview_page(account, devices))


@router.get("/devices", response_class=HTMLResponse)
def devices(request: Request):
    return _app_page(request, lambda account, devices, _: pages.devices_page(account, devices))


@router.get("/settings", response_class=HTMLResponse)
def settings(request: Request):
    return _app_page(request, lambda account, _, linked: pages.settings_page(account, linked, providers.enabled()))


@router.get("/admin", response_class=HTMLResponse)
def admin(request: Request):
    return _app_page(request, lambda account, *_: pages.admin_page(account) if account["is_admin"] else None)


@router.get("/login", response_class=HTMLResponse)
def login(request: Request):
    with closing(db.connect()) as conn:
        if sessions.resolve(conn, request):
            return RedirectResponse("/", status_code=302)
    return sign_in_page(request, pages.login_page)


@router.get("/register", response_class=HTMLResponse)
def register(request: Request):
    return sign_in_page(request, pages.register_page)


@router.get("/verify", response_class=HTMLResponse)
def verify(token: str = ""):
    return HTMLResponse(pages.verify_page(token), headers=NO_STORE)


@router.get("/email/confirm", response_class=HTMLResponse)
def email_confirm(token: str = ""):
    return HTMLResponse(pages.email_confirm_page(token), headers=NO_STORE)


@router.get("/reset", response_class=HTMLResponse)
def reset():
    return HTMLResponse(pages.reset_page(), headers=NO_STORE)


@router.get("/reset/confirm", response_class=HTMLResponse)
def reset_confirm(token: str = ""):
    return HTMLResponse(pages.reset_confirm_page(token), headers=NO_STORE)


@router.get("/api/health")
def health():
    return {"ok": True}

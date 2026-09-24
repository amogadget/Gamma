"""Sign in with Google / GitHub: the wire of ``identities.py``.

- ``POST /api/oauth/{provider}/start`` — the page's button asks for the
  provider URL (JSON, so no other site can start a sign-in for the
  browser) and gets the ``gc_ext`` cookie. ``link`` connects the provider
  to the signed-in account instead; ``request_id`` is a Gamma server's
  pending authorize request to finish once signed in.
- ``GET /oauth/{provider}/callback`` — the provider sends the browser back;
  the state must match the cookie's. Ends signed in (and, for a Gamma
  server's sign-in, straight on that server), on the signup form for a new
  person, or on a page that says what went wrong.
- ``POST /api/oauth/google/one-tap`` — the credential from Google's
  sign-in prompt, checked against the nonce in the ``gc_tap`` cookie.
- ``POST /api/oauth/signup`` — the signup form: username (+ invite).
- ``POST /api/me/identities/{provider}/unlink`` — Settings.
"""

import hmac
from contextlib import closing
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from .. import accounts, config, db, identities, oidc, pages, providers, ratelimit, sessions
from ..accounts import Problem
from ..db import new_token
from ..pages import NO_STORE
from .accounts import portal_account

router = APIRouter()


def _provider(provider: str) -> str:
    if provider not in providers.enabled():
        raise HTTPException(404, "That sign-in method is not available here.")
    return provider


def sign_in_page(request: Request, render, *, next_url: str = "/", request_id: str = "", status: int = 200):
    """An HTML page with the provider buttons and, when on, Google's one-tap
    prompt. ``render(social)`` builds the page from the options. Google's
    script needs the page's origin as referrer, so these pages send it
    (origin only — they carry no token in the URL)."""
    seed = request.cookies.get(identities.TAP_COOKIE) or new_token(24)
    tap = {"client_id": config.GOOGLE_CLIENT_ID, "nonce": identities.derive(seed, "one-tap")} if providers.one_tap() else None
    social = {"providers": providers.enabled(), "tap": tap, "next": identities.safe_next(next_url), "request_id": request_id}
    resp = HTMLResponse(render(social), status_code=status,
                        headers={**NO_STORE, "Referrer-Policy": "strict-origin-when-cross-origin"})
    if tap and seed != request.cookies.get(identities.TAP_COOKIE):
        sessions.set_cookie(resp, seed, name=identities.TAP_COOKIE, max_age=None)
    return resp


def _fail(message: str, back: str = "/login", status: int = 400):
    return HTMLResponse(pages.error_page("Could not sign you in", message, back), status_code=status, headers=NO_STORE)


def _back(flow: dict) -> str:
    """Where a cancelled or failed sign-in returns to."""
    if flow.get("link_account"):
        return "/settings"
    if flow.get("request_id"):
        return f"/authorize/resume?request_id={quote(flow['request_id'])}"
    return "/login"


def _sign_in(conn, request: Request, account, flow: dict, via: str) -> tuple[str, str]:
    """A portal session for the account; returns (where to go, session
    token). A Gamma server's pending sign-in finishes right here when it can."""
    token = sessions.create(conn, account["id"], request)
    db.audit(conn, "account.login", account["id"], account["id"], f"{via} {ratelimit.client_ip(request)}")
    if flow.get("request_id"):
        req = oidc.pending(conn, flow["request_id"])
        if req and account["email_verified_at"]:
            return oidc.finish(conn, req, account), token
        return _back(flow), token
    return identities.safe_next(flow.get("next", "/")), token


def _complete(request: Request, flow: dict, ident: providers.Identity) -> tuple[str, str, str]:
    """After a verified identity: (redirect, session token, signup token);
    raises Problem."""
    with closing(db.connect()) as conn:
        if flow.get("link_account"):
            account = sessions.resolve(conn, request)
            if not account or account["id"] != flow["link_account"]:
                raise Problem(401, "Sign in again, then connect the account from Settings.")
            identities.link(conn, account["id"], ident)
            conn.commit()
            return f"/settings?connected={ident.provider}", "", ""
        account = identities.resolve(conn, ident)
        if account is None:
            if config.REGISTRATION == "closed":
                raise Problem(403, f"No Gamma Cloud account uses this {providers.NAMES[ident.provider]} account, "
                                   "and registration is closed.")
            ext = identities.to_signup(conn, flow, ident)
            conn.commit()
            return "/signup/finish", "", ext
        redirect, token = _sign_in(conn, request, account, flow, ident.provider)
        conn.commit()
        return redirect, token, ""


def _respond(resp, token: str, ext: str):
    if token:
        sessions.set_cookie(resp, token)
    if ext:
        sessions.set_cookie(resp, ext, name=identities.COOKIE, max_age=config.EXTERNAL_LOGIN_TTL)
    else:
        resp.delete_cookie(identities.COOKIE, path="/")
    return resp


# --- the round trip -----------------------------------------------------------

class StartBody(BaseModel):
    next: str = "/"
    request_id: str = ""
    link: bool = False


@router.post("/api/oauth/{provider}/start")
def start(provider: str, body: StartBody, request: Request):
    _provider(provider)
    ratelimit.check(f"oauth-start:ip:{ratelimit.client_ip(request)}", 30, 600)
    with closing(db.connect()) as conn:
        link_account = portal_account(conn, request)["id"] if body.link else ""
        token = identities.start(conn, provider, next_url=body.next, request_id=body.request_id,
                                 link_account=link_account)
        conn.commit()
    url = providers.authorize_url(provider, state=identities.derive(token, "state"),
                                  verifier=identities.derive(token, "pkce"), nonce=identities.derive(token, "nonce"))
    resp = JSONResponse({"url": url})
    sessions.set_cookie(resp, token, name=identities.COOKIE, max_age=config.EXTERNAL_LOGIN_TTL)
    return resp


@router.get("/oauth/{provider}/callback")
def callback(provider: str, request: Request, code: str = "", state: str = "", error: str = ""):
    _provider(provider)
    ratelimit.check(f"oauth-callback:ip:{ratelimit.client_ip(request)}", 30, 600)
    token = request.cookies.get(identities.COOKIE, "")
    with closing(db.connect()) as conn:
        flow = identities.load(conn, token, "redirect")
        if flow:
            identities.drop(conn, token)
            conn.commit()
    if not flow or flow["provider"] != provider or not hmac.compare_digest(state.encode(), identities.derive(token, "state").encode()):
        return _fail("This sign-in expired or was started in another browser. Try again.")
    if error:  # the person cancelled at the provider
        return _respond(RedirectResponse(_back(flow), status_code=302), "", "")
    try:
        ident = providers.fetch_identity(provider, code, verifier=identities.derive(token, "pkce"),
                                         nonce=identities.derive(token, "nonce"))
        redirect, session, ext = _complete(request, flow, ident)
    except Problem as e:
        return _respond(_fail(e.detail, _back(flow), e.status), "", "")
    return _respond(RedirectResponse(redirect, status_code=302), session, ext)


class OneTapBody(BaseModel):
    credential: str
    next: str = "/"
    request_id: str = ""


@router.post("/api/oauth/google/one-tap")
def one_tap(body: OneTapBody, request: Request):
    if not providers.one_tap():
        raise HTTPException(404, "Google sign-in is not available here.")
    ratelimit.check(f"oauth-callback:ip:{ratelimit.client_ip(request)}", 30, 600)
    seed = request.cookies.get(identities.TAP_COOKIE, "")
    if not seed:
        raise HTTPException(400, "Reload the page and try again.")
    flow = {"next": body.next, "request_id": body.request_id}
    ident = providers.google_identity(body.credential, identities.derive(seed, "one-tap"))
    redirect, session, ext = _complete(request, flow, ident)
    return _respond(JSONResponse({"redirect": redirect}), session, ext)


# --- the signup form ----------------------------------------------------------

@router.get("/signup/finish", response_class=HTMLResponse)
def signup_page(request: Request):
    with closing(db.connect()) as conn:
        flow = identities.load(conn, request.cookies.get(identities.COOKIE, ""), "signup")
        if not flow:
            return RedirectResponse("/login", status_code=302)
        suggestion = identities.suggest_username(conn, flow)
    return HTMLResponse(pages.signup_finish_page(flow, suggestion), headers=NO_STORE)


class SignupBody(BaseModel):
    username: str
    invite: str = ""


@router.post("/api/oauth/signup")
def signup(body: SignupBody, request: Request):
    ratelimit.check(f"register:ip:{ratelimit.client_ip(request)}", 20, 3600)
    ext = request.cookies.get(identities.COOKIE, "")
    with closing(db.connect()) as conn:
        flow = identities.load(conn, ext, "signup")
        if not flow:
            raise HTTPException(400, "This sign-up expired. Start again from the sign-in page.")
        account = identities.create_from(conn, flow, body.username, body.invite)
        identities.drop(conn, ext)
        redirect, token = _sign_in(conn, request, account, flow, flow["provider"])
        conn.commit()
    return _respond(JSONResponse({"redirect": redirect, "account": accounts.public(account)}, status_code=201), token, "")


# --- settings -----------------------------------------------------------------

@router.post("/api/me/identities/{provider}/unlink")
def unlink(provider: str, request: Request):
    with closing(db.connect()) as conn:
        identities.unlink(conn, portal_account(conn, request), provider)
        conn.commit()
    return {"ok": True}

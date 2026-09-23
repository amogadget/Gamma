"""The OpenID Connect endpoints: discovery, JWKS, authorize (an HTML page
that signs the person in, or lets a signed-in person continue), token,
userinfo, revoke. The logic is in ``oidc.py``; this is the wire.

An account whose e-mail is not verified cannot sign in to a Gamma server:
the authorize page shows the verify notice instead of issuing a code. That
is the one gate a hosted Gamma relies on.
"""

from contextlib import closing

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from .. import accounts, db, oidc, pages, ratelimit, sessions
from ..oidc import OAuthError
from .external import sign_in_page

router = APIRouter()


def _no_store(payload, status=200):
    return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


def _oauth_error(e: OAuthError):
    return _no_store({"error": e.code, "error_description": e.description}, e.status if e.status != 302 else 400)


@router.get("/.well-known/openid-configuration")
def discovery():
    return oidc.discovery()


@router.get("/jwks")
def jwks():
    with closing(db.connect()) as conn:
        oidc.ensure_signing_key(conn)
        conn.commit()
        return JSONResponse(oidc.jwks(conn), headers={"Cache-Control": "public, max-age=300"})


# --- authorize ----------------------------------------------------------------

@router.get("/authorize")
def authorize(request: Request):
    ratelimit.check(f"authorize:ip:{ratelimit.client_ip(request)}", 60, 600)
    if len(str(request.url)) > 8192:
        raise HTTPException(414)
    params = dict(request.query_params)
    with closing(db.connect()) as conn:
        try:
            req = oidc.begin(conn, params)
        except OAuthError as e:
            if e.status == 302:
                extra = {"error": e.code, "error_description": e.description}
                if params.get("state"):
                    extra["state"] = params["state"]
                return RedirectResponse(oidc.redirect_with(params["redirect_uri"], extra), status_code=302)
            return HTMLResponse(pages.error_page("Cannot sign in", e.description), status_code=400)
        account = sessions.resolve(conn, request)
        conn.commit()
    return _authorize_page(request, req, account)


def _authorize_page(request: Request, req: dict, account):
    if account and not account["email_verified_at"]:
        return HTMLResponse(pages.authorize_page(req, account, verify_needed=True), headers={"Cache-Control": "no-store"})
    if account:
        return HTMLResponse(pages.authorize_page(req, account), headers={"Cache-Control": "no-store"})
    return sign_in_page(request, lambda social: pages.authorize_page(req, None, social=social), request_id=req["id"])


@router.get("/authorize/resume")
def authorize_resume(request: Request, request_id: str = ""):
    """The authorize page again for a request still pending — where a
    Google/GitHub sign-in started there comes back when it cannot finish
    on its own (cancelled, or the account's e-mail is unconfirmed)."""
    with closing(db.connect()) as conn:
        req = oidc.pending(conn, request_id)
        account = sessions.resolve(conn, request)
        conn.commit()
    if not req:
        return HTMLResponse(pages.error_page("Cannot sign in", "This sign-in request expired. Start again from the app."),
                            status_code=400)
    return _authorize_page(request, req, account)


class AuthorizeLogin(BaseModel):
    request_id: str
    login: str
    password: str


@router.post("/authorize/login")
def authorize_login(body: AuthorizeLogin, request: Request):
    """Sign in on the authorize page; answers ``{redirect}`` for the page to
    follow. Also sets the portal cookie, so the next server's sign-in is one
    click."""
    ip = ratelimit.client_ip(request)
    who = body.login.strip().lower()[:254]
    ratelimit.check(f"login:ip:{ip}", 10, 300)
    ratelimit.check(f"login:who:{who}", 10, 300)
    with closing(db.connect()) as conn:
        req = oidc.pending(conn, body.request_id)
        if not req:
            raise HTTPException(400, "This sign-in request expired. Start again from the app.")
        account = accounts.by_login(conn, who)
        if not accounts.password_ok(account, body.password):
            raise HTTPException(401, "Wrong e-mail, username or password.")
        token = sessions.create(conn, account["id"], request)
        if not account["email_verified_at"]:
            conn.commit()
            resp = JSONResponse({"verify_needed": True, "account": accounts.public(account)})
            sessions.set_cookie(resp, token)
            return resp
        redirect = oidc.finish(conn, req, account)
        conn.commit()
    ratelimit.reset(f"login:ip:{ip}")
    ratelimit.reset(f"login:who:{who}")
    resp = JSONResponse({"redirect": redirect})
    sessions.set_cookie(resp, token)
    return resp


class AuthorizeContinue(BaseModel):
    request_id: str


@router.post("/authorize/continue")
def authorize_continue(body: AuthorizeContinue, request: Request):
    """The signed-in person confirmed the server that is asking."""
    with closing(db.connect()) as conn:
        req = oidc.pending(conn, body.request_id)
        if not req:
            raise HTTPException(400, "This sign-in request expired. Start again from the app.")
        account = sessions.resolve(conn, request)
        if not account:
            raise HTTPException(401, "not signed in")
        if not account["email_verified_at"]:
            raise HTTPException(403, "Confirm your e-mail address first.")
        redirect = oidc.finish(conn, req, account)
        conn.commit()
    return {"redirect": redirect}


@router.post("/authorize/cancel")
def authorize_cancel(body: AuthorizeContinue):
    with closing(db.connect()) as conn:
        req = oidc.pending(conn, body.request_id)
        if not req:
            return {"redirect": ""}
        conn.execute("DELETE FROM oauth_requests WHERE id = ?", (req["id"],))
        conn.commit()
    extra = {"error": "access_denied"}
    if req["state"]:
        extra["state"] = req["state"]
    return {"redirect": oidc.redirect_with(req["redirect_uri"], extra)}


# --- token / userinfo / revoke ------------------------------------------------

async def _client_from(request: Request, form) -> tuple[str, str | None]:
    """client_id + secret from the body (client_secret_post) or the
    Authorization header (client_secret_basic)."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("basic "):
        import base64
        try:
            raw = base64.b64decode(auth[6:]).decode()
            client_id, _, secret = raw.partition(":")
            return client_id, secret
        except (ValueError, UnicodeDecodeError):
            raise OAuthError("invalid_client", "bad basic auth", 401)
    return str(form.get("client_id", "")), (str(form["client_secret"]) if form.get("client_secret") else None)


@router.post("/token")
async def token(request: Request):
    ratelimit.check(f"token:ip:{ratelimit.client_ip(request)}", 120, 600)
    if int(request.headers.get("content-length", "0") or 0) > 16384:
        raise HTTPException(413)
    form = await request.form()
    grant_type = str(form.get("grant_type", ""))
    with closing(db.connect()) as conn:
        try:
            client_id, secret = await _client_from(request, form)
            client = oidc.authenticate_client(conn, client_id, secret)
            if grant_type == "authorization_code":
                out = oidc.exchange_code(conn, client, str(form.get("code", "")), str(form.get("redirect_uri", "")),
                                         str(form.get("code_verifier", "")), request)
            elif grant_type == "refresh_token":
                out = oidc.refresh_grant(conn, client, str(form.get("refresh_token", "")), request)
            else:
                raise OAuthError("unsupported_grant_type")
        except OAuthError as e:
            conn.commit()  # a replayed code's revocation must land
            return _oauth_error(e)
        conn.commit()
    return _no_store(out)


@router.get("/userinfo")
def userinfo(request: Request):
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return _no_store({"error": "invalid_token"}, 401)
    with closing(db.connect()) as conn:
        found = oidc.resolve_access_token(conn, auth[7:].strip())
        conn.commit()
        if not found:
            return _no_store({"error": "invalid_token"}, 401)
        account, row = found
        return _no_store({"sub": account["id"], **oidc.claims_for(account, row["scope"])})


@router.post("/revoke")
async def revoke(request: Request):
    form = await request.form()
    with closing(db.connect()) as conn:
        try:
            client_id, secret = await _client_from(request, form)
            client = oidc.authenticate_client(conn, client_id, secret)
        except OAuthError as e:
            return _oauth_error(e)
        oidc.revoke(conn, client, str(form.get("token", "")))
        conn.commit()
    return _no_store({})

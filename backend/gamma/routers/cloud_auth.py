"""Sign in with Gamma Cloud — the wire around ``gamma/cloud_auth.py``:

- ``GET /api/server-config`` (public): what the login page needs — whether
  cloud sign-in is on and the account server's address;
- ``GET /api/auth/cloud/start?next=&link=1`` → redirect to the account
  server (``link=1`` with a session attaches the identity to that account);
- ``GET /api/auth/cloud/callback?code=&state=`` → session cookie + redirect
  to ``next``, or back to the login page with ``?cloud_error=``;
- ``GET /api/auth/cloud/status`` / ``POST /api/auth/cloud/unlink`` for the
  signed-in account's own identity (Settings → Account).
"""

from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from .. import cloud_auth, ratelimit
from ..auth import require_personal_user, require_user, set_session_cookie
from ..cloud_auth import CloudAuthError
from ..db import connect_users_db
from ..logbuf import log
from .auth import new_session

router = APIRouter()


@router.get("/api/server-config")
async def server_config():
    cfg = cloud_auth.settings()
    return {"cloud": {"enabled": cfg["enabled"], "issuer": cfg["issuer"] if cfg["enabled"] else ""},
            "password_login": True, "registration": False}


@router.get("/api/auth/cloud/start")
def cloud_start(request: Request, next: str = "/", link: str = ""):
    ratelimit.check(f"cloud-start:ip:{ratelimit.client_ip(request)}", 30, 600)
    link_user = None
    if link:
        link_user = require_personal_user(request, "Sign in with a password first to link a Gamma Cloud account.")
        if request.state.is_guest:
            raise HTTPException(403, "The guest account cannot be linked.")
    try:
        url = cloud_auth.begin(request, link_user=link_user, next_path=cloud_auth.safe_next(next))
    except CloudAuthError as e:
        raise HTTPException(503, str(e))
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})


def _login_redirect(error: str, next_path: str = "/") -> RedirectResponse:
    query = urlencode({"cloud_error": error})
    return RedirectResponse(f"{next_path.split('?')[0] or '/'}?{query}", status_code=302,
                            headers={"Cache-Control": "no-store"})


@router.get("/api/auth/cloud/callback")
def cloud_callback(request: Request, code: str = "", state: str = "", error: str = "",
                   error_description: str = ""):
    ratelimit.check(f"cloud-callback:ip:{ratelimit.client_ip(request)}", 30, 600)
    if error:
        return _login_redirect(error_description or ("Sign-in cancelled." if error == "access_denied" else error))
    try:
        claims, tokens, next_path = cloud_auth.exchange(request, code=code, state=state)
        claims["_refresh_token"] = tokens.get("refresh_token", "")
        username = cloud_auth.resolve_account(claims)
    except CloudAuthError as e:
        log.info(f"cloud sign-in refused: {e}")
        return _login_redirect(str(e))
    token = new_session(username)
    resp = RedirectResponse(next_path, status_code=302, headers={"Cache-Control": "no-store"})
    set_session_cookie(resp, token, request)
    return resp


@router.get("/api/auth/cloud/status")
async def cloud_status(request: Request):
    user = require_user(request)
    return {"identity": cloud_auth.status_of(user), "enabled": cloud_auth.settings()["enabled"]}


@router.post("/api/auth/cloud/unlink")
async def cloud_unlink(request: Request):
    """Detach the cloud identity. An account the cloud provisioned has no
    password, so unlinking would lock it out: refused until a password is
    set."""
    user = require_personal_user(request, "unlink from a browser session")
    with connect_users_db() as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE username = ?", (user,)).fetchone()
        if not row or not row[0]:
            raise HTTPException(400, "Set a password for this account first, or it could not sign in any more.")
        if not cloud_auth.unlink(conn, user):
            raise HTTPException(404, "no Gamma Cloud account is linked")
        conn.commit()
    log.info(f"cloud sign-in: {user} unlinked")
    return {"ok": True}

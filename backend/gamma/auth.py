"""Session middleware and request→user resolution helpers."""

import secrets
import sqlite3
import time
from datetime import datetime, timezone

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .config import USERS_DB
from .db import page_now
from .logbuf import log
from .seed import reset_guest_data

SESSION_COOKIE = "session"
SESSION_MAX_AGE = 365 * 24 * 3600
_AUTH_PATHS = {"/api/login", "/api/login-guest", "/api/logout", "/api/session"}


def _finish_request_log(request: Request, response, started: float, expected: str | None, reason: str = ""):
    """Correlate browser diagnostics with useful, low-noise CLI context."""
    request_id = request.state.request_id
    response.headers["X-Gamma-Request-ID"] = request_id
    elapsed_ms = (time.perf_counter() - started) * 1000
    status = response.status_code
    path = request.url.path
    # Uvicorn already prints every access. Supplement only failures,
    # authentication operations, and requests slow enough to investigate.
    if status < 400 and path not in _AUTH_PATHS and elapsed_ms < 2000:
        return response
    if not reason:
        if status == 401:
            reason = "authentication-required"
        elif status == 403:
            reason = "forbidden"
        elif status >= 500:
            reason = "server-error"
        elif path in _AUTH_PATHS:
            reason = "session-operation"
        else:
            reason = "request-rejected"
    log.info(
        f"[http] request={request_id} {request.method} {path} status={status} "
        f"duration_ms={elapsed_ms:.1f} session={request.state.user or '-'} "
        f"expected={expected if expected is not None else '-'} reason={reason}"
    )
    return response


def set_session_cookie(response, token: str):
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=SESSION_MAX_AGE)


async def session_middleware(request: Request, call_next):
    """Resolve the session cookie to request.state.user / is_guest.

    Guest sessions are date-stamped: on the first request of a new UTC day the
    guest workspace is wiped, re-seeded, and a fresh session is issued.
    """
    started = time.perf_counter()
    request.state.request_id = secrets.token_hex(4)
    token = request.cookies.get(SESSION_COOKIE)
    request.state.user = None
    request.state.is_guest = False
    request.state.is_admin = False
    new_session_token = None
    if token:
        with sqlite3.connect(str(USERS_DB)) as conn:
            row = conn.execute(
                "SELECT u.username, u.is_guest, u.is_admin, s.guest_date FROM sessions s "
                "JOIN users u ON s.username = u.username WHERE s.token = ?",
                (token,),
            ).fetchone()
            if row:
                username, is_guest, is_admin, guest_date = row
                if is_guest:
                    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                    if guest_date != today:
                        # New day — wipe and recreate the guest workspace
                        conn.execute("DELETE FROM sessions WHERE username = 'guest'")
                        conn.commit()
                        reset_guest_data()
                        new_session_token = secrets.token_urlsafe(32)
                        conn.execute(
                            "INSERT INTO sessions (token, username, guest_date, created_at) VALUES (?, 'guest', ?, ?)",
                            (new_session_token, today, page_now()),
                        )
                        conn.commit()
                request.state.user = username
                request.state.is_guest = bool(is_guest)
                request.state.is_admin = bool(is_admin) and not is_guest
    # The session cookie is browser-wide, so logging in from a second tab
    # silently switches every other tab's identity. Tabs declare who they
    # think is signed in (X-Gamma-User); on mismatch refuse the request
    # instead of reading/writing the wrong account's data. Requests without
    # the header (share views, pdf.js range requests) behave as before.
    expected = request.headers.get("x-gamma-user")
    if expected is not None and request.url.path.startswith("/api/") and expected != (request.state.user or ""):
        now_who = f'"{request.state.user}"' if request.state.user else "signed out"
        resp = JSONResponse(
            {
                "detail": f'This tab is signed in as "{expected}", but the browser '
                f"session is now {now_who}. Reload the tab to continue."
            },
            status_code=409,
        )
        resp.headers["X-Gamma-Session-User"] = request.state.user or ""
        return _finish_request_log(request, resp, started, expected, "session-mismatch")
    response = await call_next(request)
    if new_session_token:
        set_session_cookie(response, new_session_token)
    return _finish_request_log(request, response, started, expected)


def require_user(request: Request) -> str:
    """Return the session username or raise 401. Use for all write endpoints."""
    user = request.state.user
    if not user:
        raise HTTPException(status_code=401)
    return user


def require_admin(request: Request) -> str:
    """Return the session username or raise 401/403. Admin-only endpoints."""
    user = require_user(request)
    if not request.state.is_admin:
        raise HTTPException(status_code=403, detail="admin privilege required")
    return user


def resolve_user(request: Request) -> str:
    """Return the user whose data to read.

    Session user if logged in, else the ?user= query param (public shared
    links pass the owner explicitly). Read-only endpoints only.
    """
    user = request.state.user
    if user:
        return user
    user = request.query_params.get("user")
    if user:
        return user
    raise HTTPException(status_code=401)

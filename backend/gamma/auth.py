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


def _session_expired(created_at: str) -> bool:
    """True if a session row is older than SESSION_MAX_AGE. Unparseable
    timestamps are treated as expired (fail closed)."""
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return True
    return (datetime.now(timezone.utc) - created).total_seconds() > SESSION_MAX_AGE


def _is_https(request: Request) -> bool:
    """True when the client's connection to us (or the TLS-terminating proxy in
    front) is HTTPS. Used to add Secure/HSTS only when they won't break the
    plain-HTTP LAN access this app also supports."""
    if request.url.scheme == "https":
        return True
    return request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"


def _apply_security_headers(request: Request, response) -> None:
    """Baseline hardening headers on every response. Deliberately conservative:
    a resource-restricting CSP would break the SPA, so we only set
    frame-ancestors (clickjacking) plus nosniff / referrer / (conditional) HSTS."""
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "SAMEORIGIN")
    h.setdefault("Referrer-Policy", "no-referrer")
    h.setdefault("Content-Security-Policy", "frame-ancestors 'self'")
    if _is_https(request):
        h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")


def _finish_request_log(request: Request, response, started: float, expected: str | None, reason: str = ""):
    """Correlate browser diagnostics with useful, low-noise CLI context."""
    request_id = request.state.request_id
    response.headers["X-Gamma-Request-ID"] = request_id
    _apply_security_headers(request, response)
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


def set_session_cookie(response, token: str, request: Request | None = None):
    # Secure only when the connection is HTTPS — this app is also reached over
    # plain HTTP on the LAN, where a Secure cookie would never be sent and login
    # would silently fail. Behind TLS (or a proxy sending X-Forwarded-Proto) the
    # flag turns on automatically.
    secure = bool(request is not None and _is_https(request))
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax",
                        max_age=SESSION_MAX_AGE, secure=secure)


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
                "SELECT u.username, u.is_guest, u.is_admin, s.guest_date, s.created_at FROM sessions s "
                "JOIN users u ON s.username = u.username WHERE s.token = ?",
                (token,),
            ).fetchone()
            if row and _session_expired(row[4]):
                # Server-side expiry: a stolen token can't outlive its window
                # even though the browser cookie's Max-Age is long.
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                row = None
            if row:
                username, is_guest, is_admin, guest_date, _created = row
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
        set_session_cookie(response, new_session_token, request)
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


def share_grant(request: Request):
    """(owner_username, doc_id) if the request carries a valid ?share=<token>,
    else None. Cached on request.state so repeat calls in one request are free.

    This is the ONLY unauthenticated read path: a share token is minted per
    document and names its owner, so access is scoped to that one document — the
    old ?user= fallback trusted any username and leaked whole accounts.
    """
    cached = getattr(request.state, "_share_grant", "unset")
    if cached != "unset":
        return cached
    token = request.query_params.get("share")
    grant = None
    if token:
        with sqlite3.connect(str(USERS_DB)) as conn:
            row = conn.execute(
                "SELECT username, doc_id FROM shares WHERE token = ?", (token,)
            ).fetchone()
        if row:
            grant = (row[0], row[1])
    request.state._share_grant = grant
    return grant


def share_scope_doc(request: Request):
    """The doc id a read is confined to, or None for a full-access session user.

    Read endpoints pass this to blocks_store.assert_block_in_doc so a share
    token can only reach its own document's subtree and assets.
    """
    if request.state.user:
        return None
    grant = share_grant(request)
    return grant[1] if grant else None


def resolve_user(request: Request) -> str:
    """Return the user whose data to read: the session user, or the owner named
    by a valid ?share=<token>. Read-only endpoints only; callers that can serve
    a share view must also enforce share_scope_doc()."""
    user = request.state.user
    if user:
        return user
    grant = share_grant(request)
    if grant:
        return grant[0]
    raise HTTPException(status_code=401)

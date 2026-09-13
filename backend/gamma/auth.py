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
    _apply_share_cors(request, response)


def _apply_share_cors(request: Request, response) -> None:
    """Share reads are readable cross-origin, so another Gamma's frontend can
    pull a shared page straight into its library (Import → share link, the
    share view's "Add to my library"): a GET carrying ?share= or resolving
    /api/share/{token} answers ``Access-Control-Allow-Origin: *``. Nothing
    leaks that the token alone doesn't already grant: ``*`` makes browsers
    refuse credentialed responses, so a cross-origin fetch arrives without a
    session and only ``anyone`` shares open (a signed-in-only share answers
    401 as it would to any stranger). Writes and every other endpoint keep the
    browser's same-origin default."""
    if request.method != "GET":
        return
    path = request.url.path
    if request.query_params.get("share") or path.startswith("/api/share/"):
        response.headers["Access-Control-Allow-Origin"] = "*"


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
        elif status < 400:
            # Successful but ≥2s — logged for the duration, not a failure
            # (AI calls, big downloads). The old fallback stamped these
            # "request-rejected", which read as an error.
            reason = "slow-request"
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


def session_lookup(token: str | None):
    """``(username, is_guest, is_admin)`` for a live session token, else None.
    Read-only (no guest-day rollover) — what a websocket handshake uses, since
    ``session_middleware`` only runs for HTTP requests."""
    if not token:
        return None
    with sqlite3.connect(str(USERS_DB)) as conn:
        row = conn.execute(
            "SELECT u.username, u.is_guest, u.is_admin, s.created_at FROM sessions s "
            "JOIN users u ON s.username = u.username WHERE s.token = ?", (token,),
        ).fetchone()
    if not row or _session_expired(row[3]):
        return None
    return row[0], bool(row[1]), bool(row[2]) and not row[1]


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
    if expected is not None and request.url.path.startswith("/api/") \
            and expected != (request.state.user or ""):
        now_who = f'"{request.state.user}"' if request.state.user else "signed out"
        resp = JSONResponse(
            {"detail": f'This tab is signed in as "{expected}", but the browser '
                       f"session is now {now_who}. Reload the tab to continue."},
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


SHARE_AUDIENCES = ("anyone", "users", "list")
SHARE_ROLES = ("view", "edit")


def parse_share_users(raw: str) -> list[dict]:
    """``allowed_users`` ("carol:edit,dave" — a missing role means view) →
    [{"name", "role"}]."""
    users = []
    for item in (raw or "").split(","):
        name, _, role = item.strip().partition(":")
        if name:
            users.append({"name": name, "role": role if role in SHARE_ROLES else "view"})
    return users


def serialize_share_users(users: list[dict]) -> str:
    return ",".join(f"{u['name']}:{u['role']}" for u in users)


def share_lookup(token: str) -> dict | None:
    """The share row for a token as a dict ({token, username, page_id,
    audience, role, users}), or None. Every row carries page_id: the ones
    minted before shares were keyed by page were backfilled (or deleted) by
    gamma/migrate.py, so a row without one is treated as dead. The vestigial
    ``shares.doc_id`` column is never read (the page's attachment is what
    counts — blocks_store.page_attachment); ``migrate.drop_shares_doc_id``
    removes it once every deployed binary stopped writing it."""
    if not token:
        return None
    with sqlite3.connect(str(USERS_DB)) as conn:
        row = conn.execute(
            "SELECT username, page_id, audience, role, allowed_users "
            "FROM shares WHERE token = ?", (token,)
        ).fetchone()
        if not row:
            return None
        username, page_id, audience, role, allowed = row
    if not page_id:
        return None
    return {
        "token": token, "username": username, "page_id": page_id,
        "audience": audience if audience in SHARE_AUDIENCES else "anyone",
        "role": role if role in SHARE_ROLES else "view",
        "users": parse_share_users(allowed),
    }


def share_access(share: dict, request: Request):
    """What this request's viewer may do with a share: ("edit" | "view", "")
    when allowed, else (None, "login" | "forbidden").

    Notion-style and additive: the owner always edits their own page; a
    signed-in account the owner INVITED (``users``) gets its own per-person
    role regardless of general access; everyone else goes through the general
    access gate — ``anyone`` needs no session (and is always view-only),
    ``users`` admits any signed-in non-guest account with the share's role,
    ``list`` admits nobody beyond the invited. Guests count as not signed in.
    """
    viewer = request.state.user
    if viewer and viewer == share["username"]:
        return "edit", ""
    signed_in = bool(viewer) and not request.state.is_guest
    if signed_in:
        for invited in share["users"]:
            if invited["name"] == viewer:
                return invited["role"], ""
    audience = share["audience"]
    if audience == "anyone":
        return "view", ""
    if not signed_in:
        return None, "login"
    if audience == "list":
        return None, "forbidden"
    return share["role"], ""


def share_grant(request: Request):
    """(owner_username, page_id, level) for a valid, permitted ?share=<token>
    on this request, else None. Cached on request.state.

    This is the ONLY read path besides the session itself: a share token is
    minted per page and names its owner, so access is scoped to that one
    page's subtree — the old ?user= fallback trusted any username and leaked
    whole accounts. When a token is present it takes precedence over the
    session for choosing WHOSE data is read (a signed-in visitor sees the
    owner's page, not their own), while the session still decides whether the
    audience gate lets them in.
    """
    cached = getattr(request.state, "_share_grant", "unset")
    if cached != "unset":
        return cached
    grant = None
    token = request.query_params.get("share")
    if token:
        share = share_lookup(token)
        if share:
            level, _reason = share_access(share, request)
            if level:
                grant = (share["username"], share["page_id"], level)
    request.state._share_grant = grant
    return grant


def _share_denied(request: Request) -> HTTPException:
    """The right status for a ?share= request that share_grant refused: 401
    when signing in could help, 403 when the viewer is signed in but not
    allowed (or the token is unknown — indistinguishable to outsiders)."""
    if request.state.user and not request.state.is_guest:
        return HTTPException(status_code=403, detail="not accessible via this share link")
    return HTTPException(status_code=401)


def share_scope_page(request: Request):
    """The page id a request is confined to, or None for a full-access session
    user. Any request carrying ?share= is scoped — even a signed-in one.

    Read endpoints pass this to blocks_store.assert_block_in_page so a share
    token can only reach its own page's subtree and assets.
    """
    if not request.query_params.get("share"):
        return None
    grant = share_grant(request)
    if not grant:
        raise _share_denied(request)
    return grant[1]


def resolve_user(request: Request) -> str:
    """Return the user whose data to READ: the owner named by a ?share=<token>
    when one is present (and permits this viewer), else the session user.
    Read-only endpoints only; callers that can serve a share view must also
    enforce share_scope_page()."""
    if request.query_params.get("share"):
        grant = share_grant(request)
        if grant:
            return grant[0]
        raise _share_denied(request)
    user = request.state.user
    if user:
        return user
    raise HTTPException(status_code=401)


def require_writer(request: Request) -> str:
    """Return the user whose data to WRITE: the share owner when the request's
    ?share= token grants edit, else the session user. Endpoints that accept
    share editors must additionally confine every touched block to
    share_scope_page() — the token never reaches the rest of the account."""
    if request.query_params.get("share"):
        grant = share_grant(request)
        if not grant:
            raise _share_denied(request)
        if grant[2] != "edit":
            raise HTTPException(status_code=403, detail="this share link is view-only")
        return grant[0]
    return require_user(request)


"""Session middleware and request → identity / workspace resolution.

Two questions every endpoint answers through this module:

- WHO is asking — ``request.state.user`` from the session cookie
  (``require_user`` for identity-only endpoints: session, AI keys, admin).
- WHICH WORKSPACE the data comes from — ``require_ws`` (session member of
  the workspace named by ``?ws=`` / ``X-Gamma-Workspace`` / the account's
  default), ``resolve_ws`` (a ``?share=`` token's workspace, else
  ``require_ws``) and ``require_ws_writer`` (an edit share, else a member
  with the editor or owner role). The returned id is what every data helper
  takes (``connect_pages_db``, ``ws_uploads_dir``, ...). docs/dev/workspaces.md.
"""

import secrets
import sqlite3
import time
from datetime import datetime, timezone

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from . import publisher_sessions
from .config import USERS_DB
from .db import page_now
from .logbuf import log
from .seed import reset_guest_data

SESSION_COOKIE = "session"
SESSION_MAX_AGE = 365 * 24 * 3600
WORKSPACE_HEADER = "x-gamma-workspace"
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


_SESSION_SQL = ("SELECT u.username, u.is_guest, u.is_admin, u.default_workspace, s.guest_date, s.created_at "
                "FROM sessions s JOIN users u ON s.username = u.username WHERE s.token = ?")


def session_lookup(token: str | None):
    """``(username, is_guest, is_admin, default_workspace)`` for a live
    session token, else None. Read-only (no guest-day rollover) — what a
    websocket handshake uses, since ``session_middleware`` only runs for
    HTTP requests."""
    if not token:
        return None
    with sqlite3.connect(str(USERS_DB)) as conn:
        row = conn.execute(_SESSION_SQL, (token,)).fetchone()
    if not row or _session_expired(row[5]):
        return None
    return row[0], bool(row[1]), bool(row[2]) and not row[1], row[3] or ""


async def session_middleware(request: Request, call_next):
    """Resolve the session cookie to request.state.user / is_guest / is_admin
    / default_ws.

    Guest sessions are date-stamped: on the first request of a new UTC day the
    guest workspace is wiped, re-seeded, and a fresh session is issued.
    """
    started = time.perf_counter()
    request.state.request_id = secrets.token_hex(4)
    token = request.cookies.get(SESSION_COOKIE)
    request.state.user = None
    request.state.is_guest = False
    request.state.is_admin = False
    request.state.default_ws = ""
    new_session_token = None
    if token:
        with sqlite3.connect(str(USERS_DB)) as conn:
            row = conn.execute(_SESSION_SQL, (token,)).fetchone()
            if row and _session_expired(row[5]):
                # Server-side expiry: a stolen token can't outlive its window
                # even though the browser cookie's Max-Age is long.
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                row = None
            if row:
                username, is_guest, is_admin, default_ws, guest_date, _created = row
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
                request.state.default_ws = default_ws or ""
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
    # Only interactive PDF operations may use the caller's publisher sessions.
    # Public/share reads and guest accounts must never borrow credentials.
    publisher_user = (request.state.user
                      if request.url.path in publisher_sessions.PDF_PATHS
                      and not request.state.is_guest and not request.query_params.get("share")
                      else None)
    publisher_token = publisher_sessions.current_user.set(publisher_user)
    try:
        response = await call_next(request)
    finally:
        publisher_sessions.current_user.reset(publisher_token)
    if new_session_token:
        set_session_cookie(response, new_session_token, request)
    return _finish_request_log(request, response, started, expected)


def require_user(request: Request) -> str:
    """Return the session username or raise 401. Identity only — endpoints
    that touch a workspace's data use require_ws / resolve_ws instead."""
    user = request.state.user
    if not user:
        raise HTTPException(status_code=401)
    return user


def require_personal_user(request: Request, detail: str) -> str:
    """A signed-in, non-guest account; guests get 403 `detail`."""
    username = require_user(request)
    if request.state.is_guest:
        raise HTTPException(403, detail)
    return username


async def read_body(request: Request, limit: int, detail: str) -> bytes:
    """The raw request body, refused with 413 `detail` as soon as it passes
    `limit` bytes (before the rest is buffered)."""
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(413, detail)
        chunks.append(chunk)
    return b"".join(chunks)


def require_admin(request: Request) -> str:
    """Return the session username or raise 401/403. Admin-only endpoints."""
    user = require_user(request)
    if not request.state.is_admin:
        raise HTTPException(status_code=403, detail="admin privilege required")
    return user


# --- workspaces --------------------------------------------------------------

def requested_ws(carrier) -> str:
    """The workspace a request names: ``?ws=`` (explicit — links, the
    websocket), else the ``X-Gamma-Workspace`` header (the frontend's fetch
    wrapper), else "" (the caller falls back to the account's default).
    ``carrier`` is a Request or a WebSocket."""
    return (carrier.query_params.get("ws") or carrier.headers.get(WORKSPACE_HEADER) or "").strip()


def workspace_access(username: str, requested: str, default_ws: str) -> tuple[str, str | None]:
    """``(workspace_id, role)`` for an account's request: the named
    workspace, else the account's default (created on the spot if the
    account somehow has none). role is None when not a member."""
    from . import workspaces  # local: workspaces imports seed, which imports db

    ws = requested or default_ws or workspaces.ensure_personal(username)
    return ws, workspaces.role_of(ws, username)


def require_ws(request: Request, write: bool = False) -> str:
    """The workspace this session request works in (401 without a session,
    403 when the account is not a member — or is only a viewer and ``write``
    is set). Cached on request.state as ``ws`` / ``ws_role``."""
    user = require_user(request)
    ws = getattr(request.state, "ws", None)
    if ws is None:
        ws, role = workspace_access(user, requested_ws(request), request.state.default_ws)
        request.state.ws, request.state.ws_role = ws, role
    role = request.state.ws_role
    if not role:
        raise HTTPException(status_code=403, detail="you are not a member of this workspace")
    if write and role == "viewer":
        raise HTTPException(status_code=403, detail="you can only view this workspace")
    return ws


def ws_role(request: Request) -> str | None:
    """The session's role in the request's workspace (None: not resolved or
    not a member). Read after require_ws / resolve_ws."""
    return getattr(request.state, "ws_role", None)


# --- shares --------------------------------------------------------------------

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
    """The share row for a token as a dict ({token, workspace_id, page_id,
    created_by, audience, role, users}), or None."""
    if not token:
        return None
    with sqlite3.connect(str(USERS_DB)) as conn:
        row = conn.execute(
            "SELECT workspace_id, page_id, created_by, audience, role, allowed_users "
            "FROM shares WHERE token = ?", (token,)
        ).fetchone()
    if not row:
        return None
    workspace_id, page_id, created_by, audience, role, allowed = row
    if not page_id or not workspace_id:
        return None
    return {
        "token": token, "workspace_id": workspace_id, "page_id": page_id, "created_by": created_by,
        "audience": audience if audience in SHARE_AUDIENCES else "anyone",
        "role": role if role in SHARE_ROLES else "view",
        "users": parse_share_users(allowed),
    }


def share_access(share: dict, carrier):
    """What this request's viewer may do with a share: ("edit" | "view", "")
    when allowed, else (None, "login" | "forbidden").

    Notion-style and additive: a member of the page's workspace keeps their
    workspace role (editors and owners edit, viewers view — the share can
    only add to that, never take away); a signed-in account the sharer
    INVITED (``users``) gets its own per-person role regardless of general
    access; everyone else goes through the general access gate — ``anyone``
    needs no session (and is always view-only), ``users`` admits any
    signed-in non-guest account with the share's role, ``list`` admits nobody
    beyond the invited. Guests count as not signed in. ``carrier`` is a
    Request or a WebSocket (its ``state`` carries user / is_guest).
    """
    from . import workspaces

    viewer = carrier.state.user
    signed_in = bool(viewer) and not carrier.state.is_guest
    best = None
    if signed_in:
        role = workspaces.role_of(share["workspace_id"], viewer)
        if role in ("editor", "owner"):
            return "edit", ""
        if role == "viewer":
            best = "view"
        for invited in share["users"]:
            if invited["name"] == viewer:
                return invited["role"], ""
    audience = share["audience"]
    if audience == "anyone":
        return "view", ""
    if not signed_in:
        return None, "login"
    if audience == "list":
        return (best, "") if best else (None, "forbidden")
    return share["role"], ""


def share_grant(request: Request):
    """(workspace_id, page_id, level) for a valid, permitted ?share=<token>
    on this request, else None. Cached on request.state.

    A share token is minted per page and names its workspace, so access is
    scoped to that one page's subtree. When a token is present it takes
    precedence over the session for choosing WHOSE data is read (a signed-in
    visitor sees the shared page, not their own library), while the session
    still decides whether the audience gate lets them in.
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
                grant = (share["workspace_id"], share["page_id"], level)
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
    """The page id a request is confined to, or None for a full-access
    workspace member. Any request carrying ?share= is scoped — even a
    signed-in one.

    Read endpoints pass this to blocks_store.assert_block_in_page so a share
    token can only reach its own page's subtree and assets.
    """
    if not request.query_params.get("share"):
        return None
    grant = share_grant(request)
    if not grant:
        raise _share_denied(request)
    return grant[1]


def resolve_ws(request: Request) -> str:
    """The workspace whose data to READ: the one named by a ?share=<token>
    when one is present (and permits this viewer), else the session's
    workspace (any member role). Read-only endpoints only; callers that can
    serve a share view must also enforce share_scope_page()."""
    if request.query_params.get("share"):
        grant = share_grant(request)
        if grant:
            return grant[0]
        raise _share_denied(request)
    return require_ws(request)


def require_ws_writer(request: Request) -> str:
    """The workspace whose data to WRITE: the shared page's workspace when
    the request's ?share= token grants edit, else the session's workspace
    with an editor or owner role. Endpoints that accept share editors must
    additionally confine every touched block to share_scope_page() — the
    token never reaches the rest of the workspace."""
    if request.query_params.get("share"):
        grant = share_grant(request)
        if not grant:
            raise _share_denied(request)
        if grant[2] != "edit":
            raise HTTPException(status_code=403, detail="this share link is view-only")
        return grant[0]
    return require_ws(request, write=True)

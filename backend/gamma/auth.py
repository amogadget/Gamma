"""Session middleware and request→user resolution helpers."""

import secrets
import sqlite3
from datetime import datetime, timezone

from fastapi import HTTPException, Request

from .config import USERS_DB
from .db import page_now
from .seed import reset_guest_data

SESSION_COOKIE = "session"
SESSION_MAX_AGE = 365 * 24 * 3600


def set_session_cookie(response, token: str):
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=SESSION_MAX_AGE)


async def session_middleware(request: Request, call_next):
    """Resolve the session cookie to request.state.user / is_guest.

    Guest sessions are date-stamped: on the first request of a new UTC day the
    guest workspace is wiped, re-seeded, and a fresh session is issued.
    """
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
    response = await call_next(request)
    if new_session_token:
        set_session_cookie(response, new_session_token)
    return response


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

"""Portal sessions: the cookie that signs a person into account.gammapdf.com
itself (the account page and the authorize page). Not what Gamma servers
get — they get ID tokens (``oidc.py``).

The cookie holds a random token; the table holds its hash. Sessions slide:
``last_seen_at`` moves forward on use (at most once an hour, to keep writes
down) and a session older than ``PORTAL_SESSION_TTL`` since it was last seen
is gone.
"""

from fastapi import Request

from . import accounts, config
from .db import after, new_token, now, parse, token_hash

COOKIE = "gc_session"
MAX_PER_ACCOUNT = 20


def create(conn, account_id: str, request: Request | None) -> str:
    token = new_token(32)
    ts = now()
    conn.execute("INSERT INTO portal_sessions (token_hash, account_id, created_at, last_seen_at, ip, user_agent) "
                 "VALUES (?, ?, ?, ?, ?, ?)",
                 (token_hash(token), account_id, ts, ts, _ip(request), _agent(request)))
    # An account keeps its newest MAX_PER_ACCOUNT browsers signed in.
    conn.execute("DELETE FROM portal_sessions WHERE account_id = ? AND token_hash NOT IN (SELECT token_hash FROM "
                 "portal_sessions WHERE account_id = ? ORDER BY last_seen_at DESC LIMIT ?)",
                 (account_id, account_id, MAX_PER_ACCOUNT))
    return token


def resolve(conn, request: Request):
    """The account the request's cookie names, or None. Touches
    ``last_seen_at``; drops a stale session."""
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    row = conn.execute("SELECT * FROM portal_sessions WHERE token_hash = ?", (token_hash(token),)).fetchone()
    if not row:
        return None
    if row["last_seen_at"] < after(-config.PORTAL_SESSION_TTL):
        conn.execute("DELETE FROM portal_sessions WHERE token_hash = ?", (row["token_hash"],))
        return None
    account = accounts.by_id(conn, row["account_id"])
    if not account:
        conn.execute("DELETE FROM portal_sessions WHERE token_hash = ?", (row["token_hash"],))
        return None
    if (parse(now()) - parse(row["last_seen_at"])).total_seconds() > 3600:
        conn.execute("UPDATE portal_sessions SET last_seen_at = ? WHERE token_hash = ?", (now(), row["token_hash"]))
    return account


def drop(conn, request: Request) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        conn.execute("DELETE FROM portal_sessions WHERE token_hash = ?", (token_hash(token),))


def set_cookie(response, token: str) -> None:
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=config.PUBLIC_URL.startswith("https://"),
                        max_age=config.PORTAL_SESSION_TTL, path="/")


def clear_cookie(response) -> None:
    response.delete_cookie(COOKIE, path="/")


def purge_stale(conn) -> int:
    cur = conn.execute("DELETE FROM portal_sessions WHERE last_seen_at < ?", (after(-config.PORTAL_SESSION_TTL),))
    return cur.rowcount


def _ip(request: Request | None) -> str:
    if request is None:
        return ""
    from .ratelimit import client_ip
    return client_ip(request)[:64]


def _agent(request: Request | None) -> str:
    if request is None:
        return ""
    return request.headers.get("user-agent", "")[:200]

"""Portal sessions: the cookie that signs a person into account.gammapdf.com
itself (the account page and the authorize page). Not what Gamma servers
get — they get ID tokens (``oidc.py``).

The cookie holds a random token; the table holds its hash. Sessions slide:
``last_seen_at`` moves forward on use (at most once an hour, to keep writes
down) and a session older than ``PORTAL_SESSION_TTL`` since it was last seen
is gone.
"""

import re

from fastapi import Request

from . import accounts, config
from .db import after, new_token, now, parse, token_hash
from .ratelimit import agent_of, ip_of

COOKIE = "gc_session"
MAX_PER_ACCOUNT = 20
ID_RE = re.compile(r"^[0-9a-f]{16}$")


def create(conn, account_id: str, request: Request | None) -> str:
    token = new_token(32)
    ts = now()
    conn.execute("INSERT INTO portal_sessions (token_hash, account_id, created_at, last_seen_at, ip, user_agent) "
                 "VALUES (?, ?, ?, ?, ?, ?)",
                 (token_hash(token), account_id, ts, ts, ip_of(request), agent_of(request)))
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


def of_account(conn, account_id: str, request: Request) -> list[dict]:
    """An account's signed-in browsers, the latest seen first; ``current``
    is the one asking. A row's ``id`` is the head of its token's hash:
    enough to name it, useless as a cookie."""
    mine = token_hash(request.cookies.get(COOKIE) or "")
    rows = conn.execute("SELECT * FROM portal_sessions WHERE account_id = ? AND last_seen_at >= ? "
                        "ORDER BY last_seen_at DESC", (account_id, after(-config.PORTAL_SESSION_TTL))).fetchall()
    return [{"id": r["token_hash"][:16], "created_at": r["created_at"], "last_seen_at": r["last_seen_at"], "ip": r["ip"],
             "user_agent": r["user_agent"], "current": r["token_hash"] == mine} for r in rows]


def end(conn, account_id: str, session_id: str) -> bool:
    """Sign one of an account's browsers out by its ``of_account`` id."""
    if not ID_RE.match(session_id or ""):
        return False
    cur = conn.execute("DELETE FROM portal_sessions WHERE account_id = ? AND substr(token_hash, 1, 16) = ?",
                       (account_id, session_id))
    return bool(cur.rowcount)


def drop(conn, request: Request) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        conn.execute("DELETE FROM portal_sessions WHERE token_hash = ?", (token_hash(token),))


def set_cookie(response, token: str, *, name: str = COOKIE, max_age: int | None = config.PORTAL_SESSION_TTL) -> None:
    """The portal cookie by default; ``identities.py``'s cookies pass their
    own name and lifetime."""
    response.set_cookie(name, token, httponly=True, samesite="lax", secure=config.PUBLIC_URL.startswith("https://"),
                        max_age=max_age, path="/")


def clear_cookie(response) -> None:
    response.delete_cookie(COOKIE, path="/")


def purge_stale(conn) -> int:
    cur = conn.execute("DELETE FROM portal_sessions WHERE last_seen_at < ?", (after(-config.PORTAL_SESSION_TTL),))
    return cur.rowcount

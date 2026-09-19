"""Revocable credentials for one account and workspace: ``read`` tokens
(the MCP endpoint, the HTTP API's reads) and ``write`` tokens (a mirror
pushing its edits, docs/dev/mirror.md).

Only token hashes are stored. Recheck the account and workspace access on
every request, so removing membership also removes integration access.
"""

import hashlib
import json
import secrets
import time

from fastapi import HTTPException

from .db import connect_users_db, page_now
from .workspaces import role_of


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


SCOPES = ("read", "write")


def create_token(username: str, ws: str, name: str, days: int, *, oauth_resource: str | None = None,
                 scope: str = "read") -> dict:
    if scope not in SCOPES:
        raise HTTPException(400, "scope must be read or write")
    now = int(time.time())
    token = ("gamma_oauth_" if oauth_resource else "gamma_") + secrets.token_urlsafe(32)
    item = {"id": secrets.token_hex(16), "name": name, "workspace_id": ws, "scope": scope,
            "created_at": page_now(), "expires_at": now + days * 86400}
    with connect_users_db() as conn:
        # Serialize count + insert, including concurrent requests.
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM integration_tokens WHERE username = ? AND expires_at <= ?", (username, now))
        count = conn.execute("SELECT COUNT(*) FROM integration_tokens WHERE username = ?", (username,)).fetchone()[0]
        if count >= 20:
            raise HTTPException(400, "Revoke an existing connection before creating another (limit 20).")
        conn.execute("INSERT INTO integration_tokens (id, token_hash, username, workspace_id, name, "
                     "created_at, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (item["id"], token_digest(token), username, ws, name, item["created_at"],
                      item["expires_at"], scope))
        if oauth_resource:
            conn.execute("INSERT INTO mcp_oauth VALUES ('access', ?, ?, ?)",
                         (token_digest(token), json.dumps({"resource": oauth_resource}), item["expires_at"]))
    return {**item, "token": token}


def resolve_token(token: str, resource: str | None = None) -> tuple[str, str] | None:
    """``(username, workspace_id)`` for a live token whose account still has
    access to its workspace, else None. ``resource`` is the MCP URL an OAuth
    token must be bound to."""
    found = resolve_token_scope(token, resource)
    return found[:2] if found else None


def resolve_token_scope(token: str, resource: str | None = None) -> tuple[str, str, str] | None:
    """Like ``resolve_token`` plus the token's scope: ``(username,
    workspace_id, scope)``."""
    if not token.startswith("gamma_") or len(token) > 128:
        return None
    with connect_users_db() as conn:
        if token.startswith("gamma_oauth_"):
            audience = conn.execute("SELECT value FROM mcp_oauth WHERE kind = 'access' AND key_hash = ? AND expires_at > ?",
                                    (token_digest(token), int(time.time()))).fetchone()
            if not audience or json.loads(audience[0]).get("resource") != resource:
                return None
        row = conn.execute(
            "SELECT t.username, t.workspace_id, t.scope FROM integration_tokens t "
            "JOIN users u ON u.username = t.username "
            "WHERE t.token_hash = ? AND t.expires_at > ? AND u.is_guest = 0",
            (token_digest(token), int(time.time()))).fetchone()
    if not row or not role_of(row[1], row[0]):
        return None
    return row[0], row[1], row[2] if row[2] in SCOPES else "read"

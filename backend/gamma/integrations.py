"""Revocable, read-only credentials for one account and workspace.

Only token hashes are stored. Recheck the account and workspace access on
every request, so removing membership also removes integration access.
"""

import hashlib
import secrets
import time

from fastapi import HTTPException

from .db import connect_users_db, page_now
from .workspaces import role_of


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_token(username: str, ws: str, name: str, days: int) -> dict:
    now = int(time.time())
    token = "gamma_" + secrets.token_urlsafe(32)
    item = {"id": secrets.token_hex(16), "name": name, "workspace_id": ws,
            "created_at": page_now(), "expires_at": now + days * 86400}
    with connect_users_db() as conn:
        # Serialize count + insert, including concurrent requests.
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM integration_tokens WHERE username = ? AND expires_at <= ?", (username, now))
        count = conn.execute("SELECT COUNT(*) FROM integration_tokens WHERE username = ?", (username,)).fetchone()[0]
        if count >= 20:
            raise HTTPException(400, "Revoke an existing connection before creating another (limit 20).")
        conn.execute("INSERT INTO integration_tokens VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (item["id"], token_digest(token), username, ws, name, item["created_at"], item["expires_at"]))
    return {**item, "token": token}


def resolve_token(token: str) -> tuple[str, str] | None:
    if not token.startswith("gamma_") or len(token) > 128:
        return None
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT t.username, t.workspace_id FROM integration_tokens t "
            "JOIN users u ON u.username = t.username "
            "WHERE t.token_hash = ? AND t.expires_at > ? AND u.is_guest = 0",
            (token_digest(token), int(time.time()))).fetchone()
    if not row or not role_of(row[1], row[0]):
        return None
    return row[0], row[1]

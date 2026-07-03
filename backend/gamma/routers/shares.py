"""Public read-only share tokens."""

import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_user
from ..db import connect_users_db, page_now

router = APIRouter(prefix="/api", tags=["shares"])


@router.post("/share/{doc_id}")
async def create_share(doc_id: str, request: Request):
    user = require_user(request)
    with connect_users_db() as conn:
        # Reuse existing share for this doc+user
        row = conn.execute(
            "SELECT token FROM shares WHERE username = ? AND doc_id = ?",
            (user, doc_id),
        ).fetchone()
        if row:
            return {"token": row[0]}
        token = secrets.token_urlsafe(12)
        conn.execute(
            "INSERT INTO shares (token, username, doc_id, created_at) VALUES (?, ?, ?, ?)",
            (token, user, doc_id, page_now()),
        )
        conn.commit()
    return {"token": token}


@router.get("/share/{token}")
async def get_share(token: str):
    with connect_users_db() as conn:
        row = conn.execute(
            "SELECT doc_id, username FROM shares WHERE token = ?",
            (token,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="share not found")
    return {"doc_id": row[0], "username": row[1]}

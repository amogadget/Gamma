"""Per-page AI chat-history persistence."""

import json

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..auth import require_user
from ..db import connect_data_db, page_now


router = APIRouter(prefix="/api/chats", tags=["chats"])


class ChatSaveRequest(BaseModel):
    messages: list


@router.get("/{block_id}")
async def get_chat(block_id: str, request: Request):
    user = require_user(request)
    with connect_data_db(user) as database:
        row = database.execute(
            "SELECT messages FROM chats WHERE block_id = ?", (block_id,)
        ).fetchone()
    return {"messages": json.loads(row[0]) if row else []}


@router.put("/{block_id}")
async def save_chat(block_id: str, payload: ChatSaveRequest, request: Request):
    user = require_user(request)
    with connect_data_db(user) as database:
        database.execute(
            "INSERT INTO chats (block_id, messages, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(block_id) DO UPDATE SET "
            "messages = excluded.messages, updated_at = excluded.updated_at",
            (block_id, json.dumps(payload.messages), page_now()),
        )
        database.commit()
    return {"ok": True}


@router.delete("/{block_id}")
async def delete_chat(block_id: str, request: Request):
    user = require_user(request)
    with connect_data_db(user) as database:
        database.execute("DELETE FROM chats WHERE block_id = ?", (block_id,))
        database.commit()
    return {"ok": True}

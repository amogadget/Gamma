"""Per-page AI chat-history persistence.

Bucket keys are the focused page's block id, "home" (the library-root chat),
or "home:<folder path>" (per-folder chats — one conversation per folder view).
Folder paths nest on "/", so the key routes use the :path converter (uvicorn
decodes %2F before routing, a plain {block_id} would 404 on nested folders).
"""

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_user
from ..db import connect_data_db, page_now


router = APIRouter(prefix="/api/chats", tags=["chats"])


class ChatSaveRequest(BaseModel):
    messages: list


class ChatFolderRenameRequest(BaseModel):
    src: str        # folder path whose chat buckets move ("a/b" — never "")
    dst: str = ""   # new path; "" = the folder was deleted, drop its buckets


@router.post("/folder-rename")
async def rename_folder_chats(payload: ChatFolderRenameRequest, request: Request):
    """Follow a folder rename/move/delete: per-folder buckets embed the path
    in their key, so path rewrites must carry the conversations along. The
    frontend calls this with the same src → dst prefix mapping it applies to
    the pages' folder tags (subfolders ride along). When the destination
    already holds a real conversation it wins and the source is dropped; an
    empty destination row (a save-effect echo) is overwritten."""
    user = require_user(request)
    src = (payload.src or "").strip().strip("/")
    dst = (payload.dst or "").strip().strip("/")
    if not src:
        raise HTTPException(status_code=400, detail="src folder path required")
    src_key = f"home:{src}"
    with connect_data_db(user) as database:
        rows = database.execute(
            "SELECT block_id FROM chats WHERE block_id = ? OR substr(block_id, 1, ?) = ?",
            (src_key, len(src_key) + 1, src_key + "/"),
        ).fetchall()
        for (old_id,) in rows:
            if not dst:
                database.execute("DELETE FROM chats WHERE block_id = ?", (old_id,))
                continue
            new_id = f"home:{dst}" + old_id[len(src_key):]
            existing = database.execute(
                "SELECT messages FROM chats WHERE block_id = ?", (new_id,)
            ).fetchone()
            if existing and json.loads(existing[0] or "[]"):
                database.execute("DELETE FROM chats WHERE block_id = ?", (old_id,))
            else:
                database.execute("DELETE FROM chats WHERE block_id = ?", (new_id,))
                database.execute("UPDATE chats SET block_id = ? WHERE block_id = ?",
                                 (new_id, old_id))
        database.commit()
    return {"ok": True, "moved": len(rows)}


@router.get("/{block_id:path}")
async def get_chat(block_id: str, request: Request):
    user = require_user(request)
    with connect_data_db(user) as database:
        row = database.execute("SELECT messages FROM chats WHERE block_id = ?", (block_id,)).fetchone()
    return {"messages": json.loads(row[0]) if row else []}


@router.put("/{block_id:path}")
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


@router.delete("/{block_id:path}")
async def delete_chat(block_id: str, request: Request):
    user = require_user(request)
    with connect_data_db(user) as database:
        database.execute("DELETE FROM chats WHERE block_id = ?", (block_id,))
        database.commit()
    return {"ok": True}

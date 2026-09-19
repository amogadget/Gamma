"""AI chat persistence: the active conversation per bucket plus its history.

Bucket keys are the focused page's block id, "home" (the library-root chat),
or "home:<folder path>" (per-folder chats — one conversation per folder view).
Folder paths nest on "/", so the key routes use the :path converter (uvicorn
decodes %2F before routing, a plain {block_id} would 404 on nested folders).

`chats` holds ONE active conversation per bucket (what ChatDock shows and
autosaves); `chat_history` holds the bucket's earlier conversations. "New
chat" archives the active one into history and opening a history entry swaps
it back — the client sends its current messages with both calls, so nothing
still sitting in the autosave debounce is lost. Titles are user-given, else
derived from the first user message when a conversation is archived.
"""

import json
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_ws, resolve_ws, share_scope_page
from ..db import connect_data_db, page_now


router = APIRouter(prefix="/api/chats", tags=["chats"])
history_router = APIRouter(prefix="/api/chat-history", tags=["chats"])

TITLE_MAX = 80
HISTORY_LIST_CAP = 200


def _require_chat_writer(request: Request) -> str:
    if request.query_params.get("share"):
        raise HTTPException(status_code=403, detail="shared chat is read-only")
    return require_ws(request)


class ChatSaveRequest(BaseModel):
    messages: list
    title: str | None = None   # None = keep the stored title


class ChatFolderRenameRequest(BaseModel):
    src: str        # folder path whose chat buckets move ("a/b" — never "")
    dst: str = ""   # new path; "" = the folder was deleted, drop its buckets


class ChatArchiveRequest(BaseModel):
    bucket: str
    messages: list = []   # the client's current conversation (authoritative)
    title: str = ""


class ChatTitleRequest(BaseModel):
    title: str


def _clean_title(raw) -> str:
    return " ".join(str(raw or "").split())[:TITLE_MAX]


def _first_user_text(messages: list) -> str:
    for m in messages or []:
        if isinstance(m, dict) and m.get("role") == "user":
            return str(m.get("text") or m.get("content") or "")
    return ""


def derive_title(messages: list) -> str:
    """The first user message's first line, quotes stripped, for a
    conversation the user never named."""
    for line in _first_user_text(messages).splitlines():
        line = line.strip()
        if line and not line.startswith(">"):
            return _clean_title(line[:TITLE_MAX])
    return ""


def _preview(messages: list) -> str:
    return " ".join(_first_user_text(messages).split())[:120]


def _archive(database, bucket: str, messages: list, title: str) -> str | None:
    """Move a non-empty conversation into the bucket's history and clear the
    active row. Returns the new history id, or None when there was nothing
    to keep (the active row is cleared either way)."""
    now = page_now()
    row = database.execute("SELECT title FROM chats WHERE block_id = ?", (bucket,)).fetchone()
    database.execute("DELETE FROM chats WHERE block_id = ?", (bucket,))
    if not messages:
        return None
    title = _clean_title(title) or (row[0] if row else "") or derive_title(messages)
    entry_id = uuid.uuid4().hex
    database.execute(
        "INSERT INTO chat_history (id, bucket, title, messages, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (entry_id, bucket, title, json.dumps(messages), now, now),
    )
    return entry_id


@router.post("/folder-rename")
async def rename_folder_chats(payload: ChatFolderRenameRequest, request: Request):
    """Follow a folder rename/move/delete: per-folder buckets embed the path
    in their key, so path rewrites must carry the conversations along. The
    frontend calls this with the same src → dst prefix mapping it applies to
    the pages' folder tags (subfolders ride along). When the destination
    already holds a real conversation it wins and the source is dropped; an
    empty destination row (a save-effect echo) is overwritten. History
    entries simply follow their bucket (ids never collide)."""
    ws = _require_chat_writer(request)
    src = (payload.src or "").strip().strip("/")
    dst = (payload.dst or "").strip().strip("/")
    if not src:
        raise HTTPException(status_code=400, detail="src folder path required")
    src_key = f"home:{src}"
    prefix_match = "(bucket = ? OR substr(bucket, 1, ?) = ?)"
    with connect_data_db(ws) as database:
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
        hist = database.execute(
            f"SELECT id, bucket FROM chat_history WHERE {prefix_match}",
            (src_key, len(src_key) + 1, src_key + "/"),
        ).fetchall()
        for entry_id, bucket in hist:
            if not dst:
                database.execute("DELETE FROM chat_history WHERE id = ?", (entry_id,))
            else:
                database.execute("UPDATE chat_history SET bucket = ? WHERE id = ?",
                                 (f"home:{dst}" + bucket[len(src_key):], entry_id))
        database.commit()
    return {"ok": True, "moved": len(rows), "history_moved": len(hist)}


@router.get("/{block_id:path}")
async def get_chat(block_id: str, request: Request):
    ws = resolve_ws(request)
    shared_page = share_scope_page(request)
    if shared_page and block_id != shared_page:
        raise HTTPException(status_code=403, detail="chat is outside the shared page")
    with connect_data_db(ws) as database:
        row = database.execute(
            "SELECT messages, title FROM chats WHERE block_id = ?", (block_id,)
        ).fetchone()
    return {"messages": json.loads(row[0]) if row else [], "title": (row[1] if row else "") or ""}


@router.put("/{block_id:path}")
async def save_chat(block_id: str, payload: ChatSaveRequest, request: Request):
    ws = _require_chat_writer(request)
    with connect_data_db(ws) as database:
        # A request without a title (the autosave) keeps the stored one.
        database.execute(
            "INSERT INTO chats (block_id, messages, updated_at, title) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(block_id) DO UPDATE SET "
            "messages = excluded.messages, updated_at = excluded.updated_at, "
            "title = CASE WHEN ? THEN excluded.title ELSE chats.title END",
            (block_id, json.dumps(payload.messages), page_now(), _clean_title(payload.title),
             payload.title is not None),
        )
        database.commit()
    return {"ok": True}


@router.delete("/{block_id:path}")
async def delete_chat(block_id: str, request: Request):
    ws = _require_chat_writer(request)
    with connect_data_db(ws) as database:
        database.execute("DELETE FROM chats WHERE block_id = ?", (block_id,))
        database.commit()
    return {"ok": True}


# --- history ------------------------------------------------------------------

@history_router.get("")
async def list_history(request: Request, bucket: str = ""):
    """The bucket's earlier conversations, newest first, without messages
    (`count` + `preview` are enough for a list row)."""
    ws = require_ws(request)
    with connect_data_db(ws) as database:
        rows = database.execute(
            "SELECT id, title, messages, created_at, updated_at FROM chat_history "
            "WHERE bucket = ? ORDER BY updated_at DESC LIMIT ?",
            (bucket, HISTORY_LIST_CAP),
        ).fetchall()
    sessions = []
    for entry_id, title, raw, created_at, updated_at in rows:
        messages = json.loads(raw or "[]")
        sessions.append({
            "id": entry_id, "title": title or derive_title(messages),
            "preview": _preview(messages), "count": len(messages),
            "created_at": created_at, "updated_at": updated_at,
        })
    return {"sessions": sessions}


@history_router.post("/archive")
async def archive_chat(payload: ChatArchiveRequest, request: Request):
    """"New chat": file the active conversation (the client's copy — the
    autosave may still be pending) into history and clear the bucket."""
    ws = _require_chat_writer(request)
    if not payload.bucket:
        raise HTTPException(status_code=400, detail="bucket required")
    with connect_data_db(ws) as database:
        entry_id = _archive(database, payload.bucket, payload.messages, payload.title)
        database.commit()
    return {"id": entry_id}


@history_router.post("/{entry_id}/open")
async def open_history(entry_id: str, payload: ChatArchiveRequest, request: Request):
    """Make a history entry the bucket's active conversation: the current
    one (sent by the client) is archived first, then the entry moves back
    into `chats` — so a conversation is always in exactly one place."""
    ws = _require_chat_writer(request)
    if not payload.bucket:
        raise HTTPException(status_code=400, detail="bucket required")
    with connect_data_db(ws) as database:
        row = database.execute(
            "SELECT title, messages FROM chat_history WHERE id = ?", (entry_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="conversation not found")
        _archive(database, payload.bucket, payload.messages, payload.title)
        database.execute("DELETE FROM chat_history WHERE id = ?", (entry_id,))
        database.execute(
            "INSERT OR REPLACE INTO chats (block_id, messages, updated_at, title) VALUES (?, ?, ?, ?)",
            (payload.bucket, row[1], page_now(), row[0] or ""),
        )
        database.commit()
    return {"messages": json.loads(row[1] or "[]"), "title": row[0] or ""}


@history_router.put("/{entry_id}")
async def rename_history(entry_id: str, payload: ChatTitleRequest, request: Request):
    ws = _require_chat_writer(request)
    with connect_data_db(ws) as database:
        cur = database.execute("UPDATE chat_history SET title = ? WHERE id = ?",
                               (_clean_title(payload.title), entry_id))
        database.commit()
    if not cur.rowcount:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"ok": True}


@history_router.delete("/{entry_id}")
async def delete_history(entry_id: str, request: Request):
    ws = _require_chat_writer(request)
    with connect_data_db(ws) as database:
        database.execute("DELETE FROM chat_history WHERE id = ?", (entry_id,))
        database.commit()
    return {"ok": True}

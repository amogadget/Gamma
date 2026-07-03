"""Legacy per-document annotation blobs (kept for backward compatibility)."""

import sqlite3

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..auth import require_user
from ..db import user_db_path

router = APIRouter(prefix="/api", tags=["annotations"])


class AnnotationDoc(BaseModel):
    data: str


@router.get("/annotations/{doc_id}")
async def get_annotations(doc_id: str, request: Request):
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "data.db")) as db:
        row = db.execute("SELECT data FROM annotations WHERE doc_id = ?", (doc_id,)).fetchone()
    if row is None:
        return {"data": '{"version":1,"annotations":[]}'}
    return {"data": row[0]}


@router.put("/annotations/{doc_id}")
async def put_annotations(doc_id: str, payload: AnnotationDoc, request: Request):
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "data.db")) as db:
        db.execute(
            "INSERT INTO annotations (doc_id, data) VALUES (?, ?) "
            "ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data",
            (doc_id, payload.data),
        )
        db.commit()
    return {"ok": True}

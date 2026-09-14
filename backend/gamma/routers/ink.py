"""Handwriting uploads: one ``gamma-ink`` file per ink group, content-hash
stored like any upload (docs/dev/handwriting.md)."""

from fastapi import APIRouter, HTTPException, Request

from ..auth import require_ws_writer
from ..ink import InkError, bounding_box, dumps, parse_ink, pdf_position
from ..storage import store_file

router = APIRouter(prefix="/api", tags=["ink"])


@router.post("/upload-ink")
async def upload_ink(request: Request):
    """Body: the ink file as JSON. Validated against the schema and its
    budgets, stored canonically (sorted keys, so identical strokes dedup)
    as ``uploads/<sha>.ink``. → ``{url, size, strokes, pdf_position,
    already_existed}``; the client puts ``url`` and ``pdf_position`` on the
    block. A workspace editor or an edit share (the block writers' rule)."""
    ws = require_ws_writer(request)
    try:
        ink = parse_ink(await request.body())
    except InkError as e:
        raise HTTPException(status_code=400, detail=f"invalid ink file: {e}")
    data = dumps(ink)
    filename, already_existed = store_file(ws, data, ".ink")
    return {
        "url": f"/api/uploads/{filename}",
        "size": len(data),
        "strokes": len(ink.strokes),
        "bbox": bounding_box(ink),
        "pdf_position": pdf_position(ink),
        "already_existed": already_existed,
    }

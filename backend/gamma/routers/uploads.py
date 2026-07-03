"""PDF/image uploads (content-hash deduped) and upload serving/cleanup."""

import hashlib
import sqlite3

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from ..auth import require_user
from ..config import MAX_UPLOAD_BYTES
from ..db import user_db_path, user_uploads_dir
from ..storage import ALLOWED_IMAGE_TYPES, IMAGE_EXTENSIONS, IMAGE_MEDIA_TYPES, cleanup_orphan_uploads, find_upload_file

router = APIRouter(prefix="/api", tags=["uploads"])


@router.post("/uploads")
async def upload_pdf(request: Request, file: UploadFile = File(...)):
    user = require_user(request)
    uploads = user_uploads_dir(user)
    uploads.mkdir(parents=True, exist_ok=True)
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    if len(contents) < 4 or contents[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="not a valid PDF (missing %PDF header)")

    digest = hashlib.sha256(contents).hexdigest()[:24]
    target = uploads / f"{digest}.pdf"
    already_existed = target.exists()
    if not already_existed:
        target.write_bytes(contents)

    return {
        "doc_id": digest,
        "source_url": f"/api/uploads/{digest}.pdf",
        "size": len(contents),
        "already_existed": already_existed,
    }


@router.post("/upload-image")
async def upload_image(request: Request, file: UploadFile = File(...)):
    user = require_user(request)
    uploads = user_uploads_dir(user)
    uploads.mkdir(parents=True, exist_ok=True)
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"unsupported image type: {file.content_type}")
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    digest = hashlib.sha256(contents).hexdigest()[:24]
    ext = IMAGE_EXTENSIONS[file.content_type]
    target = uploads / f"{digest}{ext}"
    already_existed = target.exists()
    if not already_existed:
        target.write_bytes(contents)
    return {
        "url": f"/api/uploads/{digest}{ext}",
        "size": len(contents),
        "already_existed": already_existed,
    }


@router.get("/uploads/{filename}")
async def serve_upload(filename: str, request: Request):
    # Sanitize: only allow [hex].ext pattern, no path traversal
    dot = filename.rfind(".")
    if dot < 0:
        raise HTTPException(status_code=400, detail="invalid filename")
    stem = filename[:dot]
    ext = filename[dot:].lower()
    if ext == ".pdf":
        media_type = "application/pdf"
    elif ext in IMAGE_MEDIA_TYPES:
        media_type = IMAGE_MEDIA_TYPES[ext]
    else:
        raise HTTPException(status_code=400, detail="unsupported file type")
    if not stem or not all(c in "0123456789abcdef" for c in stem):
        raise HTTPException(status_code=400, detail="invalid filename")
    path = find_upload_file(filename, request)
    if not path:
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=3600"})


@router.post("/cleanup-uploads")
async def manual_cleanup_uploads(request: Request):
    user = require_user(request)
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        removed = cleanup_orphan_uploads(conn, user_uploads_dir(user))
    return {"ok": True, "removed_uploads": removed}

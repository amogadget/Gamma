"""PDF/image uploads (content-hash deduped) and upload serving."""

import hashlib
import sqlite3

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from ..auth import require_user, share_grant
from ..blocks_store import fetch_subtree
from ..db import user_db_path, user_uploads_dir
from .. import flatten_queue
from ..server_settings import check_upload_allowed, usage_bytes, user_limits
from ..storage import ALLOWED_IMAGE_TYPES, IMAGE_EXTENSIONS, IMAGE_MEDIA_TYPES, find_upload_file

router = APIRouter(prefix="/api", tags=["uploads"])


@router.get("/quota")
async def get_quota(request: Request):
    """The session user's effective storage limits and current usage — feeds
    the client-side pre-upload size check and the Settings usage display.
    (Deliberately its own endpoint: limits/usage change on admin edits and
    uploads, /api/session only at login.)"""
    user = require_user(request)
    limits = user_limits(user)
    return {**limits, "used_bytes": usage_bytes(user)}


@router.post("/uploads")
async def upload_pdf(request: Request, file: UploadFile = File(...)):
    user = require_user(request)
    uploads = user_uploads_dir(user)
    uploads.mkdir(parents=True, exist_ok=True)
    contents = await file.read()
    if len(contents) < 4 or contents[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="not a valid PDF (missing %PDF header)")

    digest = hashlib.sha256(contents).hexdigest()[:24]
    target = uploads / f"{digest}.pdf"
    already_existed = target.exists()
    if not already_existed:
        # dedup first: a re-upload of a stored file costs nothing, so limits
        # only gate genuinely new bytes
        check_upload_allowed(user, len(contents))
        target.write_bytes(contents)
    # MRC scans render ~10x slower than they need to; the flattened copy takes
    # over once it exists (see gamma/flatten_queue).
    flatten_queue.schedule(user, digest)

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
    digest = hashlib.sha256(contents).hexdigest()[:24]
    ext = IMAGE_EXTENSIONS[file.content_type]
    target = uploads / f"{digest}{ext}"
    already_existed = target.exists()
    if not already_existed:
        check_upload_allowed(user, len(contents))
        target.write_bytes(contents)
    return {
        "url": f"/api/uploads/{digest}{ext}",
        "size": len(contents),
        "already_existed": already_existed,
    }


def _share_can_read_upload(user: str, scope_doc_id: str, filename: str) -> bool:
    """A share link may read only its own document's PDF (``<doc_id>.pdf``) or a
    file its subtree references (embedded images)."""
    if filename == f"{scope_doc_id}.pdf":
        return True
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        root = conn.execute(
            "SELECT id FROM unified_blocks WHERE json_extract(properties, '$.doc_id') = ?",
            (scope_doc_id,),
        ).fetchone()
        if not root:
            return False
        rows = fetch_subtree(conn, root[0])
    needle = f"/api/uploads/{filename}"
    return any(needle in (r[3] or "") or needle in (r[4] or "") for r in rows)


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
    # Flattened copies live beside the original as "<doc_id>-flat.pdf".
    bare = stem[: -len(flatten_queue.FLAT_SUFFIX)] if stem.endswith(flatten_queue.FLAT_SUFFIX) else stem
    if not bare or not all(c in "0123456789abcdef" for c in bare):
        raise HTTPException(status_code=400, detail="invalid filename")

    # Resolve who may read this: the session user (their own dir), or a valid
    # ?share= token scoped to its one document. No bare ?user= access.
    user = request.state.user
    scope_doc_id = None
    if not user:
        grant = share_grant(request)
        if not grant:
            raise HTTPException(status_code=401)
        user, scope_doc_id = grant
    if scope_doc_id is not None and not _share_can_read_upload(user, scope_doc_id, filename):
        raise HTTPException(status_code=403, detail="not accessible via this share link")

    path = find_upload_file(filename, user)
    if not path:
        raise HTTPException(status_code=404, detail="not found")
    # Filenames are content hashes (or URL hashes the server only writes once),
    # so a given name can never serve different bytes — cache hard for a month.
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=2592000, immutable"})

"""PDF / image / generic file uploads (content-hash deduped) and upload serving."""

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from ..auth import link_ratelimit, require_ws, require_ws_writer, resolve_ws, share_scope_page
from ..blocks_store import fetch_subtree
from .. import pdf_meta
from ..db import connect_pages_db, ws_uploads_dir
from ..server_settings import check_upload_allowed, workspace_quota
from ..storage import (
    ALLOWED_IMAGE_TYPES,
    IMAGE_EXTENSIONS,
    INLINE_EXTENSIONS,
    SANDBOXED_EXTENSIONS,
    content_digest,
    display_filename,
    find_upload_file,
    is_pdf,
    store_file,
    store_pdf,
    upload_extension,
    upload_media_type,
)

# Link visitors (anyone-with-the-link edit shares) may paste images and files
# like any editor, within the page's workspace quota, but only so many per IP.
LINK_UPLOADS_PER_5_MIN = 60

router = APIRouter(prefix="/api", tags=["uploads"])


@router.get("/quota")
async def get_quota(request: Request):
    """The storage limits that apply to uploads into the request's workspace
    (its billing account's) and that account's usage — feeds the client-side
    pre-upload size check and the Settings usage display. (Deliberately its
    own endpoint: limits/usage change on admin edits and uploads, /api/session
    only at login.)"""
    return workspace_quota(require_ws(request))


@router.post("/uploads")
async def upload_pdf(request: Request, file: UploadFile = File(...)):
    ws = require_ws(request, write=True)
    contents = await file.read()
    if not is_pdf(contents):
        raise HTTPException(status_code=400, detail="not a valid PDF (missing %PDF header)")
    doc_id, source_url, already_existed = store_pdf(ws, contents)
    return {
        "doc_id": doc_id,
        "source_url": source_url,
        "size": len(contents),
        "already_existed": already_existed,
    }


@router.post("/upload-image")
async def upload_image(request: Request, file: UploadFile = File(...)):
    # Share editors' images land in the page's workspace (and count against
    # its billing account) — they are referenced from that workspace's page.
    ws = require_ws_writer(request)
    link_ratelimit(request, "upload", LINK_UPLOADS_PER_5_MIN, 300)
    uploads = ws_uploads_dir(ws)
    uploads.mkdir(parents=True, exist_ok=True)
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"unsupported image type: {file.content_type}")
    contents = await file.read()
    digest = content_digest(contents)
    ext = IMAGE_EXTENSIONS[file.content_type]
    target = uploads / f"{digest}{ext}"
    already_existed = target.exists()
    if not already_existed:
        check_upload_allowed(ws, len(contents))
        target.write_bytes(contents)
    return {
        "url": f"/api/uploads/{digest}{ext}",
        "size": len(contents),
        "already_existed": already_existed,
    }


@router.post("/upload-file")
async def upload_file(request: Request, file: UploadFile = File(...)):
    """Store any file except executables (``storage.BLOCKED_EXTENSIONS``)
    under its content hash for a block to reference as
    ``[name](/api/uploads/<hash>.<ext>)`` — a file block. The extension comes
    from the uploaded name (``.bin`` when it has none; images: from the
    declared type, same path as /upload-image). A PDF stored this way gets
    the same ``<hash>.pdf`` name the PDF ingest mints, so it can later be
    opened as a document page without a second upload (``POST
    /blocks/by-doc/{hash}``). → ``{url, name, size, already_existed}``."""
    ws = require_ws_writer(request)
    link_ratelimit(request, "upload", LINK_UPLOADS_PER_5_MIN, 300)
    name = display_filename(file.filename, "file")
    if file.content_type in ALLOWED_IMAGE_TYPES:
        ext = IMAGE_EXTENSIONS[file.content_type]
    else:
        try:
            ext = upload_extension(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    contents = await file.read()
    if ext == ".pdf" and not is_pdf(contents):
        raise HTTPException(status_code=400, detail="not a valid PDF (missing %PDF header)")
    filename, already_existed = store_file(ws, contents, ext)
    return {"url": f"/api/uploads/{filename}", "name": name, "size": len(contents),
            "already_existed": already_existed}


def _share_can_read_upload(ws: str, scope_page_id: str, filename: str) -> bool:
    """A share link may read only its own page's PDF (``<doc_id>.pdf``) or a
    file the page's subtree references (embedded images, file chips — any
    extension, matched textually)."""
    with connect_pages_db(ws) as conn:
        doc = conn.execute(
            "SELECT json_extract(properties, '$.doc_id') FROM unified_blocks WHERE id = ?",
            (scope_page_id,),
        ).fetchone()
        if not doc:
            return False
        if doc[0] and filename == f"{doc[0]}.pdf":
            return True
        rows = fetch_subtree(conn, scope_page_id)
    needle = f"/api/uploads/{filename}"
    return any(needle in (r[3] or "") or needle in (r[4] or "") for r in rows)


@router.get("/pdf-info/{doc_id}")
def pdf_info(doc_id: str, request: Request):
    """The document manifest (``gamma/pdf_meta.py``): ``{doc_id, bytes,
    pages, dims: [[w, h], …]}`` in PDF points. Same access rule as the file
    itself. Sync def on purpose: a document nobody has measured yet is walked
    in pdfium here, in the threadpool. A manifest is immutable per doc id
    (content-hash names), so it caches for a day; a failed read (pages 0)
    does not."""
    if not doc_id or not all(c in "0123456789abcdef" for c in doc_id):
        raise HTTPException(status_code=400, detail="invalid document id")
    ws = resolve_ws(request)
    scope_page_id = share_scope_page(request)
    if scope_page_id is not None and not _share_can_read_upload(ws, scope_page_id, f"{doc_id}.pdf"):
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    info = pdf_meta.ensure(ws, doc_id)
    if info is None:
        raise HTTPException(status_code=404, detail="not found")
    cache = "private, max-age=86400" if info["pages"] else "no-store"
    return JSONResponse(info, headers={"Cache-Control": cache})


# GET and HEAD: the viewer asks HEAD for a file's size before deciding how to
# open it (FastAPI does not add HEAD to a GET route by itself; FileResponse
# answers a HEAD with the headers alone).
@router.api_route("/uploads/{filename}", methods=["GET", "HEAD"])
async def serve_upload(filename: str, request: Request):
    # A native annotation's asset (gamma/native_ink.py) lives in this same
    # uploads directory but answers to both names. It must NOT fall through to
    # the public month-long cache policy below — its bytes are the user's — so
    # /api/uploads/<native asset> and /api/assets/<native asset> are served by
    # one function with one set of headers. 64-hex names are minted only by the
    # native asset store, so no other upload can reach this branch.
    from ..native_ink import ASSET_NAME_RE
    if ASSET_NAME_RE.fullmatch(filename):
        from .native_ink import asset_response
        return asset_response(filename, request)
    # Sanitize: only allow [hex].ext pattern, no path traversal
    dot = filename.rfind(".")
    if dot < 0:
        raise HTTPException(status_code=400, detail="invalid filename")
    stem = filename[:dot]
    ext = filename[dot:].lower()
    media_type = upload_media_type(ext)
    if not media_type:
        raise HTTPException(status_code=400, detail="unsupported file type")
    if not stem or not all(c in "0123456789abcdef" for c in stem):
        raise HTTPException(status_code=400, detail="invalid filename")

    # Who may read this: a member of the workspace, or — with a ?share=
    # token — anyone the share admits, confined to the shared page's own assets.
    # Same resolution and refusal statuses as every other read endpoint.
    ws = resolve_ws(request)
    scope_page_id = share_scope_page(request)
    if scope_page_id is not None and not _share_can_read_upload(ws, scope_page_id, filename):
        raise HTTPException(status_code=403, detail="not accessible via this share link")

    path = find_upload_file(filename, ws)
    if not path:
        raise HTTPException(status_code=404, detail="not found")
    # Filenames are content hashes (or URL hashes the server only writes once),
    # so a given name can never serve different bytes — cache hard for a month.
    headers = {"Cache-Control": "public, max-age=2592000, immutable",
               "X-Content-Type-Options": "nosniff"}
    # Only images, PDFs and plain text render on direct navigation; generic
    # files (office, zip, …) download, and so do svg/html — scriptable in this
    # origin (stored XSS) — which are sandboxed too in case a browser renders
    # them anyway (storage.INLINE_EXTENSIONS / SANDBOXED_EXTENSIONS).
    if ext not in INLINE_EXTENSIONS:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    if ext in SANDBOXED_EXTENSIONS:
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return FileResponse(path, media_type=media_type, headers=headers)



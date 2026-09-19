"""Page-first endpoints (/api/pages*): create a page, attach or detach its
PDF. Stage 1 of docs/dev/block_centric.md — a page is a root block that may
CARRY a PDF; the PDF is an action on an existing page, not the way pages come
into being. (``POST /api/blocks/by-doc/{doc_id}`` remains the lookup-or-create
BY ATTACHMENT path for PDF ingest and the extension's dedup.)

All three need an editor of the workspace (``require_ws(write=True)``): a share token never creates
pages or changes a page's attachment (page properties stay the owner's, same
rule as PUT /blocks/{id} under a share).
"""


import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import block_index
from ..auth import require_ws
from ..blocks_store import (
    BLOCK_COLUMNS,
    attachment_props,
    block_to_dict,
    create_page,
    page_attachment,
    page_for_doc,
    pages_for_docs,
)
from ..db import connect_pages_db, safe_doc_id
from ..foldertags import clean_path
from ..markdown_zip_import import markdown_page
from ..storage import find_upload_file
from ..ops import after_commit, apply_ops, props_patch

router = APIRouter(prefix="/api", tags=["pages"])

ATTACHMENT_KEYS = ("doc_id", "source_url", "original_filename")


PAGE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class PageCreate(BaseModel):
    title: str = ""
    folder: str = ""
    id: str = ""              # a mirror bringing a page over keeps its id (409 when taken)
    properties: dict = {}     # ...and its page properties


class AttachRequest(BaseModel):
    doc_id: str = ""              # content hash of an uploaded PDF, or the URL hash a proxied one gets
    source_url: str = ""          # where the viewer loads it from (upload path or external URL)
    original_filename: str = ""   # display name; becomes the title while it is still automatic


def _load_page(conn, page_id: str):
    row = conn.execute(
        f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="page not found")
    if row[1] != "root":
        raise HTTPException(status_code=400, detail="not a page (only root blocks carry attachments)")
    return block_to_dict(row)


@router.post("/pages")
async def create_page_endpoint(payload: PageCreate, request: Request):
    """A new text-only page: ``{title?, folder?}`` → the page's block dict.
    Title defaults to "Untitled"; ``folder`` (a path like ``a/b``) becomes
    ``properties.folder``."""
    ws = require_ws(request, write=True)
    props = dict(payload.properties or {})
    folder = clean_path(payload.folder or "")
    if folder:
        props["folder"] = folder
    if payload.id and not PAGE_ID_RE.match(payload.id):
        raise HTTPException(status_code=400, detail="invalid page id")
    with connect_pages_db(ws) as conn:
        if payload.id and conn.execute("SELECT 1 FROM unified_blocks WHERE id = ?", (payload.id,)).fetchone():
            raise HTTPException(status_code=409, detail="a block with that id exists")
        return create_page(conn, payload.title, props, block_id=payload.id)


class DocsLookup(BaseModel):
    doc_ids: list[str] = []


@router.post("/pages/by-docs")
async def pages_by_docs(payload: DocsLookup, request: Request):
    """Which pages these stored files became: ``{doc_ids: [<hash>, ...]}`` →
    ``{"pages": {hash: {id, title}}}`` — a hash matches the page carrying it
    as its PDF (``doc_id``) or the note page made from it (a markdown file's
    ``markdown_import``); hashes with no page are absent. The file chips ask
    this once per page render to show the "open page" button and label the
    menu "Open page" / "Open as page". Any member."""
    ws = require_ws(request)
    ids = [d for d in dict.fromkeys(payload.doc_ids[:500]) if d]
    with connect_pages_db(ws) as conn:
        return {"pages": pages_for_docs(conn, ids)}


class FromFile(BaseModel):
    filename: str          # a stored upload, ``<hash>.md`` / ``.markdown``
    original: str = ""     # the chip's display name (the page title when there is no front-matter title)
    folder: str = ""       # files the new page (a path); ignored when the page exists


@router.post("/pages/from-file")
async def page_from_file(payload: FromFile, request: Request):
    """"Open as page" on a markdown file chip: the stored upload becomes a
    note page through the same importer as POST /import/markdown (title from
    front matter else the file name, blocks from the body), filed in
    ``folder``. Idempotent: a page already made from this file (its
    ``markdown_import`` is the file's hash) is returned instead of a second
    copy. The file stays what it was — the page is a copy, edits to it never
    touch the file. → ``{page, created}``. 400 for anything but a stored
    markdown name, 404 when the file is not in this workspace."""
    ws = require_ws(request, write=True)
    name = (payload.filename or "").strip().lower()
    m = re.fullmatch(r"([0-9a-f]{8,64})\.(md|markdown)", name)
    if not m:
        raise HTTPException(status_code=400, detail="filename must be a stored <hash>.md upload")
    path = find_upload_file(name, ws)
    if not path:
        raise HTTPException(status_code=404, detail="file not found")
    with connect_pages_db(ws) as conn:
        hit = pages_for_docs(conn, [m.group(1)]).get(m.group(1))
        if hit:
            row = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (hit["id"],)).fetchone()
            return {"page": block_to_dict(row), "created": False}
        original = m.group(0)
        # the chip's text is the display name; the stored name is a hash, so
        # take the title from the request's ``original`` when given
        result = markdown_page(conn, path.read_bytes(), payload.original or original, payload.folder)
        row = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (result["block_id"],)).fetchone()
    return {"page": block_to_dict(row), "created": True, "imported": result["imported"]}


@router.post("/pages/{page_id}/attachment")
async def attach_pdf(page_id: str, payload: AttachRequest, request: Request):
    """Attach a PDF to an existing page that has none. Body: ``doc_id``
    (validated shape only — like ``by-doc``, a URL-opened PDF's id is the URL
    hash and the file is fetched lazily by the proxy) and/or ``source_url``,
    plus an optional ``original_filename``. 409 when the page already carries
    an attachment, or when another page already carries this ``doc_id``
    (``{"detail", "page_id"}`` so the client can offer to open it). While the
    title is still automatic ("Untitled"/empty) it becomes the file name (or
    URL tail) and is marked ``auto_title`` for the metadata worker.
    Returns the updated block."""
    ws = require_ws(request, write=True)
    doc_id = (payload.doc_id or "").strip()
    source_url = (payload.source_url or "").strip()
    if doc_id:
        try:
            doc_id = safe_doc_id(doc_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid doc_id")
    if not doc_id and not source_url:
        raise HTTPException(status_code=400, detail="doc_id or source_url required")
    with connect_pages_db(ws) as conn:
        page = _load_page(conn, page_id)
        props = dict(page["properties"])
        if page_attachment(props):
            raise HTTPException(status_code=409, detail="page already has an attachment")
        if doc_id:
            other = page_for_doc(conn, doc_id)  # this page has none, so any hit is another
            if other:
                return JSONResponse(status_code=409, content={
                    "detail": "attachment belongs to another page", "page_id": other[0]})
        attachment, auto = attachment_props(doc_id, source_url, payload.original_filename)
        props.update(attachment)
        props["source_url"] = source_url or f"/api/uploads/{doc_id}.pdf"
        content = page["content"]
        if not content.strip() or content.strip() == "Untitled":
            # Same marker semantics as get_or_create_doc_page: metadata may
            # replace an automatic title, an explicit rename clears the marker.
            content = auto or content
            props["auto_title"] = content
        op = {"op": "set", "id": page_id, "props": props_patch(page["properties"], props)}
        if content != page["content"]:
            op["content"] = content
        result = after_commit(ws, conn, apply_ops(conn, page_id, [op], actor=request.state.user or ""))
    return {**page, "content": content, "properties": props, "updated_at": result["at"]}


@router.delete("/pages/{page_id}/attachment")
async def detach_pdf(page_id: str, request: Request):
    """Remove the page's PDF attachment (``doc_id`` / ``source_url`` /
    ``original_filename``). Highlight blocks keep their ``pdf_position``;
    the file itself is deleted by the orphan sweep unless another page still
    references it. → ``{"ok", "block", "removed_uploads"}``."""
    ws = require_ws(request, write=True)
    with connect_pages_db(ws) as conn:
        page = _load_page(conn, page_id)
        props = dict(page["properties"])
        if not page_attachment(props):
            raise HTTPException(status_code=404, detail="page has no attachment")
        for key in ATTACHMENT_KEYS:
            props.pop(key, None)
        result = after_commit(ws, conn, apply_ops(
            conn, page_id, [{"op": "set", "id": page_id,
                             "props": props_patch(page["properties"], props)}], actor=request.state.user or ""))
        block_index.purge_page_data(ws, conn, [])
    return {"ok": True, "block": {**page, "properties": props, "updated_at": result["at"]},
            "removed_uploads": result["removed_uploads"]}

"""Blank notebooks: create distinct, immutable blank PDFs as ordinary library
pages.

A notebook is a normal page carrying a generated PDF — the same block shape as
any other PDF page (``doc_id`` / ``source_url`` through ``attachment_props``,
the viewer manifest through ``store_pdf``, by-doc lookup, folder labels,
backup/export) — so the viewer, notes, highlighting, AI context and export all
work on it with no special case.

Why its own endpoint instead of an upload: the page id is **client-minted**
(a canonical UUID) and the call is **idempotent** on the creation payload. A
client that lost the response retries and gets the page as it stands, *including
a rename that happened in between*, instead of creating a second notebook; the
same id paired with a different payload is refused (409) rather than silently
reusing or overwriting the page. The fingerprint rides in the page's properties
as ``blank_pdf_creation``, which is what a retry compares.

Every notebook gets its own ``doc_id`` even when the geometry is identical:
the generated file carries the page id as ``/GammaNotebookID`` metadata, so two
blank A4 notebooks never collapse into one document identity.

Permission rules: an editor or owner of the request's workspace
(``require_ws_writer``). A ``?share=`` request is refused outright — a share is
a page, and creating a page is a library-level action, the same rule
``POST /api/blocks`` with ``parent_id='root'`` applies. ``?ws=`` /
``X-Gamma-Workspace`` select the workspace the page is created in.
"""

import hashlib
import io
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from PyPDF2 import PdfWriter

from ..auth import require_ws_writer, share_scope_page
from ..blocks_store import BLOCK_COLUMNS, attachment_props, block_to_dict, create_page
from ..db import connect_pages_db, pdf_upload_path
from ..foldertags import clean_path
from ..native_ink import is_canonical_uuid
from ..storage import store_pdf

router = APIRouter(prefix="/api", tags=["pdf"])

# ISO A4 in points, and US Letter. The client may only choose between these.
PAGE_SIZES = {"a4": (595.2756, 841.8898), "letter": (612.0, 792.0)}


class BlankPDF(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="Blank PDF", min_length=1, max_length=200)
    page_size: Literal["a4", "letter"] = "a4"
    orientation: Literal["portrait", "landscape"] = "portrait"
    page_count: int = Field(default=1, ge=1, le=100, strict=True)
    folder: str = Field(default="", max_length=2000)


def _blank_pdf_bytes(payload: BlankPDF, page_id: str) -> tuple[bytes, float, float]:
    """``(pdf bytes, page width, page height)`` for one notebook: ``page_count``
    empty pages at the requested size (landscape swaps them), titled, and
    stamped with the notebook id so distinct notebooks keep distinct document
    identities."""
    width, height = PAGE_SIZES[payload.page_size]
    if payload.orientation == "landscape":
        width, height = height, width
    writer = PdfWriter()
    for _ in range(payload.page_count):
        writer.add_blank_page(width=width, height=height)
    writer.add_metadata({"/Title": payload.title.strip(), "/GammaNotebookID": page_id})
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue(), width, height


@router.put("/blank-pdfs/{page_id}")
def create_blank_pdf(page_id: str, payload: BlankPDF, request: Request):
    """Create (or recognize) one blank notebook page.

    ``page_id`` is the canonical lowercase UUID the client minted. Returns the
    ordinary full block of the new root page — ``{id, parent_id, position,
    content, properties, created_at, updated_at}`` — with the PDF attachment
    props, ``pdf_kind: "blank"``, the requested geometry in ``blank_pdf`` and
    the request fingerprint in ``blank_pdf_creation``; ``source_url`` serves the
    generated file.

    Idempotent: an identical retry returns the page unchanged (later edits
    included); a different payload against an id that already exists is a 409.
    Quota applies (413/507) and nothing is published when it refuses."""
    if not is_canonical_uuid(page_id):
        raise HTTPException(422, "expected canonical lowercase UUID")
    ws = require_ws_writer(request)
    if share_scope_page(request) is not None:
        # A share reaches one page; minting a library page is not that.
        raise HTTPException(403, "not accessible via this share link")
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "title must not be blank")
    fingerprint = hashlib.sha256(
        json.dumps(payload.model_dump(), sort_keys=True).encode()).hexdigest()
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (page_id,)).fetchone()
        if existing is not None:
            block = block_to_dict(existing)
            if (block["parent_id"] != "root"
                    or block["properties"].get("blank_pdf_creation") != fingerprint):
                raise HTTPException(409, "creation ID already used for a different request")
            return block
        data, width, height = _blank_pdf_bytes(payload, page_id)
        doc_id, source_url, already_existed = store_pdf(ws, data)
        path = pdf_upload_path(ws, doc_id)
        # Content addressing makes the name its digest: a stored file that does
        # not hash to it was truncated or tampered with, and must not become a
        # page's document.
        if path.read_bytes() != data:
            raise HTTPException(409, "document digest collision")
        props = dict(attachment_props(doc_id, source_url)[0])
        props.update({
            "pdf_kind": "blank",
            "blank_pdf_creation": fingerprint,
            "blank_pdf": {"page_size": payload.page_size, "orientation": payload.orientation,
                          "initial_page_count": payload.page_count,
                          "width": width, "height": height},
        })
        folder = clean_path(payload.folder)
        if folder:
            props["folder"] = folder
        try:
            return create_page(conn, title, props, block_id=page_id)
        except Exception:
            # Publishing nothing on failure: the bytes were new, so drop them.
            if not already_existed:
                path.unlink(missing_ok=True)
            raise

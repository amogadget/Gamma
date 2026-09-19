"""Idempotent creation of ordinary Gamma highlight blocks from native clients.

A native text selection is nothing new to the data model: it is the same
``highlight_id`` / ``quote`` / ``color`` / ``pdf_page`` / ``pdf_position`` block
the Web client writes. What the native client needs is a CREATE-ONLY,
retry-safe route for a client-minted UUID, because its outbox may re-send a
highlight long after the response was lost — and a retry must return the
block's current state (including whatever the Web has since edited) instead of
resetting it or, worse, claiming an unrelated block whose UUID collides.

The write goes through ``gamma/ops.py`` like every other block writer: one
transaction, one op-log row, the page's room notified, orphan uploads swept.
Workspace scope and share confinement come from ``require_ws_writer`` /
``share_scope_page`` — an edit share may annotate its own page only
(``gamma/routers/native_ink.py`` documents the full permission table).
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..auth import require_ws_writer
from ..blocks_store import block_to_dict
from ..db import connect_pages_db
from .native_ink import (
    block_row,
    commit_native_batch,
    current_block,
    request_page_scope,
    require_pdf_page,
    require_uuid,
)

router = APIRouter(prefix="/api", tags=["blocks"])


class Rect(BaseModel):
    """One viewport rectangle, in the Web client's highlight convention."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x1: float = Field(ge=0)
    y1: float = Field(ge=0)
    x2: float = Field(gt=0)
    y2: float = Field(gt=0)
    width: float = Field(gt=0, le=1_000_000)
    height: float = Field(gt=0, le=1_000_000)
    pageNumber: int = Field(ge=1, strict=True)

    @model_validator(mode="after")
    def bounds(self):
        if (self.x2 <= self.x1 or self.y2 <= self.y1
                or self.x2 > self.width + .01 or self.y2 > self.height + .01):
            raise ValueError("invalid viewport rectangle")
        return self


class Position(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pageNumber: int = Field(ge=1, strict=True)
    boundingRect: Rect
    rects: list[Rect] = Field(min_length=1, max_length=2000)
    area: bool = False

    @model_validator(mode="after")
    def same_page(self):
        for rect in [self.boundingRect, *self.rects]:
            if rect.pageNumber != self.pageNumber:
                raise ValueError("each highlight belongs to one page")
        return self


class CreateHighlight(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_id: str = Field(min_length=1, max_length=200)
    quote: str = Field(min_length=1, max_length=100_000)
    color: str = Field(min_length=1, max_length=100)
    pdf_position: Position


@router.put("/blocks/{block_id}/highlight")
def create_highlight(block_id: str, payload: CreateHighlight, request: Request):
    """Create one page-scoped highlight with a client-minted canonical UUID.

    ``parent_id`` must be an existing top-level Gamma PDF page. A retry for the
    same UUID returns the block as it stands NOW — later Web text, color and
    comment edits included — without touching it; a UUID that already belongs
    to another block, or to a different parent, is refused with 409 rather than
    hijacked. A selection spanning pages becomes one block per page (the client
    calls this once per page). → the complete block.

    Requires an editor or owner of the request's workspace, or an edit share
    confined to ``parent_id``'s page."""
    require_uuid(block_id)
    ws = require_ws_writer(request)
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        page_id = require_pdf_page(conn, payload.parent_id)
        scope = request_page_scope(request, page_id)
        existing, props = current_block(conn, block_id)
        if existing is not None:
            # Create-only: a lost-response retry never replaces later Web edits,
            # and never claims an unrelated block's UUID.
            if (existing["parent_id"] != payload.parent_id
                    or props.get("highlight_id") != block_id):
                raise HTTPException(409, "block ID collision")
            return existing
        created = {
            "highlight_id": block_id,
            "quote": payload.quote,
            "color": payload.color,
            "pdf_page": payload.pdf_position.pageNumber,
            "pdf_position": payload.pdf_position.model_dump(),
        }
        commit_native_batch(ws, conn, page_id,
                            [{"op": "insert", "id": block_id, "parent": payload.parent_id,
                              "content": "", "props": created}], request, scope)
        row = block_row(conn, block_id)
    return block_to_dict(row)

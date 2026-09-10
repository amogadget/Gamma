"""Idempotent creation of ordinary Gamma highlight blocks from native clients."""
import json
import sqlite3
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fractional_indexing import generate_key_between
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..auth import require_user
from ..blocks_store import BLOCK_COLUMNS, block_to_dict
from ..db import page_now, user_db_path

router = APIRouter(prefix="/api", tags=["blocks"])


class Rect(BaseModel):
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
        if self.x2 <= self.x1 or self.y2 <= self.y1 or self.x2 > self.width + .01 or self.y2 > self.height + .01:
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
    user = require_user(request)
    try:
        if str(UUID(block_id)) != block_id:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "expected canonical UUID")
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        conn.execute("BEGIN IMMEDIATE")
        parent = conn.execute("SELECT parent_id, properties FROM unified_blocks WHERE id = ?", (payload.parent_id,)).fetchone()
        if not parent:
            raise HTTPException(404, "parent not found")
        if parent[0] != "root" or not json.loads(parent[1] or "{}").get("doc_id"):
            raise HTTPException(409, "parent must be a Gamma PDF page")
        row = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        if row:
            existing = block_to_dict(row)
            # Create-only endpoint: a lost-response retry never replaces later
            # Web edits, and never claims an unrelated block's UUID.
            if existing["parent_id"] != payload.parent_id or existing["properties"].get("highlight_id") != block_id:
                raise HTTPException(409, "block ID collision")
            return existing
        props = {"highlight_id": block_id, "quote": payload.quote, "color": payload.color,
                 "pdf_page": payload.pdf_position.pageNumber, "pdf_position": payload.pdf_position.model_dump()}
        last = conn.execute("SELECT position FROM unified_blocks WHERE parent_id = ? ORDER BY position DESC LIMIT 1", (payload.parent_id,)).fetchone()
        now = page_now()
        conn.execute(f"INSERT INTO unified_blocks ({BLOCK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (block_id, payload.parent_id, generate_key_between(last[0] if last else None, None), "", json.dumps(props), now, now))
        result = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        conn.commit()
    return block_to_dict(result)

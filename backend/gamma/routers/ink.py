"""Native grouped PencilKit annotations, stored as ordinary unified blocks."""

import hashlib
import io
import json
import os
import re
import sqlite3
import tempfile
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fractional_indexing import generate_key_between
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..auth import require_user
from ..blocks_store import BLOCK_COLUMNS, block_to_dict
from ..db import page_now, user_db_path, user_uploads_dir
from ..server_settings import check_upload_allowed

router = APIRouter(prefix="/api", tags=["ink"])
ASSET_NAME_RE = re.compile(r"^[0-9a-f]{64}\.(?:pkdrawing|png|m4a)$")
ASSET_REF_RE = re.compile(r"^/api/assets/([0-9a-f]{64}\.(?:pkdrawing|png|m4a))$")


def asset_path(user: str, filename: str):
    if not ASSET_NAME_RE.fullmatch(filename):
        raise HTTPException(400, "invalid asset filename")
    path = user_uploads_dir(user) / filename
    if path.is_symlink():
        raise HTTPException(400, "unsafe asset path")
    return path


@router.post("/assets")
async def upload_asset(request: Request, file: UploadFile = File(...)):
    user = require_user(request)
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    allowed = {"png": {"image/png"}, "pkdrawing": {
        "application/octet-stream", "application/x-pkdrawing"}, "m4a": {
        "audio/mp4", "audio/x-m4a"}}
    if ext not in allowed or file.content_type not in allowed[ext]:
        raise HTTPException(400, "only PNG, PKDrawing, or M4A audio assets are supported")
    # Bounded reading, unlike legacy upload routes. A fixed safety ceiling also
    # applies to duplicates; quota/per-file policy otherwise gates only new bytes.
    cap = 32 * 1024 * 1024
    contents = await file.read(cap + 1)
    if len(contents) > cap:
        raise HTTPException(413, "asset too large")
    if not contents:
        raise HTTPException(400, "empty asset")
    if ext == "m4a":
        # Opaque audio: require a plausible ISO-BMFF ftyp box; decoders stay client-side.
        if len(contents) < 16 or contents[4:8] != b"ftyp":
            raise HTTPException(400, "invalid M4A (missing ftyp)")
    if ext == "png":
        try:
            with Image.open(io.BytesIO(contents)) as image:
                if image.format != "PNG":
                    raise ValueError("not PNG")
                image.verify()
        except Exception:
            raise HTTPException(400, "invalid PNG")
    # PKDrawing is opaque: Linux cannot validate Apple's serialization. Never
    # deserialize it server-side or claim arbitrary bytes are valid PencilKit.
    filename = f"{hashlib.sha256(contents).hexdigest()}.{ext}"
    target = asset_path(user, filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Same per-user SQLite write lock as ink upsert; serializes quota checks and
    # publication across workers. No partially written content-addressed files.
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existed = target.is_file()
        if not existed:
            check_upload_allowed(user, len(contents))
            fd, temp = tempfile.mkstemp(prefix=".ink-", dir=target.parent)
            try:
                with os.fdopen(fd, "wb") as out:
                    out.write(contents)
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp, target)
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
        else:
            # Renew the staging grace period on a durable retry before upsert.
            os.utime(target, None)
    return {"filename": filename, "url": f"/api/assets/{filename}",
            "size": len(contents), "already_existed": existed}


@router.get("/assets/{filename}")
def get_asset(filename: str, request: Request):
    path = asset_path(require_user(request), filename)
    if not path.is_file():
        raise HTTPException(404, "asset not found")
    return FileResponse(path, media_type=("image/png" if filename.endswith(".png")
                                         else ("audio/mp4" if filename.endswith(".m4a") else "application/octet-stream")), headers={
        "Cache-Control": "private, no-cache", "Vary": "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": f'inline; filename="{filename}"',
    })


class CropBox(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    width: float = Field(gt=0, le=100000)
    height: float = Field(gt=0, le=100000)


class InkBounds(CropBox):
    x: float = Field(ge=0)
    y: float = Field(ge=0)


class InkSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_id: str = Field(min_length=1, max_length=200)
    pdf_page: int = Field(ge=1, strict=True)
    ink_asset: str
    preview_asset: str
    bounds: InkBounds
    crop_box: CropBox
    coordinate_space: Literal["pdf-crop-top-left-v1"] = "pdf-crop-top-left-v1"
    expected_revision: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode="after")
    def validate_geometry(self):
        b, c = self.bounds, self.crop_box
        if b.x + b.width > c.width + 0.001 or b.y + b.height > c.height + 0.001:
            raise ValueError("bounds must lie within crop_box")
        for ref, ext in ((self.ink_asset, ".pkdrawing"), (self.preview_asset, ".png")):
            if not ASSET_REF_RE.fullmatch(ref) or not ref.endswith(ext):
                raise ValueError(f"expected a local {ext} asset URL")
        return self


@router.put("/blocks/{block_id}/ink")
def save_ink(block_id: str, payload: InkSave, request: Request):
    user = require_user(request)
    try:
        if str(UUID(block_id)) != block_id:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "block_id must be a canonical lowercase UUID")
    ink = payload.model_dump(exclude={"parent_id", "expected_revision"})
    ink["type"] = "pdf_ink"
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        conn.execute("BEGIN IMMEDIATE")
        parent = conn.execute(
            "SELECT parent_id, properties FROM unified_blocks WHERE id = ?", (payload.parent_id,)
        ).fetchone()
        if not parent:
            raise HTTPException(404, "parent block not found")
        parent_props = json.loads(parent[1] or "{}")
        if parent[0] != "root" or not parent_props.get("doc_id"):
            raise HTTPException(409, "parent must be an existing Gamma PDF page")
        row = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        existing = block_to_dict(row) if row else None
        props = existing["properties"] if existing else {}
        revision = props.get("ink_revision", 0)
        if existing:
            if (existing["parent_id"] != payload.parent_id or props.get("type") != "pdf_ink"
                    or props.get("pdf_page") != payload.pdf_page
                    or not isinstance(revision, int) or revision < 1
                    or any(props.get(key) for key in ("highlight_id", "link_url", "link_page_id", "doc_id"))):
                raise HTTPException(409, "block ID belongs to another block or annotation scope")
            if all(props.get(key) == value for key, value in ink.items()):
                return existing  # Lost-response retry: no new revision or timestamp.
        if payload.expected_revision is not None and payload.expected_revision != revision:
            raise HTTPException(409, {"message": "ink revision conflict", "current_revision": revision})
        for ref in (payload.ink_asset, payload.preview_asset):
            if not asset_path(user, ref.rsplit("/", 1)[-1]).is_file():
                raise HTTPException(404, "asset not found; upload assets before saving ink")
        props.update(ink)
        props["ink_revision"] = revision + 1
        now = page_now()
        if existing:
            conn.execute("UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?",
                         (json.dumps(props), now, block_id))
        else:
            last = conn.execute("SELECT position FROM unified_blocks WHERE parent_id = ? "
                                "ORDER BY position DESC LIMIT 1", (payload.parent_id,)).fetchone()
            position = generate_key_between(last[0] if last else None, None)
            conn.execute(f"INSERT INTO unified_blocks ({BLOCK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (block_id, payload.parent_id, position, "", json.dumps(props), now, now))
        result = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        conn.commit()
    return block_to_dict(result)


class AudioSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str
    asset: str
    duration: float = Field(gt=0, le=24 * 60 * 60)


class ReplayEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str
    kind: Literal["stroke", "page", "note"]
    segment_id: str
    start: float = Field(ge=0, le=24 * 60 * 60)
    end: float = Field(ge=0, le=24 * 60 * 60)
    pdf_page: int = Field(gt=0, strict=True)
    block_id: str | None = None
    stroke_id: str | None = None

    @model_validator(mode="after")
    def validate_event(self):
        for name, value in (("id", self.id), ("segment_id", self.segment_id)):
            try:
                if str(UUID(value)) != value:
                    raise ValueError()
            except (ValueError, AttributeError):
                raise ValueError(f"{name} must be a canonical lowercase UUID")
        if self.end < self.start:
            raise ValueError("replay event end must be at least start")
        if self.kind == "stroke" and (not self.block_id or not self.stroke_id):
            raise ValueError("stroke replay events require block_id and stroke_id")
        if self.kind == "note" and not self.block_id:
            raise ValueError("note replay events require block_id")
        if self.kind == "page" and (self.block_id is not None or self.stroke_id is not None):
            raise ValueError("page replay events cannot have block_id or stroke_id")
        return self


class AudioSave(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    parent_id: str = Field(min_length=1, max_length=200)
    expected_revision: int | None = Field(default=None, ge=0, strict=True)
    audio_state: Literal["recording", "paused", "interrupted", "stopped"]
    segments: list[AudioSegment] = Field(default_factory=list, max_length=1000)
    replay_events: list[ReplayEvent] | None = Field(default=None, max_length=20000)

    @model_validator(mode="after")
    def validate_replay_events(self):
        if self.replay_events is None:
            return self
        ids = [event.id for event in self.replay_events]
        if len(ids) != len(set(ids)):
            raise ValueError("replay event IDs must be unique")
        segment_ids = {segment.id for segment in self.segments}
        if any(event.segment_id not in segment_ids for event in self.replay_events):
            raise ValueError("replay event segment_id must reference a submitted segment")
        return self


@router.put("/blocks/{block_id}/audio")
def save_audio(block_id: str, payload: AudioSave, request: Request):
    user = require_user(request)
    try:
        if str(UUID(block_id)) != block_id:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "block_id must be a canonical lowercase UUID")
    ids = [s.id for s in payload.segments]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, "audio segment IDs must be unique")
    for sid in ids:
        try:
            if str(UUID(sid)) != sid:
                raise ValueError()
        except ValueError:
            raise HTTPException(422, "segment IDs must be canonical lowercase UUIDs")
    total = sum(s.duration for s in payload.segments)
    if total > 24 * 60 * 60:
        raise HTTPException(422, "audio duration exceeds 24 hour limit")
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        conn.execute("BEGIN IMMEDIATE")
        parent = conn.execute("SELECT parent_id, properties FROM unified_blocks WHERE id = ?", (payload.parent_id,)).fetchone()
        if not parent:
            raise HTTPException(404, "parent block not found")
        pprops = json.loads(parent[1] or "{}")
        if parent[0] != "root" or not pprops.get("doc_id"):
            raise HTTPException(409, "parent must be an existing Gamma PDF page")
        row = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        existing = block_to_dict(row) if row else None
        props = existing["properties"] if existing else {}
        revision = props.get("audio_revision", 0)
        if existing and (existing["parent_id"] != payload.parent_id or props.get("type") != "audio" or not isinstance(revision, int) or revision < 1):
            raise HTTPException(409, "block ID belongs to another block or audio scope")
        incoming = [{"id": s.id, "asset": s.asset, "duration": s.duration} for s in payload.segments]
        incoming_replay = ([event.model_dump(exclude_none=True) for event in payload.replay_events]
                           if payload.replay_events is not None else None)
        old_segments = props.get("segments", [])
        # Stored segments carry derived start_time; compare only client-owned fields
        # so exact retries remain idempotent after the first save. An omitted
        # replay_events field is an old-client save and preserves the stored timeline.
        comparable_old = [{k: s.get(k) for k in ("id", "asset", "duration")}
                          for s in old_segments if isinstance(s, dict)]
        timeline_same = (incoming_replay is None or props.get("replay_events", []) == incoming_replay)
        if existing and props.get("audio_state") == payload.audio_state and comparable_old == incoming and timeline_same:
            return existing
        if payload.expected_revision is not None and payload.expected_revision != revision:
            raise HTTPException(409, {"message": "audio revision conflict", "current_revision": revision})
        for seg in payload.segments:
            if not ASSET_REF_RE.fullmatch(seg.asset) or not seg.asset.endswith(".m4a"):
                raise HTTPException(422, "expected a local M4A asset URL")
            if not asset_path(user, seg.asset.rsplit("/", 1)[-1]).is_file():
                raise HTTPException(404, "audio asset not found; upload assets before saving audio")
        start = 0.0
        segments = []
        for seg in payload.segments:
            segments.append({"id": seg.id, "asset": seg.asset, "duration": seg.duration, "start_time": start})
            start += seg.duration
        props.update(type="audio", audio_revision=revision + 1, audio_state=payload.audio_state, segments=segments, duration=total)
        if payload.replay_events is not None:
            props["replay_events"] = incoming_replay
        now = page_now()
        if existing:
            conn.execute("UPDATE unified_blocks SET properties = ?, updated_at = ? WHERE id = ?", (json.dumps(props), now, block_id))
        else:
            last = conn.execute("SELECT position FROM unified_blocks WHERE parent_id = ? ORDER BY position DESC LIMIT 1", (payload.parent_id,)).fetchone()
            pos = generate_key_between(last[0] if last else None, None)
            conn.execute(f"INSERT INTO unified_blocks ({BLOCK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)", (block_id, payload.parent_id, pos, "", json.dumps(props), now, now))
        result = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        conn.commit()
    return block_to_dict(result)


class NativeNoteSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_id: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=1_000_000)
    expected_revision: int | None = Field(default=None, ge=0, strict=True)


@router.put("/blocks/{block_id}/note")
def save_native_note(block_id: str, payload: NativeNoteSave, request: Request):
    """Durable outbox note writes, without taking ownership of unrelated blocks."""
    user = require_user(request)
    try:
        if str(UUID(block_id)) != block_id:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "block_id must be a canonical lowercase UUID")
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        conn.execute("BEGIN IMMEDIATE")
        # Only a bounded chain of native notes may lead to an ink annotation;
        # plain text blocks, cycles, detached ink and non-PDF roots are refused.
        ancestor_id = payload.parent_id
        seen = {block_id}
        ink_id = None
        for depth in range(64):
            if ancestor_id in seen:
                raise HTTPException(409, "invalid note ancestor cycle")
            seen.add(ancestor_id)
            ancestor = conn.execute("SELECT parent_id, properties FROM unified_blocks WHERE id = ?",
                                    (ancestor_id,)).fetchone()
            if not ancestor:
                raise HTTPException(404 if depth == 0 else 409, "note ancestor not found")
            ancestor_props = json.loads(ancestor[1] or "{}")
            if ancestor_props.get("type") == "pdf_ink":
                ink_id = ancestor_id
                page = conn.execute("SELECT parent_id, properties FROM unified_blocks WHERE id = ?",
                                    (ancestor[0],)).fetchone()
                if not page or page[0] != "root" or not json.loads(page[1] or "{}").get("doc_id"):
                    raise HTTPException(409, "ink ancestor must belong to a Gamma PDF page")
                break
            if (ancestor_props.get("native_note") is not True
                    or any(ancestor_props.get(key) for key in ("type", "highlight_id", "link_url", "link_page_id", "doc_id"))):
                raise HTTPException(409, "parent must be ink or a native note beneath ink")
            ancestor_id = ancestor[0]
        if ink_id is None:
            raise HTTPException(409, "note nesting limit exceeded")
        row = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        existing = block_to_dict(row) if row else None
        props = existing["properties"] if existing else {}
        revision = props.get("note_revision", 0)
        if existing:
            if (existing["parent_id"] != payload.parent_id or props.get("native_note") is not True
                    or not isinstance(revision, int) or revision < 1
                    or any(props.get(key) for key in ("type", "highlight_id", "link_url", "link_page_id", "doc_id"))):
                raise HTTPException(409, "block ID belongs to another block or note scope")
            if existing["content"] == payload.content:
                return existing
        if payload.expected_revision is not None and payload.expected_revision != revision:
            raise HTTPException(409, {"message": "note revision conflict", "current_revision": revision})
        props.update(native_note=True, note_revision=revision + 1)
        now = page_now()
        if existing:
            conn.execute("UPDATE unified_blocks SET content = ?, properties = ?, updated_at = ? WHERE id = ?",
                         (payload.content, json.dumps(props), now, block_id))
        else:
            last = conn.execute("SELECT position FROM unified_blocks WHERE parent_id = ? "
                                "ORDER BY position DESC LIMIT 1", (payload.parent_id,)).fetchone()
            position = generate_key_between(last[0] if last else None, None)
            conn.execute(f"INSERT INTO unified_blocks ({BLOCK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (block_id, payload.parent_id, position, payload.content, json.dumps(props), now, now))
        result = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM unified_blocks WHERE id = ?", (block_id,)).fetchone()
        conn.commit()
    return block_to_dict(result)

"""Native (iPad) ink, audio and note payloads: the validation schemas, the
content-addressed asset store and the reserved-property rules.

This module is the workspace-scoped home of what the native client speaks
(docs/dev/api.md): ``/api/assets`` plus the ``ink`` / ``replay-preview`` /
``audio`` / ``note`` block endpoints, served by ``gamma/routers/native_ink.py``.
The upstream handwriting feature (``gamma/ink.py`` — the ``gamma-ink`` stroke
file behind ``POST /api/upload-ink`` and ``properties.ink_url``) is untouched and
independent: two client generations, two shapes, one app.

Asset naming and storage
------------------------

A native asset keeps its FULL sha256 plus extension (``<64hex>.pkdrawing``,
``.png``, ``.m4a``, ``.inkjson``) in the WORKSPACE uploads directory
(``ws_uploads_dir``). It lives there — rather than in a directory of its own —
because everything upstream already does with that directory is what these
files need: quota accounting, the backup zip, the scoped Gamma export/import
and the orphan sweep (``gamma/storage.py``). The full digest is not cosmetic:
a replay document names its source drawing with ``source_sha256``, and the
native client computes that digest from the bytes it uploaded, so the stored
name must be the digest it expects. 64 hex characters cannot collide with the
24-hex names every other upload route mints, which is what lets
``/api/assets/<filename>`` and ``/api/uploads/<filename>`` name the same file.

Permission rules (explicit)
---------------------------

``?user=`` is never honoured, and no endpoint here reaches outside the
workspace the request resolves to (``?ws=`` / ``X-Gamma-Workspace`` / the
account's default) — the uploads directory and ``pages.db`` are both that
workspace's.

======================  ==========================  ==============================
endpoint                requires                    confinement
======================  ==========================  ==============================
``POST /api/assets``    ``require_ws_writer``       bytes land in the resolved
                                                    workspace's uploads dir; the
                                                    file is unreferenced until a
                                                    save binds it, and an
                                                    unreferenced native asset is
                                                    retained for offline recovery
``GET /api/assets/…``   ``resolve_ws``              a ``?share=`` token is
                                                    confined to assets referenced
                                                    inside its own page's subtree
``PUT …/ink``           ``require_ws_writer``       the parent page must be the
                                                    share's page; the block must
                                                    already be an ink block inside
                                                    that page (nesting is preserved)
``PUT …/replay-preview``  ``require_ws_writer``     as above, and the block must
                                                    be an existing ``pdf_ink``
                                                    block in the share's page
``PUT …/audio``         ``require_ws_writer``       as for ``ink``
``PUT …/note``          ``require_ws_writer``       the whole ancestor chain must
                                                    stay inside the share's page
======================  ==========================  ==============================

``require_ws_writer`` is an editor/owner member of the workspace, or an edit
share whose block access is confined to its page (``share_scope_page``); a
viewer, an anonymous visitor and a view-only share are all refused (403), and a
missing session is 401. Reads follow the upstream read model
(``resolve_ws``), so a shared page's ink renders for the people it was shared
with.

Reserved native properties
-------------------------

Native endpoints own the properties that describe a recording. Generic writers
(``PUT /api/blocks/{id}``, the page ops endpoint, ``PUT /api/blocks/{id}/children``)
may edit a native block's text, children and unrelated properties, but must not
touch the reserved keys — otherwise a stale Web autosave could roll back a
recording's timeline or clear a freshly backfilled replay. ``native_kind`` /
``reserved_keys`` / ``guard_generic_update`` / ``guard_generic_insert`` /
``preserve_native_properties`` / ``restored_native_properties`` are the single
place those rules live; ``gamma/ops.py`` applies them on the one write path
every block writer uses.

Three consequences worth stating plainly, all deliberate:

- **Copying an annotation is a native write.** A generic insert that carried
  ``type: "pdf_ink"`` / ``ink_asset`` / ``segments`` over from a block it copied
  is refused (409), because the server would otherwise mint a block claiming a
  recorded payload it never validated (no geometry check, no CAS, no revision
  of its own). The copy belongs on the native endpoint with a fresh UUID and
  the same assets, which is exactly the create path. The Web "duplicate block"
  action — which copies every property — therefore refuses a native annotation
  rather than producing a half-native one.
- **Undoing a deletion is not copying.** Ctrl+Z re-inserts a block the Web
  itself removed, and the page's op log recorded that block when it went, so the
  insert is checked against the record and the RECORDED payload is restored
  (``restored_native_properties``, called from ``gamma/ops.py``). The refusal
  above is about a payload no deletion ever recorded — an invented id, another
  page, another workspace or an edited manifest is still 409.
- **A Web text edit moves a native note's revision** (``note_revision``), so an
  offline note save computed against the old revision conflicts (409) instead
  of overwriting the Web edit.
"""

import base64
import binascii
import hashlib
import json
import os
import re
import tempfile
import zlib
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

from .db import connect_pages_db, ws_uploads_dir
from .server_settings import check_upload_allowed
from .storage import NATIVE_ASSET_NAME_RE, NATIVE_ASSET_TEMP_PREFIX

# --- assets ------------------------------------------------------------------

# The one filename shape a native asset may have: the full lowercase sha256 of
# its bytes plus one of the four supported extensions.
ASSET_NAME_RE = NATIVE_ASSET_NAME_RE
# A payload may only name an asset through the canonical local URL: no remote
# URLs, no data URLs, no traversal, no other extension.
ASSET_REF_RE = re.compile(r"^/api/assets/([0-9a-f]{64}\.(?:pkdrawing|png|m4a|inkjson))$")
DRAWING_REF_RE = re.compile(r"^/api/assets/[0-9a-f]{64}\.pkdrawing$")
PREVIEW_REF_RE = re.compile(r"^/api/assets/[0-9a-f]{64}\.png$")
AUDIO_REF_RE = re.compile(r"^/api/assets/[0-9a-f]{64}\.m4a$")
REPLAY_REF_RE = re.compile(r"^/api/assets/([0-9a-f]{64}\.inkjson)$")

# Media type the client must declare per extension. Parameters (";
# charset=utf-8") are stripped before the comparison — the type is what the
# policy is about, and some clients always append a charset.
ASSET_CONTENT_TYPES = {
    "pkdrawing": frozenset({"application/octet-stream", "application/x-pkdrawing"}),
    "png": frozenset({"image/png"}),
    "inkjson": frozenset({"application/json"}),
    "m4a": frozenset({"audio/mp4", "audio/x-m4a"}),
}
ASSET_EXTENSIONS = tuple(ASSET_CONTENT_TYPES)
# Hard cap on one asset, whatever the quota says: a bounded read, so an
# oversized body cannot be buffered into memory first.
ASSET_MAX_BYTES = 32 * 1024 * 1024

_REPLAY_MAX_STROKES = 2000
_REPLAY_MAX_POINTS = 200_000
_REPLAY_MAX_PNG_DIMENSION = 4096
_REPLAY_MAX_PIXELS = 24_000_000
_REPLAY_EPSILON = 0.001
_AUDIO_MAX_SECONDS = 24 * 60 * 60
_AUDIO_MAX_SEGMENTS = 1000
_REPLAY_MAX_EVENTS = 20_000
_NOTE_ANCESTOR_LIMIT = 64
_NOTE_MAX_CONTENT = 1_000_000

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class NativeAssetError(ValueError):
    """A bad asset name/path or an unsupported asset payload (→ 400)."""


class NativeAssetMissing(NativeAssetError):
    """A referenced asset is not stored yet (→ 404; the client uploads first)."""


class NativeAssetInvalid(NativeAssetError):
    """A stored asset exists but is not usable (→ 400)."""


class NativeScopeError(ValueError):
    """A generic writer touched a property only the native endpoints own."""


def png_dimensions(raw: bytes) -> tuple[int, int]:
    """``(width, height)`` of a structurally valid PNG, or ValueError.

    Deliberately Pillow-free (the server has no image library): the signature,
    a walk over every chunk with its CRC, the IHDR contract and a terminating
    IEND are checked — the same class of damage ``Image.verify()`` catches —
    and the pixel data is never decoded, so a decompression bomb costs nothing
    here. Dimensions come from IHDR, which is what the replay budgets need.
    """
    if len(raw) < len(_PNG_SIGNATURE) or not raw.startswith(_PNG_SIGNATURE):
        raise ValueError("not a PNG")
    pos = len(_PNG_SIGNATURE)
    width = height = None
    saw_end = False
    while pos < len(raw):
        if pos + 8 > len(raw):
            raise ValueError("truncated PNG chunk header")
        length = int.from_bytes(raw[pos:pos + 4], "big")
        ctype = raw[pos + 4:pos + 8]
        if length > len(raw) - pos - 12:
            raise ValueError("truncated PNG chunk")
        body = raw[pos + 8:pos + 8 + length]
        crc = int.from_bytes(raw[pos + 8 + length:pos + 12 + length], "big")
        if zlib.crc32(ctype + body) & 0xFFFFFFFF != crc:
            raise ValueError("bad PNG chunk CRC")
        if width is None:
            if ctype != b"IHDR" or length != 13:
                raise ValueError("PNG must start with IHDR")
            width = int.from_bytes(body[0:4], "big")
            height = int.from_bytes(body[4:8], "big")
            if not width or not height:
                raise ValueError("bad PNG dimensions")
        elif ctype == b"IEND":
            saw_end = True
        pos += 12 + length
        if saw_end:
            break
    if width is None or not saw_end:
        raise ValueError("incomplete PNG")
    return width, height


def asset_path(ws: str, filename: str) -> Path:
    """Validated path to a native asset in ``ws``'s uploads directory.

    The name must be the full-digest form and the resolved path must not be a
    symlink — the same two guards every other file this server writes has, plus
    the digest itself, so nothing outside the uploads directory is reachable.
    Raises :class:`NativeAssetError` (the router maps it to 400)."""
    if not isinstance(filename, str) or not ASSET_NAME_RE.fullmatch(filename):
        raise NativeAssetError("invalid asset filename")
    path = ws_uploads_dir(ws) / filename
    if path.is_symlink():
        raise NativeAssetError("unsafe asset path")
    return path


def asset_ref(filename: str) -> str:
    """The canonical URL of a stored native asset."""
    return f"/api/assets/{filename}"


def store_asset(ws: str, contents: bytes, ext: str) -> tuple[str, bool]:
    """Store bytes as ``<sha256>.<ext>`` in the workspace, atomically.

    Returns ``(filename, already_existed)``. Content addressing makes a retry
    free: the same bytes are the same file, so quota and the per-file cap only
    gate genuinely new ones. The write goes to a temp file in the uploads
    directory and is renamed into place after fsync, so a reader never sees a
    partial asset and a crash cannot leave a truncated one under a name that
    claims to be its digest.

    The whole check-and-publish runs under the workspace's ``pages.db`` write
    lock, which serializes quota accounting and publication across workers.
    Re-storing an existing asset updates its mtime for bookkeeping. Native
    assets are retained independently of age so offline retries remain safe."""
    uploads = ws_uploads_dir(ws)
    uploads.mkdir(parents=True, exist_ok=True)
    filename = f"{hashlib.sha256(contents).hexdigest()}.{ext}"
    target = asset_path(ws, filename)
    with connect_pages_db(ws) as conn:
        conn.execute("BEGIN IMMEDIATE")
        existed = target.is_file()
        if not existed:
            check_upload_allowed(ws, len(contents))
            fd, temp = tempfile.mkstemp(prefix=NATIVE_ASSET_TEMP_PREFIX, dir=target.parent)
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
            os.utime(target, None)
        conn.commit()
    return filename, existed


def asset_bytes(ws: str, filename: str) -> bytes | None:
    """The stored bytes of ``filename``, or None when there is no such asset."""
    try:
        path = asset_path(ws, filename)
    except NativeAssetError:
        return None
    return path.read_bytes() if path.is_file() else None


def replay_source_digest(asset_url: str) -> str:
    """The 64-hex digest a replay document must carry for ``asset_url`` — the
    stem of the ink asset it animates."""
    return str(asset_url).rsplit("/", 1)[-1].split(".", 1)[0]


def load_replay(ws: str, asset_url: str) -> "ReplayAsset":
    """Validate the stored ``.inkjson`` behind ``asset_url``.

    Raises :class:`NativeAssetMissing` when there is no such file and
    :class:`NativeAssetInvalid` for unreadable JSON or a schema violation, so no
    endpoint ever stores a replay reference it has not read."""
    filename = str(asset_url).rsplit("/", 1)[-1]
    raw = asset_bytes(ws, filename)
    if raw is None:
        raise NativeAssetMissing("replay asset not found; upload assets before saving")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise NativeAssetInvalid("invalid ink replay asset")
    try:
        return ReplayAsset.model_validate(data)
    except Exception:
        raise NativeAssetInvalid("invalid ink replay asset")


def is_canonical_uuid(value) -> bool:
    """True when ``value`` is a canonical lowercase UUID string."""
    try:
        return str(UUID(str(value))) == value
    except (ValueError, AttributeError, TypeError):
        return False


# --- reserved native properties ----------------------------------------------

_INK_RESERVED = frozenset({
    "type", "ink_asset", "preview_asset", "replay_asset", "ink_revision",
    "bounds", "crop_box", "coordinate_space", "pdf_page",
})
_AUDIO_RESERVED = frozenset({
    "type", "audio_revision", "audio_state", "segments", "duration", "replay_events",
})
_NOTE_RESERVED = frozenset({"native_note", "note_revision"})

INK_RESERVED = _INK_RESERVED
AUDIO_RESERVED = _AUDIO_RESERVED
NOTE_RESERVED = _NOTE_RESERVED
NATIVE_TYPE_VALUES = frozenset({"pdf_ink", "audio"})

# Properties no generic writer may introduce on a block that is not already
# native: they exist only to describe a native payload, so a client inventing
# one would be claiming bytes and a revision the server never recorded.
# ``type`` (only its native values) and ``pdf_page`` are handled separately —
# both are ordinary upstream properties for other kinds of block.
NATIVE_RESERVED_INSERT = frozenset(
    (_INK_RESERVED | _AUDIO_RESERVED | _NOTE_RESERVED) - {"type", "pdf_page"}
)

# The endpoint that owns each native payload, named in the refusal so a client
# that hits the rule knows where the write belongs instead.
NATIVE_ENDPOINT = {
    "ink": "PUT /api/blocks/{id}/ink",
    "audio": "PUT /api/blocks/{id}/audio",
    "note": "PUT /api/blocks/{id}/note",
}


def native_kind(props: dict | None) -> str | None:
    """``"ink"`` / ``"audio"`` / ``None`` for a stored properties dict."""
    if not isinstance(props, dict):
        return None
    if props.get("native_note") is True:
        return "note"
    kind = props.get("type")
    if kind == "pdf_ink":
        return "ink"
    if kind == "audio":
        return "audio"
    return None


def reserved_keys(props: dict | None) -> frozenset:
    """The keys a generic writer must leave alone on this block."""
    kind = native_kind(props)
    if kind == "ink":
        return _INK_RESERVED
    if kind == "audio":
        return _AUDIO_RESERVED
    if kind == "note":
        return _NOTE_RESERVED
    return frozenset()


def guard_generic_update(props: dict | None, patch: dict | None) -> None:
    """Refuse a generic ``set.props`` patch that touches a reserved key.

    Deletion counts: a patch of ``{"ink_asset": None}`` would otherwise drop the
    native payload as surely as overwriting it. Raises
    :class:`NativeScopeError` (the block writer maps it to 409)."""
    if not patch:
        return
    kind = native_kind(props)
    keys = reserved_keys(props)
    if keys:
        hit = sorted(set(patch) & keys)
        if hit:
            raise NativeScopeError(
                f"{', '.join(hit)} describe a native {kind} payload; "
                f"{NATIVE_ENDPOINT[kind]} owns them")
        return
    hit = sorted(set(patch) & NATIVE_RESERVED_INSERT)
    if props is not None and patch.get("type") in NATIVE_TYPE_VALUES:
        hit.append("type")
    if hit:
        raise NativeScopeError(
            f"{', '.join(sorted(set(hit)))} describe a native payload — create it "
            "through the native ink/audio/note endpoints, or copy it there")


def native_claim_keys(props: dict | None) -> list[str]:
    """The reserved keys — and a native ``type`` — this properties dict claims.

    The one definition of "this block is claiming a native payload", shared by
    the insert guard below and by the block writer's restore check, so a
    properties dict that claims nothing never reaches the log lookup a restore
    needs (and ``guard_generic_insert`` and that check cannot drift apart)."""
    props = props or {}
    hit = set(props) & NATIVE_RESERVED_INSERT
    if props.get("type") in NATIVE_TYPE_VALUES:
        hit.add("type")
    return sorted(hit)


def guard_generic_insert(props: dict | None) -> None:
    """Refuse generic creation of a block that claims a native payload.

    Copying an annotation is a native write (a new UUID, the same assets, its
    own revision); a generic insert that carried the fields over would mint a
    block claiming a recorded payload the server never validated. Undoing a
    deletion is the exception, and it is not decided here: the block writer
    checks the page's own record of that deletion first
    (``restored_native_properties``)."""
    hit = native_claim_keys(props)
    if hit:
        raise NativeScopeError(
            f"{', '.join(hit)} describe a native payload — create it "
            "through the native ink/audio/note endpoints, or copy it there")


def restored_native_properties(snapshot: dict | None, new_props: dict | None,
                               new_content: str | None = None) -> dict:
    """The properties a generic insert stores when it RESTORES a block the
    server itself recorded as deleted — the Web's Ctrl+Z, and the one exception
    to ``guard_generic_insert`` below.

    ``snapshot`` is the provenance that deletion left in the page's own op log
    (``gamma/ops.py``, ``_recorded_deletion``): the id, its text and the
    properties it had when it went. A restore is not a second create path:

    - the writer must reproduce the recorded native payload EXACTLY — every key
      of the recorded kind's reserved set is compared (parsed values, so a float
      written ``1e-05`` by one client and ``0.00001`` by another is the same
      number), and any missing, different or invented reserved key refuses the
      insert. A queued offline save, a stale Web tree or a hand-written request
      therefore cannot turn a deletion into a new annotation, a new asset set or
      a revision nobody recorded;
    - the RECORDED properties are what gets stored, so ``ink_revision`` /
      ``audio_revision`` / ``note_revision`` resume exactly where they stopped
      and the iPad's CAS and outbox expectations keep working. Unrelated
      properties are the record's too — a restore is the server's last state for
      that block, so a stale copy cannot rewrite a colour or drop a key that
      another client set before the deletion;
    - the only thing the writer keeps is a caption: text on ink and audio is
      ordinary note text, editable on a live block too (the same rule as
      ``preserve_native_properties``), so it stays the writer's. A native note's
      text IS its payload, so there it has to match the recorded text; a
      genuinely new note belongs on ``PUT /api/blocks/{id}/note``, which has a
      revision CAS of its own.

    Raises :class:`NativeScopeError` for a snapshot that is not a native
    deletion, a manifest that does not match it, or a native note whose text
    differs (the block writer maps all three to 409)."""
    recorded = snapshot.get("properties") if isinstance(snapshot, dict) else None
    if not isinstance(recorded, dict) or native_kind(recorded) is None:
        raise NativeScopeError("block id has no recorded native deletion to restore")
    kind = native_kind(recorded)
    incoming = new_props if isinstance(new_props, dict) else {}
    mismatch = sorted(key for key in reserved_keys(recorded)
                      if incoming.get(key) != recorded.get(key))
    if mismatch:
        raise NativeScopeError(
            f"{', '.join(mismatch)} do not match the deleted native {kind} payload — "
            "a restore reproduces it exactly, and a new annotation belongs on "
            f"{NATIVE_ENDPOINT[kind]}")
    if kind == "note" and (new_content or "") != (snapshot.get("content") or ""):
        raise NativeScopeError(
            "a native note's text is its own payload — restoring it must reproduce "
            "the deleted text, and writing a different one belongs on "
            f"{NATIVE_ENDPOINT['note']}")
    return dict(recorded)


def preserve_native_properties(previous_props: dict | None, previous_content: str | None,
                               new_props: dict | None, new_content: str | None) -> dict:
    """The properties a bulk subtree write must store for a block that already
    has native state.

    ``PUT /api/blocks/{id}/children`` replaces a subtree wholesale from a
    client's copy of it, which is exactly how a stale Web autosave would roll
    back a recording: the copy it sends carries whatever native fields it last
    saw. The recorded payload wins over anything the writer sends, while text,
    children and unrelated properties stay the writer's. A native note's
    revision advances when its text really changes, so a queued offline note
    save still detects the conflict."""
    previous = previous_props or {}
    incoming = dict(new_props or {})
    keys = reserved_keys(previous)
    if not keys:
        # A block with no native state stays ordinary: it may not acquire one
        # through a bulk write.
        guard_generic_insert(incoming)
        return incoming
    for key in keys:
        if key in previous:
            incoming[key] = previous[key]
        else:
            incoming.pop(key, None)
    if previous.get("native_note") is True:
        revision = previous.get("note_revision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise NativeScopeError("native note revision state is invalid")
        incoming["native_note"] = True
        incoming["note_revision"] = revision + 1 if (new_content or "") != (previous_content or "") else revision
    return incoming


def note_revision_bump(props: dict, new_content: str, old_content: str) -> int:
    """The ``note_revision`` a generic text edit of a native note produces.

    Every content change to a native note has to move the revision, or a queued
    offline save would pass its ``expected_revision`` check and overwrite the
    Web edit. Raises :class:`NativeScopeError` for a corrupt revision."""
    revision = props.get("note_revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise NativeScopeError("native note revision state is invalid")
    return revision + 1 if new_content != old_content else revision


# --- payloads -----------------------------------------------------------------


class ReplayPoint(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    x: float
    y: float
    t: float = Field(ge=0)
    radius: float = Field(gt=0)


class ReplayBounds(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class ReplayStroke(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=256)
    bounds: ReplayBounds
    png: str
    points: list[ReplayPoint] = Field(min_length=1)
    # Decoded pixel count, summed against the budget by ReplayAsset.
    _decoded_pixels: int = PrivateAttr(default=0)

    @model_validator(mode="after")
    def validate_png_and_points(self):
        times = [point.t for point in self.points]
        if any(a > b for a, b in zip(times, times[1:])):
            raise ValueError("stroke points must have monotonic t")
        if self.png.startswith("data:"):
            raise ValueError("PNG must not be a data URL")
        try:
            raw = base64.b64decode(self.png.encode("ascii"), validate=True)
            width, height = png_dimensions(raw)
        except (UnicodeEncodeError, ValueError, binascii.Error):
            raise ValueError("png must be a valid PNG")
        if width > _REPLAY_MAX_PNG_DIMENSION or height > _REPLAY_MAX_PNG_DIMENSION:
            raise ValueError("PNG dimensions exceed limit")
        self._decoded_pixels = width * height
        return self


class ReplayAsset(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    format: Literal["gamma-ink-replay-v1"]
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    width: float = Field(gt=0, le=100000)
    height: float = Field(gt=0, le=100000)
    strokes: list[ReplayStroke] = Field(max_length=_REPLAY_MAX_STROKES)

    @model_validator(mode="after")
    def validate_replay(self):
        points = 0
        pixels = 0
        for stroke in self.strokes:
            points += len(stroke.points)
            if (stroke.bounds.x + stroke.bounds.width > self.width + _REPLAY_EPSILON
                    or stroke.bounds.y + stroke.bounds.height > self.height + _REPLAY_EPSILON):
                raise ValueError("stroke bounds must lie within page")
            pixels += stroke._decoded_pixels
        if points > _REPLAY_MAX_POINTS:
            raise ValueError("too many replay points")
        if pixels > _REPLAY_MAX_PIXELS:
            raise ValueError("too many decoded PNG pixels")
        return self


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
    replay_asset: str | None = None
    bounds: InkBounds
    crop_box: CropBox
    coordinate_space: Literal["pdf-crop-top-left-v1"] = "pdf-crop-top-left-v1"
    expected_revision: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode="after")
    def validate_geometry(self):
        b, c = self.bounds, self.crop_box
        if b.x + b.width > c.width + _REPLAY_EPSILON or b.y + b.height > c.height + _REPLAY_EPSILON:
            raise ValueError("bounds must lie within crop_box")
        for ref, ext in ((self.ink_asset, ".pkdrawing"), (self.preview_asset, ".png")):
            if not ASSET_REF_RE.fullmatch(ref) or not ref.endswith(ext):
                raise ValueError(f"expected a local {ext} asset URL")
        if self.replay_asset is not None and not REPLAY_REF_RE.fullmatch(self.replay_asset):
            raise ValueError("expected a local .inkjson asset URL")
        return self


class ReplayPreviewSave(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ink_asset: str
    replay_asset: str

    @model_validator(mode="after")
    def validate_refs(self):
        if not DRAWING_REF_RE.fullmatch(self.ink_asset):
            raise ValueError("expected a local PKDrawing asset URL")
        if not REPLAY_REF_RE.fullmatch(self.replay_asset):
            raise ValueError("expected a local .inkjson asset URL")
        return self


class AudioSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str
    asset: str
    duration: float = Field(gt=0, le=_AUDIO_MAX_SECONDS)


class ReplayEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str
    kind: Literal["stroke", "page", "note"]
    segment_id: str
    start: float = Field(ge=0, le=_AUDIO_MAX_SECONDS)
    end: float = Field(ge=0, le=_AUDIO_MAX_SECONDS)
    pdf_page: int = Field(gt=0, strict=True)
    block_id: str | None = None
    stroke_id: str | None = None

    @model_validator(mode="after")
    def validate_event(self):
        for name, value in (("id", self.id), ("segment_id", self.segment_id)):
            if not is_canonical_uuid(value):
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
    segments: list[AudioSegment] = Field(default_factory=list, max_length=_AUDIO_MAX_SEGMENTS)
    replay_events: list[ReplayEvent] | None = Field(default=None, max_length=_REPLAY_MAX_EVENTS)

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


class NativeNoteSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_id: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=_NOTE_MAX_CONTENT)
    expected_revision: int | None = Field(default=None, ge=0, strict=True)

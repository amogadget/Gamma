"""Uploaded-file helpers: media types, content-hash storage, lookup, orphan
cleanup."""

import re
import time
import hashlib
import urllib.parse
from pathlib import Path

from . import pdf_meta
from .db import ws_uploads_dir
from .server_settings import check_upload_allowed

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
IMAGE_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg"}
IMAGE_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}

# Generic (non-image, non-PDF) files blocks reference as
# ``[name](/api/uploads/<hash>.<ext>)`` file blocks. POST /api/upload-file
# takes ANY extension except BLOCKED_EXTENSIONS (a lab shares notebooks, data
# files, packages — an allowlist can never be complete); this table only picks
# a better media type than ``application/octet-stream`` for the common ones.
# Everything outside INLINE_EXTENSIONS is served as a download anyway.
FILE_MEDIA_TYPES = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json",
    ".ink": "application/json",   # handwriting groups (gamma/ink.py)
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".toml": "application/toml",
    ".xml": "application/xml",
    ".tex": "application/x-tex",
    ".bib": "application/x-bibtex",
    ".py": "text/x-python; charset=utf-8",
    ".ipynb": "application/x-ipynb+json",
    ".nb": "application/mathematica",
    ".m": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tgz": "application/gzip",
    ".tar": "application/x-tar",
    ".7z": "application/x-7z-compressed",
    ".whl": "application/zip",
    ".h5": "application/x-hdf5",
    ".hdf5": "application/x-hdf5",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
}
# Files an OS runs as code when opened — the one kind Gamma refuses to host,
# on upload and (belt and braces) on serving. Archives and package formats
# (zip, whl, dmg, deb …) are fine: a lab shares software.
BLOCKED_EXTENSIONS = {
    ".exe", ".com", ".scr", ".pif", ".bat", ".cmd", ".msi", ".msix", ".appx",
    ".dll", ".cpl", ".sys", ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".hta",
    ".ps1", ".psm1", ".reg", ".lnk", ".jar", ".app",
}
# A stored extension is ``.`` + 1-12 lowercase letters/digits; a name with
# none (or an odd one) is stored as ``.bin``.
EXTENSION_RE = re.compile(r"^\.[a-z0-9]{1,12}$")
# Served inline (rendered by the browser on navigation); everything else gets
# ``Content-Disposition: attachment``. An SVG opened as a top-level document
# would run its inline <script> in this origin (stored XSS), so it downloads
# like html — <img>/<object> embedding still works, inline note images are
# unaffected. SANDBOXED_EXTENSIONS additionally get a sandboxing CSP in case
# a browser renders them anyway.
INLINE_EXTENSIONS = {".pdf", ".txt", ".md", *(e for e in IMAGE_MEDIA_TYPES if e != ".svg")}
SANDBOXED_EXTENSIONS = {".svg", ".html"}


def upload_media_type(ext: str) -> str | None:
    """Media type for a stored upload's extension (lowercase, with the dot),
    or None when Gamma never stores that kind of file (blocked, malformed).
    Unknown but well-formed extensions are ``application/octet-stream``."""
    if ext == ".pdf":
        return "application/pdf"
    if ext in BLOCKED_EXTENSIONS or not EXTENSION_RE.match(ext):
        return None
    return IMAGE_MEDIA_TYPES.get(ext) or FILE_MEDIA_TYPES.get(ext) or "application/octet-stream"


def upload_extension(name: str) -> str:
    """The stored extension for an uploaded file name: its last suffix,
    lowercased (``Data.CSV`` → ``.csv``; ``pkg.tar.gz`` → ``.gz``, the full
    name stays in the link text), ``.bin`` when there is none or it is
    malformed. Raises ValueError for BLOCKED_EXTENSIONS."""
    dot = name.rfind(".")
    ext = name[dot:].lower() if dot > 0 else ""
    if ext in BLOCKED_EXTENSIONS:
        raise ValueError(f"{ext} files are not accepted (executable)")
    return ext if EXTENSION_RE.match(ext) else ".bin"


# Upload filenames are the content sha256 truncated to this many hex chars
# (long enough that collisions stay theoretical, short enough to read in logs).
DIGEST_CHARS = 24

# Native (iPad) assets — ink drawings, previews, replay timelines, recordings —
# share the workspace uploads directory (so quota, backups and exports cover
# them for free) but keep their FULL sha256 name: a replay document names its
# source drawing by digest, and the native client computes that digest itself
# (gamma/native_ink.py). The 64-hex stem cannot collide with the 24-hex names
# every other upload route mints, which is what lets /api/uploads and
# /api/assets be interchangeable for these files.
NATIVE_ASSET_NAME_RE = re.compile(r"^[0-9a-f]{64}\.(?:pkdrawing|png|m4a|inkjson)$")
# A native asset is uploaded BEFORE the block that references it exists (the
# client persists the payload, then uploads, then saves the block), and a
# recording's replay timeline can be generated long after. There is no finite
# age that proves all offline clients have finished referencing these bytes.
# Native assets are therefore excluded from automatic garbage collection,
# including old unreferenced sources; they still count toward storage quotas.
# In-flight atomic writes. Sweeping one would break a concurrent store, so the
# prefix is reserved and never cleaned up here.
NATIVE_ASSET_TEMP_PREFIX = ".ink-"


def display_filename(name: str, fallback: str = "") -> str:
    """A browser-supplied upload name reduced to one display-only leaf.

    Directory pickers may put a relative path in the multipart filename on
    some browsers. Folder placement is carried separately, so neither POSIX
    nor Windows separators belong in a page title or original_filename.
    """
    raw = str(name or "").replace("\x00", "").strip().replace("\\", "/")
    leaf = raw.rsplit("/", 1)[-1].strip()
    return (leaf or fallback)[:500]


def url_filename(url: str) -> str:
    """The display name a URL suggests for the file behind it: its last path
    segment, unquoted, without query or fragment — "" when the URL has no
    path (a bare host). Reduced through :func:`display_filename`."""
    parts = urllib.parse.urlsplit(str(url or "").strip())
    tail = urllib.parse.unquote(parts.path.rstrip("/").split("/")[-1]).strip()
    return display_filename(tail)


def is_pdf(data: bytes) -> bool:
    return len(data) >= 4 and data[:4] == b"%PDF"


def content_digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:DIGEST_CHARS]


def store_pdf(ws: str, data: bytes) -> tuple[str, str, bool]:
    """Store PDF bytes under their content hash in the workspace (callers
    validate with :func:`is_pdf` first). Returns ``(doc_id, source_url,
    already_existed)``. Dedup first: a re-upload of a stored file adds no
    bytes, so the storage limits only gate genuinely new ones
    (check_upload_allowed raises 413/507 past them)."""
    uploads = ws_uploads_dir(ws)
    uploads.mkdir(parents=True, exist_ok=True)
    doc_id = content_digest(data)
    target = uploads / f"{doc_id}.pdf"
    already_existed = target.exists()
    if not already_existed:
        check_upload_allowed(ws, len(data))
        target.write_bytes(data)
    pdf_meta.schedule(ws, doc_id)  # the viewer's manifest, ready before the first open
    return doc_id, f"/api/uploads/{doc_id}.pdf", already_existed


def store_file(ws: str, data: bytes, ext: str) -> tuple[str, bool]:
    """Store any upload under its content hash as ``<sha24><ext>`` (``ext``
    lowercase with the dot, already validated by the caller). Returns
    ``(filename, already_existed)``; storage limits gate new bytes only."""
    uploads = ws_uploads_dir(ws)
    uploads.mkdir(parents=True, exist_ok=True)
    filename = f"{content_digest(data)}{ext}"
    target = uploads / filename
    already_existed = target.exists()
    if not already_existed:
        check_upload_allowed(ws, len(data))
        target.write_bytes(data)
    return filename, already_existed


def find_upload_file(filename: str, ws: str) -> Path | None:
    """The uploaded file `filename` in the workspace's uploads dir, or None.

    Deliberately scoped to the single named workspace — the caller resolves
    which (the session's workspace or a validated share's). No cross-workspace
    fallback: that would let anyone read any file by guessing a content hash.
    """
    if not ws:
        return None
    try:
        path = ws_uploads_dir(ws) / filename
    except ValueError:
        return None
    return path if path.is_file() else None


UPLOAD_GRACE_S = 15 * 60


def cleanup_orphan_uploads(conn, uploads_dir: Path):
    """Delete files in uploads_dir that are no longer referenced by any block
    in conn. Extension-agnostic: a file survives when its stem is some page's
    ``doc_id`` (the PDF attachment) or any block's content/properties mention
    ``/api/uploads/<filename>`` or ``/api/assets/<filename>`` (images, generic
    file chips, native ink/audio assets — both URL forms are checked because
    native assets are reachable under either prefix).

    Ordinary files younger than ``UPLOAD_GRACE_S`` are staged (upload then
    attach). Native assets (``NATIVE_ASSET_NAME_RE``) are NEVER auto-deleted:
    an unreferenced file may belong to an offline outbox or retained source
    version, and age cannot prove that it is disposable. Reclamation requires
    a separate explicit administrative action, not startup or a block edit.
    This conservative policy may increase storage usage; quota still applies.
    Atomic-write temporaries (``NATIVE_ASSET_TEMP_PREFIX``) are never swept.
    """
    if not uploads_dir.exists():
        return []
    removed = []
    now = time.time()
    for f in uploads_dir.iterdir():
        if not f.is_file() or f.name.startswith(NATIVE_ASSET_TEMP_PREFIX):
            continue
        try:
            age = now - f.stat().st_mtime
        except OSError:
            continue
        if age < UPLOAD_GRACE_S:
            continue
        if NATIVE_ASSET_NAME_RE.fullmatch(f.name):
            continue
        filename = f.name
        stem = f.stem
        ref = conn.execute(
            "SELECT 1 FROM unified_blocks "
            "WHERE json_extract(properties, '$.doc_id') = ? "
            "   OR content LIKE ? "
            "   OR properties LIKE ? "
            "   OR content LIKE ? "
            "   OR properties LIKE ? "
            "LIMIT 1",
            (stem, f"%/api/uploads/{filename}%", f"%/api/uploads/{filename}%",
             f"%/api/assets/{filename}%", f"%/api/assets/{filename}%"),
        ).fetchone()
        if not ref:
            try:
                f.unlink()
                removed.append(filename)
            except OSError:
                pass
    return removed

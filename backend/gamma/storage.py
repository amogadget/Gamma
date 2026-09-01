"""Uploaded-file helpers: media types, lookup, orphan cleanup."""

from pathlib import Path

from .db import user_uploads_dir

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
}
IMAGE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}


def display_filename(name: str, fallback: str = "") -> str:
    """A browser-supplied upload name reduced to one display-only leaf.

    Directory pickers may put a relative path in the multipart filename on
    some browsers. Folder placement is carried separately, so neither POSIX
    nor Windows separators belong in a page title or original_filename.
    """
    raw = str(name or "").replace("\x00", "").strip().replace("\\", "/")
    leaf = raw.rsplit("/", 1)[-1].strip()
    return (leaf or fallback)[:500]


def find_upload_file(filename: str, user: str) -> Path | None:
    """The uploaded file `filename` in `user`'s uploads dir, or None.

    Deliberately scoped to the single named user — the caller resolves who that
    is (session user or a validated share owner). No cross-user fallback: that
    let anyone read any account's files by guessing a content hash.
    """
    if not user:
        return None
    try:
        path = user_uploads_dir(user) / filename
    except ValueError:
        return None
    return path if path.is_file() else None


def cleanup_orphan_uploads(conn, uploads_dir: Path):
    """Delete files in uploads_dir that are no longer referenced by any block in conn."""
    if not uploads_dir.exists():
        return []
    removed = []
    for f in uploads_dir.iterdir():
        if not f.is_file():
            continue
        filename = f.name
        stem = f.stem
        ref = conn.execute(
            "SELECT 1 FROM unified_blocks "
            "WHERE json_extract(properties, '$.doc_id') = ? "
            "   OR content LIKE ? "
            "   OR properties LIKE ? "
            "LIMIT 1",
            (stem, f"%/api/uploads/{filename}%", f"%/api/uploads/{filename}%"),
        ).fetchone()
        if not ref:
            try:
                f.unlink()
                removed.append(filename)
            except OSError:
                pass
    return removed

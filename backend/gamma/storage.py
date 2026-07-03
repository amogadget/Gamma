"""Uploaded-file helpers: media types, lookup, orphan cleanup."""

from pathlib import Path

from fastapi import Request

from .config import USERS_DIR

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
IMAGE_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg"}
IMAGE_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}


def find_upload_file(filename: str, request: Request) -> Path | None:
    """Search for an uploaded file. Checks session user first, then ?user= param, then all users."""
    user = request.state.user
    if user:
        path = USERS_DIR / user / "uploads" / filename
        if path.is_file():
            return path
    param_user = request.query_params.get("user")
    if param_user:
        path = USERS_DIR / param_user / "uploads" / filename
        if path.is_file():
            return path
    # Fallback: search all user directories (for shared links without ?user=)
    if USERS_DIR.exists():
        for d in USERS_DIR.iterdir():
            if d.is_dir():
                path = d / "uploads" / filename
                if path.is_file():
                    return path
    return None


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

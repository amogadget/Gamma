"""Storage limits admins edit at runtime, and their enforcement.

Two layers, both in users.db (unlike config.py's env vars, which are fixed at
process start):
  - server-wide defaults in the `settings` KV: per-file upload cap and total
    storage quota per account;
  - per-user overrides in nullable `users` columns (NULL = inherit default).

`user_limits()` resolves the effective pair for an account; a missing or
corrupt value can never break request handling — it falls back to the
default. Quota 0 means unlimited.

What a workspace's uploads are checked against (`workspace_quota`):
  - a PERSONAL workspace: its account's limits, and the account's usage is
    the uploads/ of all its personal workspaces together — nothing anyone
    puts into a shared workspace counts against a person;
  - a SHARED workspace: the server-wide per-file cap and the workspace's own
    `workspaces.quota_mb` (NULL = unlimited), which admins set.
The databases are not metered.
"""

from fastapi import HTTPException

from .config import MAX_UPLOAD_BYTES
from .db import connect_users_db, page_now, ws_uploads_dir

MB = 1024 * 1024
DEFAULT_MAX_UPLOAD_MB = MAX_UPLOAD_BYTES // MB
DEFAULT_QUOTA_MB = 0  # unlimited
# The guest workspace is shared and reachable by anyone on the internet, so it
# gets a bounded default quota (an admin can still override it per-account).
# Applied only when no explicit per-user override is set.
GUEST_DEFAULT_QUOTA_MB = 200
UPLOAD_MB_MIN, UPLOAD_MB_MAX = 1, 2048
QUOTA_MB_MIN, QUOTA_MB_MAX = 0, 1024 * 1024  # 0 = unlimited, cap 1 TB


def validate_upload_mb(mb) -> int:
    mb = int(mb)
    if not UPLOAD_MB_MIN <= mb <= UPLOAD_MB_MAX:
        raise ValueError(f"upload limit must be {UPLOAD_MB_MIN}-{UPLOAD_MB_MAX} MB")
    return mb


def validate_quota_mb(mb) -> int:
    mb = int(mb)
    if not QUOTA_MB_MIN <= mb <= QUOTA_MB_MAX:
        raise ValueError(f"storage quota must be {QUOTA_MB_MIN}-{QUOTA_MB_MAX} MB (0 = unlimited)")
    return mb


def _parse(raw, default: int, lo: int, hi: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if lo <= value <= hi else default


def _set_raw(key: str, value: str) -> None:
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, value, page_now()),
        )
        conn.commit()


def _defaults(conn) -> tuple[int, int]:
    rows = dict(conn.execute("SELECT key, value FROM settings WHERE key IN ('max_upload_mb', 'quota_mb')"))
    return (_parse(rows.get("max_upload_mb"), DEFAULT_MAX_UPLOAD_MB, UPLOAD_MB_MIN, UPLOAD_MB_MAX),
            _parse(rows.get("quota_mb"), DEFAULT_QUOTA_MB, QUOTA_MB_MIN, QUOTA_MB_MAX))


def get_defaults() -> dict:
    with connect_users_db() as conn:
        upload_mb, quota_mb = _defaults(conn)
    return {"max_upload_mb": upload_mb, "quota_mb": quota_mb}


def set_default_max_upload_mb(mb: int) -> None:
    _set_raw("max_upload_mb", str(validate_upload_mb(mb)))


def set_default_quota_mb(mb: int) -> None:
    _set_raw("quota_mb", str(validate_quota_mb(mb)))


def user_limits(username: str) -> dict:
    """Effective limits for an account: per-user override, else server default."""
    with connect_users_db() as conn:
        default_upload, default_quota = _defaults(conn)
        row = conn.execute("SELECT max_upload_mb, quota_mb FROM users WHERE username = ?",
                           (username,)).fetchone()
    upload_override = row[0] if row else None
    quota_override = row[1] if row else None
    # Guest falls back to a bounded quota rather than the (often unlimited)
    # server default, unless an admin has set an explicit override.
    if username == "guest" and quota_override is None and default_quota == 0:
        default_quota = GUEST_DEFAULT_QUOTA_MB
    return {
        "max_upload_mb": _parse(upload_override, default_upload, UPLOAD_MB_MIN, UPLOAD_MB_MAX),
        "quota_mb": _parse(quota_override, default_quota, QUOTA_MB_MIN, QUOTA_MB_MAX),
    }


def workspace_bytes(ws: str) -> int:
    """Upload bytes stored in one workspace."""
    try:
        uploads = ws_uploads_dir(ws)
    except ValueError:
        return 0
    if not uploads.exists():
        return 0
    return sum(f.stat().st_size for f in uploads.iterdir() if f.is_file())


def usage_bytes(username: str) -> int:
    """Upload bytes that count against an account: its personal workspaces."""
    from . import workspaces  # local: workspaces imports seed → db

    return sum(workspace_bytes(ws) for ws in workspaces.personal_workspaces(username))


def workspace_quota(ws: str) -> dict:
    """The limits and usage that apply to uploads into ``ws``:
    ``{max_upload_mb, quota_mb, used_bytes, workspace_bytes, account}`` —
    ``account`` is the person whose limits these are (a personal
    workspace), "" for a shared workspace under its own quota."""
    from . import workspaces

    used = workspace_bytes(ws)
    owner = workspaces.personal_owner(ws)
    if owner:
        return {**user_limits(owner), "used_bytes": usage_bytes(owner), "workspace_bytes": used, "account": owner}
    info = workspaces.get(ws) or {}
    with connect_users_db() as conn:
        default_upload, _default_quota = _defaults(conn)
    return {"max_upload_mb": default_upload,
            "quota_mb": _parse(info.get("quota_mb"), 0, QUOTA_MB_MIN, QUOTA_MB_MAX),
            "used_bytes": used, "workspace_bytes": used, "account": ""}


def check_upload_allowed(ws: str, nbytes: int) -> None:
    """Hard gate for explicit uploads into a workspace: 413 over the
    per-file cap, 507 over the quota that applies (``workspace_quota``).

    Callers should skip this when the content hash already exists on disk —
    re-uploading a stored file costs nothing, so it is always allowed.
    """
    limits = workspace_quota(ws)
    if nbytes > limits["max_upload_mb"] * MB:
        raise HTTPException(status_code=413, detail=f"file too large (max {limits['max_upload_mb']} MB)")
    quota = limits["quota_mb"]
    if quota:
        used = limits["used_bytes"]
        if used + nbytes > quota * MB:
            raise HTTPException(
                status_code=507,
                detail=f"storage quota exceeded ({used // MB} of {quota} MB used — "
                       f"this file needs {max(1, nbytes // MB)} MB more)")


def can_store(ws: str, nbytes: int) -> bool:
    """Soft gate for best-effort caches (external-PDF save, AI re-download):
    same rules as check_upload_allowed, but the caller just skips the save."""
    try:
        check_upload_allowed(ws, nbytes)
        return True
    except HTTPException:
        return False

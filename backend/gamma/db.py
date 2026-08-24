"""SQLite helpers: schema, connections, per-user paths, timestamps."""

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import USERS_DB, USERS_DIR


def page_now() -> str:
    # UTC ISO string with Z suffix so clients parse it correctly.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


# Identifiers that become a single path segment. Both exclude '/' and '\', so a
# validated value can never introduce a path separator; '.'/'..' are rejected
# outright so they can't climb out of the user's directory either. These guard
# every filesystem path built from a username or doc id — the last line of
# defense against traversal even after upstream auth checks.
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_DOC_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


def safe_username(username: str) -> str:
    if not isinstance(username, str) or username in (".", "..") or not _USERNAME_RE.match(username):
        raise ValueError(f"unsafe username: {username!r}")
    return username


def safe_doc_id(doc_id: str) -> str:
    if not isinstance(doc_id, str) or doc_id in (".", "..") or not _DOC_ID_RE.match(doc_id):
        raise ValueError(f"unsafe doc id: {doc_id!r}")
    return doc_id


USERS_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        is_guest INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
        max_upload_mb INTEGER,
        quota_mb INTEGER,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username),
        guest_date TEXT,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS shares (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
    # Server-wide admin-tunable settings (see gamma/server_settings.py) — a
    # tiny KV, global because limits like upload size apply to every user.
    """CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
]

PAGES_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS unified_blocks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES unified_blocks(id),
        position TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        properties TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_ub_parent ON unified_blocks(parent_id, position)",
]

# data.db = derived / regenerable data (chats, the pdf_fts search index which
# is created lazily by routers/search.py). Old installs may still carry the
# legacy `annotations` and per-user `shares` tables — harmless leftovers.
# prefs = small JSON UI state synced across browsers (open tabs, ...) — no
# secrets: data.db is included verbatim in /api/export backups.
DATA_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS chats (block_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
]


def connect_data_db(username: str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(USERS_DIR / username / "data.db"))
    for stmt in DATA_SCHEMA:
        conn.execute(stmt)
    return conn


def get_pref(username: str, key: str):
    """(value, updated_at) from the user's prefs KV store, or (None, "") when unset."""
    with connect_data_db(username) as db:
        row = db.execute("SELECT value, updated_at FROM prefs WHERE key = ?", (key,)).fetchone()
    if not row:
        return None, ""
    try:
        return json.loads(row[0]), row[1]
    except ValueError:
        return None, ""


def set_pref(username: str, key: str, value) -> str:
    """Store a pref (last write wins); returns the new updated_at."""
    now = page_now()
    with connect_data_db(username) as db:
        db.execute(
            "INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, json.dumps(value), now),
        )
        db.commit()
    return now


def connect_users_db() -> sqlite3.Connection:
    """Open the global users.db, creating the schema if needed."""
    USERS_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(USERS_DB))
    for stmt in USERS_SCHEMA:
        conn.execute(stmt)
    # Lazy upgrades for databases created before these columns existed.
    # (The auth middleware connects directly, so this must run before requests
    # do — app startup calls connect_users_db() once, which covers it.)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
    if "is_admin" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    if "max_upload_mb" not in cols:
        # per-user storage-limit overrides; NULL = inherit the server default
        conn.execute("ALTER TABLE users ADD COLUMN max_upload_mb INTEGER")
        conn.execute("ALTER TABLE users ADD COLUMN quota_mb INTEGER")
    conn.commit()
    return conn


def user_db_path(username: str, db_name: str) -> str:
    return str(USERS_DIR / safe_username(username) / db_name)


def user_uploads_dir(username: str) -> Path:
    return USERS_DIR / safe_username(username) / "uploads"


def pdf_upload_path(username: str, doc_id: str) -> Path:
    """Validated path to a document's stored PDF. Use instead of joining an
    untrusted doc id into a filename by hand."""
    return user_uploads_dir(username) / f"{safe_doc_id(doc_id)}.pdf"

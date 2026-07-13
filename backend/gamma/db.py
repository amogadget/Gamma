"""SQLite helpers: schema, connections, per-user paths, timestamps."""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import USERS_DB, USERS_DIR


def page_now() -> str:
    # UTC ISO string with Z suffix so clients parse it correctly.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


USERS_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        is_guest INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
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


def _connect_data_db(username: str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(USERS_DIR / username / "data.db"))
    for stmt in DATA_SCHEMA:
        conn.execute(stmt)
    return conn


def get_pref(username: str, key: str):
    """(value, updated_at) from the user's prefs KV store, or (None, "") when unset."""
    with _connect_data_db(username) as db:
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
    with _connect_data_db(username) as db:
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
    # Lazy upgrade for databases created before the admin privilege existed.
    # (The auth middleware connects directly, so this must run before requests
    # do — app startup calls connect_users_db() once, which covers it.)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
    if "is_admin" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    return conn


def user_db_path(username: str, db_name: str) -> str:
    return str(USERS_DIR / username / db_name)


def user_uploads_dir(username: str) -> Path:
    return USERS_DIR / username / "uploads"

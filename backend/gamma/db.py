"""SQLite helpers: schema, connections, per-user paths, timestamps."""

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
DATA_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS chats (block_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL)",
]


def connect_users_db() -> sqlite3.Connection:
    """Open the global users.db, creating the schema if needed."""
    USERS_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(USERS_DB))
    for stmt in USERS_SCHEMA:
        conn.execute(stmt)
    conn.commit()
    return conn


def user_db_path(username: str, db_name: str) -> str:
    return str(USERS_DIR / username / db_name)


def user_uploads_dir(username: str) -> Path:
    return USERS_DIR / username / "uploads"

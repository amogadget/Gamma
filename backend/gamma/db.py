"""SQLite helpers: schemas, connections, workspace paths, prefs, timestamps.

Two kinds of database (docs/dev/user_db.md):

- ``users.db`` — global: accounts, sessions, workspaces + memberships, page
  shares, personal prefs, server settings. Its ``PRAGMA user_version`` is
  the data directory's schema version (``SCHEMA_VERSION``); a data
  directory behind it is upgraded by ``gamma/migrations.py`` before the
  server serves anything, one ahead of it is refused.
- per workspace, under ``workspaces/<id>/``: ``pages.db`` (the block tree
  + op log) and ``data.db`` (chats, cover snapshots, the search indexes).
  These files carry no version: their statements are ``CREATE TABLE IF NOT
  EXISTS`` applied on every connect, and a restored backup is normalized
  by ``gamma/normalize.py`` when it is imported.

``USERS_SCHEMA`` is always the CURRENT shape. Older shapes are not patched
here on connect — that is what the numbered migration steps are for.
"""

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import USERS_DB, WORKSPACES_DIR

# The data-directory schema version this code expects (users.db
# ``PRAGMA user_version``). Bump it together with a new step in
# gamma/migrations.py — never without one, never without bumping.
SCHEMA_VERSION = 3


class SchemaOutdated(RuntimeError):
    """users.db is behind SCHEMA_VERSION: run the migrations first (the app
    does at startup; ``python manage.py migrate`` by hand)."""


def page_now() -> str:
    # UTC ISO string with Z suffix so clients parse it correctly.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


# Identifiers that become a single path segment. Both exclude '/' and '\', so
# a validated value can never introduce a path separator; '.'/'..' are
# rejected outright so they can't climb out of the data directory either.
# These guard every filesystem path built from a workspace id or doc id — the
# last line of defense against traversal even after upstream auth checks.
_WS_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DOC_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


def safe_ws_id(ws: str) -> str:
    """A workspace id names the directory workspaces/<id>/."""
    if not isinstance(ws, str) or not _WS_ID_RE.match(ws):
        raise ValueError(f"unsafe workspace id: {ws!r}")
    return ws


def safe_doc_id(doc_id: str) -> str:
    if not isinstance(doc_id, str) or doc_id in (".", "..") or not _DOC_ID_RE.match(doc_id):
        raise ValueError(f"unsafe doc id: {doc_id!r}")
    return doc_id


USERS_SCHEMA = [
    # default_workspace: the personal workspace created with the account —
    # where a request lands when it names no workspace (the browser
    # extension, older clients), and the one that cannot be left or deleted.
    """CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        is_guest INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
        max_upload_mb INTEGER,
        quota_mb INTEGER,
        default_workspace TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username),
        guest_date TEXT,
        created_at TEXT NOT NULL
    )""",
    # A workspace is a library: its own pages.db / data.db / uploads under
    # workspaces/<id>/. `id` is a random token (never a name, so renaming a
    # workspace or an account moves no files). Roles (gamma/workspaces.py):
    # owner (manage members, rename, delete), editor (read + write), viewer
    # (read). access: "private" = members only; "public" = every signed-in
    # account on the server is in at public_role, explicit members keep
    # their own role. quota_mb: a shared workspace's own storage cap (NULL =
    # unlimited); a personal workspace uses its account's quota instead.
    """CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        access TEXT NOT NULL DEFAULT 'private',
        public_role TEXT NOT NULL DEFAULT 'viewer',
        quota_mb INTEGER
    )""",
    """CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        username TEXT NOT NULL REFERENCES users(username),
        role TEXT NOT NULL,
        added_by TEXT NOT NULL DEFAULT '',
        added_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, username)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_wm_user ON workspace_members(username)",
    # Share links, one per (workspace, page). page_id is the shared page's
    # root block. audience: who may open the link — "anyone" (no login),
    # "users" (any signed-in non-guest account), "list" (the usernames in
    # allowed_users, "carol:edit,dave:view"). role: "view" or "edit" (edit
    # never applies to anonymous viewers — see gamma/auth.py share_access).
    """CREATE TABLE IF NOT EXISTS shares (
        token TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        audience TEXT NOT NULL DEFAULT 'anyone',
        role TEXT NOT NULL DEFAULT 'view',
        allowed_users TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )""",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_page ON shares(workspace_id, page_id)",
    # Small JSON values that follow the ACCOUNT (docs/dev/settings.md):
    # workspace_id '' = personal (appearance, the AI provider entries),
    # otherwise per account AND workspace (open tabs, recents — they name
    # pages of that workspace). See USER_PREF_KEYS / pref_scope.
    """CREATE TABLE IF NOT EXISTS user_prefs (
        username TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (username, workspace_id, key)
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
    # page_ops = the per-page operation log (gamma/ops.py): one row per
    # applied batch, `seq` counting up per page. Live clients follow it over
    # the page's websocket; a reconnecting client catches up with
    # GET /api/pages/{id}/ops?since=. Pruned to the newest rows per page.
    """CREATE TABLE IF NOT EXISTS page_ops (
        page_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        actor TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL,
        ops TEXT NOT NULL,
        PRIMARY KEY (page_id, seq)
    ) WITHOUT ROWID""",
]

# data.db = the workspace's derived / regenerable data (chats, cover
# snapshots, the pdf_fts / block_fts search indexes created lazily by
# gamma/pdf_index.py and gamma/block_index.py). Personal prefs used to live
# here too (a `prefs` table) — they are in users.db `user_prefs` now, and
# gamma/normalize.py drops the old table.
DATA_SCHEMA = [
    # chats = the ACTIVE conversation per bucket (page id / "home" /
    # "home:<folder>"); `title` is the user-given name of that conversation.
    "CREATE TABLE IF NOT EXISTS chats (block_id TEXT PRIMARY KEY, messages TEXT NOT NULL, "
    "updated_at TEXT NOT NULL, title TEXT NOT NULL DEFAULT '')",
    # chat_history = earlier conversations of a bucket ("New chat" archives
    # the active one here; opening an entry swaps it back into `chats`).
    "CREATE TABLE IF NOT EXISTS chat_history (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, "
    "title TEXT NOT NULL DEFAULT '', messages TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS chat_history_bucket ON chat_history (bucket, updated_at)",
    # page_snaps = the recents-card cover thumbnails (small JPEG data URLs
    # captured client-side from the rendered viewer), shared by the
    # workspace's members. Too big for the prefs KV, hence their own table
    # + /api/page-snaps.
    "CREATE TABLE IF NOT EXISTS page_snaps (page_id TEXT PRIMARY KEY, img TEXT NOT NULL, at TEXT NOT NULL)",
]

# Snapshots exist only to cover the (24-entry) recents queue; keep a few
# spares so multi-device merge timing never evicts a still-live cover.
PAGE_SNAPS_CAP = 30


# --- users.db ----------------------------------------------------------------

def users_db_version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def connect_users_db() -> sqlite3.Connection:
    """Open the global users.db, creating it at SCHEMA_VERSION when it does
    not exist yet. An existing file behind SCHEMA_VERSION raises
    ``SchemaOutdated`` — the migration runner (gamma/migrations.py) is the
    only code that touches an old-shape users.db, so nothing can ever read
    or write it with the wrong assumptions."""
    USERS_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(USERS_DB))
    has_users = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone()
    version = users_db_version(conn)
    if has_users and version < SCHEMA_VERSION:
        conn.close()
        raise SchemaOutdated(
            f"the data directory is at schema version {version}, this Gamma expects "
            f"{SCHEMA_VERSION} — run `python manage.py migrate` (the server does so at startup)")
    for stmt in USERS_SCHEMA:
        conn.execute(stmt)
    if not has_users:
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()
    return conn


# Prefs that follow the account regardless of workspace (stored with
# workspace_id ''). Everything else is per account + workspace, because the
# value names that workspace's pages (open tabs, recents, pinned folders,
# reading positions).
USER_PREF_KEYS = frozenset({"ai-settings", "ai-provider", "appearance"})


def pref_scope(key: str, ws: str) -> str:
    return "" if key in USER_PREF_KEYS else (ws or "")


def get_pref(username: str, key: str, ws: str = ""):
    """(value, updated_at) from the account's prefs, or (None, "") when unset."""
    with connect_users_db() as db:
        row = db.execute(
            "SELECT value, updated_at FROM user_prefs WHERE username = ? AND workspace_id = ? AND key = ?",
            (username, pref_scope(key, ws), key)).fetchone()
    if not row:
        return None, ""
    try:
        return json.loads(row[0]), row[1]
    except ValueError:
        return None, ""


def set_pref(username: str, key: str, value, ws: str = "") -> str:
    """Store a pref (last write wins); returns the new updated_at."""
    now = page_now()
    with connect_users_db() as db:
        db.execute(
            "INSERT INTO user_prefs (username, workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(username, workspace_id, key) DO UPDATE SET value = excluded.value, "
            "updated_at = excluded.updated_at",
            (username, pref_scope(key, ws), key, json.dumps(value), now),
        )
        db.commit()
    return now


# --- workspace files ---------------------------------------------------------

def ws_dir(ws: str) -> Path:
    return WORKSPACES_DIR / safe_ws_id(ws)


def ws_db_path(ws: str, db_name: str) -> str:
    return str(ws_dir(ws) / db_name)


def ws_uploads_dir(ws: str) -> Path:
    return ws_dir(ws) / "uploads"


def pdf_upload_path(ws: str, doc_id: str) -> Path:
    """Validated path to a document's stored PDF. Use instead of joining an
    untrusted doc id into a filename by hand."""
    return ws_uploads_dir(ws) / f"{safe_doc_id(doc_id)}.pdf"


def connect_pages_db(ws: str) -> sqlite3.Connection:
    """THE way to open a workspace's pages.db. WAL mode (readers never wait
    on a writer — several browsers, several members), a busy timeout instead
    of an instant "database is locked", and the schema statements (cheap
    no-ops once applied; they also give a restored backup the page_ops
    table)."""
    conn = sqlite3.connect(ws_db_path(ws, "pages.db"), timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    for stmt in PAGES_SCHEMA:
        conn.execute(stmt)
    return conn


def connect_data_db(ws: str) -> sqlite3.Connection:
    conn = sqlite3.connect(ws_db_path(ws, "data.db"))
    for stmt in DATA_SCHEMA:
        conn.execute(stmt)
    return conn


def get_page_snaps(ws: str, after: str = "") -> dict:
    """{page_id: {img, at}} — optionally only entries newer than `after`."""
    with connect_data_db(ws) as db:
        rows = db.execute(
            "SELECT page_id, img, at FROM page_snaps WHERE at > ? ORDER BY at DESC",
            (after or "",),
        ).fetchall()
    return {pid: {"img": img, "at": at} for pid, img, at in rows}


def set_page_snap(ws: str, page_id: str, img: str, at: str = "") -> str:
    """Store a snapshot (newest `at` wins) and prune past the cap; returns the stored at."""
    at = at or page_now()
    with connect_data_db(ws) as db:
        row = db.execute("SELECT at FROM page_snaps WHERE page_id = ?", (page_id,)).fetchone()
        if row and row[0] >= at:
            return row[0]  # a newer capture (another device) already landed
        db.execute(
            "INSERT INTO page_snaps (page_id, img, at) VALUES (?, ?, ?) "
            "ON CONFLICT(page_id) DO UPDATE SET img = excluded.img, at = excluded.at",
            (page_id, img, at),
        )
        db.execute(
            "DELETE FROM page_snaps WHERE page_id NOT IN "
            "(SELECT page_id FROM page_snaps ORDER BY at DESC LIMIT ?)",
            (PAGE_SNAPS_CAP,),
        )
        db.commit()
    return at


def delete_page_snap(ws: str, page_id: str):
    with connect_data_db(ws) as db:
        db.execute("DELETE FROM page_snaps WHERE page_id = ?", (page_id,))
        db.commit()

"""Versioned upgrades of the data directory.

The data directory has ONE schema version, stored as ``PRAGMA user_version``
of ``users.db`` (``db.SCHEMA_VERSION`` is what this code expects). A
release that changes stored shapes ships a numbered step here and bumps the
constant; the step is the whole change — moved files, rebuilt tables,
rewritten rows — and ``db.py``'s ``CREATE TABLE`` statements always describe
the CURRENT shape, so nothing is patched lazily on connect any more.

The rules that keep this safe and small:

- **Runs before anything else.** ``ensure_current()`` is the first thing
  the server does at startup (and ``python manage.py migrate`` by hand). A
  data directory AHEAD of the binary is refused with a clear message — an
  older Gamma never opens files it does not understand.
- **Backup first.** Before the first pending step every database file is
  snapshotted with the SQLite backup API into ``backups/<time>-v<N>/``
  (``gamma/backups.py``; uploads are never copied — steps move them, never
  rewrite them). Only the newest ``backups.KEEP_BACKUPS`` are kept.
- **One step, one stamp.** Steps run in order; the version is stamped after
  each one, so an interrupted upgrade resumes at the step that did not
  finish. Every step is written to be re-runnable (it checks what it is
  about to do).
- **Nothing piles up.** A step is kept only while ``MIN_UPGRADABLE`` is
  below it. Raising ``MIN_UPGRADABLE`` (a release or two later) deletes the
  older steps; a data directory that old must first run a release that
  still has them (the refusal says which). Content normalization of
  per-workspace files (``gamma/normalize.py``) is not a step: it also runs
  on backup restore, because a backup can be older than any step.

Docs: docs/dev/migrations.md.
"""

import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

from . import backups, config
from .db import PAGES_SCHEMA, SCHEMA_VERSION, USERS_SCHEMA, USER_PREF_KEYS, page_now, users_db_version
from .logbuf import log
from .normalize import normalize_data_db, normalize_pages_db

# Lowest version this release can still upgrade from (0 = the unversioned
# layout every Gamma before schema versions wrote).
MIN_UPGRADABLE = 0


class MigrationError(RuntimeError):
    pass


class NewerDataError(MigrationError):
    """The data directory was written by a newer Gamma."""


class TooOldDataError(MigrationError):
    """The data directory predates MIN_UPGRADABLE."""


# --- inspection ---------------------------------------------------------------

def data_version() -> int | None:
    """The data directory's schema version; None when it has no users.db yet
    (a fresh install — ``db.connect_users_db`` creates it at SCHEMA_VERSION)."""
    if not config.USERS_DB.exists():
        return None
    with closing(sqlite3.connect(str(config.USERS_DB))) as conn:
        has_users = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone()
        if not has_users:
            return None
        return users_db_version(conn)


def pending_steps(version: int) -> list:
    return [(v, name, fn) for v, name, fn in STEPS if v > version]


def status() -> dict:
    """``{"version", "target", "fresh", "pending": [{"version", "name"}],
    "backups": [...]}`` for the CLI and the startup line."""
    version = data_version()
    fresh = version is None
    pending = [] if fresh else pending_steps(version)
    return {
        "version": SCHEMA_VERSION if fresh else version,
        "target": SCHEMA_VERSION,
        "fresh": fresh,
        "pending": [{"version": v, "name": name} for v, name, _ in pending],
        "backups": [b["name"] for b in backups.list_backups()],
    }


# --- the runner ---------------------------------------------------------------

def ensure_current(dry_run: bool = False) -> dict:
    """Bring the data directory to SCHEMA_VERSION. Returns ``{"from", "to",
    "applied": [names], "backup": path | None}``. Raises ``NewerDataError``
    / ``TooOldDataError`` (refuse to run) or ``MigrationError`` (a step
    failed — the version stays at the last completed step; fix or restore
    the backup and rerun)."""
    version = data_version()
    if version is None:
        return {"from": SCHEMA_VERSION, "to": SCHEMA_VERSION, "applied": [], "backup": None}
    if version > SCHEMA_VERSION:
        raise NewerDataError(
            f"the data directory ({config.DATA_DIR}) is at schema version {version}, newer than "
            f"this Gamma (version {SCHEMA_VERSION}). Run the Gamma release that wrote it, or "
            f"restore the matching snapshot from {config.BACKUPS_DIR}.")
    if version < MIN_UPGRADABLE:
        raise TooOldDataError(
            f"the data directory is at schema version {version}; this release upgrades from "
            f"{MIN_UPGRADABLE} at the earliest. Run an intermediate Gamma release first.")
    pending = pending_steps(version)
    result = {"from": version, "to": SCHEMA_VERSION, "applied": [], "backup": None}
    if not pending or dry_run:
        return result
    result["backup"] = backups.create(f"v{version}", prune=True)["path"]
    log.info(f"[migrate] upgrading data directory from schema version {version} to "
             f"{SCHEMA_VERSION}; snapshot in {result['backup']}")
    for v, name, fn in pending:
        try:
            with closing(sqlite3.connect(str(config.USERS_DB))) as conn:
                fn(conn)
                conn.execute(f"PRAGMA user_version = {v}")
                conn.commit()
        except Exception as e:
            raise MigrationError(
                f"migration step {v} ({name}) failed: {e}. The data directory is at the last "
                f"completed step; fix the cause and rerun `manage.py migrate`, or restore "
                f"{result['backup']}.") from e
        result["applied"].append(name)
        log.info(f"[migrate] step {v} ({name}) done")
    return result


# --- steps --------------------------------------------------------------------
# Each step gets an open users.db connection (autocommit off) and must leave
# the database consistent when it returns; the runner stamps the version.

def _columns(conn, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def _v1_baseline(conn: sqlite3.Connection) -> None:
    """Everything before workspaces, in its final shape: the columns that
    used to be added lazily on connect, share rows keyed by page, the
    per-user files normalized (gamma/normalize.py)."""
    cols = _columns(conn, "users")
    if "is_admin" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    if "max_upload_mb" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN max_upload_mb INTEGER")
        conn.execute("ALTER TABLE users ADD COLUMN quota_mb INTEGER")
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shares'").fetchone():
        conn.execute("""CREATE TABLE shares (
            token TEXT PRIMARY KEY, username TEXT NOT NULL, doc_id TEXT NOT NULL DEFAULT '',
            page_id TEXT, audience TEXT NOT NULL DEFAULT 'anyone', role TEXT NOT NULL DEFAULT 'view',
            allowed_users TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)""")
    share_cols = _columns(conn, "shares")
    if "page_id" not in share_cols:
        conn.execute("ALTER TABLE shares ADD COLUMN page_id TEXT")
    if "audience" not in share_cols:
        conn.execute("ALTER TABLE shares ADD COLUMN audience TEXT NOT NULL DEFAULT 'anyone'")
        conn.execute("ALTER TABLE shares ADD COLUMN role TEXT NOT NULL DEFAULT 'view'")
        conn.execute("ALTER TABLE shares ADD COLUMN allowed_users TEXT NOT NULL DEFAULT ''")
    conn.commit()

    # Per-user files: content normalization + legacy tables.
    users_dir = config.LEGACY_USERS_DIR
    if users_dir.is_dir():
        for user_dir in sorted(users_dir.iterdir()):
            if not user_dir.is_dir():
                continue
            if (user_dir / "pages.db").is_file():
                with closing(sqlite3.connect(str(user_dir / "pages.db"))) as pdb:
                    for stmt in PAGES_SCHEMA:
                        pdb.execute(stmt)
                    normalize_pages_db(pdb)
            if (user_dir / "data.db").is_file():
                with closing(sqlite3.connect(str(user_dir / "data.db"))) as ddb:
                    normalize_data_db(ddb, keep_prefs=True)

    # Shares minted when they were keyed by PDF: resolve to the page, or drop.
    doc_col = "doc_id" if "doc_id" in _columns(conn, "shares") else "''"
    rows = conn.execute(
        f"SELECT token, username, {doc_col} FROM shares WHERE page_id IS NULL OR page_id = ''").fetchall()
    for token, username, doc_id in rows:
        page_id = None
        pages_db = users_dir / str(username) / "pages.db"
        if doc_id and pages_db.is_file():
            with closing(sqlite3.connect(str(pages_db))) as pdb:
                row = pdb.execute(
                    "SELECT id FROM unified_blocks WHERE parent_id = 'root' "
                    "AND json_extract(properties, '$.doc_id') = ? LIMIT 1", (doc_id,)).fetchone()
                page_id = row[0] if row else None
        if page_id:
            conn.execute("UPDATE shares SET page_id = ? WHERE token = ?", (page_id, token))
        else:
            conn.execute("DELETE FROM shares WHERE token = ?", (token,))
    conn.commit()


def _v2_workspaces(conn: sqlite3.Connection) -> None:
    """users/<username>/ becomes workspaces/<id>/ — one personal workspace
    per account (the account is its owner and it becomes the default);
    personal prefs move from data.db to users.db; shares are keyed by
    workspace."""
    for stmt in USERS_SCHEMA:
        if "CREATE TABLE IF NOT EXISTS shares" in stmt or "idx_shares_page" in stmt:
            continue  # rebuilt below from the old rows
        conn.execute(stmt)
    if "default_workspace" not in _columns(conn, "users"):
        conn.execute("ALTER TABLE users ADD COLUMN default_workspace TEXT NOT NULL DEFAULT ''")
    conn.commit()

    now = page_now()
    config.WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
    for username, default_ws in conn.execute(
            "SELECT username, default_workspace FROM users ORDER BY created_at").fetchall():
        if default_ws:
            continue  # resumed run: this account is done
        from .workspaces import new_workspace_id  # local: workspaces imports seed
        ws_id = new_workspace_id()
        src = config.LEGACY_USERS_DIR / username
        dst = config.WORKSPACES_DIR / ws_id
        if src.is_dir():
            src.rename(dst)
        else:
            _fresh_workspace_files(dst)
        _move_prefs(conn, username, ws_id, dst / "data.db")
        conn.execute("INSERT OR IGNORE INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
                     (ws_id, username, username, now))
        conn.execute("INSERT OR IGNORE INTO workspace_members (workspace_id, username, role, added_by, added_at) "
                     "VALUES (?, ?, 'owner', ?, ?)", (ws_id, username, username, now))
        conn.execute("UPDATE users SET default_workspace = ? WHERE username = ?", (ws_id, username))
        conn.commit()

    # Shares: (username, page) → (workspace, page). Rows of unknown accounts
    # have nothing to resolve through and go.
    if "workspace_id" not in _columns(conn, "shares"):
        conn.execute("DROP TABLE IF EXISTS shares_new")
        conn.execute(next(s for s in USERS_SCHEMA if "CREATE TABLE IF NOT EXISTS shares" in s)
                     .replace("CREATE TABLE IF NOT EXISTS shares", "CREATE TABLE shares_new"))
        conn.execute(
            "INSERT OR IGNORE INTO shares_new (token, workspace_id, page_id, created_by, audience, role, "
            "allowed_users, created_at) "
            "SELECT s.token, u.default_workspace, s.page_id, s.username, s.audience, s.role, "
            "s.allowed_users, s.created_at FROM shares s JOIN users u ON u.username = s.username "
            "WHERE s.page_id IS NOT NULL AND s.page_id != '' AND u.default_workspace != ''")
        conn.execute("DROP TABLE shares")
        conn.execute("ALTER TABLE shares_new RENAME TO shares")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_page ON shares(workspace_id, page_id)")
        conn.commit()

    # Directories without an account row stay where they are, but say so.
    legacy = config.LEGACY_USERS_DIR
    if legacy.is_dir():
        leftovers = [d.name for d in legacy.iterdir() if d.is_dir()]
        if leftovers:
            log.warning(f"[migrate] {legacy} still holds directories with no account: "
                        f"{', '.join(leftovers)} — inspect and delete them by hand")
        else:
            shutil.rmtree(str(legacy), ignore_errors=True)


def _fresh_workspace_files(target: Path) -> None:
    """Empty pages.db (with its root row) + data.db + uploads/ — for an
    account whose directory had gone missing."""
    from .seed import create_workspace_files  # local: seed imports db

    target.mkdir(parents=True, exist_ok=True)
    create_workspace_files(target.name)


def _move_prefs(conn: sqlite3.Connection, username: str, ws_id: str, data_db: Path) -> None:
    """data.db `prefs` rows → users.db user_prefs (personal keys with
    workspace '' , the rest under the new workspace), then drop the table."""
    if not data_db.is_file():
        return
    with closing(sqlite3.connect(str(data_db))) as ddb:
        if ddb.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prefs'").fetchone():
            for key, value, updated_at in ddb.execute("SELECT key, value, updated_at FROM prefs"):
                scope = "" if key in USER_PREF_KEYS else ws_id
                conn.execute(
                    "INSERT OR IGNORE INTO user_prefs (username, workspace_id, key, value, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)", (username, scope, key, value, updated_at))
        normalize_data_db(ddb)


def _v3_workspace_access(conn: sqlite3.Connection) -> None:
    """Workspaces gain an access setting (private / public + the role every
    signed-in account gets in a public one) and their own optional storage
    quota; nothing is moved. Existing rows keep today's behaviour: private,
    no workspace quota."""
    cols = _columns(conn, "workspaces")
    if "access" not in cols:
        conn.execute("ALTER TABLE workspaces ADD COLUMN access TEXT NOT NULL DEFAULT 'private'")
    if "public_role" not in cols:
        conn.execute("ALTER TABLE workspaces ADD COLUMN public_role TEXT NOT NULL DEFAULT 'viewer'")
    if "quota_mb" not in cols:
        conn.execute("ALTER TABLE workspaces ADD COLUMN quota_mb INTEGER")
    conn.commit()


def _v4_workspace_kinds(conn: sqlite3.Connection) -> None:
    """Workspaces gain a ``kind``. An account's default workspace and any
    workspace with a single member are personal (the account's own library,
    metered against it); everything with more members is shared (from now
    on admin-managed). A default workspace that had other members stays
    personal — personal workspaces have no other members — and those
    memberships are dropped, named in the log so an admin can put the
    people into a shared workspace instead."""
    if "kind" not in _columns(conn, "workspaces"):
        conn.execute("ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal'")
    conn.commit()
    defaults = {r[0]: r[1] for r in conn.execute(
        "SELECT default_workspace, username FROM users WHERE default_workspace != ''")}
    for ws, in conn.execute("SELECT id FROM workspaces").fetchall():
        people = [r[0] for r in conn.execute(
            "SELECT username FROM workspace_members WHERE workspace_id = ? ORDER BY added_at", (ws,))]
        if ws in defaults:
            extra = [u for u in people if u != defaults[ws]]
            if extra:
                log.warning(f"[migrate] personal workspace {ws} of {defaults[ws]} had other members "
                            f"({', '.join(extra)}); they were removed — give them a shared workspace")
                conn.execute("DELETE FROM workspace_members WHERE workspace_id = ? AND username != ?",
                             (ws, defaults[ws]))
            kind = "personal"
        else:
            kind = "personal" if len(people) == 1 else "shared"
        conn.execute("UPDATE workspaces SET kind = ?, access = CASE WHEN ? = 'personal' THEN 'private' ELSE access END, "
                     "quota_mb = CASE WHEN ? = 'personal' THEN NULL ELSE quota_mb END WHERE id = ?",
                     (kind, kind, kind, ws))
    conn.commit()


def _v5_publisher_sessions(conn: sqlite3.Connection) -> None:
    conn.execute(next(s for s in USERS_SCHEMA if "CREATE TABLE IF NOT EXISTS publisher_sessions" in s))
    conn.commit()


def _v6_integration_tokens(conn: sqlite3.Connection) -> None:
    conn.execute(next(s for s in USERS_SCHEMA if "CREATE TABLE IF NOT EXISTS integration_tokens" in s))
    conn.commit()


STEPS = [
    (1, "baseline", _v1_baseline),
    (2, "workspaces", _v2_workspaces),
    (3, "workspace_access", _v3_workspace_access),
    (4, "workspace_kinds", _v4_workspace_kinds),
    (5, "publisher_sessions", _v5_publisher_sessions),
    (6, "integration_tokens", _v6_integration_tokens),
]

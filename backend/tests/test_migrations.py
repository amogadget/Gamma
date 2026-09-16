"""gamma/migrations.py — the versioned upgrade of the data directory, run
against a hand-built pre-workspace layout (schema version 0): every account
directory becomes a workspace, personal prefs move to users.db, shares are
re-keyed, a snapshot is taken first, a second run is a no-op, and a newer
data directory is refused. Runs in its own temp data directory so the
suite's shared one is never touched."""

import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

import gamma.app as app_mod  # noqa: F401  (builds the app on the suite's data dir, before any fixture repoints it)
from gamma import backups, config, migrations
from gamma.db import SCHEMA_VERSION, SchemaOutdated, connect_users_db

OLD = "2024-01-01T00:00:00.000000Z"


def test_v5_adds_integration_tokens_and_is_repeatable(data_dir):
    connect_users_db().close()
    with closing(sqlite3.connect(str(data_dir / "users.db"))) as conn:
        conn.execute("DROP TABLE integration_tokens")
        conn.execute("PRAGMA user_version = 5")
        conn.commit()
    assert migrations.ensure_current()["applied"] == ["integration_tokens"]
    with connect_users_db() as conn:
        assert conn.execute("SELECT * FROM integration_tokens").fetchall() == []
    assert migrations.ensure_current()["applied"] == []


def test_v4_adds_publisher_sessions_and_is_repeatable(data_dir):
    connect_users_db().close()
    with closing(sqlite3.connect(str(data_dir / "users.db"))) as conn:
        conn.execute("DROP TABLE publisher_sessions")
        conn.execute("PRAGMA user_version = 4")
        conn.commit()
    result = migrations.ensure_current()
    assert result["applied"] == ["publisher_sessions", "integration_tokens"]
    with connect_users_db() as conn:
        assert conn.execute("SELECT * FROM publisher_sessions").fetchall() == []
    assert migrations.ensure_current()["applied"] == []


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """Point every module that caches a data-directory path at tmp_path."""
    import gamma.auth as auth_mod
    import gamma.db as db_mod
    import gamma.seed as seed_mod
    import gamma.workspaces as ws_mod

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "USERS_DB", tmp_path / "users.db")
    monkeypatch.setattr(config, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setattr(config, "LEGACY_USERS_DIR", tmp_path / "users")
    monkeypatch.setattr(config, "BACKUPS_DIR", tmp_path / "backups")
    monkeypatch.setattr(db_mod, "USERS_DB", tmp_path / "users.db")
    monkeypatch.setattr(db_mod, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setattr(auth_mod, "USERS_DB", tmp_path / "users.db")
    monkeypatch.setattr(seed_mod, "WORKSPACES_DIR", tmp_path / "workspaces")
    monkeypatch.setattr(ws_mod, "WORKSPACES_DIR", tmp_path / "workspaces")
    return tmp_path


def _legacy_pages_db(path: Path, blocks):
    with closing(sqlite3.connect(str(path))) as conn:
        conn.execute("""CREATE TABLE unified_blocks (id TEXT PRIMARY KEY, parent_id TEXT, position TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '', properties TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        conn.execute("INSERT INTO unified_blocks VALUES ('root', NULL, 'a0', '', '{}', ?, ?)", (OLD, OLD))
        for bid, parent, content, props in blocks:
            conn.execute("INSERT INTO unified_blocks VALUES (?, ?, 'a0', ?, ?, ?, ?)",
                         (bid, parent, content, json.dumps(props), OLD, OLD))
        conn.commit()


def _legacy_data_db(path: Path, prefs: dict):
    with closing(sqlite3.connect(str(path))) as conn:
        # the oldest chats shape (no title column) + legacy tables + prefs
        conn.execute("CREATE TABLE chats (block_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE annotations (id TEXT)")
        conn.execute("CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)")
        for k, v in prefs.items():
            conn.execute("INSERT INTO prefs VALUES (?, ?, ?)", (k, json.dumps(v), OLD))
        conn.commit()


def build_v0(root: Path):
    """The layout every pre-workspace Gamma wrote: users.db without the
    later columns, users/<name>/ with pages.db + data.db + uploads/."""
    with closing(sqlite3.connect(str(root / "users.db"))) as conn:
        conn.execute("CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, "
                     "is_guest INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, "
                     "guest_date TEXT, created_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE shares (token TEXT PRIMARY KEY, username TEXT NOT NULL, "
                     "doc_id TEXT NOT NULL, created_at TEXT NOT NULL)")
        conn.executemany("INSERT INTO users VALUES (?, ?, ?, ?)", [
            ("alice", "hash", 0, OLD), ("bob", "hash", 0, OLD), ("guest", "", 1, OLD)])
        conn.execute("INSERT INTO sessions VALUES ('tok-alice', 'alice', NULL, ?)", (OLD,))
        conn.executemany("INSERT INTO shares VALUES (?, ?, ?, ?)", [
            ("share-doc", "alice", "docA", OLD),       # doc-keyed: resolves to alice's page
            ("share-gone", "alice", "vanished", OLD),  # unresolvable: dropped
            ("share-ghost", "nobody", "docA", OLD),    # unknown account: dropped
        ])
        conn.commit()
    for name in ("alice", "bob", "guest"):
        d = root / "users" / name
        (d / "uploads").mkdir(parents=True)
        (d / "uploads" / "docA.pdf").write_bytes(b"%PDF-1.4 " + name.encode())
    _legacy_pages_db(root / "users/alice/pages.db", [
        ("pageA", "root", "PDF Notes - a.pdf", {"doc_id": "docA", "sourceUrl": "https://x/a.pdf"}),
        ("noteA", "pageA", "see ![c](/api/uploads/i.png){:width 120}", {}),
    ])
    _legacy_pages_db(root / "users/bob/pages.db", [("pageB", "root", "Bob page", {})])
    _legacy_pages_db(root / "users/guest/pages.db", [])
    _legacy_data_db(root / "users/alice/data.db", {
        "open-tabs": [{"id": "pageA"}], "ai-settings": {"providers": [{"id": "p1", "protocol": "openai"}]},
        "appearance": {"theme": "dark"}})
    _legacy_data_db(root / "users/bob/data.db", {"recent-views": ["pageB"]})
    _legacy_data_db(root / "users/guest/data.db", {})


def test_status_and_refusal_on_a_v0_directory(data_dir):
    build_v0(data_dir)
    st = migrations.status()
    assert st["version"] == 0 and st["target"] == SCHEMA_VERSION and not st["fresh"]
    assert [p["name"] for p in st["pending"]] == ["baseline", "workspaces", "workspace_access", "workspace_kinds", "publisher_sessions", "integration_tokens"]
    # Nothing but the runner may open an old users.db.
    with pytest.raises(SchemaOutdated):
        connect_users_db()
    assert migrations.ensure_current(dry_run=True)["applied"] == []
    assert migrations.data_version() == 0  # a dry run changes nothing


def test_upgrade_v0_to_current(data_dir):
    build_v0(data_dir)
    result = migrations.ensure_current()
    assert result["from"] == 0 and result["to"] == SCHEMA_VERSION
    assert result["applied"] == ["baseline", "workspaces", "workspace_access", "workspace_kinds", "publisher_sessions", "integration_tokens"]
    assert migrations.data_version() == SCHEMA_VERSION

    # A snapshot of every database was taken first, with a manifest.
    backup = Path(result["backup"])
    manifest = json.loads((backup / "manifest.json").read_text())
    assert manifest["schema_version"] == 0
    assert "users.db" in manifest["files"] and "users/alice/pages.db" in manifest["files"]
    assert (backup / "users/alice/pages.db").is_file() and not (backup / "users/alice/uploads").exists()
    assert migrations.status()["backups"] == [backup.name]
    assert backups.info(backup.name)["uploads"] is False

    with connect_users_db() as conn:
        users = {r[0]: r[1] for r in conn.execute("SELECT username, default_workspace FROM users")}
        assert set(users) == {"alice", "bob", "guest"} and all(users.values())
        ws_alice, ws_bob, ws_guest = users["alice"], users["bob"], users["guest"]
        # one personal workspace per account, the account its owner
        rows = conn.execute("SELECT id, name, created_by FROM workspaces ORDER BY created_at").fetchall()
        assert {r[0] for r in rows} == {ws_alice, ws_bob, ws_guest}
        assert dict((r[0], r[1]) for r in rows)[ws_alice] == "alice"
        members = conn.execute("SELECT workspace_id, username, role FROM workspace_members").fetchall()
        assert (ws_alice, "alice", "owner") in members and len(members) == 3
        # the columns that used to be added lazily exist
        cols = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
        assert {"is_admin", "max_upload_mb", "quota_mb", "default_workspace"} <= cols
        # shares: doc-keyed row resolved and re-keyed by workspace; the rest dropped
        shares = conn.execute("SELECT token, workspace_id, page_id, created_by FROM shares").fetchall()
        assert shares == [("share-doc", ws_alice, "pageA", "alice")]
        assert "doc_id" not in {r[1] for r in conn.execute("PRAGMA table_info(shares)")}
        # personal prefs moved: account-wide keys under '', page-naming keys under the workspace
        prefs = {(r[0], r[1], r[2]): json.loads(r[3]) for r in conn.execute(
            "SELECT username, workspace_id, key, value FROM user_prefs")}
        assert prefs[("alice", "", "ai-settings")]["providers"][0]["id"] == "p1"
        assert prefs[("alice", "", "appearance")] == {"theme": "dark"}
        assert prefs[("alice", ws_alice, "open-tabs")] == [{"id": "pageA"}]
        assert prefs[("bob", ws_bob, "recent-views")] == ["pageB"]
        # the session row survived untouched
        assert conn.execute("SELECT username FROM sessions WHERE token = 'tok-alice'").fetchone() == ("alice",)

    # Files moved, not copied; the legacy directory is gone.
    ws_dir = data_dir / "workspaces" / ws_alice
    assert (ws_dir / "pages.db").is_file() and (ws_dir / "uploads" / "docA.pdf").read_bytes().endswith(b"alice")
    assert not (data_dir / "users").exists()

    # Per-workspace files normalized: content shapes, legacy tables, chats.title.
    with closing(sqlite3.connect(str(ws_dir / "pages.db"))) as conn:
        content, props = conn.execute("SELECT content, properties FROM unified_blocks WHERE id = 'pageA'").fetchone()
        assert content == "a.pdf" and json.loads(props) == {"doc_id": "docA", "source_url": "https://x/a.pdf", "auto_title": "a.pdf"}
        assert conn.execute("SELECT content FROM unified_blocks WHERE id = 'noteA'").fetchone()[0] == "see ![c|120](/api/uploads/i.png)"
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'page_ops'").fetchone()
    with closing(sqlite3.connect(str(ws_dir / "data.db"))) as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "prefs" not in tables and "annotations" not in tables
        assert "title" in {r[1] for r in conn.execute("PRAGMA table_info(chats)")}

    # Idempotent: a second run applies nothing and takes no new snapshot.
    again = migrations.ensure_current()
    assert again["applied"] == [] and again["backup"] is None
    assert len(backups.list_backups()) == 1


def test_interrupted_upgrade_resumes(data_dir):
    """A crash mid-step leaves the version at the last completed step; the
    next start finishes the rest without redoing accounts already moved."""
    build_v0(data_dir)
    # Run the baseline step only, then half of the workspaces step by hand.
    with closing(sqlite3.connect(str(config.USERS_DB))) as conn:
        migrations._v1_baseline(conn)
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
    assert migrations.data_version() == 1
    calls = {"n": 0}
    real = migrations._move_prefs

    def crash_after_first(conn, username, ws_id, data_db):
        real(conn, username, ws_id, data_db)
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("disk full")

    import gamma.migrations as m
    original = m._move_prefs
    m._move_prefs = crash_after_first
    try:
        with pytest.raises(migrations.MigrationError, match="workspaces"):
            migrations.ensure_current()
    finally:
        m._move_prefs = original
    assert migrations.data_version() == 1  # the failed step did not stamp
    result = migrations.ensure_current()   # resumes: the moved account is skipped, the rest done
    assert result["applied"] == ["workspaces", "workspace_access", "workspace_kinds", "publisher_sessions", "integration_tokens"] and migrations.data_version() == SCHEMA_VERSION
    with connect_users_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM users WHERE default_workspace = ''").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0] == 3
    assert not (data_dir / "users").exists()


def test_newer_data_directory_is_refused(data_dir):
    build_v0(data_dir)
    migrations.ensure_current()
    with closing(sqlite3.connect(str(config.USERS_DB))) as conn:
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
        conn.commit()
    with pytest.raises(migrations.NewerDataError):
        migrations.ensure_current()
    # …and so is running the app's startup on it.
    with pytest.raises(SystemExit):
        app_mod._startup_maintenance()


def test_fresh_directory_needs_no_migration(data_dir):
    assert migrations.status()["fresh"] is True
    assert migrations.ensure_current()["applied"] == []
    connect_users_db().close()  # created at the current version
    assert migrations.data_version() == SCHEMA_VERSION
    assert migrations.ensure_current()["applied"] == []


def test_backups_are_pruned_only_on_request(data_dir, monkeypatch):
    build_v0(data_dir)
    monkeypatch.setattr(backups, "KEEP_BACKUPS", 2)
    backups.create("a")
    backups.create("b")   # a second one within the same second gets the next stamp
    backups.create("c")
    names = [b["name"] for b in backups.list_backups()]
    assert len(names) == 3  # hand-made backups are never pruned by themselves
    assert backups.prune_backups() == names[:1]
    assert backups.prune_backups(keep=0) == names[1:] and backups.list_backups() == []


def test_backup_with_uploads_zip_and_restore(data_dir):
    build_v0(data_dir)
    migrations.ensure_current()
    ws = connect_users_db().execute("SELECT default_workspace FROM users WHERE username = 'alice'").fetchone()[0]
    pdf = data_dir / "workspaces" / ws / "uploads" / "docA.pdf"
    b = backups.create("full", uploads=True)
    assert b["uploads"] is True and b["upload_files"] == 3 and b["size_bytes"] > 0
    assert (Path(b["path"]) / "workspaces" / ws / "uploads" / "docA.pdf").read_bytes() == pdf.read_bytes()
    assert backups.backup_path("../../etc") is None and backups.info("nope") is None
    # the zip holds every file at its relative path
    import zipfile
    z = zipfile.ZipFile(backups.zip_backup(b["name"]))
    assert "manifest.json" in z.namelist() and f"workspaces/{ws}/uploads/docA.pdf" in z.namelist()
    # damage the live data, restore, and it is back
    pdf.unlink()
    with closing(sqlite3.connect(str(data_dir / "workspaces" / ws / "pages.db"))) as conn:
        conn.execute("DELETE FROM unified_blocks WHERE id = 'noteA'")
        conn.commit()
    r = backups.restore(b["name"])
    assert r["files"] >= 7 and pdf.is_file()
    with closing(sqlite3.connect(str(data_dir / "workspaces" / ws / "pages.db"))) as conn:
        assert conn.execute("SELECT 1 FROM unified_blocks WHERE id = 'noteA'").fetchone()
    assert backups.delete(b["name"]) is True and backups.delete(b["name"]) is False

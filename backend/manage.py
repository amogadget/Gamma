#!/usr/bin/env python3
"""CLI for managing Gamma users. Run from the backend/ directory.

Usage:
  python manage.py create-user <username> [password]
  python manage.py delete-user <username>
  python manage.py list-users
  python manage.py reset-guest      # wipe guest data (auto-runs daily)
"""

import sys
import sqlite3
import shutil
from pathlib import Path
from datetime import datetime, timezone

import bcrypt
from fractional_indexing import generate_key_between

USERS_DB = Path(__file__).parent / "users.db"
USERS_DIR = Path(__file__).parent / "users"


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def _ensure_users_db():
    conn = sqlite3.connect(str(USERS_DB))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            is_guest INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL REFERENCES users(username),
            guest_date TEXT,
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS shares (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    conn.commit()
    return conn


def _create_user_db(username):
    """Create fresh per-user pages.db, data.db, and uploads/ directory."""
    user_dir = USERS_DIR / username
    user_dir.mkdir(parents=True, exist_ok=True)

    pages_db = sqlite3.connect(str(user_dir / "pages.db"))
    pages_db.execute("""
        CREATE TABLE unified_blocks (
            id TEXT PRIMARY KEY,
            parent_id TEXT REFERENCES unified_blocks(id),
            position TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            properties TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    pages_db.execute("CREATE INDEX idx_ub_parent ON unified_blocks(parent_id, position)")
    nw = now()
    pages_db.execute(
        "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
        "VALUES ('root', NULL, 'a0', '', '{}', ?, ?)",
        (nw, nw),
    )

    if username == "guest":
        import secrets
        raw = "https://raw.githubusercontent.com/amogadget/Gamma/main/docs/screenshots"
        wid = secrets.token_urlsafe(9)
        intro_id = secrets.token_urlsafe(9)
        started_id = secrets.token_urlsafe(9)
        figures_id = secrets.token_urlsafe(9)
        guest_id = secrets.token_urlsafe(9)
        md_id = secrets.token_urlsafe(9)
        blocks = [
            (wid, "root", "a0V", "Welcome", '{"summary":"A quick-start guide to Gamma PDF Annotator"}'),
            (intro_id, wid, "a0", "Gamma is a self-hosted, Logseq-inspired PDF annotation tool. You can highlight PDFs, organize notes as nested outliner blocks, and share read-only annotated copies via link.", '{}'),
            (started_id, wid, generate_key_between("a0", None), "## Getting started", '{}'),
            (secrets.token_urlsafe(9), started_id, "a0", "**Open a PDF**: paste a URL in the topbar and click Open, or drag a PDF file onto this page.", '{}'),
            (secrets.token_urlsafe(9), started_id, generate_key_between("a0", None), "**Highlight text**: select text in the PDF to create a highlight with optional comment and color.", '{}'),
            (secrets.token_urlsafe(9), started_id, generate_key_between("a0V", None), "**Add notes**: type in any block. Press Enter for a new sibling, Tab to indent, Shift+Tab to outdent.", '{}'),
            (secrets.token_urlsafe(9), started_id, generate_key_between("a1", None), "**Reorder blocks**: hover over a block's left edge, grab the ⋮⋮ handle, and drag to reorder.", '{}'),
            (secrets.token_urlsafe(9), started_id, generate_key_between("a1V", None), "**Drag images**: drag an image file from your computer onto any block to insert it. You can also paste images from the clipboard.", '{}'),
            (secrets.token_urlsafe(9), started_id, generate_key_between("a2", None), "**AI chat**: click \"Show AI Chat\" at the bottom of the sidebar to ask questions about the open PDF.", '{}'),
            (secrets.token_urlsafe(9), started_id, generate_key_between("a2V", None), "**Share**: click \"Share link\" in the ⋮ menu to generate a public read-only link for any annotated PDF.", '{}'),
            (secrets.token_urlsafe(9), started_id, generate_key_between("a3", None), "**Category tags**: add a `category::` tag below the summary to organize pages. The home page groups them into carousels.", '{}'),
            (figures_id, wid, generate_key_between("a0V", None), "## Insert figures", '{}'),
            (secrets.token_urlsafe(9), figures_id, "a0", f"Drag any image file into a block to embed it. Gamma uploads it and inserts `![]()` markdown. Here is what the app looks like:", '{}'),
            (secrets.token_urlsafe(9), figures_id, generate_key_between("a0", None), f"![]({raw}/01-annotated-pdf.png)", '{}'),
            (secrets.token_urlsafe(9), figures_id, generate_key_between("a0V", None), f"![]({raw}/02-home-carousels.png)", '{}'),
            (guest_id, wid, generate_key_between("a1", None), "## Guest account", '{}'),
            (secrets.token_urlsafe(9), guest_id, "a0", "You are logged in as a **guest**. Your data resets each day at midnight UTC. To keep your work permanently, ask the admin to create an account for you.", '{}'),
            (md_id, wid, generate_key_between("a1V", None), "## Markdown formatting", '{}'),
            (secrets.token_urlsafe(9), md_id, "a0", "Blocks support **bold**, *italic*, `code`, [links](https://example.com), and inline $\\KaTeX$ math like $E = mc^2$.", '{}'),
        ]
        for bid, pid, pos, content, props in blocks:
            pages_db.execute(
                "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (bid, pid, pos, content, props or '{}', nw, nw),
            )

    pages_db.commit()
    pages_db.close()

    data_db = sqlite3.connect(str(user_dir / "data.db"))
    data_db.execute("CREATE TABLE IF NOT EXISTS annotations (doc_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    data_db.execute("CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, doc_id TEXT NOT NULL)")
    data_db.commit()
    data_db.close()

    (user_dir / "uploads").mkdir(parents=True, exist_ok=True)


def create_user(username, password=None):
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    conn = _ensure_users_db()

    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        print(f"User '{username}' already exists.")
        conn.close()
        return

    pwhash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode() if password else ""
    is_guest = 0 if password else 1

    conn.execute(
        "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, ?, ?)",
        (username, pwhash, is_guest, now()),
    )
    conn.commit()
    conn.close()

    _create_user_db(username)

    tag = " (no password)" if not password else ""
    print(f"Created user '{username}'{tag}")


def list_users():
    conn = _ensure_users_db()
    rows = conn.execute(
        "SELECT username, is_guest, created_at FROM users ORDER BY created_at"
    ).fetchall()
    if not rows:
        print("No users.")
    else:
        for user, is_guest, created in rows:
            tag = " [guest]" if is_guest else ""
            print(f"  {user}{tag}  ({created})")
    conn.close()


def delete_user(username):
    if username == "guest":
        print("Use 'reset-guest' to reset the guest account.")
        return
    conn = _ensure_users_db()
    conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
    conn.execute("DELETE FROM users WHERE username = ?", (username,))
    conn.commit()
    conn.close()

    user_dir = USERS_DIR / username
    if user_dir.exists():
        shutil.rmtree(str(user_dir))
    print(f"Deleted user '{username}'")


def reset_guest():
    """Wipe guest databases and sessions, then recreate fresh."""
    conn = _ensure_users_db()
    conn.execute("DELETE FROM sessions WHERE username = 'guest'")
    conn.commit()
    conn.close()

    guest_dir = USERS_DIR / "guest"
    if guest_dir.exists():
        shutil.rmtree(str(guest_dir))

    # Ensure guest user exists in users.db
    conn = _ensure_users_db()
    if not conn.execute("SELECT 1 FROM users WHERE username = 'guest'").fetchone():
        conn.execute(
            "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES ('guest', '', 1, ?)",
            (now(),),
        )
        conn.commit()
    conn.close()

    _create_user_db("guest")
    print("Guest account reset.")


def set_password(username, password):
    conn = _ensure_users_db()
    if not conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        print(f"User '{username}' not found.")
        conn.close()
        return
    if not password:
        print("Password cannot be empty.")
        conn.close()
        return
    pwhash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    conn.execute("UPDATE users SET password_hash = ? WHERE username = ?", (pwhash, username))
    conn.commit()
    conn.close()
    print(f"Password set for '{username}'.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python manage.py <command> [args]")
        print("  create-user <username> [password]")
        print("  set-password <username> <password>")
        print("  delete-user <username>")
        print("  list-users")
        print("  reset-guest")
        print("  setup   — create guest account (if not exists)")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "create-user":
        if len(sys.argv) < 3:
            print("Usage: python manage.py create-user <username> [password]")
            sys.exit(1)
        create_user(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "set-password":
        if len(sys.argv) < 4:
            print("Usage: python manage.py set-password <username> <password>")
            sys.exit(1)
        set_password(sys.argv[2], sys.argv[3])
    elif cmd == "delete-user":
        if len(sys.argv) < 3:
            print("Usage: python manage.py delete-user <username>")
            sys.exit(1)
        delete_user(sys.argv[2])
    elif cmd == "list-users":
        list_users()
    elif cmd == "reset-guest":
        reset_guest()
    elif cmd == "setup":
        # Idempotent setup: create guest if absent, ensure all users have DB dirs
        conn = _ensure_users_db()
        rows = conn.execute("SELECT username, is_guest FROM users").fetchall()
        conn.close()
        for user, _is_guest in rows:
            u = USERS_DIR / user
            if not (u / "pages.db").exists():
                _create_user_db(user)
                print(f"  repaired: created missing DBs for '{user}'")
        # Ensure guest exists
        if not any(r[0] == "guest" for r in rows):
            conn = _ensure_users_db()
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES ('guest', '', 1, ?)",
                (now(),),
            )
            conn.commit()
            conn.close()
            _create_user_db("guest")
            print("  created guest account")
        print("Setup complete.")
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)

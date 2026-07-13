#!/usr/bin/env python3
"""CLI for managing Gamma users. Run from the backend/ directory.

Usage:
  python manage.py create-user <username> [password]
  python manage.py set-password <username> <password>
  python manage.py set-admin <username> <on|off>   # admin = privilege flag, manages users in the GUI
  python manage.py rename-user <old> <new>
  python manage.py delete-user <username>
  python manage.py list-users
  python manage.py reset-guest      # wipe guest data (auto-runs daily)
  python manage.py setup            # idempotent: create guest + repair missing per-user DBs

Respects GAMMA_DATA_DIR (defaults to this directory).
"""

import re
import shutil
import sys

import bcrypt

from gamma.config import USERS_DIR
from gamma.db import connect_users_db, page_now
from gamma.seed import create_user_dbs, ensure_guest_user, reset_guest_data


def create_user(username, password=None):
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    with connect_users_db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            print(f"User '{username}' already exists.")
            return
        pwhash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode() if password else ""
        is_guest = 0 if password else 1
        conn.execute(
            "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, ?, ?)",
            (username, pwhash, is_guest, page_now()),
        )
        conn.commit()

    create_user_dbs(username)
    tag = " (no password)" if not password else ""
    print(f"Created user '{username}'{tag}")


def list_users():
    with connect_users_db() as conn:
        rows = conn.execute(
            "SELECT username, is_guest, is_admin, created_at FROM users ORDER BY created_at"
        ).fetchall()
    if not rows:
        print("No users.")
    for user, is_guest, is_admin, created in rows:
        tag = " [guest]" if is_guest else (" [admin]" if is_admin else "")
        print(f"  {user}{tag}  ({created})")


def set_admin(username, value):
    if value not in ("on", "off"):
        print("Usage: python manage.py set-admin <username> <on|off>")
        return
    if username == "guest":
        print("The guest account cannot be an admin.")
        return
    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            print(f"User '{username}' not found.")
            return
        conn.execute("UPDATE users SET is_admin = ? WHERE username = ?",
                     (1 if value == "on" else 0, username))
        conn.commit()
    print(f"Admin privilege {'granted to' if value == 'on' else 'revoked from'} '{username}'.")


def delete_user(username):
    if username == "guest":
        print("Use 'reset-guest' to reset the guest account.")
        return
    with connect_users_db() as conn:
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.execute("DELETE FROM shares WHERE username = ?", (username,))
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
    user_dir = USERS_DIR / username
    if user_dir.exists():
        shutil.rmtree(str(user_dir))
    print(f"Deleted user '{username}'")


def reset_guest():
    """Wipe guest databases and sessions, then recreate fresh."""
    with connect_users_db() as conn:
        conn.execute("DELETE FROM sessions WHERE username = 'guest'")
        conn.commit()
    ensure_guest_user()
    reset_guest_data()
    print("Guest account reset.")


def rename_user(old, new):
    """Rename an account: users/sessions/shares rows + the users/<name> data dir.

    Sessions and share tokens keep working (they are keyed by token, the
    username column is updated in place), so nobody gets logged out.
    """
    if old == "guest":
        print("The guest account cannot be renamed.")
        return
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", new):
        print("New username must be 1-64 chars of letters, digits, '_', '.', '-' (it names a data directory).")
        return
    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (old,)).fetchone():
            print(f"User '{old}' not found.")
            return
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (new,)).fetchone():
            print(f"User '{new}' already exists.")
            return
        conn.execute("UPDATE users SET username = ? WHERE username = ?", (new, old))
        conn.execute("UPDATE sessions SET username = ? WHERE username = ?", (new, old))
        conn.execute("UPDATE shares SET username = ? WHERE username = ?", (new, old))
        conn.commit()
    old_dir, new_dir = USERS_DIR / old, USERS_DIR / new
    if old_dir.exists():
        try:
            old_dir.rename(new_dir)
        except OSError as e:
            print(f"Account row renamed, but moving {old_dir} -> {new_dir} failed: {e}")
            print("Stop the server (open database handles lock the directory on Windows), "
                  "move the folder manually, then everything is consistent.")
            return
    print(f"Renamed user '{old}' -> '{new}'")


def set_password(username, password):
    if not password:
        print("Password cannot be empty.")
        return
    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            print(f"User '{username}' not found.")
            return
        pwhash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        conn.execute("UPDATE users SET password_hash = ? WHERE username = ?", (pwhash, username))
        conn.commit()
    print(f"Password set for '{username}'.")


def setup():
    """Idempotent setup: create guest if absent, repair missing per-user DBs."""
    with connect_users_db() as conn:
        rows = conn.execute("SELECT username, is_guest FROM users").fetchall()
    for user, _is_guest in rows:
        if not (USERS_DIR / user / "pages.db").exists():
            create_user_dbs(user)
            print(f"  repaired: created missing DBs for '{user}'")
    if not any(r[0] == "guest" for r in rows):
        ensure_guest_user()
        create_user_dbs("guest")
        print("  created guest account")
    print("Setup complete.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
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
    elif cmd == "set-admin":
        if len(sys.argv) < 4:
            print("Usage: python manage.py set-admin <username> <on|off>")
            sys.exit(1)
        set_admin(sys.argv[2], sys.argv[3])
    elif cmd == "rename-user":
        if len(sys.argv) < 4:
            print("Usage: python manage.py rename-user <old> <new>")
            sys.exit(1)
        rename_user(sys.argv[2], sys.argv[3])
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
        setup()
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

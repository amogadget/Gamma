#!/usr/bin/env python3
"""CLI for managing Gamma users. Run from the backend/ directory.

Usage:
  python manage.py create-user <username> [password]
  python manage.py set-password <username> <password>
  python manage.py delete-user <username>
  python manage.py list-users
  python manage.py reset-guest      # wipe guest data (auto-runs daily)
  python manage.py setup            # idempotent: create guest + repair missing per-user DBs

Respects GAMMA_DATA_DIR (defaults to this directory).
"""

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
            "SELECT username, is_guest, created_at FROM users ORDER BY created_at"
        ).fetchall()
    if not rows:
        print("No users.")
    for user, is_guest, created in rows:
        tag = " [guest]" if is_guest else ""
        print(f"  {user}{tag}  ({created})")


def delete_user(username):
    if username == "guest":
        print("Use 'reset-guest' to reset the guest account.")
        return
    with connect_users_db() as conn:
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
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

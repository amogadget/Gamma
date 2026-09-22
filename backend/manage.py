#!/usr/bin/env python3
"""CLI for managing Gamma accounts, workspaces and the data directory. Run
from the backend/ directory, with the server STOPPED for anything that moves
files (migrate on Windows, delete-user).

Usage:
  python manage.py create-user <username> [password]
  python manage.py set-password <username> <password>
  python manage.py set-admin <username> <on|off>   # admin = privilege flag, manages users in the GUI
  python manage.py list-identities | link-identity <user> <sub> <username> [email] | unlink-identity <user>
                                                   # Sign in with Gamma Cloud (docs/dev/cloud_accounts.md)
  python manage.py rename-user <old> <new>
  python manage.py delete-user <username>          # + the workspaces only they owned
  python manage.py list-users
  python manage.py list-workspaces                 # every workspace, access, members, size
  python manage.py create-workspace <name> <owner> [shared [public [viewer|editor]]]
  python manage.py set-member <workspace-id> <username> <owner|editor|viewer|none>
  python manage.py set-access <workspace-id> <private|public> [viewer|editor]
  python manage.py reset-guest                     # wipe guest data (auto-runs daily)
  python manage.py setup                           # idempotent: guest account + missing workspace files
  python manage.py migrate [--status] [--dry-run]  # upgrade the data directory (also runs at server start)
  python manage.py backups                         # list the snapshots under backups/
  python manage.py backups --create [--uploads] [--label x]   # take one now (databases; + uploads)
  python manage.py backups --restore <name>        # copy one back over the data dir (server stopped!)
  python manage.py backups --delete <name> | --prune

Respects GAMMA_DATA_DIR (defaults to the repo's data/ folder).
"""

import re
import sys

import bcrypt

import json

from gamma import backups as backups_mod, cloud_auth, migrations, workspaces
from gamma.db import SchemaOutdated, connect_users_db, page_now, ws_dir
from gamma.seed import create_account, ensure_guest_user, reset_guest_data


def _guard_schema():
    """Every command but `migrate` needs the data directory at the current
    schema version."""
    try:
        connect_users_db().close()
    except SchemaOutdated as e:
        print(f"{e}")
        sys.exit(2)


def create_user(username, password=None):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", username):
        print("Username must be 1-64 chars of letters, digits, '_', '.', '-'.")
        return
    with connect_users_db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            print(f"User '{username}' already exists.")
            return
    ws = create_account(username, password)
    tag = " (no password)" if not password else ""
    print(f"Created user '{username}'{tag} with personal workspace {ws}")


def list_users():
    with connect_users_db() as conn:
        rows = conn.execute(
            "SELECT username, is_guest, is_admin, created_at, default_workspace FROM users ORDER BY created_at"
        ).fetchall()
    if not rows:
        print("No users.")
    for user, is_guest, is_admin, created, ws in rows:
        tag = " [guest]" if is_guest else (" [admin]" if is_admin else "")
        print(f"  {user}{tag}  ({created})  personal workspace: {ws or '-'}")


def list_workspaces():
    rows = workspaces.all_workspaces()
    if not rows:
        print("No workspaces.")
    for w in rows:
        kind = f"personal:{w['personal']}{' (default)' if w['default'] else ''}" if w["personal"] else (
            f"shared public:{w['public_role']}" if w["access"] == "public" else "shared private")
        quota = f"/{w['quota_mb']} MB" if w.get("quota_mb") else ""
        members = ", ".join(f"{m['username']}:{m['role']}" for m in w["members"])
        print(f"  {w['id']}  {w['name']!r}  [{kind}]  {w['used_bytes'] // (1024 * 1024)} MB{quota}  members: {members}")
    orphans = workspaces.orphan_dirs()
    if orphans:
        print("  directories without a workspace row (inspect / delete by hand): " + ", ".join(orphans))


def set_member(ws, username, role):
    if not workspaces.get(ws):
        print(f"Workspace '{ws}' not found.")
        return
    try:
        if role == "none":
            workspaces.remove_member(ws, username)
            print(f"Removed '{username}' from workspace {ws}.")
        else:
            workspaces.set_member(ws, username, role, by="manage.py")
            print(f"'{username}' is now {role} of workspace {ws}.")
    except ValueError as e:
        print(f"Refused: {e}")


def create_workspace(name, owner, kind="personal", access="private", public_role="viewer"):
    try:
        info = workspaces.create(name, owner, kind=kind, by="manage.py", access=access, public_role=public_role)
    except ValueError as e:
        print(f"Refused: {e}")
        return
    print(f"Created {info['kind']} workspace {info['id']} {info['name']!r} ({info['access']}), owner {owner}.")


def set_access(ws, access, public_role=None):
    info = workspaces.get(ws)
    if not info:
        print(f"Workspace '{ws}' not found.")
        return
    try:
        info = workspaces.set_access(ws, access, public_role or info["public_role"])
    except ValueError as e:
        print(f"Refused: {e}")
        return
    print(f"Workspace {ws} is now {info['access']}"
          + (f" (everyone {info['public_role']})." if info["access"] == "public" else "."))


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
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            print(f"User '{username}' not found.")
            return
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.execute("DELETE FROM identities WHERE username = ?", (username,))
        conn.commit()
    deleted = workspaces.delete_account_workspaces(username)
    with connect_users_db() as conn:
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
    print(f"Deleted user '{username}'" + (f" and workspace(s) {', '.join(deleted)}" if deleted else ""))


def reset_guest():
    """Wipe guest databases and sessions, then recreate fresh."""
    with connect_users_db() as conn:
        conn.execute("DELETE FROM sessions WHERE username = 'guest'")
        conn.commit()
    ensure_guest_user()
    reset_guest_data()
    print("Guest account reset.")


def rename_user(old, new):
    """Rename an account: every row that names it. Sessions and share tokens
    keep working; no files move (workspace directories are named by id)."""
    from gamma.routers.admin import rename_account_rows

    if old == "guest":
        print("The guest account cannot be renamed.")
        return
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", new):
        print("New username must be 1-64 chars of letters, digits, '_', '.', '-'.")
        return
    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (old,)).fetchone():
            print(f"User '{old}' not found.")
            return
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (new,)).fetchone():
            print(f"User '{new}' already exists.")
            return
        rename_account_rows(conn, old, new)
        conn.commit()
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
        # Match the admin API: a password reset invalidates existing access.
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.execute("DELETE FROM integration_tokens WHERE username = ?", (username,))
        conn.commit()
    print(f"Password set for '{username}'.")


def list_identities():
    """Which accounts are linked to a Gamma Cloud account."""
    with connect_users_db() as conn:
        rows = conn.execute("SELECT username, subject, email, claims, last_login_at FROM identities "
                            "WHERE provider = ? ORDER BY username", (cloud_auth.PROVIDER,)).fetchall()
    if not rows:
        print("No account is linked to Gamma Cloud.")
    for username, subject, email, claims, last in rows:
        username = json.loads(claims or "{}").get("username", "")
        print(f"{username:<20} cloud username {username:<20} {email:<30} sub={subject}  last login {last[:10]}")


def link_identity(username, subject, cloud_username, email=""):
    """Link an account to a Gamma Cloud subject by hand (the sign-in flow
    does it itself; this is for a locked-out admin)."""
    with connect_users_db() as conn:
        row = conn.execute("SELECT is_guest FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            print(f"User '{username}' not found.")
            return
        if row[0]:
            print("The guest account cannot be linked.")
            return
        cloud_auth.link(conn, username, {"sub": subject, "preferred_username": cloud_username, "email": email,
                                         "email_verified": True})
        conn.commit()
    print(f"Linked '{username}' to Gamma Cloud subject {subject} (cloud username {cloud_username}).")


def unlink_identity(username):
    """Detach an account's Gamma Cloud identity and sign it out everywhere."""
    with connect_users_db() as conn:
        if not cloud_auth.unlink(conn, username):
            print(f"'{username}' is not linked to Gamma Cloud.")
            return
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.commit()
    print(f"Unlinked '{username}'. Set a password with set-password if it has none.")


def setup():
    """Idempotent setup: the guest account, a personal workspace for every
    account, missing workspace files recreated."""
    with connect_users_db() as conn:
        rows = conn.execute("SELECT username FROM users").fetchall()
    for (user,) in rows:
        ws = workspaces.ensure_personal(user, welcome=user == "guest")
        if not (ws_dir(ws) / "pages.db").exists():
            print(f"  repaired: created missing files for '{user}' ({ws})")
    if not any(r[0] == "guest" for r in rows):
        ensure_guest_user()
        print("  created guest account")
    print("Setup complete.")


def migrate(status_only: bool = False, dry_run: bool = False):
    """Upgrade the data directory to this Gamma's schema version (also done
    at every server start). ``--status`` only reports; ``--dry-run`` reports
    what would run. On Windows stop the server first: an upgrade may move
    directories that open database usernames would lock."""
    st = migrations.status()
    if st["fresh"]:
        print("No data directory yet — nothing to migrate.")
        return
    print(f"Data directory schema version: {st['version']} (this Gamma: {st['target']})")
    if not st["pending"]:
        print("Up to date.")
    else:
        print("Pending steps: " + ", ".join(f"{p['version']} {p['name']}" for p in st["pending"]))
    if status_only or not st["pending"]:
        return
    try:
        result = migrations.ensure_current(dry_run=dry_run)
    except migrations.MigrationError as e:
        print(f"Refused: {e}")
        sys.exit(2)
    if dry_run:
        print("Dry run: nothing changed.")
        return
    print(f"Snapshot of the databases before the upgrade: {result['backup']}")
    print("Applied: " + ", ".join(result["applied"]))
    print(f"Now at schema version {result['to']}.")


def backups(args: list):
    """List / create / delete / restore / prune the snapshots under backups/."""
    def arg(flag):
        return args[args.index(flag) + 1] if flag in args and args.index(flag) + 1 < len(args) else ""
    if "--create" in args:
        label = arg("--label") or "manual"
        try:
            b = backups_mod.create(label, uploads="--uploads" in args)
        except ValueError as e:
            print(f"Refused: {e}")
            sys.exit(2)
        print(f"Created {b['name']} ({b['size_bytes'] // (1024 * 1024)} MB, "
              f"{'with' if b.get('uploads') else 'without'} uploads)")
        return
    if "--delete" in args:
        print("Deleted." if backups_mod.delete(arg("--delete")) else "No such backup.")
        return
    if "--restore" in args:
        name = arg("--restore")
        if not backups_mod.info(name):
            print("No such backup.")
            sys.exit(2)
        try:
            r = backups_mod.restore(name)
        except OSError as e:
            print(f"Restore failed (is the server stopped?): {e}")
            sys.exit(2)
        print(f"Restored {r['files']} file(s) from {name}. Start the server; it will migrate the "
              f"restored data if the snapshot predates this Gamma.")
        return
    rows = backups_mod.list_backups()
    if not rows:
        print("No backups.")
    for b in rows:
        print(f"  {b['name']}  schema v{b.get('schema_version', '?')}  {len(b.get('files', []))} db file(s)"
              f"{' + uploads' if b.get('uploads') else ''}  {b['size_bytes'] // (1024 * 1024)} MB")
    if "--prune" in args:
        removed = backups_mod.prune_backups()
        print("Pruned: " + (", ".join(removed) if removed else "nothing"))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "migrate":
        migrate(status_only="--status" in args, dry_run="--dry-run" in args)
        return
    if cmd == "backups":
        backups(args)
        return
    _guard_schema()
    if cmd == "create-user":
        if len(args) < 1:
            print("Usage: python manage.py create-user <username> [password]")
            sys.exit(1)
        create_user(args[0], args[1] if len(args) > 1 else None)
    elif cmd == "set-password":
        if len(args) < 2:
            print("Usage: python manage.py set-password <username> <password>")
            sys.exit(1)
        set_password(args[0], args[1])
    elif cmd == "set-admin":
        if len(args) < 2:
            print("Usage: python manage.py set-admin <username> <on|off>")
            sys.exit(1)
        set_admin(args[0], args[1])
    elif cmd == "rename-user":
        if len(args) < 2:
            print("Usage: python manage.py rename-user <old> <new>")
            sys.exit(1)
        rename_user(args[0], args[1])
    elif cmd == "delete-user":
        if len(args) < 1:
            print("Usage: python manage.py delete-user <username>")
            sys.exit(1)
        delete_user(args[0])
    elif cmd == "list-users":
        list_users()
    elif cmd == "list-identities":
        list_identities()
    elif cmd == "link-identity":
        if len(args) < 3:
            print("Usage: python manage.py link-identity <username> <cloud subject> <cloud username> [email]")
            sys.exit(1)
        link_identity(args[0], args[1], args[2], args[3] if len(args) > 3 else "")
    elif cmd == "unlink-identity":
        if len(args) < 1:
            print("Usage: python manage.py unlink-identity <username>")
            sys.exit(1)
        unlink_identity(args[0])
    elif cmd == "list-workspaces":
        list_workspaces()
    elif cmd == "create-workspace":
        if len(args) < 2:
            print("Usage: python manage.py create-workspace <name> <owner> [public [viewer|editor]]")
            sys.exit(1)
        shared = len(args) > 2 and args[2] == "shared"
        create_workspace(args[0], args[1], "shared" if shared else "personal",
                         "public" if shared and len(args) > 3 and args[3] == "public" else "private",
                         args[4] if len(args) > 4 else "viewer")
    elif cmd == "set-access":
        if len(args) < 2:
            print("Usage: python manage.py set-access <workspace-id> <private|public> [viewer|editor]")
            sys.exit(1)
        set_access(args[0], args[1], args[2] if len(args) > 2 else None)
    elif cmd == "set-member":
        if len(args) < 3:
            print("Usage: python manage.py set-member <workspace-id> <username> <owner|editor|viewer|none>")
            sys.exit(1)
        set_member(args[0], args[1], args[2])
    elif cmd == "reset-guest":
        reset_guest()
    elif cmd == "setup":
        setup()
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

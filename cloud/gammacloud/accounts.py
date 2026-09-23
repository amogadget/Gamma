"""Accounts: the rules for usernames, emails and passwords, creation with an
invite, the e-mail links (verify, reset, change-email), plans, deletion.

Everything takes an open connection and commits nothing: the router owns
the transaction so one request is one commit. The ``Problem`` exception
carries the status and the message the API returns; the routers turn it
into an HTTPException.
"""

import re

import bcrypt

from . import config, mail
from .db import after, audit, new_id, new_token, now, token_hash

USERNAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD = 8
MAX_PASSWORD = 200

# A username is the username on every Gamma server and the label of a
# paid container's hostname, so the names Gamma and the web reserve stay
# unavailable.
RESERVED_USERNAMES = {
    "admin", "administrator", "root", "guest", "gamma", "cloud", "account", "accounts", "api", "app",
    "www", "mail", "smtp", "imap", "ftp", "ns", "ns1", "ns2", "dns", "static", "cdn", "assets", "media",
    "help", "support", "billing", "status", "docs", "blog", "dev", "test", "staging", "demo",
    "link", "share", "shares", "sync", "mcp", "oauth", "login", "logout", "register", "signup",
}


class Problem(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# --- validation ---------------------------------------------------------------

def norm_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise Problem(400, "That does not look like an e-mail address.")
    return email


def norm_username(raw: str) -> str:
    username = (raw or "").strip().lower()
    if not USERNAME_RE.match(username):
        raise Problem(400, "A username is 3 to 32 lowercase letters, digits and hyphens, "
                           "starting and ending with a letter or digit.")
    if username in RESERVED_USERNAMES:
        raise Problem(400, "That username is reserved.")
    return username


def check_password(raw: str) -> str:
    if not isinstance(raw, str) or len(raw) < MIN_PASSWORD:
        raise Problem(400, f"A password needs at least {MIN_PASSWORD} characters.")
    if len(raw) > MAX_PASSWORD:
        raise Problem(400, "That password is too long.")
    return raw


def hash_password(raw: str) -> str:
    return bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()


def password_ok(account, raw: str) -> bool:
    if not account or not account["password_hash"]:
        return False
    return bcrypt.checkpw(raw.encode(), account["password_hash"].encode())


def confirm_ok(account, raw: str) -> bool:
    """The password a sensitive change asks for. An account made through
    Google or GitHub has none until it sets one; its session is the proof."""
    return password_ok(account, raw or "") if account["password_hash"] else True


# --- lookup -------------------------------------------------------------------

def by_id(conn, account_id: str):
    return conn.execute("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL", (account_id,)).fetchone()


def by_email(conn, email: str):
    return conn.execute("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL", (email,)).fetchone()


def by_username(conn, username: str):
    return conn.execute("SELECT * FROM accounts WHERE username = ? AND deleted_at IS NULL", (username,)).fetchone()


def by_login(conn, login: str):
    """The account a sign-in form names: an e-mail address or a username."""
    login = (login or "").strip().lower()
    if "@" in login:
        return by_email(conn, login)
    return by_username(conn, login)


def public(account) -> dict:
    """What the account owner (and ``/api/me``) sees."""
    return {
        "id": account["id"], "username": account["username"], "email": account["email"],
        "email_verified": bool(account["email_verified_at"]), "display_name": account["display_name"],
        "plan": account["plan"], "is_admin": bool(account["is_admin"]), "created_at": account["created_at"],
        "has_password": bool(account["password_hash"]),
    }


# --- creation -----------------------------------------------------------------

def take_invite(conn, code: str) -> str:
    """Consume one use of an invite code; returns the plan it grants. In
    ``open`` mode a missing code is fine; in ``invite`` mode it is required;
    in ``closed`` mode registration is refused before this is reached."""
    code = (code or "").strip()
    if not code:
        if config.REGISTRATION == "open":
            return "free"
        raise Problem(403, "Registration needs an invite code right now.")
    row = conn.execute("SELECT * FROM invites WHERE code = ?", (code,)).fetchone()
    if not row or row["uses_left"] <= 0:
        raise Problem(403, "That invite code is not valid.")
    conn.execute("UPDATE invites SET uses_left = uses_left - 1 WHERE code = ?", (code,))
    return row["plan"]


def create(conn, *, email: str, username: str, password: str | None, plan: str = "free",
           display_name: str = "", verified: bool = False, actor: str = "") -> dict:
    """Insert an account. Uniqueness is checked here so the API can answer
    with a message; the UNIQUE constraints are the backstop. A deleted
    account keeps its e-mail and username for the grace period, so those are
    unavailable too (the message says so)."""
    if conn.execute("SELECT 1 FROM accounts WHERE email = ?", (email,)).fetchone():
        raise Problem(409, "There is already an account with that e-mail address.")
    if conn.execute("SELECT 1 FROM accounts WHERE username = ?", (username,)).fetchone():
        raise Problem(409, "That username is taken.")
    if plan not in config.PLANS:
        raise Problem(400, "unknown plan")
    account_id = new_id()
    ts = now()
    conn.execute(
        "INSERT INTO accounts (id, username, email, email_verified_at, password_hash, display_name, plan, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (account_id, username, email, ts if verified else None, hash_password(password) if password else None,
         display_name[:100], plan, ts))
    audit(conn, "account.create", account_id, actor or account_id, f"username={username} plan={plan}")
    return by_id(conn, account_id)


# --- e-mail links -------------------------------------------------------------

def issue_email_token(conn, account_id: str, kind: str, ttl: int, payload: str = "") -> str:
    """One pending link per (account, kind): issuing a new one voids the
    previous, so a resend never leaves two valid links around."""
    conn.execute("UPDATE email_tokens SET used_at = ? WHERE account_id = ? AND kind = ? AND used_at IS NULL",
                 (now(), account_id, kind))
    token = new_token(32)
    conn.execute("INSERT INTO email_tokens (token_hash, kind, account_id, payload, created_at, expires_at) "
                 "VALUES (?, ?, ?, ?, ?, ?)", (token_hash(token), kind, account_id, payload, now(), after(ttl)))
    return token


def consume_email_token(conn, token: str, kind: str):
    """The (account, payload) a live link names, marking it used; None when
    unknown, expired, used or of another kind."""
    row = conn.execute("SELECT * FROM email_tokens WHERE token_hash = ?", (token_hash(token or ""),)).fetchone()
    if not row or row["kind"] != kind or row["used_at"] or row["expires_at"] <= now():
        return None
    account = by_id(conn, row["account_id"])
    if not account:
        return None
    conn.execute("UPDATE email_tokens SET used_at = ? WHERE token_hash = ?", (now(), row["token_hash"]))
    return account, row["payload"]


def link(path: str, token: str) -> str:
    return f"{config.PUBLIC_URL}{path}?token={token}"


def _hi(account) -> str:
    return f"Hi {account['display_name'] or account['username']},"


def verify_mail(account, token: str) -> tuple[str, str, str]:
    return ("Confirm your Gamma Cloud e-mail address", *mail.compose(
        _hi(account),
        ["Welcome to Gamma Cloud. Confirm this address to finish setting up your account "
         f"@{account['username']}."],
        ("Confirm e-mail address", link("/verify", token)),
        "The link works for one day. If you did not create an account, ignore this mail."))


def reset_mail(account, token: str) -> tuple[str, str, str]:
    return ("Reset your Gamma Cloud password", *mail.compose(
        _hi(account),
        ["Someone asked to reset the password of your Gamma Cloud account. Set a new one here."],
        ("Set a new password", link("/reset/confirm", token)),
        "The link works for one hour. If you did not ask for this, ignore this mail; your password "
        "is unchanged."))


def change_email_mail(account, new_email: str, token: str) -> tuple[str, str, str]:
    return ("Confirm your new Gamma Cloud e-mail address", *mail.compose(
        _hi(account),
        [f"Confirm {new_email} as the address of your Gamma Cloud account."],
        ("Confirm new address", link("/email/confirm", token)),
        "The link works for one day. Until you confirm, your account keeps its current address."))


def email_changed_notice(account, new_email: str) -> tuple[str, str, str]:
    return ("Your Gamma Cloud e-mail address changed", *mail.compose(
        _hi(account),
        [f"The e-mail address of your Gamma Cloud account is now {new_email}."],
        None,
        "If that was not you, reply to this mail."))


# --- changes ------------------------------------------------------------------

def mark_verified(conn, account_id: str) -> None:
    conn.execute("UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
                 (now(), account_id))
    audit(conn, "account.verify", account_id, account_id)


def set_password(conn, account_id: str, password: str, actor: str = "") -> None:
    """Also signs the account out everywhere: portal sessions and every
    OIDC grant (and their access tokens) go."""
    conn.execute("UPDATE accounts SET password_hash = ? WHERE id = ?", (hash_password(password), account_id))
    revoke_everything(conn, account_id)
    audit(conn, "account.password", account_id, actor or account_id)


def set_email(conn, account_id: str, email: str, actor: str = "") -> None:
    if conn.execute("SELECT 1 FROM accounts WHERE email = ? AND id != ?", (email, account_id)).fetchone():
        raise Problem(409, "There is already an account with that e-mail address.")
    conn.execute("UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ?", (email, now(), account_id))
    audit(conn, "account.email", account_id, actor or account_id, email)


def set_username(conn, account_id: str, username: str, actor: str = "") -> None:
    """Rename. The account id (the OIDC ``sub``) is what Gamma servers key
    on, so a rename changes nothing there until the next sign-in refreshes
    the claims; a deleted account's name stays taken through its grace
    period like at registration."""
    username = norm_username(username)
    if conn.execute("SELECT 1 FROM accounts WHERE username = ? AND id != ?", (username, account_id)).fetchone():
        raise Problem(409, "That username is taken.")
    conn.execute("UPDATE accounts SET username = ? WHERE id = ?", (username, account_id))
    audit(conn, "account.username", account_id, actor or account_id, username)


def set_plan(conn, account_id: str, plan: str, actor: str) -> None:
    if plan not in config.PLANS:
        raise Problem(400, "unknown plan")
    conn.execute("UPDATE accounts SET plan = ? WHERE id = ?", (plan, account_id))
    audit(conn, "account.plan", account_id, actor, plan)


def set_admin(conn, account_id: str, is_admin: bool, actor: str) -> None:
    conn.execute("UPDATE accounts SET is_admin = ? WHERE id = ?", (1 if is_admin else 0, account_id))
    audit(conn, "account.admin", account_id, actor, "on" if is_admin else "off")


def set_display_name(conn, account_id: str, name: str) -> None:
    conn.execute("UPDATE accounts SET display_name = ? WHERE id = ?", ((name or "").strip()[:100], account_id))


def revoke_everything(conn, account_id: str) -> None:
    conn.execute("DELETE FROM portal_sessions WHERE account_id = ?", (account_id,))
    conn.execute("UPDATE grants SET revoked_at = ?, refresh_hash = NULL WHERE account_id = ? AND revoked_at IS NULL",
                 (now(), account_id))
    conn.execute("DELETE FROM access_tokens WHERE account_id = ?", (account_id,))


def delete(conn, account_id: str, actor: str = "") -> None:
    """Soft delete: the row keeps its username and e-mail through the grace
    period (``manage.py purge-deleted`` removes it), nothing can sign in as
    it any more (its Google/GitHub links go at once), and its servers'
    teardown is the provisioner's job (v1)."""
    revoke_everything(conn, account_id)
    conn.execute("UPDATE email_tokens SET used_at = ? WHERE account_id = ? AND used_at IS NULL", (now(), account_id))
    conn.execute("UPDATE accounts SET deleted_at = ?, password_hash = NULL WHERE id = ?", (now(), account_id))
    conn.execute("DELETE FROM identities WHERE account_id = ?", (account_id,))
    audit(conn, "account.delete", account_id, actor or account_id)


def purge_deleted(conn, older_than_days: int) -> int:
    """Remove accounts deleted more than N days ago and every row that
    references them. Returns the count."""
    cutoff = after(-older_than_days * 86400)
    rows = conn.execute("SELECT id FROM accounts WHERE deleted_at IS NOT NULL AND deleted_at <= ?", (cutoff,)).fetchall()
    for row in rows:
        for table in ("identities", "portal_sessions", "email_tokens", "grants", "access_tokens"):
            conn.execute(f"DELETE FROM {table} WHERE account_id = ?", (row["id"],))
        conn.execute("DELETE FROM accounts WHERE id = ?", (row["id"],))
        audit(conn, "account.purge", row["id"], "system")
    return len(rows)

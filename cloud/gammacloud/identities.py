"""Sign-in through an outside provider (``providers.py``): which account an
identity is, linking and unlinking, the account a new person creates, and
the ``external_logins`` rows that carry one sign-in across the provider
round trip and the username form after it.

The browser holds a random token in the ``gc_ext`` cookie; the row holds
its hash. The OAuth ``state``, the PKCE verifier and the nonce are derived
from that token (``derive``), so the row holds nothing replayable and the
state the provider sees reveals neither. The one-tap prompt's nonce is
derived the same way from the ``gc_tap`` cookie.

Which account (``resolve``):

- the identity is linked → that account;
- else the provider vouches for an address an account has
  (``email_trusted``) → it is linked to that account. When that account
  never confirmed the address, whoever chose its password never proved
  they own it: the password is cleared and everything signed out;
- else an account has the address but the provider is not authoritative
  for it → refused, with how to connect it from Settings instead;
- else → nobody: the caller offers the signup form (unless registration
  is closed).

An account made here has no password; ``accounts.confirm_ok`` lets such an
account confirm sensitive changes with its session alone, and Settings
offers to set one.
"""

import base64
import hashlib
import re

from . import accounts, config
from .accounts import Problem
from .db import after, audit, new_token, now, token_hash
from .providers import NAMES, Identity

COOKIE = "gc_ext"
TAP_COOKIE = "gc_tap"


def derive(token: str, purpose: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(f"{purpose}:{token}".encode()).digest()).rstrip(b"=").decode()


def safe_next(raw: str) -> str:
    """A local path to land on after signing in; anything else is ``/``."""
    raw = (raw or "").strip()
    if not raw.startswith("/") or raw.startswith("//") or "\\" in raw or len(raw) > 512:
        return "/"
    return raw


# --- the in-flight row --------------------------------------------------------

def start(conn, provider: str, *, next_url: str = "/", request_id: str = "", link_account: str = "") -> str:
    """A new sign-in about to leave for the provider; returns the cookie token."""
    token = new_token(32)
    conn.execute("INSERT INTO external_logins (token_hash, stage, provider, next, request_id, link_account, created_at, "
                 "expires_at) VALUES (?, 'redirect', ?, ?, ?, ?, ?, ?)",
                 (token_hash(token), provider, safe_next(next_url), request_id[:64], link_account, now(),
                  after(config.EXTERNAL_LOGIN_TTL)))
    return token


def load(conn, token: str, stage: str):
    row = conn.execute("SELECT * FROM external_logins WHERE token_hash = ?", (token_hash(token or ""),)).fetchone()
    if not row or row["stage"] != stage or row["expires_at"] <= now():
        return None
    return dict(row)


def drop(conn, token: str) -> None:
    conn.execute("DELETE FROM external_logins WHERE token_hash = ?", (token_hash(token or ""),))


def to_signup(conn, flow: dict, ident: Identity) -> str:
    """Park a verified identity with no account for the username form;
    returns the new cookie token (the old one travelled through the provider
    as the state's source and is not reused)."""
    token = new_token(32)
    conn.execute("INSERT INTO external_logins (token_hash, stage, provider, next, request_id, subject, email, name, "
                 "handle, created_at, expires_at) VALUES (?, 'signup', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (token_hash(token), ident.provider, safe_next(flow.get("next", "/")), flow.get("request_id", ""),
                  ident.subject, ident.email, ident.name, ident.handle, now(), after(config.EXTERNAL_LOGIN_TTL)))
    return token


def set_cookie(response, name: str, token: str, max_age: int | None = None) -> None:
    response.set_cookie(name, token, httponly=True, samesite="lax", secure=config.PUBLIC_URL.startswith("https://"),
                        max_age=max_age, path="/")


def purge_expired(conn) -> None:
    conn.execute("DELETE FROM external_logins WHERE expires_at <= ?", (now(),))


# --- identities ---------------------------------------------------------------

def of_account(conn, account_id: str) -> list[dict]:
    rows = conn.execute("SELECT provider, email, created_at FROM identities WHERE account_id = ? ORDER BY created_at",
                        (account_id,)).fetchall()
    return [dict(r) for r in rows]


def link(conn, account_id: str, ident: Identity, actor: str = "") -> None:
    """One identity per provider per account, one account per identity."""
    row = conn.execute("SELECT account_id FROM identities WHERE provider = ? AND subject = ?",
                       (ident.provider, ident.subject)).fetchone()
    name = NAMES[ident.provider]
    if row:
        if row["account_id"] == account_id:
            return
        raise Problem(409, f"That {name} account already signs in to another Gamma Cloud account.")
    if conn.execute("SELECT 1 FROM identities WHERE account_id = ? AND provider = ?",
                    (account_id, ident.provider)).fetchone():
        raise Problem(409, f"This account is connected to a different {name} account. Disconnect it first.")
    conn.execute("INSERT INTO identities (provider, subject, account_id, email, created_at) VALUES (?, ?, ?, ?, ?)",
                 (ident.provider, ident.subject, account_id, ident.email, now()))
    audit(conn, "identity.link", account_id, actor or account_id, f"{ident.provider} {ident.email}")


def unlink(conn, account, provider: str) -> None:
    others = conn.execute("SELECT COUNT(*) FROM identities WHERE account_id = ? AND provider != ?",
                          (account["id"], provider)).fetchone()[0]
    if not account["password_hash"] and not others:
        raise Problem(400, "Set a password first — otherwise nothing could sign in to this account.")
    cur = conn.execute("DELETE FROM identities WHERE account_id = ? AND provider = ?", (account["id"], provider))
    if not cur.rowcount:
        raise Problem(404, "That account is not connected.")
    audit(conn, "identity.unlink", account["id"], account["id"], provider)


def resolve(conn, ident: Identity):
    """The account this identity signs in to, or None (see the module doc)."""
    name = NAMES[ident.provider]
    row = conn.execute("SELECT account_id FROM identities WHERE provider = ? AND subject = ?",
                       (ident.provider, ident.subject)).fetchone()
    if row:
        account = accounts.by_id(conn, row["account_id"])
        if not account:
            raise Problem(403, f"The Gamma Cloud account this {name} account signed in to was deleted.")
        if ident.email:
            conn.execute("UPDATE identities SET email = ? WHERE provider = ? AND subject = ?",
                         (ident.email, ident.provider, ident.subject))
        return account
    if not ident.email:
        raise Problem(400, f"Your {name} account has no verified e-mail address. Add one there, or sign up with "
                           "your e-mail and a password.")
    account = accounts.by_email(conn, ident.email)
    if not account:
        return None
    if not ident.email_trusted:
        raise Problem(409, f"There is already an account with {ident.email}. Sign in with its password, then "
                           f"connect {name} under Settings.")
    if not account["email_verified_at"]:
        conn.execute("UPDATE accounts SET password_hash = NULL WHERE id = ?", (account["id"],))
        accounts.revoke_everything(conn, account["id"])
        accounts.mark_verified(conn, account["id"])
        audit(conn, "account.claimed", account["id"], f"{ident.provider}:{ident.subject}", ident.email)
    link(conn, account["id"], ident)
    return accounts.by_id(conn, account["id"])


# --- signup -------------------------------------------------------------------

def suggest_username(conn, flow: dict) -> str:
    """A free username from the GitHub login or the address's local part."""
    base = re.sub(r"[^a-z0-9-]+", "-", (flow.get("handle") or flow.get("email", "").split("@")[0]).lower())
    base = re.sub(r"-{2,}", "-", base).strip("-")[:28].strip("-")
    if len(base) < 3:
        base = (base + "-user").strip("-")
    for n in range(0, 50):
        candidate = base if n == 0 else f"{base}-{n + 1}"
        try:
            candidate = accounts.norm_username(candidate)
        except Problem:
            continue
        if not conn.execute("SELECT 1 FROM accounts WHERE username = ?", (candidate,)).fetchone():
            return candidate
    return ""


def create_from(conn, flow: dict, username: str, invite: str):
    """The signup form's answer: an account with the provider's verified
    address and no password, linked to the identity."""
    if config.REGISTRATION == "closed":
        raise Problem(403, "Registration is closed.")
    username = accounts.norm_username(username)
    plan = accounts.take_invite(conn, invite)
    account = accounts.create(conn, email=flow["email"], username=username, password=None, plan=plan,
                              display_name=flow.get("name", ""), verified=True)
    link(conn, account["id"], Identity(flow["provider"], flow["subject"], flow["email"], True))
    return account

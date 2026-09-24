"""Sign in with Gamma Cloud: this server as an OpenID Connect client of the
account server (``cloud/``, docs/dev/cloud_accounts.md), and the identity
seam that turns a verified cloud identity into an ordinary session.

Nothing downstream changes: the callback mints the same ``sessions`` row
the password login does, and every other module keeps reading
``request.state.user``. What this module adds is the ``identities`` table
in users.db — which cloud subject is which local account — and the rules
for an identity this server has not seen (``policy``):

- ``refuse`` (the self-hosted default): only linked accounts sign in;
- ``claim``: an account whose username equals the cloud username and that
  has no cloud identity yet is linked on first sign-in — what a hosted
  container does, whose first admin was seeded under the customer's username;
- ``provision``: a new account is created under the username (empty password,
  so only the cloud can sign it in) with its personal workspace — the free
  share host.

``GAMMA_CLOUD_ADMIN_SUBJECT`` names the one subject that becomes (or claims)
the server admin whatever the policy — how a provisioned container gets its
first admin without a password on the wire.

A signed-in account can also LINK its cloud identity (``start?link=1``),
which is how a desktop user with a local account attaches the cloud
account to it; the policy is not consulted for that.

Configuration lives in the ``settings`` KV (issuer, client id, the secret
Fernet-encrypted with the data directory's key, policy) with ``GAMMA_CLOUD_*``
environment overrides for provisioned containers. Discovery and the JWKS
are fetched from the issuer and cached in memory; an ID token is verified
locally (issuer, audience, nonce, expiry, ``email_verified``) — the account
server is never called on a data request.

The desktop client names this install on its sign-in (``device``: a stable
id kept in the KV, the machine's name, the OS in the user agent), which is
how the account server's Devices page tells machines apart and keeps one
row per machine. A refresh token this server stops holding — replaced by a
newer sign-in, left over from a refused one, dropped by an unlink or a
deletion — is revoked at the account server (``revoke_later``), so no row
there outlives what it stands for.
"""

import hashlib
import json
import platform
import secrets
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlsplit

import jwt
from cryptography.fernet import InvalidToken

from . import config, mcp_oauth
from .chatgpt_oauth import _b64url
from .db import connect_users_db, page_now
from .logbuf import log
from .publisher_sessions import cipher
from .server_settings import _get_raw, _set_raw, public_url_settings, validate_public_url

PROVIDER = "gamma-cloud"
POLICIES = ("refuse", "claim", "provision")
DEFAULT_CLIENT_ID = "gamma-desktop"
SCOPE_DESKTOP = "openid email profile offline_access"
SCOPE_SERVER = "openid email profile"
CALLBACK_PATH = "/api/auth/cloud/callback"
PENDING_TTL = 600
HTTP_TIMEOUT = 15
_DISCOVERY_TTL = 3600
_JWKS_TTL = 3600


class CloudAuthError(Exception):
    """A message safe to show the person on the login page."""


def _conn() -> sqlite3.Connection:
    conn = connect_users_db()
    conn.row_factory = sqlite3.Row
    return conn


# --- settings -----------------------------------------------------------------

def settings() -> dict:
    """The effective configuration: ``issuer``, ``client_id``, ``policy``,
    ``has_secret``, ``enabled``, and ``source`` (``environment`` when
    ``GAMMA_CLOUD_ISSUER`` is set, else ``saved``). The secret itself is
    never returned."""
    env = config.cloud_env()
    if env["issuer"]:
        return {"issuer": env["issuer"], "client_id": env["client_id"] or DEFAULT_CLIENT_ID,
                "policy": env["policy"] if env["policy"] in POLICIES else "refuse",
                "has_secret": bool(env["client_secret"]), "enabled": True, "source": "environment"}
    issuer = _get_raw("cloud_issuer")
    client_id = _get_raw("cloud_client_id")
    policy = _get_raw("cloud_policy")
    has_secret = bool(_get_raw("cloud_client_secret"))
    return {"issuer": issuer, "client_id": client_id or DEFAULT_CLIENT_ID,
            "policy": policy if policy in POLICIES else "refuse",
            "has_secret": has_secret, "enabled": bool(issuer), "source": "saved"}


def client_secret() -> str:
    env = config.cloud_env()
    if env["issuer"]:
        return env["client_secret"]
    stored = _get_raw("cloud_client_secret")
    if not stored:
        return ""
    try:
        return cipher().decrypt(stored.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        log.warning("cloud sign-in: the stored client secret cannot be decrypted (key changed?)")
        return ""


def validate_issuer(value: str) -> str:
    value = (value or "").strip().rstrip("/")
    if not value:
        return ""
    try:
        return validate_public_url(value)
    except ValueError:
        raise ValueError("The issuer is the account server's HTTPS address without a path (HTTP only for localhost).") from None


def save_settings(*, issuer=None, client_id=None, client_secret=None, policy=None) -> None:
    """Admin edits (Settings → Server → Sign-in). ``None`` leaves a value;
    an empty issuer turns cloud sign-in off; an empty secret clears it."""
    if config.cloud_env()["issuer"]:
        raise ValueError("Cloud sign-in is managed by GAMMA_CLOUD_* on this server.")
    if issuer is not None:
        _set_raw("cloud_issuer", validate_issuer(issuer))
        _discovery_cache.clear()
        _jwks_cache.clear()
    if client_id is not None:
        client_id = client_id.strip()
        if client_id and len(client_id) > 100:
            raise ValueError("client id too long")
        _set_raw("cloud_client_id", client_id)
    if client_secret is not None:
        secret = client_secret.strip()
        _set_raw("cloud_client_secret", cipher().encrypt(secret.encode("utf-8")).decode("ascii") if secret else "")
    if policy is not None:
        if policy not in POLICIES:
            raise ValueError("policy must be refuse, claim or provision")
        _set_raw("cloud_policy", policy)


# --- the account server -------------------------------------------------------

_discovery_cache: dict = {}
_jwks_cache: dict = {}


def _http(url: str, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers={"Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except ValueError:
            body = {}
        raise CloudAuthError(body.get("error_description") or body.get("error") or f"account server answered {e.code}") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise CloudAuthError(f"cannot reach the account server: {e}") from e


def discovery(issuer: str) -> dict:
    cached = _discovery_cache.get(issuer)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    doc = _http(issuer + "/.well-known/openid-configuration")
    if doc.get("issuer") != issuer:
        raise CloudAuthError("the account server's issuer does not match the configured address")
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not str(doc.get(key, "")).startswith(issuer + "/"):
            raise CloudAuthError(f"the account server's {key} is not under its issuer")
    _discovery_cache[issuer] = (time.monotonic() + _DISCOVERY_TTL, doc)
    return doc


def _jwks(issuer: str, jwks_uri: str, *, kid: str) -> dict:
    """The JWKS, refetched when the key id is unknown (a rotation)."""
    cached = _jwks_cache.get(issuer)
    if cached and cached[0] > time.monotonic() and any(k.get("kid") == kid for k in cached[1].get("keys", [])):
        return cached[1]
    doc = _http(jwks_uri)
    _jwks_cache[issuer] = (time.monotonic() + _JWKS_TTL, doc)
    return doc


def verify_id_token(token: str, *, issuer: str, client_id: str, nonce: str) -> dict:
    try:
        header = jwt.get_unverified_header(token)
        doc = discovery(issuer)
        keys = _jwks(issuer, doc["jwks_uri"], kid=str(header.get("kid", "")))
        key = next((k for k in keys.get("keys", []) if k.get("kid") == header.get("kid")), None)
        if key is None:
            raise CloudAuthError("the account server's signing key is unknown")
        claims = jwt.decode(token, jwt.PyJWK(key).key, algorithms=["EdDSA"], audience=client_id, issuer=issuer,
                            options={"require": ["exp", "iat", "sub"]}, leeway=30)
    except jwt.PyJWTError as e:
        raise CloudAuthError(f"the sign-in token is not valid: {e}") from e
    if nonce and claims.get("nonce") != nonce:
        raise CloudAuthError("the sign-in token does not belong to this sign-in")
    if not claims.get("email_verified"):
        raise CloudAuthError("Confirm your e-mail address on your Gamma Cloud account first.")
    if not claims.get("preferred_username"):
        raise CloudAuthError("the sign-in token names no username")
    return claims


# --- the flow -----------------------------------------------------------------

def callback_base(request) -> str:
    """This server's address for the callback: the admin-confirmed public
    URL, else the request's own origin (a local sidecar on 127.0.0.1)."""
    # Unlike mcp_oauth.public_base, no Host checks: a plain-HTTP LAN origin
    # or a sidecar without a confirmed public URL must still reach the callback.
    configured = public_url_settings()["public_url"]
    return configured or str(request.base_url).rstrip("/")


def begin(request, *, link_user: str | None, next_path: str) -> str:
    """Store the pending sign-in and return the account server's authorize
    URL to send the browser to."""
    cfg = settings()
    if not cfg["enabled"]:
        raise CloudAuthError("Cloud sign-in is not set up on this server.")
    doc = discovery(cfg["issuer"])
    base = callback_base(request)
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    nonce = secrets.token_urlsafe(16)
    mcp_oauth.store("cloud_login", base, state,
                    {"verifier": verifier, "nonce": nonce, "link_user": link_user or "", "next": next_path,
                     "redirect_uri": base + CALLBACK_PATH}, PENDING_TTL)
    scope = SCOPE_DESKTOP if cfg["client_id"] == DEFAULT_CLIENT_ID else SCOPE_SERVER
    params = {"response_type": "code", "client_id": cfg["client_id"], "redirect_uri": base + CALLBACK_PATH,
              "scope": scope, "state": state, "nonce": nonce,
              "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256"}
    return doc["authorization_endpoint"] + "?" + urllib.parse.urlencode(params)


def device() -> tuple[str, str]:
    """This install's (stable id, machine name) for the desktop client's
    sign-in. The id is made on first use and kept in the settings KV."""
    device_id = _get_raw("cloud_device_id")
    if not device_id:
        device_id = secrets.token_urlsafe(16)
        _set_raw("cloud_device_id", device_id)
    return device_id, socket.gethostname()[:64]


def _user_agent(base: str) -> str:
    """``Gamma/<version> (<system>; <address>)``: what the Devices page reads."""
    from . import version
    system = {"Darwin": "macOS"}.get(platform.system(), platform.system()) or "unknown system"
    return f"Gamma/{version.label()} ({system}; {base})"


def exchange(request, *, code: str, state: str) -> tuple[dict, dict, str]:
    """The callback's first half: (claims, tokens, next path) for a valid
    code + state, or CloudAuthError. A token set whose ID token fails the
    checks has its refresh token revoked."""
    cfg = settings()
    base = callback_base(request)
    pending = mcp_oauth.load("cloud_login", base, state or "", consume=True) if state else None
    if not pending:
        raise CloudAuthError("This sign-in expired or was already used. Start again.")
    doc = discovery(cfg["issuer"])
    form = {"grant_type": "authorization_code", "code": code, "redirect_uri": pending["redirect_uri"],
            "client_id": cfg["client_id"], "code_verifier": pending["verifier"]}
    secret = client_secret()
    if secret:
        form["client_secret"] = secret
    if cfg["client_id"] == DEFAULT_CLIENT_ID:
        form["device_id"], form["device_name"] = device()
    tokens = _http(doc["token_endpoint"], data=urllib.parse.urlencode(form).encode(),
                   headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": _user_agent(base)})
    try:
        if not tokens.get("id_token"):
            raise CloudAuthError("the account server returned no identity token")
        claims = verify_id_token(tokens["id_token"], issuer=cfg["issuer"], client_id=cfg["client_id"],
                                 nonce=pending["nonce"])
    except CloudAuthError:
        revoke_later([tokens.get("refresh_token", "")])
        raise
    claims["_link_user"] = pending["link_user"]
    return claims, tokens, pending["next"] or "/"


# --- identities ---------------------------------------------------------------

def identity_of(conn, username: str):
    return conn.execute("SELECT * FROM identities WHERE provider = ? AND username = ?", (PROVIDER, username)).fetchone()


def identity_by_subject(conn, subject: str):
    return conn.execute("SELECT * FROM identities WHERE provider = ? AND subject = ?", (PROVIDER, subject)).fetchone()


def _public_claims(claims: dict) -> dict:
    out = {k: claims[k] for k in ("plan", "email", "email_verified", "name") if k in claims}
    out["username"] = claims.get("preferred_username", "")
    return out


def _decrypt(stored: str) -> str:
    try:
        return cipher().decrypt(stored.encode("ascii")).decode() if stored else ""
    except (InvalidToken, ValueError):
        return ""


def link(conn, username: str, claims: dict, refresh_token: str = "") -> str:
    """Insert or refresh the identity row of ``username``. The refresh token
    (desktop client only) is Fernet-encrypted at rest. Returns the refresh
    token a new one replaced, for the caller to revoke once committed."""
    old = conn.execute("SELECT refresh_token FROM identities WHERE provider = ? AND subject = ?",
                       (PROVIDER, claims["sub"])).fetchone()  # conn may or may not return Rows
    replaced = _decrypt(old[0]) if old and refresh_token else ""
    stored_refresh = cipher().encrypt(refresh_token.encode()).decode("ascii") if refresh_token else ""
    now = page_now()
    conn.execute(
        "INSERT INTO identities (provider, subject, username, email, claims, refresh_token, created_at, last_login_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET username = excluded.username, "
        "email = excluded.email, claims = excluded.claims, last_login_at = excluded.last_login_at, "
        "refresh_token = CASE WHEN excluded.refresh_token = '' THEN identities.refresh_token ELSE excluded.refresh_token END",
        (PROVIDER, claims["sub"], username, claims.get("email", ""), json.dumps(_public_claims(claims)),
         stored_refresh, now, now))
    return replaced if replaced != refresh_token else ""


def unlink(conn, username: str) -> bool:
    cur = conn.execute("DELETE FROM identities WHERE provider = ? AND username = ?", (PROVIDER, username))
    return bool(cur.rowcount)


def status_of(username: str) -> dict | None:
    """What the account page shows: the linked cloud identity, or None."""
    with _conn() as conn:
        row = identity_of(conn, username)
    if not row:
        return None
    return {"subject": row["subject"], "email": row["email"], **json.loads(row["claims"] or "{}"),
            "linked_at": row["created_at"], "last_login_at": row["last_login_at"], "offline": bool(row["refresh_token"])}


def refresh_token_of(username: str) -> str:
    with _conn() as conn:
        row = identity_of(conn, username)
    return _decrypt(row["refresh_token"]) if row else ""


def revoke_refresh(token: str) -> None:
    """Tell the account server this server no longer holds a refresh token
    (RFC 7009), so its grant leaves the person's Devices page. Best effort:
    a failure is logged, never raised."""
    cfg = settings()
    if not token or not cfg["enabled"]:
        return
    try:
        endpoint = str(discovery(cfg["issuer"]).get("revocation_endpoint", ""))
        if not endpoint.startswith(cfg["issuer"] + "/"):
            return
        form = {"token": token, "token_type_hint": "refresh_token", "client_id": cfg["client_id"]}
        secret = client_secret()
        if secret:
            form["client_secret"] = secret
        _http(endpoint, data=urllib.parse.urlencode(form).encode(),
              headers={"Content-Type": "application/x-www-form-urlencoded"})
    except CloudAuthError as e:
        log.warning(f"cloud sign-in: could not revoke a refresh token at the account server: {e}")


def revoke_later(tokens) -> None:
    """``revoke_refresh`` each token on a background thread: a sign-in,
    unlink or deletion never waits on the account server."""
    tokens = [t for t in tokens if t]
    if tokens:
        threading.Thread(target=lambda: [revoke_refresh(t) for t in tokens], name="cloud-revoke", daemon=True).start()


def resolve_account(claims: dict) -> str:
    """The callback's second half: the local username this identity signs
    in as — linking, claiming or provisioning per the rules in the module
    docstring — or CloudAuthError. Commits, then revokes the refresh token
    the new one replaced."""
    stale: list[str] = []
    username = _resolve(claims, stale)
    revoke_later(stale)
    return username


def _resolve(claims: dict, stale: list[str]) -> str:
    from . import seed

    cfg = settings()
    subject = claims["sub"]
    username = claims["preferred_username"]
    link_user = claims.get("_link_user") or ""
    admin_subject = config.cloud_env()["admin_subject"]
    with _conn() as conn:
        known = identity_by_subject(conn, subject)
        if link_user:
            if known and known["username"] != link_user:
                raise CloudAuthError(f"That Gamma Cloud account is already linked to \"{known['username']}\".")
            mine = identity_of(conn, link_user)
            if mine and mine["subject"] != subject:
                raise CloudAuthError(f"\"{link_user}\" is already linked to another Gamma Cloud account. Unlink it first.")
            if conn.execute("SELECT is_guest FROM users WHERE username = ?", (link_user,)).fetchone()[0]:
                raise CloudAuthError("The guest account cannot be linked.")
            stale.append(link(conn, link_user, claims, claims.get("_refresh_token", "")))
            conn.commit()
            log.info(f"cloud sign-in: linked {link_user} to cloud username {username}")
            return link_user
        if known:
            stale.append(link(conn, known["username"], claims, claims.get("_refresh_token", "")))
            conn.commit()
            return known["username"]
        row = conn.execute("SELECT username, is_guest FROM users WHERE username = ?", (username,)).fetchone()
        if row is None:
            # Cloud usernames are lowercase; a local username may not be. One
            # case-insensitive match claims, an ambiguous set does not.
            rows = conn.execute("SELECT username, is_guest FROM users WHERE LOWER(username) = ?", (username,)).fetchall()
            if len(rows) == 1:
                row = rows[0]
        exists = bool(row) and not row["is_guest"]
        local = row["username"] if row else username
        taken = bool(row) and (row["is_guest"] or identity_of(conn, local) is not None)
        is_admin_seed = bool(admin_subject) and subject == admin_subject
        if taken:
            raise CloudAuthError(f"The username \"{local}\" on this server belongs to someone else. "
                                 "Sign in with that account and link it, or ask the admin.")
        if exists:
            if not (cfg["policy"] == "claim" or is_admin_seed):
                raise CloudAuthError(f"\"{local}\" exists on this server but is not linked to your Gamma Cloud "
                                     "account. Sign in with its password and link it from Settings → Account.")
            stale.append(link(conn, local, claims, claims.get("_refresh_token", "")))
            if is_admin_seed:
                conn.execute("UPDATE users SET is_admin = 1 WHERE username = ?", (local,))
            conn.commit()
            log.info(f"cloud sign-in: {local} claimed by cloud username {username}")
            return local
        if not (cfg["policy"] == "provision" or is_admin_seed):
            raise CloudAuthError("Your Gamma Cloud account is not linked to an account on this server. "
                                 "Ask the admin to create one, or sign in with a password and link it.")
    # New account: the seed helper makes the row + personal workspace.
    seed.create_cloud_account(username, is_admin=is_admin_seed)
    with connect_users_db() as conn:
        stale.append(link(conn, username, claims, claims.get("_refresh_token", "")))
        conn.commit()
    log.info(f"cloud sign-in: provisioned account {username}" + (" (admin)" if is_admin_seed else ""))
    return username


def safe_next(raw: str) -> str:
    """A same-origin path to return to after sign-in, else ``/``."""
    raw = (raw or "").strip()
    if not raw.startswith("/") or raw.startswith("//") or len(raw) > 2048:
        return "/"
    if urlsplit(raw).netloc:
        return "/"
    return raw

"""The OpenID Connect provider: what a Gamma server (a local sidecar, the
free share host, a paid container) uses to sign a person in.

Authorization code with PKCE (S256, required for every client), ID tokens
signed EdDSA (Ed25519) with keys kept in ``signing_keys`` and published at
``/jwks``, opaque access tokens (hashed in ``access_tokens``), rotating
refresh tokens (hashed on ``grants``). Gamma servers verify an ID token
with the cached JWKS and never call back on a data request.

Clients:
- the **desktop** client (``config.DESKTOP_CLIENT_ID``): public, no secret,
  not in the table; its redirect URI must be
  ``http://127.0.0.1:<any port>/api/auth/cloud/callback`` (or localhost /
  [::1]), which is what a local Gamma sidecar listens on. The only client
  that may ask for ``offline_access`` (a refresh token, so a laptop signs
  in while offline).
- **share-host** and **container** clients: confidential, one row each,
  created at provisioning, exact redirect URIs.

Timing: an authorize request lives AUTHORIZE_REQUEST_TTL while the person
signs in; a code AUTH_CODE_TTL; an access token ACCESS_TOKEN_TTL; an ID
token ID_TOKEN_TTL; a refresh token REFRESH_TOKEN_TTL from its last
rotation.
"""

import base64
import hashlib
import json
import re
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from . import accounts, config
from .db import after, audit, new_id, new_token, now, parse, token_hash
from .ratelimit import agent_of, ip_of

SCOPES = ("openid", "email", "profile", "offline_access")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
DESKTOP_CALLBACK_PATH = "/api/auth/cloud/callback"
CHALLENGE_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


class OAuthError(Exception):
    """An error the token endpoint answers as ``{"error": code}``; on the
    authorize endpoint it is redirected to the client when the redirect
    URI itself was valid, else shown."""

    def __init__(self, code: str, description: str = "", status: int = 400):
        super().__init__(description or code)
        self.code = code
        self.description = description
        self.status = status


# --- keys ---------------------------------------------------------------------

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def ensure_signing_key(conn):
    """The active key (kid, private key); creates one on first use."""
    row = conn.execute("SELECT * FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1").fetchone()
    if row is None:
        return rotate_key(conn)
    key = serialization.load_pem_private_key(row["private_pem"].encode(), password=None)
    return row["kid"], key


def rotate_key(conn):
    """Retire the active key (it stays in the JWKS for RETIRED_KEY_GRACE so
    tokens it signed still verify) and create a new one."""
    conn.execute("UPDATE signing_keys SET retired_at = ? WHERE retired_at IS NULL", (now(),))
    key = ed25519.Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    kid = new_token(9)
    conn.execute("INSERT INTO signing_keys (kid, private_pem, created_at) VALUES (?, ?, ?)", (kid, pem, now()))
    audit(conn, "key.rotate", actor="system", detail=kid)
    return kid, key


def jwks(conn) -> dict:
    keys = []
    for row in conn.execute("SELECT * FROM signing_keys ORDER BY created_at DESC").fetchall():
        if row["retired_at"] and row["retired_at"] < after(-config.RETIRED_KEY_GRACE):
            continue
        private = serialization.load_pem_private_key(row["private_pem"].encode(), password=None)
        raw = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        keys.append({"kty": "OKP", "crv": "Ed25519", "x": _b64url(raw), "kid": row["kid"], "use": "sig", "alg": "EdDSA"})
    return {"keys": keys}


def discovery() -> dict:
    base = config.PUBLIC_URL
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/authorize",
        "token_endpoint": f"{base}/token",
        "userinfo_endpoint": f"{base}/userinfo",
        "jwks_uri": f"{base}/jwks",
        "revocation_endpoint": f"{base}/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["EdDSA"],
        "scopes_supported": list(SCOPES),
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "code_challenge_methods_supported": ["S256"],
        "claims_supported": ["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "preferred_username", "email",
                             "email_verified", "name", "plan"],
    }


# --- clients ------------------------------------------------------------------

def get_client(conn, client_id: str):
    """A client as a dict, or None. The desktop client is built in."""
    if client_id == config.DESKTOP_CLIENT_ID:
        return {"client_id": client_id, "secret_hash": None, "kind": "desktop", "name": "Gamma desktop app",
                "redirect_uris": [], "server_id": ""}
    row = conn.execute("SELECT * FROM oauth_clients WHERE client_id = ?", (client_id,)).fetchone()
    if not row:
        return None
    return {**dict(row), "redirect_uris": json.loads(row["redirect_uris"])}


def create_client(conn, *, name: str, kind: str, redirect_uris: list[str], server_id: str = "",
                  actor: str = "") -> tuple[str, str]:
    """A confidential client; returns (client_id, secret) — the secret is
    shown once."""
    if kind not in ("share-host", "container"):
        raise accounts.Problem(400, "kind must be share-host or container")
    if not redirect_uris:
        raise accounts.Problem(400, "a redirect URI is required")
    for uri in redirect_uris:
        url = urlsplit(uri)
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in LOOPBACK_HOSTS):
            raise accounts.Problem(400, f"redirect URI must be https: {uri}")
        if url.fragment or url.username or url.password:
            raise accounts.Problem(400, f"bad redirect URI: {uri}")
    client_id = "gc_" + new_token(12)
    secret = new_token(32)
    conn.execute("INSERT INTO oauth_clients (client_id, secret_hash, kind, name, redirect_uris, server_id, created_at) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (client_id, token_hash(secret), kind, name[:100], json.dumps(redirect_uris), server_id, now()))
    audit(conn, "client.create", actor=actor, detail=f"{client_id} {kind} {name}")
    return client_id, secret


def delete_client(conn, client_id: str, actor: str = "") -> bool:
    cur = conn.execute("DELETE FROM oauth_clients WHERE client_id = ?", (client_id,))
    if cur.rowcount:
        conn.execute("UPDATE grants SET revoked_at = ?, refresh_hash = NULL WHERE client_id = ? AND revoked_at IS NULL",
                     (now(), client_id))
        conn.execute("DELETE FROM access_tokens WHERE client_id = ?", (client_id,))
        audit(conn, "client.delete", actor=actor, detail=client_id)
    return bool(cur.rowcount)


def redirect_allowed(client: dict, uri: str) -> bool:
    if not uri or len(uri) > 2048:
        return False
    url = urlsplit(uri)
    if url.fragment or url.username or url.password:
        return False
    if client["kind"] == "desktop":
        return (url.scheme == "http" and url.hostname in LOOPBACK_HOSTS and url.path == DESKTOP_CALLBACK_PATH
                and not url.query)
    return uri in client["redirect_uris"]


def authenticate_client(conn, client_id: str, secret: str | None) -> dict:
    """The client a token request comes from, its secret checked; a public
    client passes without one (PKCE is its proof)."""
    client = get_client(conn, client_id or "")
    if not client:
        raise OAuthError("invalid_client", "unknown client", 401)
    if client["secret_hash"] is not None:
        if not secret or token_hash(secret) != client["secret_hash"]:
            raise OAuthError("invalid_client", "bad client secret", 401)
    return client


# --- authorize ----------------------------------------------------------------

def parse_scope(raw: str, client: dict) -> str:
    wanted = [s for s in (raw or "").split() if s]
    if not wanted or "openid" not in wanted:
        raise OAuthError("invalid_scope", "scope must include openid")
    for s in wanted:
        if s not in SCOPES:
            raise OAuthError("invalid_scope", f"unknown scope {s}")
    if "offline_access" in wanted and client["kind"] != "desktop":
        raise OAuthError("invalid_scope", "only the desktop app may ask for offline_access")
    return " ".join(dict.fromkeys(wanted))


def begin(conn, params: dict) -> dict:
    """Validate an authorize request and store it as pending; returns the
    row. Raises OAuthError with ``status`` 400 for a bad client or redirect
    URI (shown, never redirected) and ``status`` 302 for the rest (the
    caller redirects with the error)."""
    client = get_client(conn, params.get("client_id", ""))
    if not client:
        raise OAuthError("invalid_client", "unknown client", 400)
    redirect_uri = params.get("redirect_uri", "")
    if not redirect_allowed(client, redirect_uri):
        raise OAuthError("invalid_request", "redirect_uri is not registered for this client", 400)
    try:
        if params.get("response_type") != "code":
            raise OAuthError("unsupported_response_type", "only code")
        if params.get("code_challenge_method", "S256") != "S256":
            raise OAuthError("invalid_request", "code_challenge_method must be S256")
        challenge = params.get("code_challenge", "")
        if not CHALLENGE_RE.match(challenge):
            raise OAuthError("invalid_request", "PKCE code_challenge is required")
        scope = parse_scope(params.get("scope", ""), client)
        if len(params.get("state", "")) > 512 or len(params.get("nonce", "")) > 512:
            raise OAuthError("invalid_request", "state or nonce too long")
    except OAuthError as e:
        e.status = 302
        raise
    request_id = new_token(24)
    conn.execute("INSERT INTO oauth_requests (id, client_id, redirect_uri, scope, state, nonce, code_challenge, "
                 "created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (request_id, client["client_id"], redirect_uri, scope, params.get("state", ""),
                  params.get("nonce", ""), challenge, now(), after(config.AUTHORIZE_REQUEST_TTL)))
    return {**dict(conn.execute("SELECT * FROM oauth_requests WHERE id = ?", (request_id,)).fetchone()),
            "client": client}


def pending(conn, request_id: str):
    row = conn.execute("SELECT * FROM oauth_requests WHERE id = ?", (request_id or "",)).fetchone()
    if not row or row["expires_at"] <= now():
        return None
    client = get_client(conn, row["client_id"])
    if not client:
        return None
    return {**dict(row), "client": client}


def finish(conn, req: dict, account) -> str:
    """The person signed in: mint the code, drop the pending request, and
    return the redirect URL. A refused account (unverified) is the
    caller's decision, made before this."""
    code = new_token(32)
    conn.execute("INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, scope, nonce, "
                 "code_challenge, auth_time, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (token_hash(code), req["client_id"], account["id"], req["redirect_uri"], req["scope"], req["nonce"],
                  req["code_challenge"], now(), after(config.AUTH_CODE_TTL)))
    conn.execute("DELETE FROM oauth_requests WHERE id = ?", (req["id"],))
    audit(conn, "oidc.authorize", account["id"], account["id"], req["client_id"])
    return redirect_with(req["redirect_uri"], {"code": code, "state": req["state"]} if req["state"] else {"code": code})


def redirect_with(uri: str, params: dict) -> str:
    from urllib.parse import urlencode
    sep = "&" if "?" in uri else "?"
    return uri + sep + urlencode(params)


# --- token --------------------------------------------------------------------

def _pkce_ok(verifier: str, challenge: str) -> bool:
    if not CHALLENGE_RE.match(verifier or ""):
        return False
    digest = hashlib.sha256(verifier.encode()).digest()
    return _b64url(digest) == challenge


def exchange_code(conn, client: dict, code: str, redirect_uri: str, verifier: str, request=None) -> dict:
    row = conn.execute("SELECT * FROM oauth_codes WHERE code_hash = ?", (token_hash(code or ""),)).fetchone()
    if not row or row["client_id"] != client["client_id"]:
        raise OAuthError("invalid_grant", "unknown code")
    if row["used_at"]:
        # A replayed code: the first exchange's grant is revoked too (RFC 6749 §4.1.2).
        for g in conn.execute("SELECT id FROM grants WHERE account_id = ? AND client_id = ? AND created_at >= ? "
                              "AND revoked_at IS NULL", (row["account_id"], client["client_id"], row["auth_time"])).fetchall():
            revoke_grant(conn, g["id"])
        conn.execute("DELETE FROM access_tokens WHERE account_id = ? AND client_id = ? AND grant_id = ''",
                     (row["account_id"], client["client_id"]))
        raise OAuthError("invalid_grant", "code already used")
    if row["expires_at"] <= now():
        raise OAuthError("invalid_grant", "code expired")
    if row["redirect_uri"] != (redirect_uri or ""):
        raise OAuthError("invalid_grant", "redirect_uri mismatch")
    if not _pkce_ok(verifier, row["code_challenge"]):
        raise OAuthError("invalid_grant", "PKCE verification failed")
    conn.execute("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?", (now(), row["code_hash"]))
    account = accounts.by_id(conn, row["account_id"])
    if not account:
        raise OAuthError("invalid_grant", "account gone")
    grant_id = ""
    refresh = None
    if "offline_access" in row["scope"].split():
        grant_id, refresh = _new_grant(conn, account["id"], client["client_id"], row["scope"], request)
    return _token_response(conn, account, client, row["scope"], grant_id, refresh, nonce=row["nonce"],
                           auth_time=row["auth_time"])


def refresh_grant(conn, client: dict, refresh_token: str, request=None) -> dict:
    row = conn.execute("SELECT * FROM grants WHERE refresh_hash = ?", (token_hash(refresh_token or ""),)).fetchone()
    if not row or row["client_id"] != client["client_id"] or row["revoked_at"]:
        raise OAuthError("invalid_grant", "unknown refresh token")
    if row["expires_at"] <= now():
        conn.execute("UPDATE grants SET revoked_at = ?, refresh_hash = NULL WHERE id = ?", (now(), row["id"]))
        raise OAuthError("invalid_grant", "refresh token expired")
    account = accounts.by_id(conn, row["account_id"])
    if not account:
        raise OAuthError("invalid_grant", "account gone")
    refresh = new_token(32)
    conn.execute("UPDATE grants SET refresh_hash = ?, rotated_at = ?, last_used_at = ?, expires_at = ?, ip = ?, "
                 "user_agent = ? WHERE id = ?",
                 (token_hash(refresh), now(), now(), after(config.REFRESH_TOKEN_TTL), ip_of(request), agent_of(request),
                  row["id"]))
    conn.execute("DELETE FROM access_tokens WHERE grant_id = ?", (row["id"],))
    return _token_response(conn, account, client, row["scope"], row["id"], refresh, nonce="",
                           auth_time=row["created_at"])


def _new_grant(conn, account_id: str, client_id: str, scope: str, request) -> tuple[str, str]:
    grant_id = new_id()
    refresh = new_token(32)
    ts = now()
    conn.execute("INSERT INTO grants (id, account_id, client_id, scope, refresh_hash, created_at, rotated_at, "
                 "last_used_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (grant_id, account_id, client_id, scope, token_hash(refresh), ts, ts, ts,
                  after(config.REFRESH_TOKEN_TTL), ip_of(request), agent_of(request)))
    return grant_id, refresh


def _token_response(conn, account, client, scope, grant_id, refresh, *, nonce, auth_time) -> dict:
    access = new_token(32)
    conn.execute("INSERT INTO access_tokens (token_hash, account_id, client_id, grant_id, scope, expires_at) "
                 "VALUES (?, ?, ?, ?, ?, ?)",
                 (token_hash(access), account["id"], client["client_id"], grant_id, scope, after(config.ACCESS_TOKEN_TTL)))
    out = {"access_token": access, "token_type": "Bearer", "expires_in": config.ACCESS_TOKEN_TTL, "scope": scope,
           "id_token": id_token(conn, account, client["client_id"], scope, nonce=nonce, auth_time=auth_time)}
    if refresh:
        out["refresh_token"] = refresh
    return out


def id_token(conn, account, client_id: str, scope: str, *, nonce: str = "", auth_time: str | None = None) -> str:
    kid, key = ensure_signing_key(conn)
    issued = int(parse(now()).timestamp())
    claims = {"iss": config.PUBLIC_URL, "sub": account["id"], "aud": client_id, "iat": issued,
              "exp": issued + config.ID_TOKEN_TTL,
              "auth_time": int(parse(auth_time).timestamp()) if auth_time else issued}
    claims.update(claims_for(account, scope))
    if nonce:
        claims["nonce"] = nonce
    return jwt.encode(claims, key, algorithm="EdDSA", headers={"kid": kid})


def claims_for(account, scope: str) -> dict:
    """The identity claims a scope unlocks. ``preferred_username`` (the
    account's username) and ``plan`` always travel: a Gamma server needs the
    username for its own account row and the plan for its quota."""
    scopes = scope.split()
    out = {"preferred_username": account["username"], "plan": account["plan"]}
    if "email" in scopes:
        out["email"] = account["email"]
        out["email_verified"] = bool(account["email_verified_at"])
    if "profile" in scopes:
        out["name"] = account["display_name"] or account["username"]
    return out


def resolve_access_token(conn, token: str):
    """(account, token row) for a live bearer token, else None."""
    row = conn.execute("SELECT * FROM access_tokens WHERE token_hash = ?", (token_hash(token or ""),)).fetchone()
    if not row:
        return None
    if row["expires_at"] <= now():
        conn.execute("DELETE FROM access_tokens WHERE token_hash = ?", (row["token_hash"],))
        return None
    account = accounts.by_id(conn, row["account_id"])
    if not account:
        return None
    return account, row


def revoke(conn, client: dict, token: str) -> None:
    """RFC 7009: a refresh token revokes its grant; an access token just
    itself. Unknown tokens succeed silently."""
    h = token_hash(token or "")
    grant = conn.execute("SELECT * FROM grants WHERE refresh_hash = ? AND client_id = ?", (h, client["client_id"])).fetchone()
    if grant:
        revoke_grant(conn, grant["id"])
        return
    conn.execute("DELETE FROM access_tokens WHERE token_hash = ? AND client_id = ?", (h, client["client_id"]))


def revoke_grant(conn, grant_id: str, actor: str = "") -> None:
    conn.execute("UPDATE grants SET revoked_at = ?, refresh_hash = NULL WHERE id = ? AND revoked_at IS NULL",
                 (now(), grant_id))
    conn.execute("DELETE FROM access_tokens WHERE grant_id = ?", (grant_id,))
    if actor:
        audit(conn, "grant.revoke", actor=actor, detail=grant_id)


def devices(conn, account_id: str) -> list[dict]:
    """The live grants of an account — the portal's "signed-in devices"."""
    rows = conn.execute("SELECT * FROM grants WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ? "
                        "ORDER BY last_used_at DESC", (account_id, now())).fetchall()
    out = []
    for r in rows:
        client = get_client(conn, r["client_id"]) or {"name": r["client_id"], "kind": "?"}
        out.append({"id": r["id"], "client": client["name"], "kind": client["kind"], "created_at": r["created_at"],
                    "last_used_at": r["last_used_at"], "ip": r["ip"], "user_agent": r["user_agent"]})
    return out


def purge_expired(conn) -> None:
    ts = now()
    conn.execute("DELETE FROM oauth_requests WHERE expires_at <= ?", (ts,))
    conn.execute("DELETE FROM oauth_codes WHERE expires_at <= ?", (ts,))
    conn.execute("DELETE FROM access_tokens WHERE expires_at <= ?", (ts,))
    conn.execute("DELETE FROM email_tokens WHERE expires_at <= ?", (ts,))
    conn.execute("UPDATE grants SET revoked_at = ?, refresh_hash = NULL WHERE expires_at <= ? AND revoked_at IS NULL",
                 (ts, ts))

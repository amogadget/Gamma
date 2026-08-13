"""ChatGPT subscription sign-in (OAuth PKCE, the flow Codex CLI uses).

Instead of an API key, a provider entry can hold OAuth tokens obtained by
signing in with a ChatGPT account — usage is then covered by the user's
Plus/Pro subscription. The flow targets auth.openai.com with Codex CLI's
public client id; its registered redirect is http://localhost:1455/auth/callback,
which no one listens on when Gamma runs on a remote server — so the UI has the
user paste the (failed-to-load) callback URL back, and the code is exchanged
server-side with the PKCE verifier.

Tokens are stored in the provider entry (data.db `ai-settings` prefs key, same
protection as API keys: never sent back to the browser). Access tokens expire;
ai_runtime() refreshes them lazily via the refresh token.
"""

import base64
import hashlib
import json
import secrets
import time
import urllib.parse
import urllib.request

from .logbuf import log

AUTH_BASE = "https://auth.openai.com"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"  # Codex CLI's public client id
REDIRECT_URI = "http://localhost:1455/auth/callback"
SCOPE = "openid profile email offline_access"

# Refresh slightly early so a token can't expire mid-request.
REFRESH_MARGIN_S = 300


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _jwt_claims(token: str) -> dict:
    """Unverified JWT payload (we only mine ids/expiry out of our own tokens)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def start_auth() -> tuple[str, str, str]:
    """(state, pkce_verifier, authorization_url) for a fresh sign-in."""
    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = _b64url(secrets.token_bytes(24))
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        # Same extras Codex CLI sends — the ChatGPT-account variant of the flow.
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "codex_cli_rs",
    }
    url = f"{AUTH_BASE}/oauth/authorize?{urllib.parse.urlencode(params)}"
    return state, verifier, url


def parse_callback(pasted: str, expect_state: str) -> str:
    """Authorization code from a pasted callback URL (or a bare code).

    Users paste the full http://localhost:1455/auth/callback?code=…&state=…
    address their browser failed to load; tolerate a raw code too."""
    pasted = (pasted or "").strip()
    if not pasted:
        raise ValueError("paste the callback URL from the browser's address bar")
    if "://" in pasted or "?" in pasted or "code=" in pasted:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(pasted).query)
        code = (q.get("code") or [""])[0]
        state = (q.get("state") or [""])[0]
        if not code:
            raise ValueError("no ?code= in the pasted URL — copy the full address the browser was redirected to")
        if state and expect_state and state != expect_state:
            raise ValueError("state mismatch — start the sign-in again and paste the new URL")
        return code
    return pasted  # looks like a bare authorization code


def _token_request(form: dict) -> dict:
    req = urllib.request.Request(
        f"{AUTH_BASE}/oauth/token",
        data=urllib.parse.urlencode(form).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _oauth_entry(tokens: dict, previous: dict | None = None) -> dict:
    """Normalize a token response into what we persist on the provider entry."""
    prev = previous or {}
    access = tokens.get("access_token") or prev.get("access_token") or ""
    id_token = tokens.get("id_token") or ""
    id_claims = _jwt_claims(id_token)
    access_claims = _jwt_claims(access)
    auth_claims = access_claims.get("https://api.openai.com/auth") or id_claims.get("https://api.openai.com/auth") or {}
    account_id = auth_claims.get("chatgpt_account_id") or prev.get("account_id") or ""
    exp = access_claims.get("exp")
    expires_at = int(exp) if isinstance(exp, (int, float)) else int(time.time()) + 3600
    return {
        "access_token": access,
        "refresh_token": tokens.get("refresh_token") or prev.get("refresh_token") or "",
        "account_id": account_id,
        "email": id_claims.get("email") or prev.get("email") or "",
        "expires_at": expires_at,
    }


def exchange_code(code: str, verifier: str) -> dict:
    """Redeem an authorization code; returns the dict stored on the entry."""
    tokens = _token_request(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
        }
    )
    oauth = _oauth_entry(tokens)
    if not oauth["access_token"]:
        raise ValueError("token exchange returned no access token")
    if not oauth["account_id"]:
        raise ValueError("no ChatGPT account id in the token — is this a ChatGPT (not platform) account?")
    return oauth


def needs_refresh(oauth: dict) -> bool:
    exp = oauth.get("expires_at") or 0
    return time.time() > exp - REFRESH_MARGIN_S


def refresh(oauth: dict) -> dict | None:
    """Refreshed copy of the oauth dict, or None when refresh fails (expired /
    revoked grant — the user has to sign in again)."""
    token = oauth.get("refresh_token")
    if not token:
        return None
    try:
        tokens = _token_request(
            {
                "grant_type": "refresh_token",
                "refresh_token": token,
                "client_id": CLIENT_ID,
                "scope": "openid profile email",
            }
        )
        return _oauth_entry(tokens, previous=oauth)
    except Exception as e:
        log.warning(f"[chatgpt-oauth] refresh failed: {e}")
        return None

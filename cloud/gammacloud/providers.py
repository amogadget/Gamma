"""Outside sign-in providers: Google (OpenID Connect) and GitHub (OAuth).

The wire only: the authorize URL a browser is sent to, the code exchange,
and the identity that comes back. Which account an identity is, and the
state that carries a sign-in across the round trip, is ``identities.py``.

Both flows use PKCE. Google's ID token is verified against Google's keys
(the code flow's and the one-tap prompt's alike), with the nonce the
browser's own flow derived. GitHub has no ID token: the access token reads
``/user`` and ``/user/emails`` once and is dropped.

``Identity.email`` is an address the provider says is verified, else empty.
``email_trusted`` says whether the provider is authoritative for it — only
then may it attach to an existing account that has the address (Google:
a Gmail address or a Workspace account, ``hd``, per Google's own guidance;
GitHub: the verified primary address).
"""

import base64
import hashlib
import hmac
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

import jwt

from . import config
from .accounts import Problem
from .log import log

NAMES = {"google": "Google", "github": "GitHub"}

GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN = "https://github.com/login/oauth/access_token"
GITHUB_API = "https://api.github.com"


@dataclass
class Identity:
    provider: str
    subject: str
    email: str
    email_trusted: bool
    name: str = ""
    handle: str = ""      # a username hint: the GitHub login, the address's local part


def enabled() -> list[str]:
    """The providers this server offers, in button order."""
    out = []
    if config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET:
        out.append("google")
    if config.GITHUB_CLIENT_ID and config.GITHUB_CLIENT_SECRET:
        out.append("github")
    return out


def one_tap() -> bool:
    return config.GOOGLE_ONE_TAP and "google" in enabled()


def callback_url(provider: str) -> str:
    return f"{config.PUBLIC_URL}/oauth/{provider}/callback"


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def authorize_url(provider: str, *, state: str, verifier: str, nonce: str) -> str:
    if provider == "google":
        return GOOGLE_AUTHORIZE + "?" + urllib.parse.urlencode({
            "client_id": config.GOOGLE_CLIENT_ID, "redirect_uri": callback_url("google"), "response_type": "code",
            "scope": "openid email profile", "state": state, "nonce": nonce, "prompt": "select_account",
            "code_challenge": _challenge(verifier), "code_challenge_method": "S256"})
    return GITHUB_AUTHORIZE + "?" + urllib.parse.urlencode({
        "client_id": config.GITHUB_CLIENT_ID, "redirect_uri": callback_url("github"), "scope": "read:user user:email",
        "state": state, "code_challenge": _challenge(verifier), "code_challenge_method": "S256"})


def fetch_identity(provider: str, code: str, *, verifier: str, nonce: str) -> Identity:
    """Exchange the callback's code for the identity. Raises Problem with a
    message for the page."""
    if not code:
        raise Problem(400, f"{NAMES[provider]} did not send a sign-in code. Try again.")
    if provider == "google":
        tok = _call(provider, GOOGLE_TOKEN, data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": callback_url("google"),
            "client_id": config.GOOGLE_CLIENT_ID, "client_secret": config.GOOGLE_CLIENT_SECRET,
            "code_verifier": verifier})
        return google_identity(tok.get("id_token", ""), nonce)
    tok = _call(provider, GITHUB_TOKEN, data={
        "code": code, "redirect_uri": callback_url("github"), "client_id": config.GITHUB_CLIENT_ID,
        "client_secret": config.GITHUB_CLIENT_SECRET, "code_verifier": verifier})
    access = tok.get("access_token")
    if not access:  # GitHub answers 200 with an ``error`` field
        log.warning("github token exchange refused: %s", tok.get("error_description") or tok.get("error"))
        raise Problem(400, "GitHub did not accept the sign-in. Try again.")
    return github_identity(_call(provider, f"{GITHUB_API}/user", token=access),
                           _call(provider, f"{GITHUB_API}/user/emails", token=access))


# --- Google ---------------------------------------------------------------------

_google_jwks = None


def _google_key(token: str):
    global _google_jwks
    if _google_jwks is None:
        _google_jwks = jwt.PyJWKClient(GOOGLE_JWKS, cache_keys=True, lifespan=3600, timeout=10)
    return _google_jwks.get_signing_key_from_jwt(token).key


def google_identity(id_token: str, nonce: str) -> Identity:
    """Verify a Google ID token (from the code flow or the one-tap prompt):
    signature, issuer, audience, expiry and our nonce."""
    try:
        claims = jwt.decode(id_token, _google_key(id_token), algorithms=["RS256"], audience=config.GOOGLE_CLIENT_ID,
                            issuer=GOOGLE_ISSUERS, leeway=60, options={"require": ["exp", "iat", "iss", "aud", "sub"]})
    except jwt.PyJWKClientConnectionError as e:
        log.warning("google keys unreachable: %s", e)
        raise Problem(502, "We could not reach Google. Try again in a moment.") from e
    except jwt.PyJWTError as e:
        log.warning("google id token refused: %s", e)
        raise Problem(400, "Google's answer did not check out. Try again.") from e
    if not hmac.compare_digest(str(claims.get("nonce", "")).encode(), nonce.encode()):
        raise Problem(400, "This Google sign-in was not started here. Reload the page and try again.")
    email = str(claims.get("email", "")).strip().lower()
    verified = claims.get("email_verified") in (True, "true")
    if not verified:
        email = ""
    trusted = bool(email) and (email.endswith("@gmail.com") or bool(claims.get("hd")))
    return Identity("google", str(claims["sub"]), email, trusted, str(claims.get("name", ""))[:100],
                    email.split("@")[0])


# --- GitHub ---------------------------------------------------------------------

def github_identity(user: dict, emails: list) -> Identity:
    primary = next((e for e in emails if isinstance(e, dict) and e.get("primary") and e.get("verified")), None)
    email = str(primary.get("email", "")).strip().lower() if primary else ""
    return Identity("github", str(user["id"]), email, bool(email), str(user.get("name") or "")[:100],
                    str(user.get("login") or ""))


# --- HTTP -----------------------------------------------------------------------

def _call(provider: str, url: str, *, data: dict | None = None, token: str = ""):
    """One JSON request to the provider (a form POST when ``data``)."""
    headers = {"Accept": "application/json", "User-Agent": "gamma-cloud"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            detail = json.load(e)
        except ValueError:
            detail = {}
        log.warning("%s answered %s: %s", url, e.code, detail.get("error_description") or detail.get("error") or "")
        raise Problem(400, f"{NAMES[provider]} did not accept the sign-in. Try again.") from e
    except (OSError, ValueError) as e:
        log.warning("%s failed: %s", url, e)
        raise Problem(502, f"We could not reach {NAMES[provider]}. Try again in a moment.") from e

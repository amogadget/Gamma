"""Environment configuration of the account server. Everything is an env
variable with a ``GAMMA_CLOUD_`` prefix; nothing is read from the request.

- ``GAMMA_CLOUD_DATA_DIR`` — where ``cloud.db`` lives (default ``cloud/data``).
  The directory is the secret: it holds the signing keys and every hashed
  token, so it is never world-readable and always backed up encrypted.
- ``GAMMA_CLOUD_PUBLIC_URL`` — the issuer, e.g. ``https://account.gammapdf.com``.
  Every absolute URL (mail links, OIDC metadata) is built from it; the
  request's Host header is never trusted. Default ``http://127.0.0.1:9002``
  for a local run.
- ``GAMMA_CLOUD_REGISTRATION`` — ``open`` / ``invite`` (default; a code from
  ``manage.py invite`` is required) / ``closed``.
- ``GAMMA_CLOUD_MAIL`` — ``console`` (default; links are logged) / ``smtp``
  (``GAMMA_CLOUD_SMTP_HOST``, ``_PORT``, ``_USER``, ``_PASSWORD``,
  ``_STARTTLS``) / ``memory`` (tests). ``GAMMA_CLOUD_MAIL_FROM`` is the
  sender.
- ``GAMMA_CLOUD_TURNSTILE_SECRET`` — when set, register and reset require a
  Cloudflare Turnstile token (``GAMMA_CLOUD_TURNSTILE_SITEKEY`` is handed to
  the pages).
- ``GAMMA_CLOUD_DESKTOP_CLIENT_ID`` — the one public OIDC client every local
  Gamma sidecar is (default ``gamma-desktop``).
- ``GAMMA_CLOUD_GOOGLE_CLIENT_ID`` + ``_SECRET``, ``GAMMA_CLOUD_GITHUB_CLIENT_ID``
  + ``_SECRET`` — sign in with Google / GitHub (``providers.py``); a provider
  is offered only when both of its values are set. Their callback URLs are
  ``<public url>/oauth/<provider>/callback``. ``GAMMA_CLOUD_GOOGLE_ONE_TAP=0``
  turns off Google's sign-in prompt on the sign-in pages.
"""

import os
from pathlib import Path
from urllib.parse import urlsplit

_REPO_ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = Path(os.environ.get("GAMMA_CLOUD_DATA_DIR", "") or _REPO_ROOT / "data")
DB_PATH = DATA_DIR / "cloud.db"

PUBLIC_URL = (os.environ.get("GAMMA_CLOUD_PUBLIC_URL", "") or "http://127.0.0.1:9002").rstrip("/")

REGISTRATION = os.environ.get("GAMMA_CLOUD_REGISTRATION", "invite").strip().lower() or "invite"
if REGISTRATION not in ("open", "invite", "closed"):
    raise RuntimeError("GAMMA_CLOUD_REGISTRATION must be open, invite or closed")

MAIL_BACKEND = os.environ.get("GAMMA_CLOUD_MAIL", "console").strip().lower() or "console"
# The sender defaults to no-reply at the public URL's host, so no domain is
# named anywhere unless it is set.
MAIL_FROM = (os.environ.get("GAMMA_CLOUD_MAIL_FROM", "")
             or f"Gamma Cloud <no-reply@{urlsplit(PUBLIC_URL).hostname or 'localhost'}>")
SMTP_HOST = os.environ.get("GAMMA_CLOUD_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("GAMMA_CLOUD_SMTP_PORT", "587") or 587)
SMTP_USER = os.environ.get("GAMMA_CLOUD_SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("GAMMA_CLOUD_SMTP_PASSWORD", "")
SMTP_STARTTLS = os.environ.get("GAMMA_CLOUD_SMTP_STARTTLS", "1") not in ("0", "false", "no")

TURNSTILE_SECRET = os.environ.get("GAMMA_CLOUD_TURNSTILE_SECRET", "")
TURNSTILE_SITEKEY = os.environ.get("GAMMA_CLOUD_TURNSTILE_SITEKEY", "")

DESKTOP_CLIENT_ID = os.environ.get("GAMMA_CLOUD_DESKTOP_CLIENT_ID", "") or "gamma-desktop"

GOOGLE_CLIENT_ID = os.environ.get("GAMMA_CLOUD_GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.environ.get("GAMMA_CLOUD_GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_ONE_TAP = os.environ.get("GAMMA_CLOUD_GOOGLE_ONE_TAP", "1") not in ("0", "false", "no")
GITHUB_CLIENT_ID = os.environ.get("GAMMA_CLOUD_GITHUB_CLIENT_ID", "").strip()
GITHUB_CLIENT_SECRET = os.environ.get("GAMMA_CLOUD_GITHUB_CLIENT_SECRET", "").strip()

# Lifetimes (seconds).
PORTAL_SESSION_TTL = 30 * 86400        # sliding: refreshed on use
VERIFY_TOKEN_TTL = 24 * 3600
RESET_TOKEN_TTL = 3600
AUTHORIZE_REQUEST_TTL = 600            # a pending sign-in on the authorize page
EXTERNAL_LOGIN_TTL = 900               # a Google/GitHub round trip, or the signup form after it
AUTH_CODE_TTL = 120
ACCESS_TOKEN_TTL = 3600
ID_TOKEN_TTL = 600
REFRESH_TOKEN_TTL = 90 * 86400
REFRESH_REUSE_GRACE = 60               # a refresh token just rotated away still works once more (a lost answer)
LAST_ACTIVE_TOUCH = 600                # a grant's last activity is written at most this often
RETIRED_KEY_GRACE = 7 * 86400          # a rotated-out key stays in the JWKS this long

PLANS = ("free", "plus", "pro")

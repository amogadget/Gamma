# The Gamma Cloud account server

The one new service in the Gamma Cloud plan ([todos/gamma-cloud-plan.md](../../todos/gamma-cloud-plan.md)):
a small web service at `account.gammapdf.com` that owns who a person is,
signs them in to any Gamma server through OpenID Connect, and (later)
their plan, billing and hosted container. It holds no pages, files or
notes, and a Gamma server never calls it on a data request: an ID token is
verified locally with the published keys. Code: `cloud/` (package
`gammacloud`, entry `cloud/app.py`, CLI `cloud/manage.py`), tests
`cloud/tests/`. It imports nothing from `backend/`; the two small pieces it
shares with Gamma (the fixed-window rate limiter, the PKCE rules) are
copies, so the account server can move to its own repository without a
change.

Status: **v0** — accounts, the portal, the OIDC provider, the admin API and
CLI. Plans exist as a column set by an admin; Stripe, provisioning and the
`servers` list (v1) and outside identity providers (v2) are not built. The
consumer side — "Sign in with Gamma Cloud" on every Gamma server — is
built too and described at the end of this page ("The Gamma side").

## What it owns

| | |
|---|---|
| accounts | e-mail, handle, password (bcrypt), display name, plan, admin flag, soft deletion |
| portal | sign in / register / verify / reset / account page, server-rendered HTML over the JSON API |
| identity for Gamma servers | an OIDC provider: authorize (PKCE), token, userinfo, JWKS, revoke, discovery |
| admin | accounts, invites, OIDC clients, the audit log — API and `manage.py` |

## Running

```bash
cd cloud
pip install -r requirements.txt -r requirements-dev.txt   # the backend venv already has them all
python manage.py setup                                     # cloud.db + the signing key
python manage.py create-account you@example.org you --admin --verified
uvicorn app:app --port 9002 --reload                       # http://127.0.0.1:9002
python -m pytest tests -q
```

Configuration is env only, `GAMMA_CLOUD_*` (`cloud/gammacloud/config.py`
lists every variable): the data directory, the public URL (the OIDC
issuer; the request's Host is never trusted), the registration mode
(`open` / `invite` / `closed`, default `invite`), the mail backend
(`console` logs the links, `smtp` sends them), the Turnstile secret (off
until set), the desktop client id. The Docker image (`cloud/Dockerfile`)
runs uvicorn on 9002 with `--proxy-headers`, so the client address comes
from Cloudflare's `X-Forwarded-For`.

## Data

One SQLite file, `cloud.db`, WAL, opened through `db.connect()`. Its
`PRAGMA user_version` is `db.SCHEMA_VERSION`; `db.SCHEMA` is always the
current shape, applied on connect to a fresh file, and an existing file is
upgraded by the numbered steps in `db.STEPS` (`ensure_current()` at
startup and `manage.py migrate`) with a copy taken first and a newer file
refused — the same rules as Gamma's data directory
([migrations.md](migrations.md)). The data directory is the secret: it holds
the signing keys and every token hash.

| table | what |
|---|---|
| `accounts` | `id` (random, the OIDC `sub`; never changes), `handle` (unique; the username on every Gamma server, a paid container's hostname label — `accounts.RESERVED_HANDLES` keeps the names Gamma and the web use), `email` (unique), `email_verified_at`, `password_hash`, `display_name`, `plan`, `is_admin`, `deleted_at` |
| `identities` | outside providers (v2); the shape is fixed from v0 |
| `portal_sessions` | the portal cookie's hash; sliding 30 days, newest 20 per account |
| `email_tokens` | verify / reset / change-email links: hash, kind, expiry, `used_at`; one live link per (account, kind) |
| `invites` | codes with uses left and the plan they grant |
| `oauth_clients` | confidential OIDC clients (share-host, container) with exact redirect URIs; the desktop client is built in, not a row |
| `oauth_requests` | a sign-in in progress on the authorize page (10 min) |
| `oauth_codes` | authorization codes (2 min, single use) |
| `grants` | one per device: the rotating refresh token's hash, 90 days from the last rotation, `revoked_at` |
| `access_tokens` | opaque bearer tokens (1 h), tied to their grant |
| `signing_keys` | Ed25519 private keys; the newest unretired one signs, a retired one stays published a week |
| `audit` | every account-changing event |

Every secret at rest is a SHA-256 of a long random token
(`db.token_hash`); nothing in the file can be replayed. Timestamps are
fixed-width UTC strings with a `Z`, so they compare as strings.

## Registration and the portal

`routers/accounts.py` is the JSON API under `/api`; `routers/portal.py`
serves the pages from `pages.py`, which are small HTML shells whose inline
script posts JSON to the API. A browser form cannot post JSON cross-site
without a CORS preflight, which together with the `SameSite=Lax` cookie is
the CSRF protection; there is no separate token.

- **Register** (`POST /api/register`): e-mail, handle, password, an invite
  code in `invite` mode, a Turnstile token when configured. Rejected
  attempts count toward the per-IP limit. The account starts unverified,
  the verify mail goes out, and the browser is signed in so the account page
  can resend the mail. Taken e-mail or handle answers 409 with a message —
  a deleted account keeps both through the grace period.
- **Verified e-mail is the gate.** An unverified account can use the
  portal but the authorize page refuses to sign it in to any Gamma server
  and shows the verify notice instead. That is the one abuse control a
  hosted Gamma relies on.
- **Sign in** (`POST /api/login`): e-mail or handle plus password; limits
  per IP and per name, reset on success.
- **Reset** (`/api/reset/request` → mail → `/api/reset/confirm`): the
  request answers the same whether the address exists. Confirming sets the
  password, marks the e-mail verified (the mail reached them), signs every
  session and device out, and signs this browser in.
- **Change e-mail**: the link goes to the new address; the old one is told
  afterwards.
- **Change password** and **sign out everywhere** revoke every portal
  session and every grant (`accounts.revoke_everything`), keeping only the
  browser that asked.
- **Delete** (`/api/me/delete`, password required): soft — `deleted_at`,
  password cleared, everything revoked; `manage.py purge-deleted --days 30`
  removes the rows later. Tearing down a paid container is the provisioner's
  job (v1).
- `GET /api/me`: the account, the signed-in devices (portal session only)
  and `servers` (empty until v1). It also accepts a bearer access token,
  which is how a Gamma sidecar will discover the person's servers.
  Everything else under `/api/me` and all of `/api/admin` is portal session
  only: a token minted for a Gamma server can never change the account.

Rate limits are the in-process fixed windows of `ratelimit.py` (per IP,
per name, per account); Cloudflare's rate rules in front are the first
line. Mail (`mail.py`) is plain text with three backends.

## The OIDC provider

`oidc.py` is the logic, `routers/oidc.py` the wire: discovery at
`/.well-known/openid-configuration`, `/jwks`, `/authorize`, `/token`,
`/userinfo`, `/revoke`. Authorization code with PKCE S256, required for
every client; `response_type=code` only.

**Clients.** The *desktop* client (`GAMMA_CLOUD_DESKTOP_CLIENT_ID`,
default `gamma-desktop`) is public and built in: every local Gamma sidecar
is this client, nothing is registered per install, and its redirect URI
must be `http://127.0.0.1:<any port>/api/auth/cloud/callback` (or
`localhost`, `[::1]`), a loopback the sidecar itself serves. It is the
only client that may ask for `offline_access`. *share-host* and
*container* clients are confidential rows (`manage.py create-client` or
`POST /api/admin/clients`, the secret shown once) with exact `https`
redirect URIs, authenticated with `client_secret_post` or
`client_secret_basic`.

**The authorize page.** `GET /authorize` validates the client and redirect
URI first (a bad one is shown, never followed), the rest is redirected
back as an OAuth error, and a valid request is stored as pending. A
signed-in, verified person sees "Continue as *handle*" with *use another
account* and *cancel*; a signed-out person signs in on the page
(`POST /authorize/login`, which also sets the portal cookie so the next
server is one click); an unverified person sees the verify notice. There
is no consent screen: every client is first party, the page names the
server that asks.

**Tokens.** `POST /token` with `authorization_code` checks the code's
client, redirect URI, expiry and PKCE verifier; a replayed code revokes the
grant it produced. The answer is an opaque access token, an ID token and,
for the desktop client with `offline_access`, a refresh token.
`refresh_token` rotates: the old refresh token and the grant's access
tokens die, a new pair is issued. Revoking a device on the account page,
changing the password or deleting the account revokes the grant.

**The ID token** is signed EdDSA with the active key (`kid` in the header)
and carries `iss`, `sub` (the account id), `aud` (the client id), `exp`
(10 min), `iat`, `auth_time`, `nonce`, and the identity claims: `handle`
and `plan` always (a Gamma server needs the username and the quota),
`email` + `email_verified` for the `email` scope, `name` for `profile`.
`/userinfo` answers the same claims for an access token. Keys are Ed25519
in `signing_keys`; `manage.py rotate-key` retires the active one, which
stays in the JWKS for a week so tokens it signed still verify.

**What a Gamma server does with it** is the client side below.

## Admin

`manage.py`: `setup`, `migrate`, `backup`, `list-accounts`,
`create-account`, `set-password`, `set-admin`, `set-plan`, `verify`,
`delete-account`, `purge-deleted`, `invite`, `invites`, `create-client`,
`clients`, `delete-client`, `rotate-key`. Every command but `setup` and
`migrate` refuses an outdated `cloud.db`. `/api/admin/*`
(`routers/admin.py`, admins through a portal session only): search and
patch accounts (plan, admin, verified), resend a verify mail, delete;
invites; OIDC clients; the audit log. There is no admin page yet; the API
and the CLI are the admin surface.

## Tests

`cloud/tests/`: `test_accounts.py` (the registration, verify, reset,
e-mail change, deletion and rate-limit flows, the pages), `test_oidc.py`
(discovery and JWKS, the full desktop PKCE flow with a decoded ID token,
refresh rotation, code replay, redirect and PKCE checks, the unverified
gate, sign-in on the authorize page, cancel, a confidential client with
basic auth and revoke, key rotation), `test_admin.py` (gating, the admin
flows, that a bearer token never reaches the admin API),
`test_manage.py` (the CLI, purge, the newer-file refusal). `conftest.py`
points the data directory at a temp folder and the mail backend at the
in-memory outbox before the package is imported. CI runs them in the
`cloud` job of `check.yml`; a merge to `main` publishes
`ghcr.io/<owner>/gamma-cloud:latest` from `docker.yml`.

## The Gamma side: Sign in with Gamma Cloud

`backend/gamma/cloud_auth.py` (the client and the identity seam),
`backend/gamma/routers/cloud_auth.py` (the endpoints),
`frontend/src/settings/SettingsCloudSignIn.jsx` (the Server pane's Sign-in
section and the Account pane's row), the login page's button. Tests:
`backend/tests/test_cloud_auth.py` (a fake account server signing real
Ed25519 tokens) and the `cloudSignIn` browser scenario.

**Nothing downstream changes.** The callback mints the same `sessions` row
the password login does (`routers/auth.py` `new_session`) and sets the
same cookie; every other module keeps reading `request.state.user`. What
is new is one table in users.db, `identities` (migration step 14): which
account server subject is which local account, the last verified claims
(handle, plan, e-mail), and — desktop client only — the refresh token,
Fernet-encrypted with the data directory's key, kept for the desktop's
later use (`cloud_auth.refresh_token_of`).

**Configuration.** Settings → Server → Sign-in, stored in the `settings`
KV: the account server's address (`cloud_issuer`; empty = off), the client
(`cloud_client_id`, default the public desktop client `gamma-desktop`;
`cloud_client_secret` encrypted, write-only) and the policy. A provisioned
container gets the same through the environment — `GAMMA_CLOUD_ISSUER`,
`GAMMA_CLOUD_CLIENT_ID`, `GAMMA_CLOUD_CLIENT_SECRET`, `GAMMA_CLOUD_POLICY`,
`GAMMA_CLOUD_ADMIN_SUBJECT` — which makes the pane read-only.
`GET /api/server-config` tells the login page whether to show the button.

**The flow.** `GET /api/auth/cloud/start?next=` stores the pending sign-in
(state, PKCE verifier, nonce, the callback URL — this server's confirmed
public URL, else the request's own origin, which for a local sidecar is the
loopback the account server's desktop client allows) in the `mcp_oauth`
table and redirects to the account server's authorize endpoint; the
desktop client asks for `offline_access`, a confidential client does not.
`GET /api/auth/cloud/callback` consumes the state, exchanges the code
(client secret included for a confidential client), verifies the ID token
against the discovery document and the JWKS (both cached in memory, the
JWKS refetched on an unknown key id): issuer, audience, expiry, nonce, and
`email_verified` — an unverified cloud account is refused here as well as
on the account server. A refusal is a message on the login page
(`/?cloud_error=`), never a stack trace.

**Which local account** (`cloud_auth.resolve_account`):

| the identity is… | policy `refuse` (default) | `claim` | `provision` |
|---|---|---|---|
| linked already | that account | that account | that account |
| unknown, username = handle exists, unlinked | refused with "sign in with its password and link it" | linked to it | linked to it |
| unknown, username = handle taken (guest, or linked to another subject) | refused | refused | refused |
| unknown, no such username | refused | refused | a new account under the handle, empty password hash, personal workspace |

`GAMMA_CLOUD_ADMIN_SUBJECT` names one subject that becomes the server
admin whatever the policy (creating or claiming the account under its
handle) — how a provisioned container gets its first admin with no
password on the wire. A signed-in account can link its own identity
(`start?link=1`, the Account pane's button) whatever the policy: one
cloud account per local account and one local account per cloud account.
Unlinking (`POST /api/auth/cloud/unlink`) is refused while the account has
no password, since nothing else could sign it in. `manage.py
list-identities` / `link-identity` / `unlink-identity` are the shell
equivalents; renaming and deleting an account carry or drop its identity.

**Not built yet** (steps 5–6 of the plan): the desktop shell's first-run
sign-in, the offline grace on the sidecar (today the year-long session
cookie is what keeps a laptop signed in), and using the stored refresh
token to read `/api/me` for the person's servers.

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
change. The rate limiter has drifted from `backend/`'s: it drops
`on_first_exceed` and prunes stale keys.

Status: **v0**. Not built: Stripe, provisioning and the `servers` list
(v1). Plans are a column an admin sets. The consumer side, "Sign in with
Gamma Cloud" on every Gamma server, is under "The Gamma side" below.

## What it owns

| | |
|---|---|
| accounts | e-mail, username, password (bcrypt; none for an account made through Google/GitHub), display name, plan, admin flag, soft deletion; the random account id is the identity, e-mail and username both change |
| outside sign-in | Google (OIDC + the one-tap prompt) and GitHub (OAuth), linked to accounts |
| portal | sign in / register / verify / reset, then Overview, Devices, Settings and (admins) Admin — server-rendered HTML over the JSON API |
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
lists every variable):

- the data directory;
- the public URL — the OIDC issuer; the request's Host is never trusted;
- the registration mode: `open` / `invite` / `closed`, default `invite`;
- the mail backend: `console` logs the links, `smtp` sends them;
- the Turnstile secret, off until set;
- the desktop client id;
- the Google and GitHub OAuth clients — a provider is off until both its
  id and secret are set; setup in the deploy README.

The Docker image (`cloud/Dockerfile`) runs uvicorn on 9002 with
`--proxy-headers`, so the client address comes from Cloudflare's
`X-Forwarded-For`.

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
| `accounts` | `id` (random, the OIDC `sub`; never changes), `username` (unique; the username on every Gamma server, a paid container's hostname label — `accounts.RESERVED_USERNAMES` keeps the names Gamma and the web use), `email` (unique), `email_verified_at`, `password_hash`, `display_name`, `plan`, `is_admin`, `deleted_at` |
| `identities` | an account's Google/GitHub link: (`provider`, `subject`) → account, the provider's address at the last sign-in |
| `external_logins` | one Google/GitHub sign-in in flight (15 min): `redirect` while at the provider, `signup` while the username form waits; keyed by the hash of the `gc_ext` cookie (step 2) |
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

## Deploying

[cloud/deploy/README.md](../../cloud/deploy/README.md): the `gamma-cloud`
image on a VPS, `compose.yml` running it with Caddy for TLS behind
Cloudflare DNS; `compose.tunnel.yml` swaps Caddy for a Cloudflare Tunnel on
a host without a public address. The state is the `data/` folder. The
README covers `.env.example` (public URL, SMTP, Turnstile, hostname), the
first admin and invites, the Cloudflare rate rules, updating and rollback.
The website links here: the
header's **Sign in** and the `/login`, `/account`, `/signup` short links
([sites/README.md](../../sites/README.md)).

## Registration and the portal

`routers/accounts.py` is the JSON API under `/api`; `routers/portal.py`
serves the pages from `pages.py`: small server-rendered shells whose
inline script posts JSON to the API — no framework, no build. A browser
form cannot post JSON cross-site without a CORS preflight, which together
with the `SameSite=Lax` cookie is the CSRF protection; there is no
separate token.

Two shells in the gammapdf.com palette (`sites/site/styles.css`), light
and dark, in the quiet bordered look of a workspace tool: the **auth**
shell (a centred card: sign in, register, verify, reset, the authorize
page) and the **app** shell (a sidebar and a content column):

- **Overview** (`/`): a greeting with username, plan and admin tags.
  A *Get started* checklist (account created, e-mail confirmed, signed in
  from a Gamma app) with a progress bar, hidden once all three are done.
  Then the latest sign-ins beside a plan card (a placeholder pointing at
  self-hosting until hosted servers exist) and an account summary:
  username, e-mail state, member since, and the account id with a copy
  button — what Gamma servers key on; it never changes.
- **Devices** (`/devices`): every grant with an icon by client kind, a
  readable platform from the agent (a Gamma server names itself
  `Gamma/<version> (<its address>)` on the token request), relative last
  use ("Active now", "2 days ago"), sign-in date and address; sign one out,
  or all behind a confirm.
- **Settings** (`/settings`): labelled rows.
  - Display name.
  - **Username**: the password field and the button appear once the name
    is edited. The rules are those of registration; a taken or reserved
    name is refused. Gamma servers keep their own account rows and pick
    the new name up as a claim on the next sign-in.
  - E-mail change, confirmed at the new address; the password field is
    revealed the same way.
  - Password.
  - Deletion in a danger zone, its form revealed by a first click.
- **Admin** (`/admin`, `is_admin` only, 404 otherwise): four tabs.
  - Accounts: search by username, e-mail or id, paged; plan select,
    verify, resend, admin on/off, rename, delete.
  - Invites: create with uses, plan and note; delete.
  - Clients: the OIDC clients of hosted servers — create (the secret is
    shown once as the two env lines a container needs) and delete.
  - The audit log.

  All of it is the `/api/admin/*` API below; `manage.py` does the same
  from the shell.

- **Register** (`POST /api/register`): e-mail, username, password, an invite
  code in `invite` mode, a Turnstile token when configured. Rejected
  attempts count toward the per-IP limit. The account starts unverified,
  the verify mail goes out, and the browser is signed in so the account page
  can resend the mail. Taken e-mail or username answers 409 with a message —
  a deleted account keeps both through the grace period.
- **Verified e-mail is the gate.** An unverified account can use the
  portal but the authorize page refuses to sign it in to any Gamma server
  and shows the verify notice instead. That is the one abuse control a
  hosted Gamma relies on.
- **Sign in** (`POST /api/login`): e-mail or username plus password; limits
  per IP and per name, reset on success. An account without a password is
  refused like a wrong password.
- **Reset** (`/api/reset/request` → mail → `/api/reset/confirm`): the
  request answers the same whether the address exists. Confirming sets the
  password, marks the e-mail verified (the mail reached them), signs every
  session and device out, and signs this browser in.
- **Change e-mail**: the link goes to the new address; the old one is told
  afterwards. **Change username** (`POST /api/me/username`, password
  required, a few times a day): the account id stays, so nothing linked to
  it moves.
- **Change password** and **sign out everywhere** revoke every portal
  session and every grant (`accounts.revoke_everything`), keeping only the
  browser that asked.
- **Delete** (`/api/me/delete`, password required): soft — `deleted_at`,
  password cleared, everything revoked; `manage.py purge-deleted --days 30`
  removes the rows later. Tearing down a paid container is the provisioner's
  job (v1).
- `PATCH /api/admin/accounts/{id}` takes `plan`, `is_admin`, `verified`
  and `username`; the rest of the admin API is listed under "Admin".
- `GET /api/me`: the account, the signed-in devices (portal session only)
  and `servers` (empty until v1). It also accepts a bearer access token,
  which is how a Gamma sidecar will discover the person's servers.
  Everything else under `/api/me` and all of `/api/admin` is portal session
  only: a token minted for a Gamma server can never change the account.

### Sign in with Google and GitHub

`providers.py` is the wire (authorize URLs, the code exchange, verifying
Google's ID token against Google's keys, reading GitHub's `/user` and
`/user/emails`), `identities.py` the rules, `routers/external.py` the
endpoints. The sign-in, register and authorize pages show the providers as
tiles under the password form ("or continue with"); with Google on, its
one-tap prompt opens as well (FedCM in Chrome: "Sign in to … with
google.com"). The pages that load Google's script send
`Referrer-Policy: strict-origin-when-cross-origin`, which it needs; every
other page keeps `no-referrer`.

- **The round trip.** A tile posts `POST /api/oauth/{provider}/start`
  (JSON, so no other site can start a sign-in for the browser) with
  `next`, a pending authorize `request_id`, or `link`; the answer is the
  provider URL plus the `gc_ext` cookie. The provider returns the browser to
  `GET /oauth/{provider}/callback`. The OAuth `state`, the PKCE verifier and
  the OIDC nonce are all derived from the cookie's token
  (`identities.derive`), so the row stores only the token's hash, the state
  the provider sees reveals nothing, and a callback in another browser
  fails. Cancelling at the provider returns to where it started.
- **One tap** (`POST /api/oauth/google/one-tap`): the credential is a
  Google ID token; its nonce must be the one derived from the page's
  `gc_tap` cookie, so a token lifted from elsewhere cannot be replayed.
- **Which account** (`identities.resolve`): a linked identity signs in to
  its account. Otherwise an address the provider is authoritative for
  (Google: Gmail or a Workspace account, the `hd` claim — Google's own
  rule; GitHub: the verified primary address) links to the account that
  has it. If that account never confirmed its address, its password was
  chosen by someone who never proved they own it: the password is cleared,
  everything signed out, the address marked confirmed. An address the
  provider is not authoritative for never attaches to an existing account
  (the page says to sign in and connect from Settings). A provider without
  a verified address is refused.
- **A new person** lands on `/signup/finish`: the provider's address, a
  suggested username (the GitHub login or the address's local part, made
  valid and free), the invite code in `invite` mode; `POST
  /api/oauth/signup` creates the account with that address confirmed, no
  password, and the identity linked. `closed` registration refuses instead.
- **A Gamma server's sign-in** that started on the authorize page finishes
  right after: the code goes to the server without another click (the flow
  was started by this browser's own JSON call). When it cannot — the request
  expired, the address is unconfirmed, the person cancelled — the browser
  goes to `/authorize/resume?request_id=`, the authorize page again.
- **Settings → Connected accounts**: connect (the same round trip with
  `link`, back to `/settings?connected=`) or disconnect (`POST
  /api/me/identities/{provider}/unlink`, refused when it would leave no way
  in). One identity per provider per account, one account per identity.
  An account without a password sees *Set a password* instead of *Change*,
  and confirms the username, e-mail and delete forms with its session alone
  (`accounts.confirm_ok`). Deleting an account drops its links at once.

Rate limits are the in-process fixed windows of `ratelimit.py` (per IP,
per name, per account; the `oauth-callback:ip` window is shared by
`one_tap`); Cloudflare's rate rules in front are the first line. Mail (`mail.py`) has three backends; every message is plain text plus
an HTML alternative from `mail.compose` (portal palette, a button for the
link with the raw URL under it, inline styles only).

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
signed-in, verified person sees "Continue as *username*" with *use another
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
(10 min), `iat`, `auth_time`, `nonce`, and the identity claims:
`preferred_username` and `plan` always (a Gamma server needs the username
and the quota),
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
invites; OIDC clients; the audit log. The portal's Admin page, the API and
`manage.py` are one surface: the page and the CLI call the same functions.

## Tests

`cloud/tests/`:

- `test_accounts.py`: the registration, verify, reset, e-mail change,
  deletion and rate-limit flows, the pages.
- `test_oidc.py`: discovery and JWKS, the full desktop PKCE flow with a
  decoded ID token, refresh rotation, code replay, redirect and PKCE
  checks, the unverified gate, sign-in on the authorize page, cancel, a
  confidential client with basic auth and revoke, key rotation.
- `test_admin.py`: gating, the admin flows, that a bearer token never
  reaches the admin API.
- `test_manage.py`: the CLI, purge, the newer-file refusal.
- `test_external.py`: Google/GitHub with the provider stubbed — signup,
  linking by a trusted address, claiming an unconfirmed account, the
  authorize page's path, state and `next` checks, one tap with a real
  RS256 token, connect/disconnect, accounts without a password, the
  step-2 upgrade.

`conftest.py` points the data directory at a temp folder and the mail
backend at the in-memory outbox before the package is imported. CI runs
the tests in the `test` job of `cloud.yml` on a PR that touches `cloud/`.
Dispatching `cloud.yml` from any branch (the `update-account-server`
skill) tests and publishes `ghcr.io/<owner>/gamma-cloud:latest`; no merge
to `main` is involved. The Gamma app's `check.yml` / `docker.yml` skip
changes that only touch the account server
([github_actions.md](github_actions.md)).

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
(`preferred_username`, `plan`, `email`), and — desktop client only — the
refresh token,
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
| unknown, username = username exists, unlinked (exact, else one case-insensitive match — usernames are lowercase, usernames need not be) | refused with "sign in with its password and link it" | linked to it | linked to it |
| unknown, username = username taken (guest, or linked to another subject) | refused | refused | refused |
| unknown, no such username | refused | refused | a new account under the username, empty password hash, personal workspace |

`GAMMA_CLOUD_ADMIN_SUBJECT` names one subject that becomes the server
admin whatever the policy (creating or claiming the account under its
username) — how a provisioned container gets its first admin with no
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

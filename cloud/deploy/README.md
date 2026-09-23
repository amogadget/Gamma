# Deploying the account server

How `account.gammapdf.com` runs: the `gamma-cloud` image on a small VPS
with Caddy terminating TLS on the host's own ports, DNS at Cloudflare. A
Cloudflare Tunnel variant exists for a host without a public address (a
NAS). The service itself is described in
[docs/dev/cloud_accounts.md](../../docs/dev/cloud_accounts.md).

```
deploy/
  compose.yml          account + caddy (a VPS with a public address)
  Caddyfile            TLS for CADDY_HOST, proxied to account:9002
  compose.tunnel.yml   layered on compose.yml: cloudflared instead of caddy
  compose.build.yml    layered on compose.yml: build from ./src instead of pulling
  Dockerfile.local     the image built from a copy of cloud/ (compose.build.yml)
  .env.example         → .env: public URL, registration mode, SMTP, Turnstile, Google/GitHub, hostname
```

The whole state of the service is the `data/` folder next to the compose
file (`cloud.db`, its backups). That folder is the secret: it holds the
signing keys and every token hash. Moving to another host is copying
`data/`, `.env` and the compose files and starting them there.

## The current deployment (2026-09-22)

`root@69.63.206.178`, folder `/root/Container/gamma-account/`, running
`compose.yml` with the GHCR image (the `src/` copy there is left from the
first, built-from-source start). The admin account `tim` and a first
invite exist. Mail is still `console` (the links show in
`docker compose logs account`) until the Resend domain is verified — the
SMTP credential is already in `.env`. Updates go through the
`update-account-server` skill (`.claude/skills/`).

## First deployment on a VPS

1. **DNS.** In the Cloudflare zone add `A account → <the VPS address>`,
   proxied (orange cloud), and set SSL/TLS mode to **Full** for the zone
   (or a configuration rule for the hostname). Cloudflare holds the public
   certificate; between Cloudflare and the host Caddy serves its own
   internal certificate (`tls internal` in the Caddyfile), because Let's
   Encrypt cannot validate a proxied hostname. *Full (strict)* needs a
   Cloudflare Origin CA certificate mounted into Caddy instead (see the
   Caddyfile). A 521 from Cloudflare means it could not reach port 443 of
   the address in the record; a 526 means strict mode with the internal
   certificate.
2. **The folder** on the host:

   ```bash
   mkdir -p ~/Container/gamma-account && cd ~/Container/gamma-account
   curl -O https://raw.githubusercontent.com/tim4431/Gamma/main/cloud/deploy/compose.yml
   curl -O https://raw.githubusercontent.com/tim4431/Gamma/main/cloud/deploy/Caddyfile
   curl -o .env https://raw.githubusercontent.com/tim4431/Gamma/main/cloud/deploy/.env.example
   # fill in .env: SMTP, Turnstile; CADDY_HOST is the hostname above
   chmod 600 .env
   docker compose up -d
   ```

   Before the image is on GHCR, copy the repository's `cloud/` folder to
   `./src` (without `data/`, `tests/`, `__pycache__`) and add
   `-f compose.yml -f compose.build.yml --build` to the `up`.
3. **Check** from the host and from outside:

   ```bash
   curl -s http://127.0.0.1:9002/api/health
   curl -s https://account.gammapdf.com/.well-known/openid-configuration
   ```

   The `issuer` in the answer must be exactly `https://account.gammapdf.com`.
   `docker compose logs caddy` shows the internal certificate being made;
   from the host, `curl -k --resolve account.gammapdf.com:443:127.0.0.1
   https://account.gammapdf.com/api/health` must answer 200.
4. **The first admin and invites** (inside the container, where `manage.py`
   and `/data` are):

   ```bash
   docker compose exec account python manage.py create-account you@example.org you --admin --verified
   docker compose exec account python manage.py invite --uses 20 --note "friends"
   ```

   From then on the **Admin** page in the portal does this: accounts
   (search, plan, verify, admin, rename, delete), invites, the OIDC clients
   of hosted servers, the audit log.
5. **Sign in** at https://account.gammapdf.com/login, change the password
   under Settings, then register a second account in a private window with
   an invite code to see the verify mail arrive.

## Mail from noreply@gammapdf.com

Cloudflare does not send outbound mail; any SMTP submission service does
(Resend, Postmark, Amazon SES, Brevo, Mailgun). The steps are the same
everywhere:

1. Add the domain `gammapdf.com` in the provider and put the DNS records it
   asks for (SPF as a TXT on the apex, one to three DKIM records, sometimes
   a return-path CNAME) into the Cloudflare zone. Wait for "verified".
2. Create an SMTP credential. Put it into `.env`:

   ```
   GAMMA_CLOUD_MAIL=smtp
   GAMMA_CLOUD_MAIL_FROM=Gamma Cloud <noreply@gammapdf.com>
   GAMMA_CLOUD_SMTP_HOST=smtp.resend.com      # or the provider's host
   GAMMA_CLOUD_SMTP_PORT=587
   GAMMA_CLOUD_SMTP_USER=resend               # Resend: literally "resend"
   GAMMA_CLOUD_SMTP_PASSWORD=<the API key>
   ```

3. `docker compose up -d` (the env is read at start), then request a
   password reset for your own account and watch the mail arrive.

The sender address needs no mailbox. If you want replies to reach you,
Cloudflare Email Routing can forward `noreply@gammapdf.com` (or better a
`support@`) to your inbox; that is inbound only and independent of the
above.

## Cloudflare settings worth turning on (once proxied)

- **Rate rules** (Security → WAF → Rate limiting): `/api/login`,
  `/api/register`, `/api/reset/request`, `/authorize/login` and `/token` —
  e.g. 30 requests per minute per IP. The server has its own in-process
  limits as the second line.
- **Turnstile** (dashboard → Turnstile → add widget for the hostname,
  managed mode): the site key and secret go into `.env`; register and
  reset then show the widget.
- **Cache**: nothing to do — the server sets `Cache-Control: no-store` on
  the API and the pages; only `/jwks` is cacheable (5 min).
- **Access** is NOT used: the portal must be reachable by everyone.

## Sign in with Google and GitHub

Each provider shows up on the sign-in pages once both of its values are in
`.env`; leave them empty to offer only e-mail and password.

- **Google** (Google Cloud console → APIs & Services): configure the OAuth
  consent screen (external, app name *Gamma Cloud*, scopes `openid`,
  `email`, `profile`; publish it), then Credentials → Create OAuth client
  ID → *Web application*:
  - Authorized JavaScript origins: `https://account.gammapdf.com` (the
    one-tap prompt needs it; add `http://localhost` and
    `http://localhost:9002` for a local test).
  - Authorized redirect URIs: `https://account.gammapdf.com/oauth/google/callback`.
  - `GAMMA_CLOUD_GOOGLE_CLIENT_ID` / `_SECRET` in `.env`. The one-tap
    prompt ("Sign in to gammapdf.com with google.com") is on with it;
    `GAMMA_CLOUD_GOOGLE_ONE_TAP=0` turns it off.
- **GitHub** (Settings → Developer settings → OAuth Apps → New): homepage
  `https://gammapdf.com`, callback
  `https://account.gammapdf.com/oauth/github/callback`; generate a client
  secret; `GAMMA_CLOUD_GITHUB_CLIENT_ID` / `_SECRET` in `.env`.

Restart the container after editing `.env` (`docker compose up -d`).

## Connecting Gamma servers

- **The desktop app / any local Gamma**: Settings → Server → Sign-in →
  Account server `https://account.gammapdf.com`, server client empty,
  policy *Claim* or *Refuse*. Nothing to register on the account server:
  every local Gamma is the built-in desktop client.
- **A hosted Gamma** (a container you run for someone): create a client on
  the Admin page (kind *container*, callback
  `https://<name>.gammapdf.com/api/auth/cloud/callback`), and start that
  Gamma with `GAMMA_CLOUD_ISSUER`, the shown `GAMMA_CLOUD_CLIENT_ID` and
  `GAMMA_CLOUD_CLIENT_SECRET`, `GAMMA_CLOUD_POLICY=claim` and
  `GAMMA_CLOUD_ADMIN_SUBJECT=<the customer's account id>` (on the Admin
  page under the username), which makes that person its admin on first
  sign-in.

## Updating

```bash
cd ~/Container/gamma-account && docker compose pull account && docker compose up -d
```

(`/update-account-server` does this after checking the publish finished,
and verifies the running commit afterwards.)

(Or re-copy `src/` and `--build` while running from source.) The server
upgrades its own `cloud.db` at start with a copy taken first
(`data/backups/*-v<N>.db`) and refuses a database written by a newer
build, so a rollback is the previous image plus that copy.

## Backups

There is no scheduled backup. The server copies `cloud.db` to
`data/backups/*-v<N>.db` before a schema upgrade (the last 3 kept), and
`manage.py backup` takes a `*-manual.db` on demand. Treat any copy as a
secret.

## The tunnel variant (a NAS)

Zero Trust → Networks → Tunnels → create, public hostname
`account.gammapdf.com` → `http://account:9002`, the connector token into
`.env` as `TUNNEL_TOKEN`, then
`docker compose -f compose.yml -f compose.tunnel.yml up -d`. No port is
opened and Cloudflare terminates TLS; the DNS record is the tunnel's.

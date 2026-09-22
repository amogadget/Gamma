# Deploying the account server

How `account.gammapdf.com` runs: the `gamma-cloud` image on a small VPS
with Caddy terminating TLS on the host's own ports, DNS at Cloudflare. A
Cloudflare Tunnel variant exists for a host without a public address (a
NAS). The service itself is described in
[docs/dev/cloud_accounts.md](../../docs/dev/cloud_accounts.md).

```
deploy/
  compose.yml          account + caddy + backup (a VPS with a public address)
  Caddyfile            TLS for CADDY_HOST, proxied to account:9002
  compose.tunnel.yml   layered on compose.yml: cloudflared instead of caddy
  compose.build.yml    layered on compose.yml: build from ./src instead of pulling
  Dockerfile.local     the image built from a copy of cloud/ (compose.build.yml)
  .env.example         → .env: public URL, registration mode, SMTP, Turnstile, hostname
```

The whole state of the service is the `data/` folder next to the compose
file (`cloud.db`, its backups). That folder is the secret: it holds the
signing keys and every token hash. Moving to another host is copying
`data/`, `.env` and the compose files and starting them there.

## The current deployment (2026-09-22)

`root@69.63.206.178`, folder `/root/Container/gamma-account/`, started
with `compose.yml` + `compose.build.yml` from a copy of `cloud/` in
`src/` (the GHCR image does not exist until the first merge to `main`;
after that, drop `compose.build.yml` and `docker compose pull`). The
admin account `tim` and a first invite exist. Mail is still `console`
(the links show in `docker compose logs account`) until SMTP is set, and
Caddy is waiting for the DNS record to obtain its certificate.

## First deployment on a VPS

1. **DNS.** In the Cloudflare zone add `A account → <the VPS address>`,
   **DNS only** (grey cloud) at first, so Let's Encrypt can reach Caddy
   directly for the HTTP challenge. Once the certificate exists you may
   turn the proxy on with SSL mode *Full (strict)*, which adds the WAF and
   rate rules in front.
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
   `docker compose logs caddy` shows the certificate being obtained.
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
cd ~/Container/gamma-account && docker compose pull && docker compose up -d
```

(Or re-copy `src/` and `--build` while running from source.) The server
upgrades its own `cloud.db` at start with a copy taken first
(`data/backups/*-v<N>.db`) and refuses a database written by a newer
build, so a rollback is the previous image plus that copy.

## Backups

The `backup` service snapshots `cloud.db` daily into `data/backups/`
(`*-manual.db`, 14 kept). Copy that folder off the host — rclone to R2,
restic, or a nightly `scp` — and treat it as a secret.

## The tunnel variant (a NAS)

Zero Trust → Networks → Tunnels → create, public hostname
`account.gammapdf.com` → `http://account:9002`, the connector token into
`.env` as `TUNNEL_TOKEN`, then
`docker compose -f compose.yml -f compose.tunnel.yml up -d`. No port is
opened and Cloudflare terminates TLS; the DNS record is the tunnel's.

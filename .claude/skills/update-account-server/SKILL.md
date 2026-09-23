---
name: update-account-server
description: Pull the latest Gamma Cloud account-server image (ghcr.io/tim4431/gamma-cloud) on the VPS behind account.gammapdf.com and restart it (run after a merge to main has published to GHCR).
---

# Updating the account server on the VPS

`account.gammapdf.com` runs via docker compose on the VPS
`root@69.63.206.178`, folder `/root/Container/gamma-account/` (services
`account`, `caddy`, `backup`; Cloudflare in front). A merge to `main` runs
`docker.yml`, whose `cloud` job publishes `ghcr.io/tim4431/gamma-cloud:latest`;
this skill deploys that image. Deployment details:
[cloud/deploy/README.md](../../../cloud/deploy/README.md).

The folder's `data/` is the service's whole state and its secret (signing
keys, token hashes) and `.env` holds the SMTP/Turnstile credentials — never
read them out, copy them off the host, or overwrite them.

## Before pulling

Make sure the publish for the commit you want is FINISHED and that its
`cloud` job passed (the run also builds the Gamma image; a failed `cloud`
job leaves `:latest` on the previous build):

```bash
gh run list --workflow docker.yml --branch main --limit 3
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.name)\t\(.status)\t\(.conclusion)"'
```

- `cloud  completed  success` → proceed; note the run's `headSha`
  (`gh run view <run-id> --json headSha --jq .headSha`) to check against
  after the update.
- Still `queued` / `in_progress` → wait: `gh run watch <run-id> --exit-status`.
- `failure` → stop and investigate (`gh run view <run-id> --log-failed`); do
  NOT pull.

What is running now (the image's commit label):

```bash
ssh root@69.63.206.178 "cd /root/Container/gamma-account && docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' \$(docker compose ps -q account)"
```

If it already equals the run's `headSha`, there is nothing to deploy — say so
and stop.

## Deploy files changed?

The host keeps its own copies of `compose.yml` and `Caddyfile`. If
`cloud/deploy/` changed on `main` since the last deploy, compare before
updating:

```bash
ssh root@69.63.206.178 "cat /root/Container/gamma-account/compose.yml" | diff - <(git show origin/main:cloud/deploy/compose.yml)
ssh root@69.63.206.178 "cat /root/Container/gamma-account/Caddyfile"   | diff - <(git show origin/main:cloud/deploy/Caddyfile)
```

Show the user any difference and copy a file over (`git show origin/main:cloud/deploy/<file> | ssh root@69.63.206.178 "cat > /root/Container/gamma-account/<file>"`)
only once they agree. `.env` is never copied — new variables from
`.env.example` are named to the user to add by hand.

## Update

SSH uses public-key auth (no password prompt expected). `pull` then `up -d`
recreates only the containers whose image or config changed — no `down`, so
the portal is gone for seconds, not the whole pull:

```bash
ssh root@69.63.206.178 "cd /root/Container/gamma-account && docker compose pull account backup && docker compose up -d"
```

At start the server upgrades `cloud.db` itself, snapshotting it first to
`data/backups/*-v<N>.db`. It refuses a database written by a newer build —
if `account` keeps restarting, read its log before anything else.

## Verify

```bash
ssh root@69.63.206.178 "cd /root/Container/gamma-account && docker compose ps && docker compose logs --tail 20 account"
ssh root@69.63.206.178 "cd /root/Container/gamma-account && docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' \$(docker compose ps -q account)"
curl -s https://account.gammapdf.com/api/health                                  # {"ok":true}
curl -s https://account.gammapdf.com/.well-known/openid-configuration | head -c 200 # issuer must be exactly https://account.gammapdf.com
```

- `account` is `Up … (healthy)` (the healthcheck needs ~10 s after start) and
  its revision label equals the run's `headSha`.
- Public health answers `{"ok":true}` (a Cloudflare 521/502 means Caddy or
  the container is not reachable — check `docker compose logs caddy`).

Report the old → new commit and anything unusual from the logs (a migration
step running, mail errors).

## Rollback

Pin the previous image by its sha tag (`docker.yml` also tags
`sha-<short commit>`): set `image: ghcr.io/tim4431/gamma-cloud:sha-<old>` for
`account` and `backup` in the host's `compose.yml`, `docker compose up -d`.
If the new build already migrated `cloud.db`, the old build refuses it:
restore the `data/backups/*-v<N>.db` copy taken at that start — ask the user
first, it discards everything written since.

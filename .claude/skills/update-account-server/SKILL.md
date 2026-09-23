---
name: update-account-server
description: Publish the Gamma Cloud account server (ghcr.io/tim4431/gamma-cloud) from the current branch by dispatching cloud.yml, then pull it on the VPS behind account.gammapdf.com and restart it. No merge to main is needed.
---

# Updating the account server on the VPS

`account.gammapdf.com` runs via docker compose on the VPS
`root@69.63.206.178`, folder `/root/Container/gamma-account/` (services
`account`, `caddy`; Cloudflare in front). The account server ships on its
own: `.github/workflows/cloud.yml`, dispatched from ANY branch, runs the
`cloud/` tests and publishes `ghcr.io/tim4431/gamma-cloud:latest` (plus
`:sha-<short>`); this skill dispatches it and deploys the result. A merge to
`main` publishes nothing for the account server. Deployment details:
[cloud/deploy/README.md](../../../cloud/deploy/README.md); workflows:
[docs/dev/github_actions.md](../../../docs/dev/github_actions.md).

The folder's `data/` is the service's whole state and its secret (signing
keys, token hashes) and `.env` holds the SMTP/Turnstile/OAuth credentials —
never read them out, copy them off the host, or overwrite them.

## Publish from the branch

What ships is what is COMMITTED on the branch (normally `dev`); never commit
here.

```bash
git status --short cloud/                    # uncommitted cloud/ changes → say they will NOT ship, ask whether to go on
git fetch -q origin
git log --oneline origin/<branch>..HEAD      # local commits not pushed yet → git push origin <branch>
gh workflow run cloud.yml --ref <branch>
gh run list --workflow cloud.yml --branch <branch> --event workflow_dispatch --limit 1 --json databaseId,headSha,status
gh run watch <run-id> --exit-status
```

- The run's `headSha` must be the branch head you meant to ship; note it to
  check against after the update.
- `test` red → stop and report (`gh run view <run-id> --log-failed`); the
  `publish` job does not run and `:latest` stays on the previous build.
- `gh workflow run` answering *could not find any workflows named cloud.yml*
  means `cloud.yml` is not on `main` yet: `workflow_dispatch` is read from the
  default branch, so the file needs one merge to `main` (the `merge` skill)
  before the first dispatch. After that, dispatch works from any branch.
- Only to redeploy an image already published (no new build): skip the
  dispatch and use the newest successful run's `headSha`
  (`gh run list --workflow cloud.yml --limit 5`).

What is running now (the image's commit label):

```bash
ssh root@69.63.206.178 "cd /root/Container/gamma-account && docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' \$(docker compose ps -q account)"
```

If it already equals the run's `headSha`, there is nothing to deploy — say so
and stop.

## Deploy files changed?

The host keeps its own copies of `compose.yml` and `Caddyfile`. If
`cloud/deploy/` changed on the branch since the last deploy, compare before
updating:

```bash
ssh root@69.63.206.178 "cat /root/Container/gamma-account/compose.yml" | diff - <(git show <headSha>:cloud/deploy/compose.yml)
ssh root@69.63.206.178 "cat /root/Container/gamma-account/Caddyfile"   | diff - <(git show <headSha>:cloud/deploy/Caddyfile)
```

Show the user any difference and copy a file over (`git show <headSha>:cloud/deploy/<file> | ssh root@69.63.206.178 "cat > /root/Container/gamma-account/<file>"`)
only once they agree. `.env` is never copied — new variables from
`.env.example` (`git diff <old>..<headSha> -- cloud/deploy/.env.example`) are
named to the user to add by hand.

## Update

SSH uses public-key auth (no password prompt expected). `pull` then `up -d`
recreates only the containers whose image or config changed — no `down`, so
the portal is gone for seconds, not the whole pull. `--remove-orphans` stops
services the compose file no longer has (the old `backup` sidecar):

```bash
ssh root@69.63.206.178 "cd /root/Container/gamma-account && docker compose pull account && docker compose up -d --remove-orphans"
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

Pin the previous image by its sha tag (every publish also tags
`sha-<short commit>`; older images came from `docker.yml` with the same scheme): set `image: ghcr.io/tim4431/gamma-cloud:sha-<old>` for
`account` in the host's `compose.yml`, `docker compose up -d`.
If the new build already migrated `cloud.db`, the old build refuses it:
restore the `data/backups/*-v<N>.db` copy taken at that start — ask the user
first, it discards everything written since.

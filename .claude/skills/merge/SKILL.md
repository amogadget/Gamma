---
name: merge
description: Merge the branch's committed work into main via a PR and report the Docker publish the merge started. Never commits, never releases the desktop app or extension — that is the `release` skill.
---

# Merge to main

One job: get what is already committed on the branch into `main`. The
`check` workflow validates the PR (and `cloud` when `cloud/` changed);
the merge itself triggers only `docker.yml`
(`ghcr.io/tim4431/gamma:latest`; skipped for a merge that only touches
`cloud/`). The desktop app and the browser extension are NOT released by
a merge — run the `release` skill for that (it dispatches `desktop.yml`
/ `extension.yml` on `main`). The account server does not need a merge
at all: the `update-account-server` skill publishes and deploys it from
the branch. Details: `docs/dev/github_actions.md`.

**Scope: existing commits only.** Uncommitted changes are ongoing work —
leave them in the tree, never commit them here. If there is nothing
committed beyond `origin/main`, stop and say so.

## Steps

1. **Check**: `git status --short`, `git fetch -q origin`,
   `git log --oneline origin/main..HEAD`. On `main` itself: create a branch
   first (`git checkout -b <short-topic>`); the normal case is `dev`. No
   commits ahead of main → "nothing to merge", stop.

2. **Push**: `git push -u origin <branch>`.

3. **PR**: `gh pr create --base main --head <branch> --title "<title>" --body "<bullets>"`
   — title from the commit subjects, body a few bullets of what changed.
   If a PR for the branch is already open, reuse it.

4. **Wait for the check**: `gh pr checks <n> --watch --fail-fast`
   (`check`: backend pytest, frontend unit tests + build, the browser suite,
   extension zip, ~4 min — skipped for a PR that only touches the account
   server; `cloud`: the account server's tests, when `cloud/` changed). Red → report
   the failing job (`gh run view <id> --log-failed`) and stop; fixing is
   normal work on the branch, then re-run this skill. Do not merge over a
   red check.

5. **Merge**: `gh pr merge <n> --merge`.

6. **Report**: a few seconds after the merge,
   `gh run list --limit 5 --json workflowName,status,event,url,databaseId`
   shows the Docker run the merge started (none for an account-server-only
   merge — say so). Report it with its link. Do not
   wait for it unless asked (`gh run watch <id> --exit-status`).

Follow-ups to offer, not to run: `update-server` once the Docker run has
published (deploys `latest` to the NAS); `release` if the merged work
should ship as a new desktop app or extension version.

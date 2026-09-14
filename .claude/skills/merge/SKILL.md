---
name: merge
description: Merge the branch's committed work into main via a PR and report the release runs the merge started. Never commits, never releases by hand — GitHub Actions does that on merge.
---

# Merge to main

One job: get what is already committed on the branch into `main`. Everything
after that is automatic (`docs/dev/github_actions.md`): the `check`
workflow validates the PR; the merge itself triggers `desktop.yml`
(installers → GitHub Release `v<next>`), `extension.yml` (Connector zip →
`extension-v<next>`) and `docker.yml` (`ghcr latest`), each only if its
paths changed. Versions are computed from the tags; nothing to bump.

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
   (backend pytest, frontend build, extension zip; ~3 min). Red → report
   the failing job (`gh run view <id> --log-failed`) and stop; fixing is
   normal work on the branch, then re-run this skill. Do not merge over a
   red check.

5. **Merge**: `gh pr merge <n> --merge`.

6. **Report**: a few seconds after the merge,
   `gh run list --limit 5 --json workflowName,status,event,url,databaseId`
   shows which workflows the merge started (only the ones whose paths
   changed). Report each with its link. For the desktop run, the `meta`
   job's notice names the version it will publish
   (`gh run view <id> --json jobs --jq '.jobs[] | select(.name=="meta")'`);
   pass that on. Do not wait for the desktop build (~20 min) unless asked;
   `gh run watch <id> --exit-status` if so.

Follow-ups to offer, not to run: `update-server` once the Docker run has
published (deploys `latest` to the NAS); the Chrome Web Store upload of a
new extension zip is still manual (`extension/STORE.md`).

---
name: build-cloud
description: Build and publish the Gamma Cloud account-server image (ghcr.io/tim4431/gamma-cloud) from a branch by dispatching cloud.yml — tests first, then :latest + :sha-<short>. No merge to main; does not deploy (that is update-account-server).
---

# Build the account-server image

`.github/workflows/cloud.yml`, dispatched on a branch, runs the `cloud/`
tests and, when they pass, pushes `ghcr.io/tim4431/gamma-cloud:latest` and
`:sha-<short commit>` (amd64). It builds what is PUSHED on that branch — never
commit here. Details: [docs/dev/github_actions.md](../../../docs/dev/github_actions.md#cloudyml).

## Steps

1. **Branch**: the one given as an argument, else the current branch
   (`git branch --show-current`; normally `dev`).

2. **What will ship**:

   ```bash
   git status --short cloud/
   git fetch -q origin
   git log --oneline origin/<branch>..<branch>
   ```

   - Uncommitted `cloud/` changes → tell the user they will NOT be in the
     image and ask whether to go on.
   - Local commits not on the remote → `git push origin <branch>`.

3. **Dispatch and find the run**:

   ```bash
   gh workflow run cloud.yml --ref <branch>
   gh run list --workflow cloud.yml --branch <branch> --event workflow_dispatch --limit 1 --json databaseId,headSha,status,url
   ```

   The run may take a few seconds to appear; list again rather than guess.
   Its `headSha` must equal `git rev-parse origin/<branch>`.

   *could not find any workflows named cloud.yml* → `cloud.yml` is not on
   `main` yet (`workflow_dispatch` is read from the default branch). It needs
   one merge to `main` first — offer the `merge` skill; do not work around it.

4. **Wait**: `gh run watch <run-id> --exit-status` (~2–3 min).
   - `test` failed → report `gh run view <run-id> --log-failed` and stop;
     nothing was published, `:latest` is unchanged.
   - `publish` failed → report its log; `:latest` is unchanged.

5. **Report**: the run link, the branch, the commit (`headSha` short + its
   subject), and the tags pushed (`latest`, `sha-<short>`).

Follow-up to offer, not to run: `update-account-server` to deploy the new
image to account.gammapdf.com.

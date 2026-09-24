---
name: build-site
description: Build, check and deploy the gammapdf.com website from a branch by dispatching site.yml (a Cloudflare Worker). No merge to main needed; the live site becomes that branch's committed state.
---

# Deploy the website

`.github/workflows/site.yml`, dispatched on a branch, runs the `check` job
(build, every include expanded, the pages present, a wrangler dry run) and,
when it passes, the `deploy` job (`wrangler deploy` of `sites/dist` as the
`gammapdf-site` Worker on gammapdf.com + www). It builds what is PUSHED on
that branch: `sites/` plus what the build copies (the artwork and demos
under `docs/assets/`, the favicon, `PRIVACY.md`). Never commit here.
Details: [sites/README.md](../../../sites/README.md),
[docs/dev/github_actions.md](../../../docs/dev/github_actions.md#siteyml).

A merge to `main` touching those paths deploys `main` by itself, so a site
deployed from `dev` stays live only until the next such merge — which is
fine once `dev` is merged, and worth saying when the branch is not headed
for `main`.

## Steps

1. **Branch**: the one given as an argument, else the current branch
   (`git branch --show-current`; normally `dev`).

2. **What will ship**:

   ```bash
   git status --short sites/ PRIVACY.md docs/assets/ frontend/public/media/icons/
   git fetch -q origin
   git log --oneline origin/<branch>..<branch>
   ```

   - Uncommitted changes there → tell the user they will NOT be on the site
     and ask whether to go on.
   - Local commits not on the remote → `git push origin <branch>`.

3. **Dispatch and find the run**:

   ```bash
   gh workflow run site.yml --ref <branch>
   gh run list --workflow site.yml --branch <branch> --event workflow_dispatch --limit 1 --json databaseId,headSha,status,url
   ```

   The run may take a few seconds to appear; list again rather than guess.
   Its `headSha` must equal `git rev-parse origin/<branch>`.

   A dispatch refused because the workflow has no `workflow_dispatch` on
   `main` means the current `site.yml` has not reached `main` yet — offer the
   `merge` skill; do not work around it.

4. **Wait**: `gh run watch <run-id> --exit-status` (~1–2 min).
   - `check` failed → report `gh run view <run-id> --log-failed` and stop;
     nothing was deployed.
   - `deploy` failed → report its log (an auth error means the
     `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets); the live site
     is unchanged.

5. **Verify live**:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://gammapdf.com/
   curl -s -o /dev/null -w "%{http_code}\n" https://gammapdf.com/privacy/
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://www.gammapdf.com/
   ```

   200, 200 and a redirect to `https://gammapdf.com/`. Cloudflare may serve
   `/media/*` from cache for up to a day (`_headers`); pages are fresh. When
   the change is a visible string, `curl -s https://gammapdf.com/ | grep -c
   "<the new text>"` confirms it is live.

6. **Report**: the run link, the branch, the commit (`headSha` short + its
   subject), and the live checks.

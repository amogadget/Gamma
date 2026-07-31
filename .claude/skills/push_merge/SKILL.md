---
name: push_merge
description: Commit the uncommitted work, push the branch, and open a PR to main.
---

# Push & merge-request

Turn the working tree into a pushed branch + PR against `main`.

## Steps

1. **Check the tree**: `git status` + `git diff --stat`. If on `main`,
   create a feature branch first (`git checkout -b <short-topic-name>`);
   otherwise stay on the current branch.

2. **Pre-flight** (skip only if this session already ran them on the
   current tree):

   ```bash
   cd backend && venv/Scripts/python.exe -m pytest tests -q
   # frontend, when src/ changed (node is fnm-managed, not on PATH):
   export PATH="$HOME/AppData/Roaming/fnm/aliases/default:$PATH"
   cd frontend && npm run build
   ```

3. **Commit everything relevant**: `git add` the changed/untracked project
   files (never `backend/users/`, `venv/`, `dist/`, scratch files). Commit
   message follows the repo's style — one short descriptive line
   (see `git log --oneline`), ending with:

   ```
   Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
   ```

4. **Push**: `git push -u origin <branch>`.

5. **PR**: `gh pr create --base main --title "<title>" --body "<summary>"` —
   a few bullet points of what changed and how it was verified; body ends
   with:

   ```
   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   ```

   Report the PR URL.

## After the merge

Do NOT merge the PR yourself unless asked. Once the user merges to `main`,
GitHub Actions publishes `ghcr.io/tim4431/gamma`; deploying that to the NAS
is the `update-server` skill — offer it as the follow-up.

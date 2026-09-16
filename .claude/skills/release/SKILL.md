---
name: release
description: Release the desktop app and/or the browser extension from main by dispatching their GitHub workflows (desktop.yml → GitHub Release v<next>, extension.yml → extension-v<next>). A merge to main never does this on its own.
---

# Release from main

A merge to `main` only publishes the Docker image. Shipping a new desktop
app or extension version is this explicit step: dispatch the workflow on
`main` and it computes the next version from the tags, builds, and
publishes the GitHub Release. Nothing is bumped or tagged by hand
(`docs/dev/github_actions.md`; version rule: newest tag + patch, or the
file's version when that floor is higher — raise the file for a
minor/major and merge first).

**Argument**: `desktop` (default), `extension`, or `both`. Optional
`--dry` builds without publishing (`-f publish=false`), `--prerelease`
marks the desktop release as a pre-release.

## Steps

1. **Make sure main is what you want to ship**: `git fetch -q origin`,
   `git log --oneline origin/main -5`. Unmerged branch work → run `merge`
   first; this skill never commits, pushes or merges.

2. **Nothing already running**: `gh run list --workflow desktop.yml --limit 1`
   (or `extension.yml`). An in-progress run queues the new one behind it
   (concurrency group); say so rather than double-dispatching.

3. **Dispatch**:
   ```bash
   gh workflow run desktop.yml --ref main                   # next v<version>
   gh workflow run desktop.yml --ref main -f publish=false  # --dry
   gh workflow run desktop.yml --ref main -f prerelease=true
   gh workflow run extension.yml --ref main                 # next extension-v<version>
   ```

4. **Report**: a few seconds later
   `gh run list --workflow <file> --limit 1 --json status,url,databaseId`
   gives the run; for desktop, the `meta` job's notice names the version
   it will publish
   (`gh run view <id> --json jobs --jq '.jobs[] | select(.name=="meta")'`).
   Report the link and version. Do not wait for the desktop build
   (~20 min) unless asked; `gh run watch <id> --exit-status` if so. The
   desktop publish job re-dispatches `docker.yml` with the version, so the
   image gets a matching `:<version>` tag on its own.

Follow-ups to offer, not to run: the Chrome Web Store upload of a new
extension zip is manual (`extension/STORE.md`).

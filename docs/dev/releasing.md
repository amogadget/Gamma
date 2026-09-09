# Coordinated releases

A normal Gamma release includes **all shipped components**, not just the server/frontend:

1. Web/backend Docker image: `v<version>` → `docker.yml` tests, multi-platform image and GitHub release.
2. Desktop: `desktop-v<version>` matching `desktop/package.json` and its lockfile → all four platform jobs, packaged-app tests, then six installer assets in one release.
3. Extension: `extension-v<version>` matching `extension/manifest.json` → Connector ZIP and GitHub release.

Use the same source commit for the three tags. Bump Desktop/Connector versions even when their packaging is unchanged, so users receive a complete coordinated distribution. Create `docs/releases/v<version>.md` linking to the component releases. Do not mark the operation finished merely because Git push succeeded: inspect all three workflows and their published assets. Chrome Web Store submission is separate from publishing the Connector ZIP.

Before tagging: run backend tests/Ruff, frontend tests/ESLint/build, Desktop lint/unit tests and validate the extension manifest/package. Inspect the exact staged file list and commit tree. Exclude unfinished clients or local design documents explicitly; never use a blanket `git add .` for a partial release. The native iPad client is excluded from the 0.3.0 coordinated release.

Push the main commit and version tags together with `git push --atomic` where supported. Never force-update an existing release tag. Fix a failing workflow through a normal follow-up commit and a documented retry or new version, without falsely reporting unbuilt installers as published.

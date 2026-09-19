# GitHub Actions

Six workflows live in `.github/workflows/`. A merge to `main` publishes
only the Docker image and, when the site or its inputs changed, the website. The desktop app and the extension are released by
dispatching their workflows — the `release` skill does that — and nothing
is bumped or tagged by hand: versions are computed from the tags.

| Workflow | File | Runs when | Produces |
|---|---|---|---|
| `check` | `check.yml` | every pull request to `main` | pass/fail: brand asset consistency, backend pytest, frontend unit tests + build, the browser suite, extension zip (~4 min) |
| `desktop` | `desktop.yml` | manual dispatch only (`release` skill) | Windows installer, macOS dmg + zip, Debian/Ubuntu deb, the update-feed files → GitHub Release `v<version>`; the MSIX artifact + a Microsoft Store submission when the secrets exist; a Docker tag `<version>` |
| `extension` | `extension.yml` | manual dispatch only (`release` skill) | `gamma-connector-<version>.zip` → GitHub Release `extension-v<version>` |
| `docker` | `docker.yml` | every push to `main`; dispatched by the desktop release with a version | `ghcr.io/tim4431/gamma:latest`; plus `:<version>` and `:<major.minor>` when dispatched, linux/amd64 + arm64 |
| `site` | `site.yml` | a push to `main` touching `sites/`, the artwork and demos it copies, or `PRIVACY.md`; or manual dispatch | gammapdf.com: `sites/dist` built and deployed as a Cloudflare Worker (static assets only; needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; [sites/README.md](../../sites/README.md)) |
| `Codex plugin package` | `codex-plugin.yml` | PRs touching the plugin or its tooling, or manual dispatch | installer tests on Windows/macOS/Linux and preview plugin release assets (pins `checkout@v4`/`setup-python@v5`/`upload-artifact@v4`, older than the rule below) |

The `desktop` workflow also builds the versioned Codex plugin ZIP, its setup
scripts for Windows and macOS/Linux, and checksums, and uploads them onto the
same release (`tools/release_codex_plugin.py`).

```
PR → main ──▶ check (pytest, npm test + build, e2e, extension zip)   ← merge skill waits for this
merge ───────▶ docker.yml  ghcr :latest                              ← every merge
         └──▶ site.yml    gammapdf.com                              ← only when sites/ or its inputs changed
release skill ─┬──▶ desktop.yml  meta: version = max(package.json, newest v* tag + patch)
 (gh workflow  │        build Win/mac/Linux with that version pinned, smoke on all three
  run)         │        publish: Release v<version> (notes = commits since previous tag)
               │        └─▶ dispatch docker.yml -f version   ─▶ ghcr :<version> :<major.minor>
               │        Windows leg: MSIX → msstore publish (if PARTNER_CENTER_* secrets)
               └──▶ extension.yml  same rule on extension-v* tags; manifest pinned inside the zip
```

## Native integration checks

The `check` backend job also runs the read-only migration inventory tests in
`tools/test_audit_native_migration.py`, the iPad workspace source-contract
checks and coordinate-fixture checks. They protect upload hashes, native
manifests and account/workspace assignment during migration. The iPad Python
checks are **not** a Swift compiler or hardware test; Xcode simulator/build
results and remaining physical-device acceptance boundaries are summarized in
[iPad validation](../../ipad/VALIDATION.md). Nothing here publishes or installs the iPad app.

## Versions and tags

The **newest tag is the source of truth**; the files hold a floor.

| Deliverable | Floor | Tag series | Release name |
|---|---|---|---|
| Desktop app | `desktop/package.json` `"version"` | `v<version>` | `Gamma <version>` |
| Extension | `extension/manifest.json` `"version"` | `extension-v<version>` | `Gamma Connector <version>` |

On every run the `meta` step lists the tags of its series on the remote and
takes the newest. If the floor is higher than that, the floor is the
version — **that is how you make a minor or major release: raise the
floor and merge**. Otherwise the version is the newest tag with the patch
number plus one. The result is pinned into the build (`npm version` in the
desktop checkout; `jq` into the manifest inside the extension zip), so the
app, `latest*.yml`, the MSIX manifest and the zip all carry it, while the
repository files stay untouched: no bot commits on `main`, nothing for `dev`
to conflict with. The release step creates the tag from the merged commit.

Consequences:

- A version is never reused. Deleting or moving a tag is never the fix; the
  next merge is.
- A merge releases nothing but the Docker `latest` image; a dispatched run
  whose build fails on any platform releases nothing (the publish job needs
  all three).
- A manual run with `publish=false` builds and keeps the outputs as
  artifacts (14 days). A manual `version` input overrides the computation;
  it fails early if that tag already exists.
- `prerelease=true` on a manual run publishes without marking the release
  *Latest*; installed apps ignore pre-releases.

**The repository's "latest release" must be a desktop release.** Installed
apps update through electron-updater, which resolves
`https://github.com/tim4431/Gamma/releases/latest` and reads that release's
`latest*.yml`. The extension workflow therefore publishes with
`make_latest: false`. If you ever create a release by hand, keep that
invariant or every installed app reports *Update check failed* until the
next desktop release. Emergency lever for a bad desktop release: edit it
and tick *pre-release* — the previous release becomes *Latest* again and
clients stop seeing the bad one. Feed details:
[desktop/docs/release.md](../../desktop/docs/release.md#auto-update-feed).

Each release workflow has a `concurrency` group per ref with
`cancel-in-progress: false`, so two merges in quick succession queue and get
consecutive numbers instead of racing.

## `desktop.yml`

Matrix over `windows-latest`, `macos-latest`, `ubuntu-latest`; every leg:
pin the version, build the frontend, freeze the backend with PyInstaller,
health-check the frozen server, electron-builder, verify the signature, run
the packaged app's `--smoke` self-test (under Xvfb on Linux). Per platform:
Windows also builds the unsigned Microsoft Store MSIX (`store-windows`
artifact) and, when the `PARTNER_CENTER_*` secrets exist and the run
publishes, submits it with the `msstore` CLI (`continue-on-error`: the Store
allows one submission in certification at a time, so a second release the
same day is refused and simply waits for the next). The step's verdict is
`msstore submission status` after the publish, not the CLI's exit code —
the first run exited 1 on a transient re-read after the package was
already in certification. macOS is ad-hoc signed
by `desktop/scripts/adhoc-sign.cjs` when no Developer ID is available (see
[release.md](../../desktop/docs/release.md#code-signing-optional-secret-gated)).
Linux additionally `apt install`s the `.deb` on the runner and runs the
self-test from `/opt/Gamma/gamma` with the sandbox on.

The macOS signature diagnostics must consume all `codesign` output: an early
exit from `grep -q` or `head` can break the pipe and fail the release under
`pipefail` even when the signature is valid. Signature verification errors
must still fail the job.

The `publish` job merges the three artifacts, writes the notes — download
table, per-platform install hints, **Changes: the commit subjects since the
previous tag, restricted to `desktop/ backend/ frontend/`** (this repo's PR
titles are all "Merge pull request #N from dev", so GitHub's generator
would say nothing) — creates the release + tag with `make_latest: true`,
then runs `gh workflow run docker.yml --ref v<version> -f version=…` so the
server image gets the same version tag (a tag made with `GITHUB_TOKEN`
would not trigger `docker.yml` by itself).

No push trigger: the app bundles the backend and the frontend, so a path
filter would release it on nearly every merge. It runs only when dispatched
(`release` skill).

## `extension.yml`

One Ubuntu job: compute the version, copy `extension/` with the version
written into `manifest.json` (minus `STORE.md`, `README.md`, `.DS_Store`),
zip it, upload it as an artifact, publish `extension-v<version>` with
`make_latest: false` and the commit subjects under `extension/` as notes.
The Chrome Web Store upload stays manual
([extension/STORE.md](../../extension/STORE.md)).

## `check.yml`

Four parallel Ubuntu jobs on every PR to `main`: backend pytest (Python
3.12, `requirements.txt` + `requirements-dev.txt`, `-n auto` over pytest-xdist), the frontend unit tests
+ build (Node 22, `npm test` then `npm run build`), the browser suite
(`npm run e2e -- --continue` against a backend started from the checkout
with `GAMMA_E2E_PYTHON=python`, Playwright's Chromium installed with its
system deps; on a failure the harness's `failures/` folders — screenshots,
page problems, the error, the server log tail — are uploaded as the
`e2e-failures` artifact), and a manifest parse + zip of the extension. No
installers. The `merge` skill waits for it before merging; a red check is
fixed on the branch as normal work.

## `docker.yml`

buildx for amd64 + arm64, `latest` on every push to `main`. When dispatched
with a `version` input (the desktop publish job does this on the release
tag) it also pushes `<version>` and `<major.minor>`. Setup notes:
[docs/dev/debugging.md](debugging.md) and the memory note on GHCR.

## Running and watching by hand

```bash
gh workflow run desktop.yml --ref main                       # release (next version) — the `release` skill
gh workflow run desktop.yml --ref main -f publish=false      # build check only
gh workflow run desktop.yml --ref main -f prerelease=true -f version=1.2.0-rc1
gh workflow run extension.yml --ref main                     # extension release — the `release` skill
gh workflow run docker.yml --ref v0.2.3 -f version=0.2.3     # re-tag an image

gh run list --limit 5
gh run watch <run-id> --exit-status
gh run view <run-id> --log-failed
gh release view v<version> --json url,assets
```

A workflow can only be dispatched once its file exists on `main`
(`workflow_dispatch` is read from the default branch); pass `--ref dev` to
run the `dev` copy after that.

## Secrets

All optional; without them builds are unsigned / not submitted, and the
workflows say so with a `::warning::` or `::notice::`. `gh secret list`
shows which exist.

| Secret | Used by |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, optional `AZURE_SIGN_PUBLISHER` | `desktop.yml`, Windows leg: Azure Trusted Signing |
| `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | `desktop.yml`, macOS leg: Developer ID + notarization (replaces the ad-hoc signature) |
| `PARTNER_CENTER_TENANT_ID`, `PARTNER_CENTER_SELLER_ID`, `PARTNER_CENTER_CLIENT_ID`, `PARTNER_CENTER_CLIENT_SECRET` | `desktop.yml`, Windows leg: Microsoft Store submission via `msstore` ([release.md](../../desktop/docs/release.md#microsoft-store) says where each value comes from) |
| `GITHUB_TOKEN` (automatic) | releases and tags, the docker dispatch, the GHCR push |

Set them from a terminal with `gh secret set NAME` (prompts for the value);
never paste secret values into chat or files.

## Adding or changing a workflow

- One deliverable per workflow, a `pull_request` path filter for checks
  (release workflows are dispatch-only), and the tag-derived version rule
  above for anything that publishes.
- The Linux Electron steps need `xvfb-run`; the unpacked `linux-unpacked`
  dir needs `--no-sandbox` (the `.deb` postinst fixes that for installs).
- Pin every action to a major that runs on the runner's current Node
  (Node 24 as of 2026-09: `actions/checkout@v7`, `setup-node@v7`,
  `setup-python@v7`, `upload-artifact@v7`, `download-artifact@v8`,
  `softprops/action-gh-release@v3`, `docker/*` v4/v6/v7,
  `microsoft/microsoft-store-apppublisher@v1.4`). A run annotated "Node.js
  20 is deprecated … forced to run on Node.js 24" means a pin fell behind;
  check the action's `action.yml` `runs.using` at its latest tag. The
  "UNSIGNED build" warnings are expected until the signing secrets exist.
- Validate YAML locally with the desktop tree's `js-yaml`
  (`node -e "require('js-yaml').load(require('fs').readFileSync(f,'utf8'))"`
  from `desktop/`), and keep this document, the `merge` and `release` skills and
  [desktop/docs/release.md](../../desktop/docs/release.md) in sync.

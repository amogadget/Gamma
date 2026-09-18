# Desktop shell architecture

The shell is an Electron window plus a process manager. Gamma stays a black
box: the window shows whatever Gamma server is open, the way a browser tab
would.

## Servers and workspaces

Two levels, one switcher. A **server** is a Gamma the shell can open; a
**workspace** is one of Gamma's own libraries inside it (personal or shared,
with members and roles — [docs/dev/workspaces.md](../../docs/dev/workspaces.md)).
Before Gamma had workspaces the shell called its servers "workspaces" and
separate libraries meant separate local servers; now one local server holds
as many workspaces as you like, and the shell-bar menu switches both.

Servers come in two kinds:

- **Local** — a data directory under the shell's userData dir, served by a
  Gamma backend the shell spawns on `127.0.0.1:<free port>` with
  `GAMMA_DATA_DIR` pointed at it. Fully self-initializing: the server seeds
  schema + first admin on an empty data dir (and upgrades an older data
  layout at startup — [docs/dev/migrations.md](../../docs/dev/migrations.md)).
  The shell passes `GAMMA_ADMIN_USER`/`GAMMA_ADMIN_PASSWORD` on the first
  spawn (the server's one-time password print would be lost in the hidden
  console), remembers the credentials in its registry, and auto-logs-in
  after navigation by POSTing `/api/login` from the page. Several local
  servers are still possible (one data dir and process each; a sidecar keeps
  running until the app quits, so switching back is instant), but the usual
  shape is one local server with several workspaces.
- **Remote** — just a URL (e.g. the NAS Docker deployment). Normal login;
  the session cookie persists in the Electron profile per origin.

Servers are fully independent; there is **no synchronization** (move data
between them with Gamma's own per-workspace *Export* / *Import*).

### Gamma's workspaces in the switcher

While a server is open the main process reads `GET /api/session` through the
content view's cookie session (`session.fetch` with credentials — a public
API call, nothing injected into the page) whenever the content view
navigates, and again when the bar menu opens. The reply's `workspaces` list
and the `ws` query parameter of the current URL become `gamma` in the shell
state (`null` while signed out). The bar menu lists them above the servers;
choosing one navigates the content view to `<origin>/?ws=<id>`
(`shell:open-workspace`) — the same thing Gamma's own account-menu switcher
does. The bar button reads "server · workspace".

### Remote reachability

Local servers show a running dot (is the sidecar up). Remote ones show the
same dot from a **health probe**: the main process fetches `<url>/api/health`
(public, no session needed; 5 s timeout) per remote server, caches the
answer for 20 s, and exposes it as `reachable`
(`true` / `false` / `null` while unknown) in the shell state. Probes run on
demand — every launcher refresh and every bar-menu open ask for the list,
which triggers stale probes — and their results arrive asynchronously
through `pushState`, so the dot fills in a moment after the page renders.
Opening a remote server also records the outcome (success → reachable,
failure → unreachable). Green = reachable, red = unreachable, dim = not
probed yet.

## Window

```
┌────────────────────────────────────────────────────────────┐
│ ⌈γ⌉ Alpha · Rydberg lab ▾   Starting Beta…   [↑ Restart to update] ⟳  – □ ✕ │  shell bar (38 px, is the title bar)
├────────────────────────────────────────────────────────────┤
│                                                            │
│   launcher (file://ui/launcher.html)                       │  content view
│   or the server's Gamma frontend (http://…)                │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

One `BaseWindow`, two `WebContentsView`s. The **shell bar** is the
frameless window's title bar (OS controls overlaid on Windows/Linux, traffic
lights inset on macOS) and holds the switcher: click the name → dropdown of
the open server's Gamma workspaces (check on the current one, role or
*personal* per row), then every server (running / reachable dot, check on
the current one), then *All servers…* (the launcher, also
`Ctrl/Cmd+Shift+L`). While
the dropdown is open the bar view is temporarily enlarged over the content
(its page is transparent outside the strip and the menu), which is how a
38 px view can show a menu. At the right: the update pill (only while an
update is ready, see below) and a reload button.

The **content view** shows the launcher or the server. The launcher lists
servers as cards (kind, running / reachable dot, size on disk, data dir /
URL, *last opened* badge) with open / rename / credentials / data folder /
server log / remove actions, then Settings: the *reopen last server at
launch* switch, the *Local server storage* row, the *Updates* row (status
line + check / download / restart button), and the dev-mode server
overrides. The storage row shows the folder new local servers are created
in. *Change…* opens a folder picker and *Use default* appears once a custom
folder is set. Either one leads to a dialog with *Only new servers* and, when
local servers exist under the current root, *Move data*, which relocates
them too.

**Theme.** The chrome paints in Gamma's own theme: the preload on server
pages mirrors the page's `data-theme` attribute (`dark`/`light`/`gamma-light`/
`gamma-dark`/`sepia`/`solarized`/`gray`; none = dark) to the main process, which restyles the bar, the
launcher, the window background and the Windows title-bar overlay. The last
theme is persisted so the chrome is right before any page has loaded. The
tokens in `ui/theme.css` are copies of `frontend/src/shared/styles/app.css`'s, and the
icons are the same stroke glyphs as `frontend/src/shared/ui/Icons.jsx`.

## In-app updates

`lib/updater.js` wraps `electron-updater`, VS Code style: a silent check
15 s after launch and every 4 h, download in the background, then one
attention-seeking control — the **Restart to update** pill in the shell bar
(and the same action in the launcher's Updates row). *Help → Check for
Updates…* is the only flow that answers with a dialog. The feed is the
GitHub Release (details and the signing caveat: [release.md](release.md)).

State machine (`update` in the shell state): `idle` → `checking` →
`up-to-date` | `downloading` (percent) → `downloaded` | `error`;
`unsupported` in dev builds, under the test harness and in a Microsoft
Store install (`process.windowsStore`; the Store delivers those updates,
see [release.md](release.md#microsoft-store)). On **Windows** the
update installs on restart (`quitAndInstall`, silent NSIS run; unsigned
builds are fine — electron-updater only verifies a publisher when one is
configured). On **Linux** (the `.deb`) the same flow runs through
electron-updater's `DebUpdater` (chosen from `resources/package-type`): the
new `.deb` downloads in the background and *Restart to update* installs it
with `dpkg -i` under `pkexec`, so the user gets a password prompt, then the
app relaunches. On **macOS** an unsigned app cannot self-update (Squirrel.Mac
requires a valid signature), so the shell reports `available` instead of
downloading and the pill / button opens the release page; `IN_APP_INSTALL`
in `lib/updater.js` is the switch to flip once the builds are signed.

## Shell state

Electron's userData dir (`%APPDATA%/gamma-desktop` /
`~/Library/Application Support/gamma-desktop` / `~/.config/gamma-desktop`;
the app shows the path at the
bottom of the launcher; a Microsoft Store install gets the MSIX-virtualized
copy under `%LOCALAPPDATA%\Packages\xwtim.GammaPDF_<hash>\LocalCache\Roaming`,
which the Store uninstall deletes — [release.md](release.md#microsoft-store)):

- `servers.json` — the registry: server list, `lastOpened`, `windowBounds`,
  and `settings` (`openLastOnLaunch`, `lastTheme`, `dataRoot`, the dev-mode
  `pythonPath`/`backendDir`/`staticDir` overrides). Local admin credentials
  are stored in plaintext here — same trust level as the SQLite files next
  to it; acceptable for a per-OS-user desktop app. An older profile's
  `workspaces.json` (the file's previous name) is copied over on first start
  and left in place.
- `workspaces/<id>/` — local servers' data dirs (a standard `GAMMA_DATA_DIR`
  layout: `users.db`, `workspaces/<id>/{pages.db,data.db,uploads/}` — Gamma's
  own workspaces inside; the folder name predates the rename and stays so
  existing installs need no move). This is the default **storage root**.
  `settings.dataRoot` replaces it with any folder (a drive with room, a
  synced folder, outside an MSIX package's virtualized AppData), and new
  local servers are created under the current root as `<root>/<id>`.
- `logs/<id>.log` — captured stdout/stderr of each sidecar run.

Changing the root is `registry.setDataRoot(dir, { move })`. With `move` it
relocates every local server under the old root. The shell stops their
sidecars first (an open one returns to the launcher). The registry copies
each `<id>` dir with `fs.cpSync` (so it works across drives), and only after
every copy succeeded re-points the entries and deletes the originals. A
failure midway rolls back the copies and leaves the registry untouched. The
new folder may not be inside the current one or contain it. Removing a
server offers *keep files* / *delete everything*; deletion is guarded to
directories under the default or the configured root only.

`GAMMA_SHELL_USER_DATA=<dir>` relocates all of it (the tests use a temp
profile); `GAMMA_SHELL_DOWNLOAD_DIR=<dir>` saves downloads there without the
dialog (tests only); `GAMMA_SHELL_NO_UPDATE=1` disables the updater.

## File map

- `main.js` — window + views + layout, theme mirror, native menu
  (accelerators only; hidden behind Alt on Windows; *Help* holds *Check for
  Updates…*), IPC for the shell pages, auto-login script, navigation guard
  (only registered server origins may load in the content view; everything
  else — `target=_blank`, cross-origin redirects — opens in the system
  browser), the remote health probes, the `/api/session` read behind the
  workspace switcher, `--smoke` self-test, sidecar cleanup on quit, the
  `GAMMA_SHELL_TEST` hook the e2e suite drives.
- `preload.js` — exposes the `gammaShell` IPC bridge **only on `file:`
  URLs**; on server pages it exposes nothing and only reports `data-theme`
  changes.
- `ui/theme.css` — Gamma's tokens + the unified control classes (`uiBtn`,
  `ctlBtn`, `uiInput`, the `dot` states) for the shell pages.
- `ui/bar.html` — the shell bar. `ui/launcher.html` — the server picker.
  Both plain HTML, no build step.
- `lib/registry.js` — `servers.json` load/save, add/rename/remove,
  last-opened, settings, window bounds, data-dir size.
- `lib/sidecar.js` — local server lifecycle: free port, spawn, health poll
  (`/api/health`, 60 s budget for frozen cold starts), log capture,
  tree-kill on Windows. Backend resolution order: explicit settings
  (pythonPath/backendDir) → bundled frozen server (packaged app) →
  repo auto-detect (`backend/venv` + `frontend/dist`, dev mode).
- `lib/updater.js` — the electron-updater wrapper described above.
- `electron-builder.cjs` — the packaging config (targets, extra resources,
  secret-gated signing, the update feed's `publish` block).
- `backend_entry.py` — entry for the frozen server (`--port`, `--data-dir`;
  sets env before importing gamma, serves the bundled `frontend_dist`).
- `build_backend.py` — PyInstaller onedir freeze into
  `dist-backend/gamma-server/` (collects uvicorn's string-resolved modules,
  pypdfium2's native lib, ziamath/ziafont fonts, and `frontend/dist`).
  Handles conda-based interpreters by adding `<base>/Library/bin` to the
  DLL search path.
- `assets/icon.png` — app icon (512 px, the favicon mark; electron-builder
  derives ico/icns and the Linux icon set). `assets/entitlements.mac.plist` —
  hardened-runtime entitlements for signed mac builds.
- `assets/appx/` and `assets/store/` — tracked Store package/listing images;
  `scripts/store-art.js` regenerates them. The packager's build-resources
  directory is `assets/`; `build/` holds generated PyInstaller intermediates.
- `test/e2e.js` — the Playwright-driven end-to-end suite (see
  [checklist.md](checklist.md)). `test/smoke.js` — runs the app's `--smoke`
  self-test (dev or `--packaged`).

## Invariants

- The shell must keep treating Gamma as a black box: talk to it only via the
  public HTTP API + env config (`GAMMA_DATA_DIR`, `GAMMA_STATIC_DIR`,
  `GAMMA_ADMIN_USER`, `GAMMA_ADMIN_PASSWORD`, `GAMMA_VERSION` = the shell's
  own version, so the server's admin dashboard names the app), `/api/health` and
  `/api/session` (+ the `?ws=` URL parameter). No imports from `backend/`,
  no frontend patches. The one thing it reads off the page is the
  `data-theme` attribute (read-only, via the preload).
- Server pages never get an IPC bridge; `gammaShell` exists only on the
  shell's own `file:` pages, and every handler re-checks the sender.
- Local sidecars bind `127.0.0.1` only (the LAN-exposed use case is the
  existing server/Docker deployment, not the desktop app).
- Navigation allowlist: only registered server origins render in the
  content view; foreign URLs (including `window.open` and cross-origin
  redirects) go to the system browser.
- The updater never installs without the user's click (the pill / button /
  dialog); automatic work is limited to checking and downloading.

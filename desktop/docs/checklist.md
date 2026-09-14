# Desktop QA checklist

What to verify before cutting a release, and how much of it the suite does
for you. Run the automated part on the packaged build (that is what ships):

```bash
python desktop/build_backend.py && cd desktop && npm run pack && npm run e2e:packaged
```

`npm run e2e` runs the same suite on the dev tree (sidecars from
`backend/venv`, frontend from `frontend/dist`) in ~3 min; `--continue` keeps
going after a failure, `--keep` leaves the temp profile behind for a look.
The suite uses a throwaway userData profile, so your real servers are
never touched. Each item below names the e2e step that covers it (**auto**)
or says it is a manual look (**manual**).

## 1. Lifecycle

| # | Check | How |
|---|---|---|
| 1.1 | First start shows the launcher; the shell bar reads *Servers*; layout is bar 38 px + content below | auto: *first start shows the launcher + shell bar* |
| 1.2 | Create a local server → card appears, data dir created under `workspaces/<id>` | auto: *create a local server from the launcher* |
| 1.3 | Open it → sidecar starts on a free `127.0.0.1` port, Gamma loads, silent admin login lands, bar shows the name + reload button | auto: *open it: sidecar starts, Gamma loads, auto-login lands* |
| 1.4 | Quit → every sidecar process is gone (no orphan `gamma-server.exe`/python), window bounds saved | auto: *quit: every sidecar stops, window bounds persist* |
| 1.5 | Relaunch → the last server reopens by itself, data intact, chrome already in the persisted theme | auto: *relaunch reopens the last server with its data intact* |
| 1.6 | *Reopen last server at launch* switched off → launcher at start | manual (toggle in the launcher, restart) |
| 1.7 | Cold start of the frozen server stays well under the 60 s health budget on a slow disk | manual: watch the *Starting …* status; `logs/<id>.log` has the uvicorn banner |

## 2. Switching (the reason the shell bar exists)

| # | Check | How |
|---|---|---|
| 2.0 | Bar dropdown lists the open server's Gamma workspaces (check on the current one, role per row); choosing one navigates to `?ws=<id>` on the same server and the bar names it | auto: *Gamma workspaces: the bar lists them and switches with ?ws=* |
| 2.1 | Bar dropdown lists every server with running dots, check on the current one, *All servers…* | auto: *second server; switch from the shell bar while Alpha keeps running* |
| 2.2 | Switching to another local server starts its sidecar; the first one keeps running | auto (same step) |
| 2.3 | Switching back is instant and hits the same server process (no restart, session still valid) | auto: *switch back to Alpha: instant, same server, no restart* |
| 2.4 | The dropdown closes on choose / outside click / Esc, and the bar shrinks back to 38 px | auto (bar height asserted) + manual feel |
| 2.5 | `Ctrl/Cmd+Shift+L` and the *All servers…* item go to the launcher | auto: *launcher lists sizes …* uses the menu item; accelerator manual |
| 2.6 | A server added while another is open shows up in the dropdown | auto (Beta is added mid-session) |

## 3. Storage (per-server `GAMMA_DATA_DIR`)

| # | Check | How |
|---|---|---|
| 3.1 | Layout: `users.db`, `workspaces/<id>/pages.db`, `workspaces/<id>/data.db`, `workspaces/<id>/uploads/` (one dir per Gamma workspace; a pre-workspace `users/<name>/` layout is upgraded at first start, snapshot under `backups/`) | auto: *data dir has the standard GAMMA_DATA_DIR layout* |
| 3.2 | An uploaded PDF lands in `uploads/` under its content-hash name, exactly once | auto: *upload a PDF + create a paper page with a math note* |
| 3.3 | Launcher shows size on disk per local server + the *last opened* badge | auto: *launcher lists sizes, last-opened badge …* |
| 3.4 | Remove → *keep files* leaves the folder; *delete everything* removes it (only under the default or the configured storage root) | auto (remove) + manual (check the folder) |
| 3.5 | Two servers never share state (separate DBs, uploads, sessions) | auto: Beta starts empty; Alpha's page only appears after the import |
| 3.6 | Storage limits still apply per server (Settings → Users in Gamma) | manual, Gamma's own feature |
| 3.7 | *Local server storage → Change…* + *Move data*: every local server lands under `<new root>/<id>`, old folders gone, sidecars stopped (they start on the next open), library intact; *Use default* moves back | auto: *storage folder: change the root, existing servers move, data intact* (the picker itself is manual) |
| 3.8 | *Only new servers* leaves existing ones in place; the next new server is created in the new root | manual |

## 4. Export / import inside a server

| # | Check | How |
|---|---|---|
| 4.1 | Page export in every mode returns 200 with content: `readable`, `notes-pdf`, `logseq-graph`, `zotero-rdf`, `gamma` | auto: *page exports in every mode* |
| 4.2 | `notes-pdf` and `export-pdf` (annotated PDF) are real PDFs — the frozen bundle carries PyPDF2, pypdfium2's native lib and the ziamath/ziafont fonts | auto (same step; `%PDF` magic asserted) |
| 4.3 | Markdown import creates a page | auto: *markdown import creates a page* |
| 4.4 | Backup zip (*Export my data*) downloads through the browser download path into a file | auto: *backup zip downloads through the browser download path* |
| 4.5 | Save dialog appears for downloads in the real app (tests bypass it via `GAMMA_SHELL_DOWNLOAD_DIR`) | manual |
| 4.6 | *Import data* restores the backup into another server's workspace, uploads included | auto: *import the Alpha backup into Beta* |
| 4.7 | Drag-and-drop a PDF / `<input type=file>` uploads work in the Electron window | manual |
| 4.8 | Zotero RDF and Logseq imports | manual (need real export files) |

## 5. Remote servers + navigation guard

| # | Check | How |
|---|---|---|
| 5.1 | A remote URL loads without auto-login (normal Gamma login), bar shows its name | auto: *remote server: a URL, loads without auto-login* |
| 5.2 | Unreachable server → back on the launcher with the error text | auto: *unreachable remote falls back to the launcher with the error* |
| 5.3 | Remote cards and bar-menu rows carry a reachability dot: green for a live server, red for a dead URL, dim until probed | auto: *remote reachability dot: on for the live server, off for a dead URL* |
| 5.4 | Foreign URLs (`window.open`, `location` changes, `target=_blank` chips) open in the system browser; the window stays on the server | auto: *navigation guard: foreign URLs open outside, the window stays* |
| 5.5 | ChatGPT-OAuth sign-in: the auth page opens in the system browser and the pasted callback URL completes it in Gamma | manual |
| 5.6 | HTTPS remote with a self-signed cert shows Chromium's interstitial (expected: use a real cert) | manual |

## 6. Look and feel

| # | Check | How |
|---|---|---|
| 6.1 | Chrome follows Gamma's theme (dark/light/sepia/gray) live and persists it | auto: *theme mirror* |
| 6.2 | Windows: title-bar overlay controls recolor with the theme; the bar stops where they begin; the bar area drags the window | manual |
| 6.3 | macOS: traffic lights sit in the bar (`hiddenInset`), bar padded past them | manual (build on a Mac) |
| 6.4 | Launcher and bar use Gamma's tokens/controls/icons (no emoji, no bespoke colors) | manual: compare with Settings in Gamma |
| 6.5 | Alt reveals the native menu on Windows; accelerators work without it (Ctrl+R reload, Ctrl+Shift+I devtools, Ctrl+0/±) | manual |
| 6.6 | Rename from the launcher updates the bar immediately | auto: *rename + remove from the launcher* + bar name via pushState |
| 6.7 | Linux: title-bar overlay controls as on Windows (6.2); the desktop entry shows the icon in the launcher/dock; `gamma` on PATH starts the app | manual (build on Linux) |

## 7. Updates

| # | Check | How |
|---|---|---|
| 7.1 | Dev tree / test harness: updater reports `unsupported`, the launcher's Updates row says so, no pill in the bar | auto: *updater: disabled under test, state exposed through the shell* |
| 7.2 | Packaged app, no newer release: *Help → Check for Updates…* says *latest version*; the launcher row reads *Up to date* | manual |
| 7.3 | Packaged app, offline: the row reads *Update check failed: …*, nothing else complains; *Try again* re-checks | manual |
| 7.4 | Windows: install an older version, publish a newer release → within ~15 s of launch the bar shows *Restart to update* (row: *ready; installs when you restart*); clicking it quits, stops every sidecar, installs silently, and the relaunched app reports the new version | manual, needs a real release |
| 7.5 | macOS (unsigned): same setup shows the *Update: <v>* pill; clicking opens the release page in the browser instead of installing | manual (build on a Mac) |
| 7.6 | Linux (.deb): same setup as 7.4 shows *Restart to update*; clicking it opens a pkexec password prompt, `dpkg -i` runs, and the relaunched app reports the new version | manual, needs a real release |

## 8. Release

| # | Check | How |
|---|---|---|
| 8.1 | Version: patch releases need nothing (newest `v*` tag + 1); for a minor/major raise `"version"` in `desktop/package.json` above the newest tag before merging | manual |
| 8.2 | `desktop` workflow on the merge: version pinned → frontend build → freeze → frozen health check → electron-builder → signature verify (ad-hoc on macOS without a cert) → packaged smoke, all three OSes; Linux also installs the `.deb` and smokes `/opt/Gamma/gamma`; publish → release + tag, docker re-tag, Store submission when secrets exist | CI |
| 8.3 | Release page lists `Gamma-<v>-win-x64.exe` (+ `.blockmap`, `latest.yml`), `Gamma-<v>-mac-arm64.dmg`/`.zip` (+ `latest-mac.yml`), `Gamma-<v>-linux-amd64.deb` (+ `latest-linux.yml`); the release is NOT a draft / pre-release (installed apps skip those) and is marked *Latest* (an `extension-v*` release must never be) | manual on the release page |
| 8.4 | Fresh machine: installer runs (unsigned: SmartScreen *Run anyway*; signed: no SmartScreen block, *Publisher* shows the cert subject in the UAC prompt; Debian/Ubuntu: `sudo apt install ./Gamma-<v>-linux-amd64.deb` pulls the deps), first launch creates a local server, no Python/Node needed | manual |
| 8.5 | Signed macOS build: `codesign --verify --deep --strict Gamma.app` and `spctl --assess --type execute Gamma.app` pass; a fresh download opens without any dialog (the release job's *Verify signature* step covers this on the runner) | manual |
| 8.6 | Cert-less macOS build (ad-hoc): a fresh download shows *Apple could not verify…*, and *Privacy & Security → Open Anyway* launches it; no *damaged* dialog | manual (needs a Mac) |

## Last run

| Suite | Date | Result |
|---|---|---|
| `npm run e2e` (dev tree, Windows 11) | 2026-09-02 | 21/21 passed |
| `npm run e2e:packaged` (frozen bundle, Windows 11) | 2026-09-02 | 21/21 passed |

Manual items last looked at 2026-09-01 on Windows 11: 1.6, 2.4, 2.5, 6.2,
6.4, 6.5 (screenshots of the bar + launcher in dark and light). Not yet
exercised: 5.5, 5.6, 4.7, 4.8, 7.2–7.6, everything macOS (6.3), everything
Linux beyond the CI smoke (6.7, 7.6), 8.4, 8.5.

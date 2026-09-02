# Gamma Desktop — plan

A double-clickable Mac app that starts and maintains a local Gamma. Its own
window, its own Dock icon; it never opens a browser. Everything the hosted
version does except being reachable from outside the machine.

Status: **Phases 0, 1 and 1b done, and the Mac app works.** 0.1.1's `.dmg`,
built by CI on `macos-14`, runs on real hardware (confirmed 2026-09-02): the
chooser appears, local mode starts its bundled backend, and the library opens.
The Linux AppImage still fails its packaged tests on the x86-64 runner.

## Goal

One artifact (`Gamma.app`) that a person double-clicks. On first launch it asks
one question — run locally, or connect to a server you already have — and then
gets out of the way. In local mode it brings up the backend, shows the library
in a real window, and shuts the backend down on quit. No terminal, no Docker,
no Python install, no `localhost` URL to remember.

## Non-goals for v1

- **Reachability from other machines.** Share links still *work* — they are
  woven through eight backend modules and there is nothing to remove — but a
  `http://127.0.0.1:…/?share=…` URL is only useful on that machine. Exposing it
  is Phase 3, opt-in, with a warning.
- Multi-user. One person, one library.
- Auto-update. Replace the `.app`.
- iOS/iPadOS.

## What made this cheaper than expected

Three properties of the existing code, verified rather than assumed:

1. **The frontend is origin-relative.** `const API = "/api"` in `utils.js` —
   no host or port is baked in anywhere. The same `frontend/dist` works on any
   port with no rebuild.
2. **The server already supports being pointed anywhere.** `GAMMA_DATA_DIR`
   and `GAMMA_STATIC_DIR` are the only knobs needed; `gamma/app.py` already
   serves the SPA itself when `GAMMA_STATIC_DIR` is set, with `/api` routes
   taking precedence.
3. **Share links need no surgery.** See non-goals.

## Architecture

```
Gamma.app
├── main.js ...................... window, views, layout, theme, menu, IPC
│   ├── lib/registry.js .......... workspaces.json + the migration
│   ├── lib/sidecar.js ........... one local server per workspace
│   └── ui/ ...................... bar.html + launcher.html (the shell's chrome)
├── bar view ..................... the title bar: switcher, status, reload
├── content view ................. the launcher, or a workspace's own Gamma
└── Resources/                     (used by local workspaces)
    ├── python/ .................. standalone CPython, trimmed (43 MB)
    ├── site-packages/ ........... the 11 declared runtime deps (65 MB)
    ├── backend/gamma/ ........... the backend package (764 KB)
    └── static/ .................. frontend/dist (4.7 MB)

shell state → <userData>/{workspaces.json, workspaces/<id>/, logs/<id>.log}
```

The content view's **preload exposes nothing on a Gamma page** — it loads the
app's UI, remote servers, and AI output, none of which has business reaching
the main process. All it does there is report `data-theme`. The bridge exists
only on `file:` pages, and every IPC handler re-checks the sender frame rather
than trusting the preload alone.

The renderer points at an HTTP server rather than loading files directly: the
app is a FastAPI application, and `file://` would break every `/api` call, the
PDF proxy and the asset paths alike.

## Decisions

### Workspaces, not modes

The first version asked one question at first launch — run locally, or connect
to a server — and remembered the answer as a mode. That was too small an idea,
and the design it was replaced with is **tim4431's**, from the parallel shell
he built on the same suggestion: a *workspace* is a Gamma server, and there can
be as many as you like.

- **local** — a library directory on this machine, served by a backend the
  shell starts. Several local workspaces means several libraries, one server
  each.
- **remote** — a Gamma you already run, reached by URL, with its own login.

They are independent servers with no synchronisation; moving notes between them
is Gamma's own export/import. Local servers stay up once started, so switching
back is instant, and each library keeps its own advisory lock, so two servers
can never share one set of SQLite files — which matters much more once several
libraries exist.

The window follows from that: a 38px **bar view** that is also the title bar,
holding the workspace switcher and a reload button, above a **content view**
showing either the launcher or the workspace's own Gamma. The launcher lists
workspaces as cards with size, path or URL, last-used, and per-workspace
actions — including the **server log**, which had been an open task here.

The chrome paints in Gamma's own theme: the preload mirrors the page's
`data-theme` to the main process, which restyles the bar, the launcher, the
window background and the Windows title-bar overlay, and remembers it so the
chrome is right before any page has loaded. `ui/theme.tokens.css` is generated
from `frontend/src/app.css`, because copied colour values drift and chrome that
is nearly the right grey looks worse than chrome that is plainly separate.

A typed address is still checked against `GET <url>/api/health` **before** a
window is pointed at it, with the four failure modes reported distinctly
(unreachable / timed out / answered with a status / answered but isn't Gamma).

**What was kept rather than adopted**, where the two shells disagree:

| | his | here | why |
|---|---|---|---|
| local sign-in | admin credentials generated per workspace, stored in `workspaces.json`, POSTed to `/api/login` from the page | the loopback auto-session | no password at rest, and nothing to leak; the guard is three conditions in code with a test for each failing closed |
| the interpreter | PyInstaller freeze | standalone CPython + plain `site-packages` | his macOS build does not run; ours is verified on four platforms |
| quitting | `stopAll()` fire-and-forget on `before-quit` | awaited teardown | an orphan holds its library's lock and the next launch refuses to start — the failure this project has already hit |

Adopted from him nearly as-is: the workspace registry, the bar-plus-content
window, the launcher's card list, theme mirroring, per-workspace logs, window
bounds, serialised opens, and the `shellOnly` IPC guard that re-checks the
sender frame is a `file:` page rather than trusting the preload alone.

**Migration matters more than any of it.** The pre-workspaces app kept one
library in the platform's application-support directory. The migration adopts
*that directory* as a workspace rather than starting an empty one, and marks it
as not-ours so *Delete everything* can never touch it. Losing someone's notes
to a refactor is not a recoverable mistake, so it has its own tests.

### Electron, not Tauri

Tauri would be ~10 MB against Electron's ~150 MB, and that is a real cost. It
loses anyway, for two reasons:

- **Engine parity.** Tauri renders in the system webview — WKWebView, i.e.
  Safari — while every line of this frontend was written and tested against
  Chromium. It leans on `color-mix()`, `:is()`, CodeMirror 6, KaTeX and a
  custom pdf.js viewer. Shipping it on an engine nobody has tested it on
  invites exactly the class of bug that is most expensive to chase.
- **Testability.** Electron 44 (Chromium 152) runs and renders on the Linux
  aarch64 dev box under `xvfb-run`, so the app can be driven by the same
  Playwright harness used for everything else. Tauri's Linux build uses
  WebKitGTK, so testing it here would not even exercise the Mac code path.

Expected download: see the measured sizes below. Obsidian/VS Code territory
for a tool in this category.

### No login screen, hard-gated to loopback

The app creates one local account and establishes its session automatically.
The bcrypt/session machinery stays exactly as it is underneath; only the
*presentation* of login goes away.

The gate is the point, and implementing it showed one condition was not
enough. `auth.desktop_auto_user` requires all three:

1. `config.DESKTOP_MODE` — set only by the desktop launcher, so the code is
   inert in the hosted deployment.
2. The request's peer address is loopback. Even in desktop mode, a request
   from the LAN gets no free session.
3. No proxy headers (`X-Forwarded-For` and friends). **This is the one a bind
   check alone would have missed:** behind a reverse proxy every peer address
   looks like loopback, which would have turned condition 2 into a rubber
   stamp for anyone on the internet.

Phase 3 therefore cannot silently publish an unauthenticated library —
publishing it necessarily violates 2 or 3.

### Unsigned to start

Free, and Gatekeeper's one-time right-click → Open is an acceptable cost for a
personal tool. Signing and notarization (Apple Developer Program, $99/yr) can
be added later without redoing anything; it is a build step, not a design.

"Unsigned" has a hard floor, though, learned the expensive way: on Apple
Silicon a bundle with *no* signature does not run at all — Finder reports
"Gamma is damaged and can't be opened", which reads like a corrupt download and
is actually macOS refusing code whose signature does not validate. Ad-hoc
signing (`codesign --sign -`) is the minimum, and it must happen before the
dmg is built. See Phase 1b.

### Standalone CPython, not PyInstaller

PyInstaller reliably fights `pypdfium2` and `pikepdf`, whose native libraries
it has to discover and relocate. A standalone CPython
(`python-build-standalone`) plus a plain `site-packages` directory has no magic
to go wrong, and the size difference is small once the tree is trimmed.

**Measured** (task 0.1, done), rather than estimated:

| | |
|---|---|
| `requirements.txt` closure, clean venv | 96 MB |
| …minus `pip`/`setuptools` and `__pycache__` | **65 MB** |
| CPython 3.12 standalone, macOS arm64, trimmed | **66 MB** |
| `gamma` package | 1.7 MB |
| `frontend/dist` | 4.7 MB |
| Electron framework, one arch | ~150–190 MB |

So roughly **290–330 MB** per-architecture app, compressing to perhaps
120–160 MB in a `.dmg`. The full 463-test suite passes against the 65 MB
trimmed tree, so the trim is verified rather than hoped for.

Two things the measurement caught:

- **`.dist-info` cannot be stripped.** `ziamath` resolves `latex2mathml`'s
  version through `importlib.metadata` at import time, so removing the
  metadata directories raises `PackageNotFoundError`. Keeping them costs 2 MB.
- **`lxml` (13 MB) stays.** It arrives via `pikepdf`, which uses it for XMP
  metadata. Nothing here imports it directly, so it is *probably* droppable —
  but a wrong guess is an `ImportError` in front of a user with no terminal,
  and 13 MB of a 300 MB app is not worth that.

**Apple Silicon only; not universal, and no Intel build.** A universal binary
doubles the interpreter, the native wheels and the Electron framework — roughly
600 MB — to serve Intel Macs, and it cannot be staged on a single runner
because `pip` installs for the host: it would take two runners and a merge
step. Intel Macs are not a target (decided 2026-09-02), so neither cost is
worth paying.

### Data location

`~/Library/Application Support/Gamma/` — the Mac convention, survives app
replacement, and Time Machine covers it. The existing Docker volume is
**never touched**; a separate explicit import copies it in (task 2.1).

## Phases

### Phase 0 — make the server desktop-ready — **DONE**

All plain Python, all tested on Linux. 17 new tests; suite at 463.

- **0.1** ✅ Measured — see the sizes above.
- **0.2** ✅ `gamma/desktop.py`: per-OS data dir, port picking (9001 then
  ephemeral), and a `desktop.json` record of port + pid.
- **0.3** ✅ `SingleInstance`, an advisory `flock`/`LK_NBLCK` on the library
  directory. A second launch prints `GAMMA_ALREADY_RUNNING {port, pid}` and
  exits 3 so the shell can focus the live window. A stale record left by a
  SIGKILL is detected via the pid and cleared, so a crash cannot lock the user
  out of their own library.
- **0.4** ✅ `auth.desktop_auto_user`. Three conditions, each tested for
  failing closed alone: the `GAMMA_DESKTOP` flag, a loopback peer, and no
  proxy headers. A real session cookie always wins, so signing in as another
  account still works.
- **0.5** ✅ `seed.ensure_desktop_user` — idempotent, no password printed. The
  row still carries a bcrypt hash of a random secret rather than an empty
  one: if sharing is ever enabled the guard correctly refuses the
  auto-session, and this account must not then be a password-less way in.
- **0.6** ✅ Already existed — `GET /api/health` is unauthenticated and touches
  no database. Adding `/healthz` would have been a duplicate.
- **0.7** ✅ SIGTERM/SIGINT set `should_exit`; uvicorn drains with a 10s
  grace; a `finally` clears the record and releases the lock. Verified by
  signalling a live instance: process gone, record cleared, port released,
  and a fresh launch succeeds immediately.

`gamma/static_paths.py` was needed too and is not in the original list: a
packaged app has to *find* the built frontend, whereas the container is told
where it is. It requires an `index.html` to accept a candidate — an empty
directory winning would serve a blank page and drop every `/api` call into the
SPA fallback.

Entry point: `python -m gamma.desktop_main`, which prints one line the shell
parses:

```
GAMMA_READY {"port": 9001, "pid": 4242, "data_dir": "…", "user": "local", "url": "…"}
```

### Phase 1 — the app shell — **DONE**

`desktop/`, ~1,100 lines of JavaScript. 7 Electron tests + 11 unit tests, run
against both the source tree and a packaged build.

- **1.1** ✅ `main.js`. No window until `/api/health` answers; a native error
  dialog with the tail of the backend's log if it dies during startup.
- **1.2** ✅ `supervisor.js`. Parses `GAMMA_READY`/`GAMMA_ALREADY_RUNNING` from
  the backend's stdout — no port guessing, no sleep-and-hope. Bounded restart
  (3 in 60s, then a dialog). `before-quit` waits for the child to actually die
  before letting Electron exit, because an orphan holds the library's
  single-instance lock and the *next* launch would refuse to start.
- **1.3** ✅ `menu.js`, deliberately thin: every accelerator here steals a
  keystroke from the page, and the web UI binds many. Reload is a custom item
  rather than `role: "reload"` — after a backend restart the app's URL may be
  on a different port.
- **1.4** ✅ `test/smoke.mjs` — launch, library renders, auto-session signs in,
  no console errors and no unexpected HTTP ≥400, quit, and the Python child is
  gone with its record cleared.
- **1.5** ✅ Same suite: a generated one-page PDF (`test/tinypdf.mjs`) is
  uploaded through the app's own API, opened, and asserted to produce a canvas
  with real pixels *and* a text layer containing its text. pdf.js and the
  bundled backend both work inside the window.
- **1.6** ✅ `electron-builder` config, per-architecture (see below), plus
  `scripts/stage-runtime.mjs` to assemble the Python side.
- **1.7** ✅ The mode chooser (added mid-phase at the user's request; see
  Decisions). Also tested: unreachable address reported on the chooser,
  remote mode starts no local backend, a remembered choice skips the screen.

Two bugs the tests caught, both of which would have shipped:

- `window-all-closed` quit the app the instant the chooser closed, before its
  replacement window existed — invisible on macOS (where that event does not
  quit) and fatal on Linux and Windows.
- `normalizeServerUrl` prefixed `https://` onto anything without a scheme,
  turning `file:///etc/passwd` into the parseable nonsense
  `https://file///etc/passwd`.

**Staged bundle, measured** (Linux aarch64, `npm run stage`):

| | |
|---|---|
| CPython 3.12.11 standalone, as downloaded | 102 MB |
| …trimmed (Tk, IDLE, terminfo, headers, static libs, `libpython`) | **43 MB** |
| `site-packages`, 11 deps + transitive | 65 MB |
| `gamma` package | 764 KB |
| `frontend/dist` | 4.7 MB |
| **staged total** | **113 MB** |
| unpacked app including Electron (arm64) | 400 MB |

The `libpython` shared library is 28 MB of that trim, and dropping it is not a
guess: `trimPython()` moves it aside, re-runs the full import check, and puts
it back if anything fails. On this build the launcher is statically linked and
does not need it; on a build where it does, the app keeps working.

### Phase 1b — build it in CI, not by hand — **DONE**

`.github/workflows/desktop-release.yml`. A `desktop-v*` tag builds two
artifacts and, on each one, **runs the app it just built**: the same Playwright
suite with `GAMMA_PACKAGED_APP` pointed at the packaged binary. A release that
cannot start its own backend fails in CI rather than on someone's laptop.

| Runner | Artifact |
|---|---|
| `macos-14` | `.dmg`, Apple Silicon |
| `ubuntu-latest` | `.AppImage`, x86-64 |
| `ubuntu-24.04-arm` | `.AppImage`, arm64 |
| `windows-latest` | NSIS `.exe`, x86-64 |

- The tag must match `desktop/package.json`'s version — the same guard
  `extension-release.yml` uses.
- `--${{ matrix.arch }}` pins each build to one architecture, so the config's
  arch list cannot make a runner emit a bundle it did not stage a Python for,
  and the output paths stay predictable.
- The interpreter download is cached per OS and architecture.
- macOS builds are **ad-hoc signed** (`codesign --sign -`) from
  `desktop/scripts/afterPack.cjs`, i.e. *inside* packaging. An entirely
  unsigned bundle does not merely warn on Apple Silicon — it fails to launch
  with "Gamma is damaged and can't be opened", which is macOS refusing code
  whose signature does not validate. Ad-hoc signing is still not a Developer
  ID: a download also needs the one-time right-click → Open.

  0.1.0 got this wrong in an instructive way. Signing ran as a *workflow step
  after* `electron-builder`, which had already assembled the dmg — so the seven
  tests passed against a signed bundle in `dist/` while the artifact shipped
  the unsigned one. "Tests passed" and "the download works" came apart. The
  hook now runs before the dmg exists, and a further step opens the dmg,
  verifies its payload's signature and **runs the suite on the app it
  contains** — the artifact, not an intermediate.
- Linux needs Electron's shared libraries installed on the runner:
  `playwright install-deps chromium` covers all but GTK (its Chromium is
  headless-shell, which does not need it). Verified in a bare `ubuntu:24.04`
  container, where the binary otherwise cannot load at all — 19 unresolved
  sonames.
- Releases are created as **drafts**, so the artifacts can be tried before
  anything is published.
- **1b.5** When signing is adopted it is configuration rather than new
  machinery: a base64 `.p12` plus its password, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as repository secrets;
  `electron-builder` performs notarization itself.

This repo is public, so macOS runner minutes are free (private repos bill them
at a 10× multiplier — worth remembering if that ever changes).

Three tiers of verification, which is what keeps the untestable surface small:

| Where | Engine | Catches |
|---|---|---|
| Linux dev box, `xvfb` | Chromium (same as the Mac build) | logic, lifecycle, rendering regressions — fast |
| macOS CI, every tag | the real `.app` | packaging, bundled-Python paths, macOS-only breakage |
| Your Mac | the shipped `.dmg` | Gatekeeper, retina, trackpad, feel |

Both the first two tiers are in place and green. The Linux tier also runs
against a *packaged* build here (`GAMMA_PACKAGED_APP=…`), which is what proved
the staged interpreter and `site-packages` are wired correctly — the packaged
app runs `Resources/python/bin/python3`, not any system or venv Python.

### Phase 2 — make it usable day to day

- **2.1** Import an existing library (the Docker volume, or a Gamma export).
- **2.2** Crash/log surface. Partly done: **Help → Backend Log** shows the last
  60 lines in a dialog. A real log *file* on disk, and a way to reveal it, is
  still missing — the tail is lost when the app quits.
- **2.3** Windows and Linux arm64 — both in the matrix now. Linux arm64 is the
  architecture the dev box builds natively, so it was nearly free. Windows
  needed real changes, described below, and none of them can be tested here.
- **2.4** ✅ App icon — `desktop/assets/icon.svg`, the icon half of
  `logos/gamma-logo-dark.svg` with Apple's 10% margin, rasterized to 1024px by
  `npm run icon`. Chromium does the rasterizing (`scripts/render-icon.cjs`):
  ImageMagick's built-in SVG renderer silently drops the clipped group, losing
  the Γ and the standing wave and letting the mirrors escape the rounded
  square. The engine that draws the app draws its icon.

### What Windows actually needed

Adding `windows-latest` to a matrix is the easy part; the platform differences
are not cosmetic:

- **No `SIGTERM`.** `child.kill()` on Windows is `TerminateProcess`, which the
  backend cannot catch, so uvicorn never drains and the `finally` that clears
  the instance record never runs. `stop()` uses `taskkill /T /F` there, which
  at least takes the whole tree down instead of orphaning descendants. Leaving
  a stale record behind is survivable by design: `running_instance()` checks
  whether the recorded pid is alive and clears it if not, and the OS releases
  the lock file when the process dies.
- **A different interpreter layout.** Windows keeps the standard library in
  `Lib/` beside `DLLs/`, `libs/` and `tcl/`; Unix uses `lib/pythonX.Y`. The
  trim list was written for Unix, so on Windows it matched nothing — a bundle
  would have shipped with IDLE, Tk and the test suite inside. `python3.dll`
  and `python312.dll` sit beside `python.exe` and are linked by name, so the
  conditional `libpython` trim is skipped there entirely.
- **PowerShell.** `windows-latest` runs `run:` steps in PowerShell, and every
  script in `desktop/scripts` is bash, so the job sets `shell: bash`.
- **No dependable `python3` or `file(1)`** in Git Bash. The annotation
  escaping in `ci-step.sh` is `sed` and `awk` now, and the Windows branch of
  "locate the built app" checks a name rather than an architecture (there is
  only one).

### What the Windows runner found that nothing else could

Two of the four platform bugs were only reachable on Windows, and one of them
was a real defect rather than a build problem:

- **`.mjs` was served as `text/plain`.** Python's `mimetypes` resolves
  extensions through the *registry* on Windows, where `.mjs` is usually
  absent. Chromium then refuses the file as a module script, and pdf.js
  degrades to its main-thread fake worker without erroring: pages still
  render, and no text is extracted. Selection, highlighting and in-PDF search
  would all have been broken on Windows, and the failure is silent — a canvas
  appears, so it looks like it works. `static_paths.register_web_mime_types()`
  now pins the types the frontend serves, on every platform.
- **GNU tar and drive letters.** See the staging notes above.

The first one is the argument for testing the packaged app rather than the
source tree: nothing in a unit test, and nothing on Linux or macOS, could have
surfaced it.

### Phase 3 — optional sharing

Opt-in, off by default, behind a dialog that states plainly that it makes the
library reachable from outside the machine.

- Cloudflare Tunnel or Tailscale Funnel as the transport (no inbound port
  forwarding, no certificate work).
- Turning it on **requires** authentication — the Phase 0.4 guard enforces it.

## What needs a Mac in your hands

Once Phase 1b exists, *building* needs no Mac — CI does it. What is left is
judgement, not mechanism:

- Gatekeeper's first-launch dialog, and whether the right-click → Open dance
  is acceptable or signing is worth paying for.
- Retina rendering and trackpad gestures in the PDF viewer.
- Whether the window, menus and Dock behaviour feel right.

Everything else is covered by the Linux dev box (fast iteration, same Chromium
engine) or the macOS runner (the real `.app`, every tag).

## Risks

| Risk | Mitigation |
|---|---|
| pdf.js behaves differently inside Electron than in Chrome | ✅ Tested (1.5): canvas *and* text layer asserted, in the packaged app too |
| Bundle size disappoints | ✅ Measured before committing; 113 MB staged |
| Two instances corrupt SQLite | ✅ The single-instance lock, plus Electron's own; both tested |
| Auto-session leaks into a hosted deployment | ✅ Three conditions in code, each with a negative test |
| Backend dies silently and the window shows nothing | ✅ No window until `/api/health` answers; a dialog with the log tail on failure |
| An orphaned backend locks the library after a quit | ✅ `before-quit` waits for the child; asserted by killing the app and polling the pid |
| The macOS `.app` is still unexercised on real macOS | ✅ Closed: 0.1.1 runs on a real Mac. CI also runs the packaged app on `macos-14` every tag, including the copy inside the dmg |
| CI green but the release job broken | `desktop/scripts/ci-local.sh --clone` runs the whole job locally from a clean clone — added after a hand-written dependency range failed `npm ci` on every runner |

## Open questions

1. **Who else runs this?** Just you → unsigned is fine indefinitely. A lab or
   collaborators → signing moves up the list.
2. **Does the app own the library, or mirror the server's?** Partly answered by
   the mode chooser: "connect to a server" means the app is a *client* of the
   VPS, with one library and no sync problem. Local mode is a separate,
   independent library, with a one-time import (task 2.1). Keeping two
   libraries in sync is a much larger piece of work (conflict resolution) and
   should be planned separately if it is ever wanted.
3. **Should the browser extension point at the desktop app?** It currently
   targets a server URL; `127.0.0.1:<port>` would work, but the port can move.

# Gamma Desktop — plan

A double-clickable Mac app that starts and maintains a local Gamma. Its own
window, its own Dock icon; it never opens a browser. Everything the hosted
version does except being reachable from outside the machine.

Status: **Phases 0, 1 and 1b implemented.** Verified on Linux aarch64 against
both the source tree and a packaged build; the macOS artifact itself is built
by CI and has not yet been run on a Mac.

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
├── main.js ...................... lifecycle, the two modes, window creation
│   ├── supervisor.js ............ spawns + restarts + reaps the backend
│   ├── config.js ................ the remembered mode, in userData/settings.json
│   ├── menu.js .................. edit/zoom/reload, switch mode, reveal library
│   └── chooser/ ................. the first-run screen (its own window)
├── the app window ............... local:  http://127.0.0.1:<port>/
│                                  remote: https://<your server>/
└── Resources/                     (local mode only)
    ├── python/ .................. standalone CPython, trimmed (43 MB)
    ├── site-packages/ ........... the 11 declared runtime deps (65 MB)
    ├── backend/gamma/ ........... the backend package (764 KB)
    └── static/ .................. frontend/dist (4.7 MB)

data → ~/Library/Application Support/Gamma/
       (users.db, users/<name>/{pages.db,data.db,uploads/})
```

The app window carries **no preload script and no IPC**: it loads Gamma's UI,
remote pages in remote mode, and AI output. Only the chooser window gets a
bridge, and it exposes four methods.

The renderer points at an HTTP server rather than loading files directly: the
app is a FastAPI application, and `file://` would break every `/api` call, the
PDF proxy and the asset paths alike.

## Decisions

### Two modes, chosen on first launch

The first window is a chooser: **Run locally** or **Connect to a server**. It
is a plain page inside the app — no browser, and nothing is started until the
question is answered.

- *Local* spawns the bundled backend, as above.
- *Remote* spawns nothing and points the window at an existing Gamma, where the
  normal login applies. This is what makes the app useful to someone who
  already runs the hosted version: it is a real client for it, not a second
  disconnected library.

The choice is remembered in `userData/settings.json` and can be changed from
**File → Switch Server or Library…**. A missing, corrupt, or half-written file
means "no choice made", which shows the chooser again rather than guessing a
mode — settings are written with write-then-rename so a power cut cannot
produce a truncated file in the first place.

A typed address is checked against `GET <url>/api/health` **before** the window
is pointed at it, and the four failure modes are reported distinctly
(unreachable / timed out / answered with a status / answered but isn't Gamma).
Pointing a window at a bad address and letting Chromium's error page explain it
tells the user nothing they can act on.

Deferred deliberately: sync between the two. Remote mode reads the server
live — it is not a local mirror. See open question 2.

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

**Ship per-architecture, not universal.** A universal binary doubles the
interpreter, the native wheels and the Electron framework — roughly 600 MB —
to serve Intel Macs. Two separate downloads is the better trade.

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

`.github/workflows/desktop-release.yml`. A `desktop-v*` tag builds three
artifacts and, on each one, **runs the app it just built**: the same Playwright
suite with `GAMMA_PACKAGED_APP` pointed at the packaged binary. A release that
cannot start its own backend fails in CI rather than on someone's laptop.

| Runner | Artifact |
|---|---|
| `macos-14` | `.dmg`, Apple Silicon |
| `macos-13` | `.dmg`, Intel |
| `ubuntu-latest` | `.AppImage`, x86-64 |

- The tag must match `desktop/package.json`'s version — the same guard
  `extension-release.yml` uses.
- `--${{ matrix.arch }}` pins each build to one architecture, so an Intel
  runner does not also try to emit an Apple Silicon dmg and the output paths
  stay predictable.
- The interpreter download is cached per OS and architecture.
- macOS builds are **ad-hoc signed** (`codesign --sign -`) after packaging: an
  entirely unsigned bundle will not launch on Apple Silicon at all. That is not
  the same as satisfying Gatekeeper for a download, which still needs the
  one-time right-click → Open.
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
- **2.3** Windows. The `electron-builder` config has an NSIS target and
  `desktop.py`/`supervisor.js` have Windows branches, but nothing Windows has
  been run. Linux is done (AppImage, tested).
- **2.4** ✅ App icon — `desktop/assets/icon.svg`, the icon half of
  `logos/gamma-logo-dark.svg` with Apple's 10% margin, rasterized to 1024px by
  `npm run icon`. Chromium does the rasterizing (`scripts/render-icon.cjs`):
  ImageMagick's built-in SVG renderer silently drops the clipped group, losing
  the Γ and the standing wave and letting the mirrors escape the rounded
  square. The engine that draws the app draws its icon.

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
| The macOS `.app` is still unexercised on real macOS | CI runs the packaged app on `macos-14`/`macos-13`, but no tag has been pushed yet |

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

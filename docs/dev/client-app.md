# Gamma Desktop — plan

A double-clickable Mac app that starts and maintains a local Gamma. Its own
window, its own Dock icon; it never opens a browser. Everything the hosted
version does except being reachable from outside the machine.

Status: **plan only** — nothing implemented yet.

## Goal

One artifact (`Gamma.app`) that a person double-clicks. It brings up the
backend, shows the library in a real window, and shuts the backend down when
the window closes. No terminal, no Docker, no Python install, no `localhost`
URL to remember.

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
├── Electron main process ......... window, menu, lifecycle
│     └── supervisor .............. spawns + restarts + reaps the backend
├── Electron renderer ............ loads http://127.0.0.1:<port>/
└── Resources/
    ├── python/ .................. standalone CPython (arm64 + x86_64)
    ├── site-packages/ ........... the 11 declared runtime deps, trimmed
    ├── gamma/ ................... the backend package (1.7 MB)
    └── static/ .................. frontend/dist (4.7 MB)

data → ~/Library/Application Support/Gamma/
       (users.db, users/<name>/{pages.db,data.db,uploads/})
```

The renderer points at the local HTTP server rather than loading files
directly: the app is a FastAPI application, and `file://` would break every
`/api` call, the PDF proxy and the service-worker-free asset paths alike.

## Decisions

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

Expected download: **250–280 MB**. That is Obsidian/VS Code territory for a
tool in this category.

### No login screen, hard-gated to loopback

The app creates one local account and establishes its session automatically.
The bcrypt/session machinery stays exactly as it is underneath; only the
*presentation* of login goes away.

The gate is the point: auto-session is permitted **only** when the server is
bound to `127.0.0.1`. If a bind address is ever anything else, authentication
is required and there is no override. Phase 3 therefore cannot silently
publish an unauthenticated library — the failure mode this guard exists to
prevent.

### Unsigned to start

Free, and Gatekeeper's one-time right-click → Open is an acceptable cost for a
personal tool. Signing and notarization (Apple Developer Program, $99/yr) can
be added later without redoing anything; it is a build step, not a design.

### Standalone CPython, not PyInstaller

PyInstaller reliably fights `pypdfium2` and `pikepdf`, whose native libraries
it has to discover and relocate. A standalone CPython
(`python-build-standalone`) plus a plain `site-packages` directory has no magic
to go wrong, and the size difference is small once the tree is trimmed.

Current venv is 149 MB, but `pip`, `setuptools`, `pytest`, `reportlab`,
`pygments` and `lxml` are not declared runtime dependencies. The real closure
of `requirements.txt` needs measuring (task 0.1); estimate 90–120 MB including
the interpreter, driven by Pillow (~24 MB), `pypdfium2` (7.8 MB) and
`pikepdf` (4.7 MB).

### Data location

`~/Library/Application Support/Gamma/` — the Mac convention, survives app
replacement, and Time Machine covers it. The existing Docker volume is
**never touched**; a separate explicit import copies it in (task 2.1).

## Phases

### Phase 0 — make the server desktop-ready

All of this is plain Python, fully testable on Linux.

- **0.1** Measure the true runtime closure of `requirements.txt` in a clean
  venv. Decides the real bundle size; everything downstream depends on it.
- **0.2** `gamma/desktop.py`: resolve the per-OS data dir; pick a free port
  (try 9001, then ephemeral); write a `port` + `pid` file so the shell can
  find a running instance.
- **0.3** Single-instance lock. Second launch focuses the existing window
  rather than starting a second server on a second port against the same
  SQLite files.
- **0.4** Loopback auto-session, with the bind guard above. Tests must cover
  the *negative* case: a non-loopback bind refusing to auto-session.
- **0.5** First-run: create the data dir and the single account with no
  password printed anywhere.
- **0.6** `GET /healthz` — cheap, unauthenticated, no DB touch, so the shell
  can poll for readiness rather than sleeping.
- **0.7** Clean shutdown: SIGTERM drains in-flight requests, closes SQLite,
  releases the lock.

### Phase 1 — the app shell

Buildable and testable here; only the final `.app` packaging needs a Mac.

- **1.1** Electron main process: spawn the bundled Python, wait on `/healthz`,
  then create the window. Show a native error dialog if the backend dies
  during startup, with the last lines of its log.
- **1.2** Supervisor: restart the backend on unexpected exit (bounded — three
  attempts, then a dialog); never leave an orphan on quit.
- **1.3** Window and menu: Cmd+W/Cmd+Q semantics, zoom, a Reload that reloads
  the page and not the server. Keep the app's own keybindings from colliding
  with the web app's Ctrl+F.
- **1.4** Playwright-over-Electron test: launch, wait for the library to
  render, assert no console errors, quit and assert the Python child is gone.
- **1.5** PDF viewer smoke test in the real window — pdf.js is the most
  likely thing to behave differently inside Electron.
- **1.6** `electron-builder` config for a universal (arm64 + x86_64) `.dmg`.

### Phase 2 — make it usable day to day

- **2.1** Import an existing library (the Docker volume, or a Gamma export).
- **2.2** Crash/log surface: a menu item that reveals the backend log.
- **2.3** Windows and Linux builds, if wanted.

### Phase 3 — optional sharing

Opt-in, off by default, behind a dialog that states plainly that it makes the
library reachable from outside the machine.

- Cloudflare Tunnel or Tailscale Funnel as the transport (no inbound port
  forwarding, no certificate work).
- Turning it on **requires** authentication — the Phase 0.4 guard enforces it.

## What needs your Mac

Everything else can be built and verified on the Linux dev box.

- The final `.dmg` / `.app` packaging and its universal binary.
- Gatekeeper behaviour on first launch.
- Native menu-bar and Dock integration details.
- Signing and notarization, if adopted.
- Retina rendering and trackpad gestures in the PDF viewer.

## Risks

| Risk | Mitigation |
|---|---|
| pdf.js behaves differently inside Electron than in Chrome | Task 1.5 tests it explicitly, early, before the rest is built on top |
| Bundle size disappoints | Task 0.1 measures before committing to the approach |
| Two instances corrupt SQLite | Task 0.3, the single-instance lock, is not optional |
| Auto-session leaks into a hosted deployment | The bind guard is enforced in code, with a test for the negative case |
| Backend dies silently and the window shows nothing | Task 1.1: no window until `/healthz` answers; a real dialog on failure |

## Open questions

1. **Who else runs this?** Just you → unsigned is fine indefinitely. A lab or
   collaborators → signing moves up the list.
2. **Does the app own the library, or mirror the server's?** The plan assumes
   the desktop app has its own independent library, with a one-time import. If
   you want your laptop and the VPS to stay in sync, that is a much larger
   piece of work (conflict resolution) and should be planned separately.
3. **Should the browser extension point at the desktop app?** It currently
   targets a server URL; `127.0.0.1:<port>` would work, but the port can move.

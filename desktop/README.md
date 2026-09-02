# Gamma Desktop

The double-clickable app. It is a thin shell: Gamma's backend and frontend are
untouched, and the window loads the app from whichever Gamma server it is
connected to — exactly like a browser tab, so there is no API-base plumbing and
no version skew.

Design, decisions and phase status: [`docs/dev/client-app.md`](../docs/dev/client-app.md).

## Workspaces

A **workspace is a Gamma server**, and there can be as many as you like:

- **local** — a library directory on this machine, served by a backend the
  shell starts on loopback. No account and no password: the backend signs you
  in when the request comes from this machine (`gamma/auth.py`,
  `desktop_auto_user`), which is three checks in code rather than an admin
  credential stored next to the library.
- **remote** — a Gamma you already run, reached by URL, with its own login.

They are independent servers with **no synchronisation**; move notes between
them with Gamma's own export/import. Local servers stay running once started,
so switching back is instant, and each library has its own advisory lock, so
two servers can never share one set of SQLite files.

## The window

```
┌────────────────────────────────────────────────┐
│ ⌈γ⌉ My library ▾   Starting Thesis…       ⟳   │  bar view — the title bar
├────────────────────────────────────────────────┤
│  the launcher, or the workspace's Gamma        │  content view
└────────────────────────────────────────────────┘
```

One `BaseWindow` and two `WebContentsView`s. The bar holds the workspace
switcher and a reload button; the launcher lists workspaces as cards with their
size, path or URL, and per-workspace actions (open, rename, show the library
folder, **server log**, remove). The chrome paints in Gamma's own theme: the
preload mirrors the page's `data-theme` to the main process, which restyles the
bar, the launcher, the window background and the Windows title-bar overlay.

`ui/theme.tokens.css` is generated from `frontend/src/app.css` by
`npm run sync-theme` — copied colour values drift, and chrome that is *nearly*
the right grey looks worse than chrome that is plainly separate.

## Shell state

In Electron's userData directory (shown at the bottom of the launcher):

- `workspaces.json` — the registry: workspaces, `lastOpened`, `windowBounds`
  and settings. Written rename-over-tmp; anything unreadable is treated as "no
  workspaces yet" rather than a reason to refuse to start.
- `workspaces/<id>/` — libraries the shell created (a standard
  `GAMMA_DATA_DIR` layout). **Only these** can be deleted by *Delete
  everything*; a library adopted from elsewhere is forgotten, never erased.
- `logs/<id>.log` — each server's output, readable from the launcher.

`GAMMA_SHELL_USER_DATA` relocates all of it (the tests use a temp profile),
`GAMMA_SHELL_TEST` records outbound links instead of opening them, and
`GAMMA_SHELL_DOWNLOAD_DIR` saves downloads without a dialog.

## File map

| | |
|---|---|
| `main.js` | window, views, layout, theme mirror, menu, IPC, navigation guard, lifecycle |
| `preload.js` | the `gammaShell` bridge — **only on `file:` pages**; on a Gamma page it exposes nothing and only reports the theme |
| `lib/registry.js` | `workspaces.json`, and the migration from the pre-workspaces config |
| `lib/sidecar.js` | local server lifecycle: spawn, `GAMMA_READY`, health, logs, bounded restart, waited teardown |
| `lib/legacy.js` | where the pre-workspaces app kept its single library |
| `ui/` | `bar.html`, `launcher.html` and their scripts; plain HTML, no build step |
| `scripts/` | staging, packaging, icon rendering, the local CI runner |

## Running from a source checkout

Needs `backend/venv` (or `GAMMA_PYTHON`) and a built frontend:

```sh
npm --prefix ../frontend run build     # once, or after frontend changes
npm install
npm start
```

## Tests

```sh
npm run lint
npm test                  # 16 registry + 9 end-to-end; prefix `xvfb-run -a` on headless Linux
```

The end-to-end suite drives the real launcher: it creates local workspaces,
checks each gets its own library and port and that both servers stay up, adds a
remote workspace against a stand-in server, uploads a PDF and asserts a canvas
*and* a populated text layer, follows the theme, sends an outbound link to the
browser instead of the content view, and — the one that matters most — quits
and asserts the Python child is gone and its instance record cleared.

## Building

```sh
npm --prefix ../frontend run build
npm run stage             # standalone CPython + site-packages + backend + static
npm run dist              # installers in dist/
scripts/ci-local.sh --clone --container   # the release job, locally, before tagging
```

`npm run stage` installs the backend's dependencies *with the interpreter it
just downloaded*, so the wheels match the target's OS and architecture — which
is why a macOS build has to be made on macOS. `.github/workflows/desktop-release.yml`
does this on a `desktop-v*` tag for macOS (Apple Silicon), Windows and Linux
(x86-64 and arm64), then runs this suite against each artifact it built.

# Gamma on the iPad (and other tablets)

This document covers the installable **web app** imported from tim's branch.
This repository also retains the native Swift/PDFKit/PencilKit client in
[`ipad/`](../../ipad/README.md), including recording, replay, cached offline
reading and the **Pencil & Audio** handoff; that client is not replaced by the
home-screen installation described here.

For the web path, the browser ink layer already gives Apple Pencil pressure,
tilt, hover, palm rejection and Safari's touch-gesture handling
([handwriting.md](handwriting.md)), and every other feature — the block
editor, search, AI, sharing, workspaces — is the same React code the
desktop shell hosts. The reasoning, and what the upstream fork's native
PDFKit/PencilKit app was measured against, is in
[research/ipad.md](../research/ipad.md).

## What the user does

1. Open the server's URL in Safari on the iPad and sign in.
2. Share button → **Add to Home Screen** → Add. Chrome and Edge on a
   desktop or Android tablet offer **Install Gamma** in the address bar
   for the same result.
3. Gamma opens full screen from the icon, without Safari's toolbars,
   signed in as before (the session cookie lives a year; the installed app
   has its own cookie jar, so the first launch may ask once).

Writing then works as everywhere else: a Pencil draws right away, fingers
scroll and pinch, the tool strip's presets are per browser (the installed
app counts as one browser, separate from Safari).

## What the install adds, and where it lives

| Piece | Where | Notes |
|---|---|---|
| The manifest | `frontend/public/media/manifest.webmanifest` | `display: standalone`, `start_url` `/` (the app then picks the last used workspace), the three PNG icons. Unversioned, so under `/media/` (sent `no-cache`, [repository.md](repository.md)). The backend registers its media type, `application/manifest+json`, because Windows and slim images lack it (`gamma/app.py`; `tests/test_static.py`). |
| The icons | `frontend/public/media/icons/apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Rendered from the one brand mark by `tools/branding/build.mjs` like every other icon ([design/brand](../../design/brand/README.md)); never edited by hand. The `bleed` option of `mark.mjs` gives them a full-bleed square plate — the OS masks the corners itself, and iOS paints transparent corners black — and the maskable one keeps the mark inside the inner 80%. |
| The head tags | `frontend/index.html` | `manifest`, `apple-touch-icon`, `apple-mobile-web-app-capable` / `mobile-web-app-capable`, the title, `apple-mobile-web-app-status-bar-style` **default** and `theme-color`. |
| The status bar colour | `app/App.jsx`, the theme effect | With the *default* status-bar style the bar sits above the viewport and is painted with `theme-color`; the effect sets that meta to the topbar's background (`--bg-surface`) whenever the theme changes, so the bar continues the topbar for every theme. `black-translucent` was rejected: it puts content under the bar with fixed light text, wrong on the light themes. |
| Standalone-mode CSS | `shared/styles/app.css`, `@media (display-mode: standalone)` | The document stops rubber-banding (`overscroll-behavior: none` on html/body; the panes still scroll) and `.app` pads `env(safe-area-inset-bottom)` for the home indicator. There is no top inset to absorb with the default status bar. |

Nothing else is tablet-specific: the viewport meta already disables
browser zoom in favour of the viewer's own pinch-zoom, `touch-action:
manipulation` removes double-tap zoom, and an iPad gets the desktop
layout (its Safari sends a desktop-class UA and is wider than the phone
breakpoint, `useIsPhone` in App.jsx) with the touch rules the ink layer and
the viewer already carry.

## Web-path limitations

- **No service worker / offline shell.** Installability on iOS does not
  need one, and a cache layer would sit on top of the asset cache rules
  in [repository.md](repository.md). The web installation does not
  inherit the native client's [offline downloads and outbox](../../ipad/OFFLINE.md).
- **Pencil double-tap and squeeze** are not exposed to web content by
  iPadOS; Pencil hover is (a `pen` pointer with no buttons) and already
  shows the tool footprint.
- **Native distribution is separate.** The home-screen installation does not
  install or update the Swift client. This repository's native app includes a
  `WKWebView` full-workspace mode plus PDFKit/PencilKit recording and replay;
  see its [build and signing instructions](../../ipad/README.md).

## Tests

- `backend/tests/test_static.py`: the manifest's media type and cache
  header.
- `tests/e2e/scenarios/ipad.mjs` (`npm run e2e -- --only ipad`): in a
  tablet-sized touch context, the manifest parses with `standalone`
  display and every icon it and the `apple-touch-icon` link name is a real
  PNG; `theme-color` equals the topbar's computed background and follows a
  theme change; the bundled stylesheet carries the standalone block (the
  document overscroll rule and the home-indicator inset — Chromium cannot
  emulate `display-mode`, CDP accepts the feature but `matchMedia` ignores
  it). Chromium, not an iPad: the Add to Home Screen flow, the status-bar
  paint and the home indicator need the device.
- `node tools/branding/build.mjs --check` pins the icons to the mark.

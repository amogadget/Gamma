# Gamma Connector

A Chrome (Manifest V3) extension that saves papers into your Gamma library
with one click — like the Zotero Connector. Design and server contract:
[docs/dev/extension.md](../docs/dev/extension.md).

## Install

Chrome only installs extensions from the Web Store or as an unpacked folder
(zips and .crx files can't be double-click installed), so either way it's
**Load unpacked**:

1. Get the folder: clone the repo, or download
   `gamma-connector-<version>.zip` from the
   [releases page](https://github.com/tim4431/gamma/releases) and unzip it
   somewhere permanent (Chrome loads it from that path).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   pick the folder.
3. Click the γ icon → enter your server address **with its scheme** (e.g.
   `https://gamma.example.com` or `http://192.168.1.20:9001`) → **Connect** →
   sign in. Signing in from Gamma's own tab also works: the session cookie is
   shared. The server must run a Gamma version that has `/api/clip`
   (see `docs/dev/extension.md`).

Releases: tag `extension-v<version>` (matching `manifest.json`) and the
`Release the browser extension` workflow attaches the zip to a GitHub
release. Chrome Web Store publishing (manual, needs a developer account):
[STORE.md](STORE.md).

Edge and other Chromium browsers load it the same way. Firefox needs a
`background.scripts` manifest variant (not included yet).

## Use

- On a paper's landing page or PDF tab the icon shows **PDF / arX / DOI**;
  click it, pick a folder and labels, **Save to Gamma**. ✓ means the paper
  is already in your library — clicking opens it.
- Paywalled PDF your browser can see (institutional login)? The bytes are
  uploaded from your browser automatically when the server can't fetch them
  itself.
- Right-click: *Save link to Gamma*, *Save page to Gamma*, *Clip selection
  to Gamma* (a quoted block under the matching paper, else a "Web clips" page).
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> saves the current page.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: service worker, content script, popup, options, command |
| `worker.js` | per-tab detection state + badge, save pipeline, context menus, popup message API |
| `detect.js` | content script: identifier extraction (meta tags, URL, JSON-LD, DOI fallback) |
| `api.js` | settings in `chrome.storage.sync` + the fetch wrapper (cookie session, error parsing) |
| `popup.html/js/css` | the popup (setup → offline → sign-in → save); styling mirrors the app's theme tokens and control recipes |
| `options.html/js` | server, account, saving defaults |

No build step: plain ES modules.

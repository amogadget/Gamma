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

Releases: the `release` GitHub workflow (run from the Actions tab, no tags
to push) zips the extension as `gamma-connector-<manifest version>.zip` and
attaches it to the same GitHub Release as the desktop app. Chrome Web Store
publishing (manual, needs a developer account): [STORE.md](STORE.md).

Edge and other Chromium browsers load it the same way. Firefox needs a
`background.scripts` manifest variant (not included yet).

## Use

- On a paper's landing page or PDF tab the icon shows **PDF / arX / DOI**;
  click it, pick a folder and labels, **Save to Gamma**. The popup names the
  paper (title, authors, year, venue looked up from the DOI / arXiv id when
  the tab is a bare PDF). ✓ means the paper is already in your library, and
  clicking opens it. If that library page carries a different title, the
  popup says so.
- Paywalled PDF your browser can see (institutional login)? The bytes are
  uploaded from your browser automatically when the server can't fetch them
  itself.
- Right-click: *Save link to Gamma*, *Save page to Gamma*, *Clip selection
  to Gamma* (a quoted block under the matching paper, else a "Web clips" page).
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> saves the current page.

## Connect a publisher session

Reload the extension after upgrading to 0.2.0. Open a publisher article or PDF
over HTTPS and sign in there if needed. In the Connector, expand **Publisher
sessions** and click **Connect publisher session**. Chrome asks for the optional
cookie permission the first time. The displayed publisher host, Gamma server,
and Gamma account identify exactly where the connection applies.

This explicitly transfers the publisher cookies to Gamma for later backend
PDF downloads. Normal Save actions still transfer only the PDF. Use **Refresh
publisher session** after signing in again, or **Disconnect** to delete the
backend's copy. Connections can be disconnected from the popup on any tab.

Requires a personal Gamma account and an HTTPS server (HTTP localhost is also
supported). Guest and incognito sessions cannot connect. Only cookies applicable
to the selected publisher host are sent; university SSO and partitioned cookies
are excluded. Some browser challenges bind sessions to a browser or IP, so a
connected session is not a guarantee of access; browser PDF uploads still work.

The server encrypts the snapshot and limits reuse to that account and exact
HTTPS host. Session cookies last at most 24 hours; persistent cookies last until
their original expiry or 30 days, whichever comes first. Refresh is manual;
uninstalling the Connector does not delete sessions already stored on Gamma.
See [backend storage details](../docs/dev/paper_metadata.md#connected-publisher-sessions).

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: service worker, content script, popup, options, command |
| `worker.js` | per-tab detection state + badge, save pipeline, context menus, popup message API |
| `detect.js` | content script: identifier extraction (meta tags, URL, JSON-LD, DOI fallback) |
| `api.js` | settings in `chrome.storage.sync` + the fetch wrapper (cookie session, error parsing) |
| `popup.html/js/css` | the popup (setup → offline → sign-in → save); styling mirrors the app's theme tokens and control recipes |
| `options.html/js` | server, account, saving defaults |
| `assets/icons/` | enabled/disabled toolbar icons, manifest icons, and notification icon |

No build step: plain ES modules.

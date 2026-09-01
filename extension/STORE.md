# Publishing to the Chrome Web Store

Store publishing can't be automated from the repo: it needs a one-time
developer registration (a Google account, a US$5 fee), a manual dashboard
upload, and Google's review (usually 1–3 days, longer for `<all_urls>`
extensions). Everything below is prepared so the dashboard visit is
copy-paste.

## Steps

1. Register at <https://chrome.google.com/webstore/devconsole> (pay the fee,
   verify the account e-mail).
2. Build the zip: push a tag `extension-vX.Y.Z` (X.Y.Z = `manifest.json`'s
   `version`) — the `Release the browser extension` workflow attaches
   `gamma-connector-X.Y.Z.zip` to a GitHub release. Or locally:
   `cd extension && zip -r ../gamma-connector.zip . -x STORE.md README.md`.
3. Dashboard → **New item** → upload the zip.
4. Fill in the listing (below), upload screenshots (1280×800 or 640×400:
   the popup on an arXiv page, the popup on a PDF tab, the options page),
   pick category **Productivity**, language English.
5. **Privacy** tab: single purpose + permission justifications (below),
   "does not collect user data" for everything except *website content*
   → "not sold, not used for unrelated purposes". Link the privacy policy
   (a page on your Gamma domain or the repo README section).
6. Distribution: **Public**, or **Unlisted** if this stays a personal tool —
   unlisted still gives an install link and auto-updates, without a
   searchable listing.
7. Submit for review. Bump `version` in `manifest.json` for every later
   upload (the store refuses a re-used version).

## Listing copy

**Name:** Gamma Connector

**Summary (132 chars max):**
Save papers and PDFs into your self-hosted Gamma library with one click — like the Zotero Connector, for Gamma.

**Description:**

Gamma Connector is the browser companion for Gamma, the self-hosted PDF
annotation and note server. On a paper's landing page (arXiv, a journal, a
DOI link, OpenReview…) or a PDF tab, the toolbar icon lights up; one click
saves the paper into your Gamma library: the PDF is stored, a note page is
created, it's filed into the folder you pick with your labels, and the
metadata (title, authors, venue, DOI) is resolved automatically.

- Detects papers via citation meta tags, arXiv and DOI links, and JSON-LD.
- Shows ✓ when the paper is already in your library and opens it instead of
  making a duplicate.
- Behind a paywall your browser can see through (institutional login)?
  The bytes your browser already has are uploaded automatically.
- Right-click a link, a page, or selected text: Save to Gamma / Clip to Gamma
  (a quoted block with its source link).
- Ctrl+Shift+S saves the current page.

You need your own Gamma server (github.com/tim4431/gamma). The extension
talks only to the server address you enter; nothing is sent anywhere else.

## Privacy tab

**Single purpose:** Save web pages, papers and PDFs into the user's own
Gamma server.

**Permission justifications**

| Permission | Justification |
|---|---|
| `host_permissions: <all_urls>` | The user's Gamma server is self-hosted at an address only they know (LAN, Tailscale, or a personal domain), so it cannot be listed in the manifest; the same permission lets the content script detect papers on any site and lets the save flow fetch a paywalled PDF with the user's own browser session. Page data is only sent, to the user's server, when the user clicks Save. |
| `storage` | Remembers the server address, the default folder/labels, and per-tab detection state. |
| `contextMenus` | "Save link / page / selection to Gamma" items. |
| `activeTab`, `tabs` | Read the current tab's URL/title for detection and the badge. |
| `scripting` | Reserved for re-running detection on demand. |
| `notifications` | Result of a context-menu or keyboard-shortcut save when no popup is open. |

**Data usage:** website content (page title, DOI/arXiv id, PDF URL, selected
text, the PDF file when the user chooses to upload it) is transmitted only to
the Gamma server the user configured, only on the user's explicit action, and
is not sold, shared, or used for any other purpose. No analytics, no third
parties.

**Remote code:** none — all code ships in the package.

## Privacy policy (host it and link it)

Gamma Connector stores your server address and preferences in your browser's
extension storage. When you click Save or Clip, it sends the current page's
title, identifiers (DOI / arXiv id), PDF link or PDF file, and any text you
selected to the Gamma server address you configured, and nowhere else. It
does not collect analytics, does not use third-party services, and does not
transmit anything without your action. You can remove all stored data by
removing the extension.

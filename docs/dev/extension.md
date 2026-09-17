# Gamma Connector — the browser extension

A Zotero-Connector-style Chrome (Manifest V3) extension in `extension/`: one
click on a paper's landing page or PDF tab saves it into the user's library —
PDF stored, page created, folder/labels applied, metadata resolved — with
"already in your library → open" detection and a right-click clipper for links
and text selections. Server side: `gamma/routers/clip.py`. No build step
(plain ES modules, load unpacked); install steps in
[extension/README.md](../../extension/README.md).

## What it does

1. **Save a paper from its landing page.** arXiv abs, publisher page, DOI
   link, OpenReview… the toolbar badge shows `PDF` / `arX` / `DOI` (`?` for
   a DOI merely found in the text). The popup shows the detected title, a
   folder picker and labels → **Save to Gamma** → *Open in Gamma*
   (`/?block=<id>`).
2. **Save the PDF you are looking at.** The tab *is* a PDF, possibly behind
   an institutional login the server can't reach: the bytes are fetched with
   the browser's session → `POST /api/uploads` → `POST /api/clip {doc_id}`,
   automatically — browser-first on PDF tabs, and as a fallback on any page
   whose PDF the server fails to fetch (no checkbox; see the pipeline below).
3. **Right-click**: *Save link to Gamma* (link), *Save page to Gamma* (page),
   *Clip selection to Gamma* (selection → a `> quote — [title](url)` block
   under the paper matching this tab, else under a "Web clips" note page).
   Results arrive as a notification whose click opens the page.
   A page with no PDF at all still saves: it becomes a page of its own
   carrying the tab as `web_url` (see the pipeline below).
4. **Already in the library** — ✓ badge; the popup offers *Open in Gamma*
   and *Add to another folder…* instead of a duplicate save. When the
   library page's title differs from the paper the tab resolved to, the
   notice says "Already in your library as “…”", so a stale metadata record
   on that page is visible rather than shown as this paper's title.
5. **Preview before saving.** A PDF tab has no meta tags to read a title
   from, so for every detected DOI / arXiv id the worker asks
   `GET /api/library/preview` for the registry record. The popup head then
   shows the paper's title plus authors · year · venue. The previewed title
   also names the new page on save (`auto_title`, so the metadata lookup may
   still replace it).
6. **Ctrl+Shift+S** saves the current page with the default folder.
7. **Options**: server URL, sign in / out, default folder + labels, *prefer
   open-access fallback* and *keep a PDF copy* (the app's `oaFallback` /
   `pdfSaveLocal` prefs, sent as `allow_oa` / `save_copy`).

Non-goals: reading or annotating inside the extension, a local library,
syncing highlights back to the source page.

## Architecture

```
browser tab ──detect.js──▶ worker.js ──fetch, cookies──▶ Gamma server
 meta tags, URL,            per-tab state + badge        POST /api/clip
 JSON-LD, DOI regex,        save pipeline                GET  /api/library/lookup
 selection                  context menus, command       GET  /api/library/preview
                            popup.html · options.html    GET  /api/library/folders
                                                         POST /api/clip/note
                                                         POST /api/uploads · GET /api/session
```

**Thin client, fat endpoint.** The extension only *detects* and *asks*; one
server call, `POST /api/clip`, runs the ingest that `openPdf` in App.jsx
orchestrates client-side (resolve → probe → cache → page → metadata), through
the same helpers the app's endpoints use. Keep the ingest logic in those
helpers — never re-implement it in the extension.

| File | Role |
|---|---|
| `manifest.json` | MV3: module service worker, `<all_urls>` content script, popup, options, `save-to-gamma` command. `host_permissions: ["<all_urls>"]` — the same install warning the content script already carries, and it makes cookie-carrying fetches to the (user-configured) server origin and the PDF-from-tab fetch work without runtime permission prompts |
| `worker.js` | per-tab state in `chrome.storage.session` (`tab:<id>` → `{candidate, hit, preview, auth, saving, error}`), badge/icon, `lookup` + `preview`, the save pipeline, context menus, keyboard command, notifications, and the message API (`get-state`, `save`, `clip-selection`, `auth-changed`, `open`) |
| `doi.js` | the DOI-in-a-URL-path rule (`gammaDoiFromPath`), one file loaded by the content script and imported by the worker |
| `detect.js` | content script (`document_idle`): identifier extraction, re-run on SPA URL changes; answers `get-detection` / `get-selection` / `fetch-pdf` (downloads a PDF from inside the page and relays it base64 — publisher bot checks that 403 the worker's fetch accept the page's own same-origin request) |
| `api.js` | settings (`chrome.storage.sync`: `server, folder, labels, allowOa, saveCopy`), `api()` fetch wrapper (`credentials: "include"`, JSON `detail` → `ApiError{status}`), `login/logout/whoAmI` |
| `publisherSessions.js` | Publisher-host validation and connection flow; requests optional cookie access, checks the active tab and account, then sends a snapshot to Gamma |
| `popup.html/js/css` | setup (no server) → offline (server unreachable, with Retry) → sign-in → main view; the footer shows a connection dot (green signed in / amber signed out / red unreachable) beside `host · user` and an options gear (the app's SettingsIcon). The folder picker and label suggestions are plain-JS menus mirroring the app's MenuSelect/ctxMenu recipes; labels are the app's `categoryTag` chip input (comma/Enter commits a chip, Backspace removes, arrow keys + Enter pick a suggestion). Saving remembers the folder but not the labels — each popup prefills only the options-page default labels. `popup.css` copies the app's theme tokens (light/dark via `prefers-color-scheme`) — keep it in step with `shared/styles/app.css` when the control recipes change. `?tab=<id>` targets a specific tab when opened as a page (tests) |
| `options.html/js` | server + host permission, account, saving defaults |
| `icons/` | blue tile (paper detected) and grey tile (nothing) at 16/32/48/128, generated with Pillow |

## Detection

`detect.js` yields one candidate per page:

```js
{ kind: "pdf" | "arxiv" | "doi" | "maybe" | "none",
  source_url, pdf_url, arxiv_id, doi, title, is_pdf_tab }
```

| Signal | Yields |
|---|---|
| `arxiv.org/abs|pdf/<id>` in the URL, `citation_arxiv_id` | `arxiv_id` (version stripped) |
| a DOI used as a path — `doi.org/<doi>`, `/doi/…/10.…` (Atypon, Wiley), publisher PDF paths built on it (APS `/prl/pdf/<doi>`, Springer `/content/pdf/<doi>.pdf`, IOP `/article/<doi>/pdf`; the view/file suffix stripped by `doi.js`, the same rule as the server's `norm_doi`) — then `citation_doi`, `dc.identifier`, `prism.doi`, JSON-LD `*Article` identifiers | `doi` |
| `contentType === application/pdf` / `.pdf` URL, `citation_pdf_url`, `<link rel=alternate type=application/pdf>` | `pdf_url` |
| `citation_title`, JSON-LD headline, `dc.title`, `og:title`, `document.title` | `title` |
| DOI regex over the first 30 k chars of visible text (only when nothing else matched) | `kind: "maybe"` |

`kind` priority: pdf > arxiv > doi > maybe. Chrome's PDF viewer runs no
content scripts, so the worker also derives a URL-only candidate on every tab
load (`candidateFromUrl`, `from_url: true`) and merges it field-by-field under
the content script's result; URL-looking tab titles are dropped there.

Every detection triggers `GET /api/library/lookup` (skipped when signed out)
and sets the badge: `PDF`/`arX`/`DOI` blue, `?` grey, `✓` green (in the
library), `!` red (not signed in). A detection with a DOI or arXiv id then
fetches `GET /api/library/preview` off the badge's critical path (doi.org
can take a second or two) and stores the record as `preview`. A popup that
is already open re-renders its head from `storage.onChanged`. State is
cleared when the tab navigates.

The popup head shows the first of: the page's own title (meta tags), the
previewed registry title, the library page's title, the host. The chip +
identifier line says what the detection rests on, and the registry's
authors · year · venue sit under it.

## The save pipeline

Popup → `save` message → `savePaper()` in the worker (so it survives the popup
closing; progress is written to the tab state and the popup renders it):

```
PDF tab?  fetch bytes in the browser → %PDF check → POST /api/uploads → doc_id   (best-effort)
POST /api/clip { source_url, pdf_url, doi, arxiv_id, doc_id?, title, selection?, folder, labels, allow_oa, save_copy }
  └─ 400 and no doc_id yet? → fetch bytes in the browser → POST /api/uploads → retry /api/clip with doc_id
→ { block_id, doc_id, title, existed, open_url, folder, labels, note? }
   doc_id "" = no PDF: the clip became a page with properties.web_url
```

Browser-side downloads are automatic, no checkbox: PDF tabs upload their bytes
up front (the browser already has them; the server may be paywalled out), and
any other save that fails server-side with a 400 retries through the browser
when a `pdf_url` was detected. If the browser fetch fails too, the server's
error (paywall explanation) is the one shown. "Fetch bytes in the browser"
itself is two attempts: the worker's direct `fetch(url,
{credentials:"include"})` first, then — publisher bot checks (science.org
& co.) 403 requests with an extension origin and no Referer — the tab's
content script via `fetch-pdf`, a same-origin fetch from the page's own
context, indistinguishable from the reader loading the PDF, relayed back
base64 (capped at 60 MB). Raw PDF tabs have no content script, so there the
direct fetch is the only (and working) path.

Server side (`clip.py`, sync `def` — it downloads):

1. **Dedup** — `find_page()` by DOI / arXiv id / URL against every root page:
   `properties.meta.doi|arxiv_id` (from the metadata lookup), `source_url`,
   `web_url`, and the proxy-cache hash `sha256(url)[:24]`. A hit returns
   `existed: true` and still *adds* the folder/labels (soft link; an ancestor
   folder is refined away, `foldertags.add_tag`).
2. **Resolve** — `pdf.resolve_source()` (extracted from `/api/resolve-pdf`) on
   the best identifier: `pdf_url` > `arxiv_id` > `doi` > `source_url`. arXiv
   rewrite, `citation_pdf_url` sniff, Unpaywall when `allow_oa`.
3. **Fetch + store** — `pdf.download_pdf()` through the SSRF guard with browser
   headers; the file lands at `uploads/<sha256(url)[:24]>.pdf`, the same id
   `/api/pdf?save=1` would use, so the app's viewer finds it. Over the storage
   limit → not stored, `note` says so, the page proxies on open. `save_copy:
   false` → headers-only probe. A dead or HTML link never creates a page with
   a broken attachment (the `openPdf` invariant) — instead the clip takes the
   **web-page path** (`_clip_web_page`): a page titled from the tab (else the
   URL's last segment / host) with `properties.web_url = source_url`, no
   `doc_id`/`source_url`, the request's `selection` (if any) as its first
   `> quote — [title](url)` block, folder/labels applied, `doc_id: ""` and a
   `note` in the response. A request that names no PDF at all (no `pdf_url`,
   DOI, arXiv id or uploaded bytes — *Save page to Gamma* on a blog post)
   skips the resolver and goes there directly. Re-clipping the same URL finds
   that page (`find_web_page`: `web_url` match on attachment-less pages) and
   only files it / appends the new selection. Only a request with nothing at
   all (no URL, title or selection) is a 400. With `doc_id` (uploaded bytes)
   this step is skipped; the file must exist.
4. **Page** — `blocks_store.get_or_create_doc_page()` (extracted from
   `POST /api/blocks/by-doc`) with `default_title = citation_title`, so
   `auto_title` is set and the metadata lookup may still replace it (never a
   user rename). The tab URL is kept as `properties.web_url` when it differs
   from the PDF URL — it feeds later lookups.
5. **Folder + labels** — `properties.folder` / `properties.category` comma
   lists, cleaned by `foldertags`.
6. **Metadata** — `metadata.fetch_page_metadata()` (extracted from
   `/api/metadata/fetch`) in a daemon thread; the detector's `doi`/`arxiv_id`
   ride along as trusted hints (they come from the publisher page's own meta
   tags, so the lookup resolves them directly instead of re-mining the PDF
   text); arXiv/DOI paths need no AI provider. Skipped when `meta` already
   exists or `fetch_metadata: false`. A web-page clip starts it only when a
   DOI/arXiv id was detected (the lookup needs no PDF for those — a note about
   a paywalled paper still gets its citation).

Companions:

- `GET /api/library/lookup?doi=&arxiv_id=&url=` — 404 when absent.
  Identifiers are also extracted from `url` (`norm_doi` drops a publisher
  path suffix like `/pdf` or `.pdf` glued onto the DOI); web-clip pages
  match by `web_url`.
- `GET /api/library/preview?doi=&arxiv_id=&url=` — the registry record
  `{title, authors, year, venue, doi, arxiv_id, source}` from
  `metadata.registry_record` (arXiv, then doi.org; a small in-memory cache,
  the data is public). 404 when neither registry answers.
- `GET /api/library/folders` → `{folders, labels}` (folder paths plus their
  ancestors). Folders rank by the account/workspace's latest `recent-views`
  page timestamp, then latest page modification, with names breaking ties;
  ancestors inherit their contained pages' timestamps. Labels stay alphabetical.
- `POST /api/clip/note {text, source_url, title,
page_id?}` — the explicit "clip selection INTO a page" append path (with
`generate_key_between`; without `page_id` it uses/creates the root page
flagged `properties.web_clips = 1`), as opposed to `/api/clip`'s "make a page
of this tab". All session-only, and — since the extension names no
workspace — they land in the account's personal workspace
([workspaces.md](workspaces.md)).

## Auth and permissions

- **Sessions, not tokens.** The extension fetches with `credentials:
  "include"`; with the `<all_urls>` host permission Chrome sends the app's
  `HttpOnly; SameSite=Lax` session cookie on extension-initiated requests, and
  signing in from the popup/options (`POST /api/login`) or from the app tab
  signs in both — one cookie jar. No CORS middleware exists or is needed.
  Verified end-to-end (Playwright, headless Chromium, plain-HTTP origin).
- The server origin is user-configured (self-hosted); `normalizeServer()`
  keeps explicit schemes and adds `http://` when missing. Plain-HTTP LAN /
  Tailscale origins work — the cookie isn't `Secure` on http.
- After a successful `/api/session` check, the Connector
  remembers an HTTP-to-HTTPS redirect to the exact same host, port and API path,
  with the standard port changing from 80 to 443. The worker and options page
  use that resolved origin. Other redirect destinations are never saved.
  Publisher-session requests continue to reject redirects so cookie snapshots
  cannot be forwarded to another server. This avoids a misleading "Failed to
  fetch" when ordinary account checks followed an HTTPS redirect successfully.
- A 401 anywhere flips the tab state to `auth: false` (badge `!`) and the
  popup shows the sign-in view. Login rate limits apply unchanged; guest
  login is not offered.
- `frame-ancestors 'self'` means the popup can't iframe the app — it doesn't.

## Testing

- `backend/tests/test_clip.py` — the endpoints with faked upstream fetches
  (dedup + folder refinement, no PDF / dead link → web-page path with
  selection + re-clip dedup, `doc_id` path, `save_copy`, lookup by arXiv
  version / DOI / web_url, the preview with faked registries + its cache,
  `norm_doi` on publisher paths, folders, clip notes, 401s).
- End-to-end recipe (not checked in): Playwright `launchPersistentContext`
  with `--load-extension=extension --headless=new` on the cached ms-playwright
  Chromium, a throwaway backend (`GAMMA_DATA_DIR`, `GAMMA_ADMIN_USER/PASSWORD`,
  `GAMMA_STATIC_DIR=frontend/dist`), the service worker driven via
  `context.serviceWorkers()[0].evaluate(...)` (set `server` in
  `chrome.storage.sync`, read `chrome.storage.session`, `chrome.action.getBadgeText`),
  the popup opened as `chrome-extension://<id>/popup.html?tab=<tabId>`. Covers
  the real arXiv abs page → save → ✓ badge → clip selection → PDF tab upload
  → background metadata.

## Not done yet

- Firefox build (`background.scripts` + `webextension-polyfill`), Web Store
  listing (the release zip is built and published by
  `.github/workflows/extension.yml` on every push to main touching
  `extension/`, as `extension-v<version>` with the version computed from
  the tags; `manifest.json`'s version is only the floor for minor/major
  bumps — [github_actions.md](github_actions.md)).
- Detection is client-side only for the badge; `find_page` scans every root
  page per lookup (fine for personal libraries, index it if that changes).

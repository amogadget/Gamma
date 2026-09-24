# PDF loading

How a PDF gets from the workspace's `uploads/` to a painted page in the
viewer, and why each part is shaped the way it is. The measurements at the end
are what the design is judged by; rerun them before changing any of it. The
survey that led here is [research/pdf_loading.md](../research/pdf_loading.md).

The idea in one sentence: **the server already knows the document, so the
client lays it out before it parses, picks its transport by size, and never
throws a parsed document away.**

## The manifest (`gamma/pdf_meta.py`, `GET /api/pdf-info/{doc_id}`)

Every stored PDF gets one row in the workspace's `data.db`, table `pdf_docs`:
byte size, page count, and every page's size in PDF points with `/Rotate`
applied (the same box pdf.js measures its scale-1 viewport from, so a layout
built from it is exact). It is derived data next to the PDF text index, so it
is created with `CREATE TABLE IF NOT EXISTS` (no migration step), lives in
backups harmlessly, and is purged with the index when no page carries the
document any more (`block_index.purge_page_data`).

Who writes it: `storage.store_pdf` (uploads, imports, file chips), the
`/api/pdf` proxy's save path and `/api/clip` schedule it on a background
thread the moment the file lands, so the first open finds it ready; the search
indexer computes it while it has the file open anyway; and the endpoint
computes it on demand for anything older, in pdfium, in FastAPI's threadpool
(the route is a sync `def`). A walk already running for the document is
joined, not repeated, so opening a book right after uploading it waits for
the upload's own walk instead of queueing a second one behind the pdfium
lock. Every pdfium walk goes through
`pdf_text.page_sizes`, behind the same lock as text extraction, and closes
every page it opens explicitly, inside the lock — pypdfium2 objects sit in
reference cycles, so a page merely dropped would be closed by the cyclic GC
later, on another thread, outside the lock, which crashes the server
(`pdf_text.py` has the story; its `_serialize_finalizers` is the net). A
file pdfium cannot read is stored with `pages: 0` so it is not parsed again
on every open;
the endpoint sends that answer `no-store` and a real one with a day of
`private` caching (a doc id is a content hash, its manifest never changes).

Access is the file's own rule: a workspace member, or a share token confined
to the shared page's document (`_share_can_read_upload`).

## The client (`src/pdf/PdfViewer.jsx`, `src/pdf/pdfSource.js`)

`pdf/pdfSource.js` holds the pure decisions, unit-tested in
`tests/pdfSource.test.mjs`: which URL is an upload (`docIdOf`), which
transport to use (`chooseTransport`), the pdf.js options of a range open
(`rangeOpenOptions`), and how a manifest becomes a page layout
(`layoutFromManifest`, refusing anything that does not describe a readable
document). The viewer's load effect composes them:

1. **A parsed document from a recent visit** (`DOC_CACHE`, the last two
   `PDFDocumentProxy` objects with their layout) is committed as it is.
   Documents are never destroyed on a tab switch or a viewer unmount, only on
   eviction, a second after the commit so mounted pages are not torn out from
   under pdf.js. The byte cache (`PDF_CACHE`) holds one entry, which pays
   for this one: re-reading bytes from IndexedDB costs tens of milliseconds,
   re-parsing them is the expensive half.
2. **Otherwise the manifest and the bytes are fetched in parallel.** On a
   cold open (nothing on screen yet) the manifest alone commits a
   **skeleton**: page boxes of exact size, no document. The host's `"layout"`
   phase applies the pending exact tab position on it, and the last-read-page
   restore (the `read-pos` pref, what a reload or a cold reopen uses) accepts
   the skeleton as "pages in the DOM", so the reader is on their page before
   a byte of the PDF has been parsed, and `PdfPage` places
   highlights and ink into the reserved box, so the overlays are right from
   the first frame. The skeleton keeps its page keys when the document
   arrives: same components, nothing remounts. It is only laid out on a cold
   open; blanking a document already on screen would undo the atomic swap
   that keeps tab switches flicker-free.
3. **Transport by size.** Cached bytes (memory, then IndexedDB) are used as
   they are. For an uncached upload the size comes from the manifest or from a
   HEAD of the file, whichever answers first: a manifest computed for the
   first time (a long book opened the moment it was uploaded) can take
   seconds, and the open must not wait on it. At or under `WHOLE_MAX_BYTES`
   (12 MB) the file is one plain GET, as before: it stays in the browser's
   HTTP cache and lands in IndexedDB. Above that, pdf.js opens the URL itself
   by **range requests**
   (`disableRange: false`, `disableStream: true`, `disableAutoFetch: true`,
   256 KB chunks): the xref, the page tree and only the pages being drawn.
   `disableStream` is the flag that matters; with autofetch off but streaming
   on, pdf.js's full-file reader keeps running underneath and saturates the
   link the ranges race. pdf.js resolves the URL to an absolute one before
   fetching, and the fetch wrapper in `shared/lib/utils.js` tags absolute same-origin
   URLs with the workspace header too — without that the ranges of a document
   in a non-default workspace came back 404, which pdf.js reports as
   "Missing PDF". Browsers never store 206 responses, so three seconds
   after the commit the whole file is fetched once, quietly, into IndexedDB
   (`backfillLocalCopy`), and the second open is warm. The `/api/pdf` proxy
   streams from its upstream and cannot answer ranges: it always downloads
   whole, and it redirects to `/api/uploads` once a local copy exists.
4. **Layout from the manifest, or measured.** When the manifest describes
   the opened file (same page count) its sizes are used and the eight-page
   measure loop and the 50-page background refinement are skipped, which also
   removes the layout shifting under a scroll restore that the refinement
   caused. Without a manifest (proxy URLs, a failed read) the old path
   measures and refines exactly as before. Bytes from the cache wait at most
   250 ms for the manifest; measuring is still correct, only slower.

**The worker.** pdf.js does its parsing in a Web Worker whose script is 1.3 MB.
It is imported as a Vite asset (`pdf.worker.min.mjs?url`), so it is always the
installed `pdfjs-dist` legacy build and is served content-hashed and immutable
like the bundle; one `PDFWorker` is created at module scope and shared by every
document (pdf.js would otherwise start a fresh worker per `getDocument`, and it
destroys only workers it created itself, so a shared one survives cache
evictions). A copy under `public/` sent `no-cache` would be re-downloaded on
every page load, because Starlette's `FileResponse` sets an ETag but never
compares one (at 20 Mbps, 0.6 to 0.85 s of every open — the research note has
the measurement). The static route in `gamma/app.py` compares the ETag
itself, so the unhashed files (`index.html`, favicons) get a real 304.

## Native reading-position handoff

Pencil & Audio captures the actual `.pdfPageWrap` intersecting the PDF scroller's
visible top before awaiting note flush/session verification. The additive bridge
`viewport: {pageIndex, anchorX, anchorY}` uses a zero-based page index and finite
0…1 coordinates within the displayed (rotation-applied crop) page, not a fraction
of the entire document or the debounced reading-page preference. A loading or
pending-restore viewer refuses handoff rather than silently defaulting to page 1.
The page/document/workspace and navigation generation are checked again after
asynchronous work; existing account/role checks remain mandatory.

On iPad, `GammaReadingPosition` strictly validates optional geometry (including
rejecting booleans as numbers). `PDFInkView.requestedViewport` is consumed after
PDFKit layout/window readiness, converting the displayed crop anchor back through
`PDFView.convert` and navigating with `PDFDestination`. It is not reapplied for
ink/content rerenders. The optional field leaves old six-field callers compatible.
`nativeViewport.test.mjs`, `tests/e2e/nativeHandoff.mjs`, and
`GammaReadingPositionTests.swift` cover the contract and crop/rotation conversion.

### Native return and disconnect control (v1)

`window.__GAMMA_NATIVE_CONTROL__` is installed on every App screen, including
home and signed-out login. Its async `restorePosition(payload)` accepts
`{server,user,workspace,pageID,docID,requestID,viewport}`. Server is the current
origin; the account/workspace and fetched page's document must match. Native
may inject the same payload as `window.__GAMMA_NATIVE_RETURN__` before mount.
The `gamma:native-control-ready` DOM event announces method installation;
`not-ready` means retry after session/workspace boot. Native should reuse the
requestID when retrying. Completed requests do not jump again.

Restore opens/reloads the target page after native sync, suppresses saved coarse
and tab-position restoration, waits for the actual PDF DOM and stable geometry,
and applies the displayed crop's page-local anchor once (both scroll axes).
It returns `{ok:true,reason:"restored"}` only after application. Browser clamping
at the document edges is unavoidable; layout/open/identity failures are explicit.

`prepareDisconnect({})` blurs the editor, freezes the root, awaits React's pending
commit, awaits direct App page/block JSON mutations (including title and metadata),
flushes all collaboration sessions, uploads dirty browser ink (after its new block
insert), and flushes again. A stalled network returns `flush-timeout` with recovery
after ten seconds; the host's evaluation deadline must be longer. It needs neither a PDF nor authentication
when there is no dirty data. A failed/rejected write returns `{ok:false,reason,
recovery}`; collaboration recovery includes previous pages, in-flight batches,
and permanently rejected batches that a resync otherwise removes. Ink exports
include raw drafts and their original identity. JSON snapshots are detached and
bounded (8 Mi characters for collaboration, 12 Mi combined); oversized exports
are explicitly `complete:false`, never safe-recovery claims. No credentials are
included and nothing is automatically replayed. The native host must durably
save complete recovery before offering recovery-and-disconnect; incomplete or
unsupported bridges require an explicit data-loss confirmation, not a claim of
successful flush. `cancelDisconnect()` unfreezes the root. Sign out flushes first;
on failure it stays signed in and points to explicit native Disconnect. The
control remains usable once a clean sign out reaches Login.

## High zoom and touch scrolling

`shared/lib/canvasSize.js` bounds every PDF and live-ink backing store to 8 Mi pixels
and 4096 pixels per edge. Normal zooms keep their supersampling; at 400% or
on oversized pages the raster can fall below one device pixel per CSS pixel
while layout, text, links and SVG annotations keep the exact zoom. WebKit
documents both a [canvas area limit](https://bugs.webkit.org/show_bug.cgi?id=171238)
and [total canvas allocation failures](https://bugs.webkit.org/show_bug.cgi?id=195325),
and an iPad may report a Mac user agent, so the cap applies everywhere.

`PdfPage`'s intersection observer is rooted at the PDF scroller with 900 CSS
pixels of look-ahead. A page outside it releases its canvas backing store
and keeps its geometry, text and overlays; it repaints on return, and a
forced render (jumps, the cited page) still works. Effect cleanup cancels
the pending pdf.js render and text-layer tasks; unmount zeroes the canvas.

`pdf/verticalScrollSnap.js` is the always-on one-finger vertical alignment
(`installVerticalScrollSnap`, reinstalled on zoom and document changes). It
judges direction after 8 CSS pixels within a 30° vertical cone. It never
writes scroll offsets while a finger or native momentum is moving. After
`scrollend` (250 ms of quiet after lift on browsers without it) it corrects
horizontal drift once, instantly under reduced motion. A diagonal start, a
deliberate sideways turn, a second contact, a cancelled gesture, keyboard or
wheel input, a zoom change or teardown drops the pending alignment. Writing
offsets mid-gesture fights WebKit's native scroll animation
([WebKit issue](https://bugs.webkit.org/show_bug.cgi?id=255193)).

`tests/e2e/scenarios/pdfTouch.mjs` covers 400% rendering under an emulated
canvas allocation limit, distant-page release and repaint, live ink, and
native Chromium touch swipes with no mid-gesture offset writes; the
rendering cases also run in Playwright WebKit (`GAMMA_E2E_BROWSER=webkit`).
Unit tests pin the canvas bounds and the snap timing, cancellation and
older-Safari fallback. Physical iPad GPU limits and momentum still need a
device.

## Load phases

The viewer reports each phase to the host (`onLoadState`), which drives the
status pill, stamps `performance.mark("pdf-<phase>", {detail: {url, ms}})`
and writes `pdf <phase> +<ms>` to the session log (Settings → Advanced). `ms`
counts from the `open` phase of that url.

| Phase | Meaning |
|---|---|
| `open` | the viewer started opening this url (the clock starts) |
| `layout` | skeleton page boxes from the manifest are in the DOM (pre-paint; the pending restore lands here) |
| `start` / `progress` / `done` | a whole-file download, with byte progress |
| `cached` | bytes came from memory / IndexedDB, or the document from `DOC_CACHE` |
| `parsing` | `getDocument` called (range open: pdf.js is fetching its chunks) |
| `opened` | pdf.js has the document: xref and page tree parsed |
| `measuring` | the fallback page measure, when there is no manifest |
| `rendered` | the document's pages are in the DOM (pre-paint; the pending restore lands here when there was no skeleton) |
| `painted` | the first canvas painted; the pill clears |
| `error` / `cancelled` | failed with `detail` / the url changed mid-load |

## Measured

The e2e timing probe (`frontend/tests/e2e/scenarios/pdfload.mjs`; `npm run
e2e -- --only "pdf load"`): a 300-page, 20 MB document (tiny pages plus a
padding stream, so the file weighs what a scanned book weighs), Chromium at an
emulated 20 Mbps / 40 ms latency, first paint measured from `open`. The
timing steps assert only that the document paints; the numbers are their
notes. The same scenario then pins the behaviours: a landscape page far below
the fold has its own box shape (only the manifest could have said so), the
last-read page comes back after a reload, two large documents alternate
through the parsed-document cache without mixing, and an anonymous share
visitor opens the large document by ranges with no request rejected (the
share token rides on the ranges, the manifest and the HEAD).

| Open | Before | After (four runs) | On the wire |
|---|---|---|---|
| Cold (nothing cached, first visit) | 9.73 s | 0.68 to 0.79 s; page boxes at 65 to 78 ms | 0.3 MB in 2 range requests, plus the 1.3 MB worker script (0.6 s of the total, once per browser) |
| Warm (new tab: IndexedDB + HTTP cache) | 1.01 s | 0.13 to 0.14 s | nothing |
| Same tab, back from the library (`DOC_CACHE`) | not measured before | 0.04 s (pages in the DOM at 8 ms) | nothing |

Where the time went before: the whole 20 MB downloaded before anything was
parsed (about 8 s at 20 Mbps), then the worker script again, then eight serial
page measurements. The backfill of the whole file lands about 11.7 s after the
cold paint (3 s delay plus the 20 MB), which is what makes the warm row warm.

Not done, and why: a server-rendered preview JPEG per page (the upstream
fork's `/api/page-image`) would cover image-heavy scans, where pdf.js itself
renders slowly; for the documents this library holds, the numbers above leave
nothing for it to hide, so it stays out until a real scan says otherwise.
MRC flattening (rewriting scans into a second upload) was rejected in the
research note.

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
`pdf_text.page_sizes`, behind the same lock as text extraction. A file pdfium
cannot read is stored with `pages: 0` so it is not parsed again on every open;
the endpoint sends that answer `no-store` and a real one with a day of
`private` caching (a doc id is a content hash, its manifest never changes).

Access is the file's own rule: a workspace member, or a share token confined
to the shared page's document (`_share_can_read_upload`).

## The client (`src/pdfViewer.jsx`, `src/pdfSource.js`)

`pdfSource.js` holds the pure decisions, unit-tested in
`tests/pdfSource.test.mjs`: which URL is an upload (`docIdOf`), which
transport to use (`chooseTransport`), the pdf.js options of a range open
(`rangeOpenOptions`), and how a manifest becomes a page layout
(`layoutFromManifest`, refusing anything that does not describe a readable
document). The viewer's load effect composes them:

1. **A parsed document from a recent visit** (`DOC_CACHE`, the last two
   `PDFDocumentProxy` objects with their layout) is committed as it is.
   Documents are never destroyed on a tab switch or a viewer unmount, only on
   eviction, a second after the commit so mounted pages are not torn out from
   under pdf.js. The byte cache (`PDF_CACHE`) shrank to one entry to pay for
   it: re-reading bytes from IndexedDB costs tens of milliseconds, re-parsing
   them is the expensive half.
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
   fetching, and the fetch wrapper in `utils.js` tags absolute same-origin
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
evictions). Before this the worker was a copy under `public/vendor/` sent
`no-cache`, and since Starlette's `FileResponse` never answers 304, every page
load re-downloaded it: at 20 Mbps that was 0.6 to 0.85 s of every open, cold
or warm. Unhashed files (`index.html`, favicons) now get a real 304 from the
static route in `gamma/app.py`.

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

# PDF loading speed: what the upstream fork did, and what fits Gamma

Survey from 2026-09-14 of `amogadget/Gamma` (the repository this one forked
from), whose August 2026 commits took a cold open of a 332-page scanned book
from 39 s of blank screen to 1.4 s of readable text. Findings and the reasoning
behind the path Gamma chose; the mechanics, once built, live in `docs/dev/`.

## Where the time goes in Gamma's viewer today

Read from `frontend/src/pdfViewer.jsx` before the redesign:

1. **Whole-file download first.** `fetchPdfData` drains one GET into memory
   (browser HTTP cache, then IndexedDB, then network). Nothing is parsed until
   the last byte lands, so first paint scales with file size and link speed.
2. **Parse**, then **eight serial `getPage` round trips** to measure the first
   pages, then a page-1-sized guess for the rest.
3. **Background refinement** walks every remaining page and re-lays the tree out
   every 50 pages, under a scroll restore that is still trying to land.
4. The document swap commits, the host restores scroll, the target page's
   IntersectionObserver fires, and only then does the first canvas render start.
5. **Tab switch** destroys the `PDFDocumentProxy` and re-parses from cached
   bytes. Upstream measured that re-parse at about 665 ms and the byte re-read
   from IndexedDB at 31 ms: the expensive half is being thrown away.

## What upstream did (five commits, 2–3 Aug 2026)

| Commit | Change | Measured effect (332-page scan, 20 Mbps) |
|---|---|---|
| `7a03d22` | Open `/api/uploads` files by **range request**: pdf.js `disableRange: false`, `disableStream: true`, `disableAutoFetch: true`, 256 KB chunks. Three seconds after paint the whole file is fetched once into IndexedDB. | Page boxes 39.0 s → 2.5 s, transfer 90.7 MB → 2.4 MB |
| `ff9085b` | **Server-rendered preview JPEG** (`/api/page-image/{doc}/{page}?w=1280`, pypdfium2, 11–51 ms) painted if pdf.js has not painted within 150 ms; removed on real paint; 512 MB per-user disk LRU beside `uploads/`. | Text readable 8.1 s → 2.9 s |
| `66bc8c8` | **Page sizes from the server** (`/api/page-dims/{doc}`, one small JSON) lay the document out before pdf.js has a document; real document reuses them, so the measure loop and refinement are deleted. | Page boxes 2.5 s → 1.1 s; text 2.9 s → 1.4 s |
| `edf1825` | **Keep parsed documents alive** (`DOC_CACHE`, last two proxies); byte cache shrinks to one entry to pay for the memory. | Tab switch 3.2 s → 2.5 s; scroll restore stops drifting 40 px per switch |
| `6ba39ae` | **Flatten MRC scans** in a background thread: rewrite the image XObject as one 1280 px JPEG per page, swap `source_url` to a `-flat.pdf` copy. | Tab switch 2.6 s → 275 ms; disk 23 MB → 99 MB |

Lessons worth keeping regardless of mechanism:

- `disableStream` is the flag that matters. With autofetch off but streaming on,
  pdf.js's full-file reader keeps running and saturates the link the ranges
  race; the log looks healthy while the user waits.
- Browsers do not store 206 responses, so a range open leaves nothing cached.
  Something must fetch the whole file later, quietly, or the second open is
  slower than the first.
- Linearizing with qpdf made pdf.js thrash (169 requests, more bytes than the
  file). Not a fix.
- A preview image must never sit above `.textLayer`, and the canvas must not
  gain a z-index to cover it; remove the preview on paint instead.
- Laying out from exact sizes removes a whole class of scroll-restore bugs,
  because nothing shifts under the restore.
- The preview cache must live outside `uploads/`, or the orphan sweep deletes
  it.
- An earlier attempt (`9ea82a2`, May 2026: six parallel manual range fetches,
  HTTP/3 disabled in Caddy) was superseded by letting pdf.js own the ranges.

## What does and does not fit Gamma

Upstream keys everything per user and treats the upload as the unit. Gamma's
data helpers take a workspace, uploads are read under `resolve_ws` plus
`share_scope_page`, derived per-document data already lives in the workspace's
`data.db` (the PDF FTS index, page snapshots), and every PDF is already opened
in pypdfium2 once for that index. So:

- **Fits, as is:** keeping parsed documents alive; range transport for
  `/api/uploads` (Starlette's `FileResponse` already answers 206; the share
  token rides on the URL through `utils.withShare`).
- **Fits, reshaped:** page sizes belong in a per-document **manifest row** in
  `data.db` (bytes, page count, sizes), produced by the same pdfium pass the
  text index runs, not a `dims.json` beside the upload. `CREATE TABLE IF NOT
  EXISTS` derived data needs no migration step and is purged with the document.
- **Fits, but last and gated:** the server preview. For ordinary papers pdf.js
  paints a page in well under a second once layout and transport are fixed; the
  preview earns its cache and endpoint only for image-heavy scans, which the
  manifest can identify (bytes per page).
- **Does not fit:** MRC flattening. It rewrites the user's file into a second
  upload under an invented `-flat` id, breaking content-hash naming, costing
  4× disk, and moving `source_url` under highlights and ink that anchor to it.
  The preview covers the same scans without touching their bytes.

## The path proposed on 2026-09-14

Organizing idea: **the server already knows the document; the client lays out
before it parses and chooses transport by size; a parsed document is never
thrown away.** Stages, each shippable and measured on its own:

0. Timing stamps on the existing load-state log (ms since open per phase) and a
   big-PDF e2e probe, so every later stage shows its number.
1. `DOC_CACHE` of two parsed documents; byte cache to one entry.
2. Manifest: `pdf_meta.ensure(ws, doc_id)` at upload, clip, proxy-save and
   index time; `GET /api/pdf-info/{doc_id}` under the upload's access rule; the
   viewer lays out a skeleton from it and drops the measure loop and the
   50-page refinement. Ink and highlight overlays get exact page boxes from the
   first frame.
3. `src/pdfSource.js`, a pure, unit-tested decision: cached bytes → memory;
   small file → one GET as today; large file → pdf.js range open with a
   background backfill into IndexedDB after paint. Only for `/api/uploads`; the
   `/api/pdf` proxy keeps its streaming path.
4. Optional preview endpoint, gated by the manifest's heaviness and a 150 ms
   no-paint timer, cached under a workspace `cache/` directory that backups and
   the orphan sweep ignore.

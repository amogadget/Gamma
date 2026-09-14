// How the viewer gets a PDF's bytes (docs/dev/pdf_loading.md): pure decisions,
// no DOM and no network, so they are unit-tested (tests/pdfSource.test.mjs).
//
// A stored upload has a manifest (GET /api/pdf-info/<doc_id>: byte size, page
// count, every page's size) and is served by a FileResponse that answers
// range requests. Small files are still fetched whole in one GET — the
// browser's HTTP cache and the IndexedDB copy then make every later open
// free. Large files are opened by pdf.js range requests instead, so the first
// page is on screen after a few hundred KB rather than after the whole file;
// a whole copy is fetched into IndexedDB afterwards (browsers never store 206
// responses), so the second open is warm too. The /api/pdf proxy streams from
// its upstream and cannot answer ranges: it always downloads whole.

// Above this an uncached upload is opened by range requests.
export const WHOLE_MAX_BYTES = 12 * 1024 * 1024;
// pdf.js range chunk. 256 KB: a page's objects usually sit within one or two.
export const RANGE_CHUNK = 256 * 1024;
// A range open leaves nothing on disk; this long after the page painted —
// late enough not to compete with the ranges — the whole file is fetched
// once, quietly, for IndexedDB.
export const BACKFILL_DELAY_MS = 3000;

// The doc id of an upload URL (`/api/uploads/<hex>.pdf`, any query), else null.
export function docIdOf(url) {
  const m = /^\/api\/uploads\/([0-9a-f]+)\.pdf(?:[?#]|$)/.exec(url || "");
  return m ? m[1] : null;
}

// "memory" (bytes already cached), "whole" (one GET) or "range".
export function chooseTransport({ url, bytes, cached = false }) {
  if (cached) return "memory";
  if (!docIdOf(url)) return "whole";
  return bytes > WHOLE_MAX_BYTES ? "range" : "whole";
}

// pdf.js getDocument options for a range open. disableStream is the
// load-bearing one: with autofetch off but streaming on, pdf.js's full-file
// reader keeps running underneath and saturates the link the range requests
// are racing, while the log looks healthy.
export function rangeOpenOptions(url) {
  return {
    url,
    disableAutoFetch: true,
    disableRange: false,
    disableStream: true,
    rangeChunkSize: RANGE_CHUNK,
    withCredentials: true,
  };
}

// The page layout (scale-1 heights and widths) a manifest describes, or null
// when it does not describe a readable document. Sizes that are missing or
// nonsense fall back so a damaged entry can never yield a zero-height page.
export function layoutFromManifest(m, fallback = { width: 600, height: 800 }) {
  if (!m || !Number.isInteger(m.pages) || m.pages <= 0) return null;
  if (!Array.isArray(m.dims) || m.dims.length !== m.pages) return null;
  const heights = [], widths = [];
  for (const d of m.dims) {
    const w = Number(d?.[0]), h = Number(d?.[1]);
    widths.push(w > 0 ? w : fallback.width);
    heights.push(h > 0 ? h : fallback.height);
  }
  return { heights, widths };
}

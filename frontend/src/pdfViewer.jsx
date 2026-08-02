// The pdf.js-based viewer: lazy page rendering, highlights, link
// annotations, text search, and the selection popup. Extracted from
// App.jsx to keep the God component shrinking.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// The legacy build, not the default one: it ships the core-js polyfills the
// modern build assumes (Promise.withResolvers is Safari 17.4+, and pdf.js
// calls it the moment a loading task is created). Without it every iPad below
// iOS 17.4 threw here at module scope and the whole app rendered blank.
// public/pdf.worker.min.mjs is the matching legacy worker — keep both legacy.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { ChevronRightIcon, LinkIcon, OutlineIcon } from "./icons";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
// Pre-warm the pdfjs worker so it downloads in parallel with later PDF fetches.
// Guarded: a throw at module scope takes down every route, PDF or not.
try {
  pdfjsLib.getDocument({ data: new Uint8Array() }).promise.catch(() => {});
} catch {}

// Highlight palette (shared with the highlight context menu in App)
const COLORS = [
  "rgba(255, 226, 143, 0.65)",
  "rgba(170, 235, 170, 0.65)",
  "rgba(155, 205, 255, 0.65)",
  "rgba(230, 180, 255, 0.65)"
];

const EMPTY_MARKS = [];

// One zoom policy for every entry point (toolbar buttons in App, Ctrl+scroll
// here) — a limit change must not leave the two out of agreement.
export const ZOOM_MIN = 0.2, ZOOM_MAX = 4;
export const clampZoom = (s) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s));

// Page layout model shared by the placeholder styles and all scroll math:
// page boxes stack with a fixed gap, and unmeasured pages assume page 1's
// size (FALLBACK_* is the last resort before even that is known).
const PAGE_GAP = 8;
const FALLBACK_H = 800, FALLBACK_W = 600;

// Content-y of page idx's top edge at the given scale.
function pageTopAt(heights, idx, scale) {
  let y = 0;
  for (let i = 0; i < idx; i++) y += (heights[i] || FALLBACK_H) * scale + PAGE_GAP;
  return y;
}

// The most recently downloaded PDF, so an immediate reopen doesn't re-read it.
// pdf.js detaches the buffer it's handed, so entries are cloned on use.
// Deliberately ONE entry, not a handful of papers. These are the raw bytes,
// and the raw bytes are the cheap half: re-reading a 50 MB paper out of
// IndexedDB below measures at ~31 ms. Holding four of them costs ~400 MB for
// scanned papers (each is also cloned into the worker) and buys 31 ms. That
// budget belongs to DOC_CACHE instead, which holds the expensive half.
const PDF_CACHE = new Map(); // url -> ArrayBuffer, insertion order = LRU
const PDF_CACHE_MAX = 1;
function cachePdf(url, buf) {
  PDF_CACHE.delete(url);
  PDF_CACHE.set(url, buf);
  while (PDF_CACHE.size > PDF_CACHE_MAX) PDF_CACHE.delete(PDF_CACHE.keys().next().value);
}

// Parsed, partly-decoded documents, kept alive across tab switches.
//
// Re-opening a paper used to destroy its PDFDocumentProxy and build a new one,
// which threw away everything pdf.js had already done. On a 380-page scan a
// DevTools trace put 4.7 s of the ~5 s wait in four worker tasks of ~1.1 s
// each — one per page on screen, pure-JS decode of a full-page scan image —
// while the main thread sat idle. Every one of those was repeated work.
//
// The reuse happens on the main thread: PDFPageProxy keeps its operator list
// (pdf.mjs, the `if (!intentState.displayReadyCapability)` guard in render),
// and page unmount here only sets a cancelled flag — it never cancels the
// render task — so the list survives and a re-render replays it without
// touching the worker. NOT via pdf.js's GlobalImageCache: that requires an
// image to appear on >= 2 pages (NUM_PAGES_THRESHOLD), and a scan's pages
// each carry their own, so it caches none of them.
//
// Two documents: the one on screen plus the one being switched back to.
const DOC_CACHE = new Map(); // url -> {doc, heights, widths}, insertion order = LRU
const DOC_CACHE_MAX = 2;
function cacheDoc(url, entry) {
  DOC_CACHE.delete(url);
  DOC_CACHE.set(url, entry);
  while (DOC_CACHE.size > DOC_CACHE_MAX) {
    // Oldest first, and never the one just inserted — that one is on screen.
    const victim = [...DOC_CACHE.keys()].find((k) => k !== url);
    if (!victim) break;
    const { doc } = DOC_CACHE.get(victim);
    DOC_CACHE.delete(victim);
    // Deferred: its pages have only just unmounted, and destroying a document
    // out from under in-flight render tasks spams transport-destroyed errors.
    setTimeout(() => doc.destroy().catch(() => {}), 1000);
  }
}

// Persistent second-level cache: survives refreshes, closed tabs, and browser
// restarts, so a paper is downloaded once per month per browser. IndexedDB on
// purpose, NOT the Cache Storage API: caches is undefined in insecure
// contexts, and this app is typically reached over plain http (LAN/Tailscale)
// — which silently disabled the old cache and re-downloaded "cached" papers
// after every reload. IndexedDB works everywhere. Content behind a URL never
// changes (upload names are content hashes; proxy-saved files are written
// once), so serving from disk is safe.
const DISK_CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // one month
const DISK_CACHE_MAX = 30; // papers kept on disk

function idbOpen() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open("gamma-pdf-cache", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("pdfs").createIndex("at", "at");
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
function idbReq(rq) {
  return new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function diskCacheGet(url) {
  let db;
  try {
    db = await idbOpen();
    const row = await idbReq(db.transaction("pdfs").objectStore("pdfs").get(url));
    if (!row) return null;
    if (Date.now() - row.at > DISK_CACHE_TTL_MS) {
      await idbReq(db.transaction("pdfs", "readwrite").objectStore("pdfs").delete(url));
      return null;
    }
    return row.buf;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function diskCachePut(url, buf) {
  let db;
  try {
    const copy = buf.slice(0); // synchronously, before the caller hands buf to pdf.js
    db = await idbOpen();
    const store = db.transaction("pdfs", "readwrite").objectStore("pdfs");
    await idbReq(store.put({ buf: copy, at: Date.now() }, url));
    // Evict the oldest entries beyond the cap. A key cursor on the "at" index
    // walks oldest-first without loading the buffers themselves.
    let excess = (await idbReq(store.count())) - DISK_CACHE_MAX;
    if (excess > 0) {
      await new Promise((resolve) => {
        const cur = store.index("at").openKeyCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || excess <= 0) return resolve();
          store.delete(c.primaryKey);
          excess--;
          c.continue();
        };
        cur.onerror = () => resolve();
      });
    }
  } catch {} finally {
    db?.close();
  }
}

// Abort a download when no bytes arrive for this long — a hung server
// otherwise leaves the fetch (and the UI) waiting forever.
const STALL_MS = 45000;

// Drain a Response body chunk-by-chunk so byte progress can be reported
// while the download runs (arrayBuffer() only resolves at the very end).
async function readBody(resp, onChunk) {
  if (!resp.body?.getReader) {
    const buf = await resp.arrayBuffer();
    onChunk(buf.byteLength);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    onChunk(value.byteLength);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf.buffer;
}

// Download a PDF (cache-first) and report progress phases to the host:
// start → progress (bytes) → done, or error {detail}. Returns the
// ArrayBuffer, or null when the load failed or was cancelled (both already
// reported via onLoadState).
async function fetchPdfData(url, onLoadState, isCancelled) {
  const cached = PDF_CACHE.get(url);
  if (cached) {
    // Settles a task row registered before the load (URL-box opens);
    // ordinary cache hits have no row and ignore this.
    onLoadState?.(url, { phase: "cached" });
    return cached;
  }
  const disk = await diskCacheGet(url);
  if (disk) {
    if (isCancelled()) return null;
    onLoadState?.(url, { phase: "cached" });
    return disk;
  }
  onLoadState?.(url, { phase: "start" });
  // Stall watchdog: abort when the connection goes silent — the proxy may sit
  // for a while before its upstream download produces the first byte, but a
  // connection with no bytes for STALL_MS is dead, not slow.
  const ctrl = new AbortController();
  let loaded = 0, total = 0, lastByteAt = Date.now(), lastReport = 0, stalled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > STALL_MS) { stalled = true; ctrl.abort(); }
  }, 5000);
  const beat = (n) => {
    loaded += n;
    lastByteAt = Date.now();
    if (Date.now() - lastReport > 200) {
      lastReport = Date.now();
      onLoadState?.(url, { phase: "progress", loaded, total });
    }
  };
  try {
    // One plain GET, nothing else. Upload URLs are content-addressed and served
    // with an immutable Cache-Control, so a normal request lets the browser
    // HTTP cache make repeat downloads free — even on plain http where Cache
    // Storage is unavailable. Range requests would defeat that (browsers don't
    // store 206 responses), and against a slow server a probe + parallel
    // chunks costs 7 round trips where one stream costs one.
    const resp = await fetch(url, { credentials: "include", signal: ctrl.signal });
    if (isCancelled()) return null;
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(await resp.text());
        if (typeof j.detail === "string") detail = j.detail;
      } catch {}
      onLoadState?.(url, { phase: "error", detail });
      return null;
    }
    total = parseInt(resp.headers.get("content-length") || "0", 10) || 0;
    const data = await readBody(resp, beat);
    if (isCancelled()) return null;
    diskCachePut(url, data); // fire-and-forget; copies the buffer synchronously
    onLoadState?.(url, { phase: "done", bytes: data.byteLength });
    return data;
  } catch (e) {
    if (!isCancelled()) {
      onLoadState?.(url, {
        phase: "error",
        detail: stalled ? `no data for ${Math.round(STALL_MS / 1000)}s — server not responding` : (e.message || "network error"),
      });
    }
    return null;
  } finally {
    clearInterval(watchdog);
  }
}

function PdfViewer({ url, highlights, pdfScaleValue, scrollRef, onJump, onHighlightJump, onLinkHighlight, onSelectionFinished, onHighlightContext, searchRef, onEffectiveScale, onZoomTo, findMarks, onExternalLink, onBeforeLinkJump, onLoadState, retryRef }) {
  const viewerRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [docSeq, setDocSeq] = useState(0); // bumped per document — keys the page tree so swaps are atomic
  const [displayedUrl, setDisplayedUrl] = useState(""); // url of the document on screen (lags `url` during a load)
  const [retryNonce, setRetryNonce] = useState(0); // bumped by the host's Retry button to re-run a failed load
  // Load progress/errors render no UI here: every phase goes to the host via
  // onLoadState, and the app's single shared status pill displays them.
  useEffect(() => {
    if (retryRef) retryRef.current = () => setRetryNonce((n) => n + 1);
  }, [retryRef]);
  const [forcePages, setForcePages] = useState(new Set());
  const pageHeightsRef = useRef([]); // viewport heights at scale 1, indexed 0..n-1
  const pageWidthsRef = useRef([]); // viewport widths at scale 1 — the zoom anchor's horizontal math needs them
  const heightsExactRef = useRef(true); // false while a long doc's tail heights are page-1 estimates still refining
  const lastScrollRef = useRef(0); // scrollTop as of the last scroll event — the pre-clamp value during a zoom commit
  const lastScrollLeftRef = useRef(0);

  // Stable callback identities so memoized pages don't re-render every time a
  // parent state change recreates the handler closures. The wrappers always
  // dispatch to the latest handlers via the ref.
  const cbRef = useRef({});
  cbRef.current = { onJump, onHighlightJump, onLinkHighlight, onHighlightContext, onExternalLink, onLoadState, onZoomTo };
  const stableCbs = useMemo(() => ({
    onJump: (...a) => cbRef.current.onJump?.(...a),
    onHighlightJump: (...a) => cbRef.current.onHighlightJump?.(...a),
    onLinkHighlight: (...a) => cbRef.current.onLinkHighlight?.(...a),
    onHighlightContext: (...a) => cbRef.current.onHighlightContext?.(...a),
    onExternalLink: (...a) => cbRef.current.onExternalLink?.(...a),
  }), []);

  // "rendered" only means blank page boxes committed to the DOM — each canvas
  // paints asynchronously after that. Hold the swapped-in url here until the
  // first page reports a successful paint, then tell the host ("painted") so
  // it can drop its "Rendering page…" message. Later paints (scroll, zoom)
  // find the ref empty and no-op.
  const awaitingPaintRef = useRef(null);
  const onPagePainted = useMemo(() => () => {
    const u = awaitingPaintRef.current;
    if (!u) return;
    awaitingPaintRef.current = null;
    cbRef.current.onLoadState?.(u, { phase: "painted" });
  }, []);

  // Ctrl/Cmd + scroll zooms (this is also what a trackpad pinch reports).
  // Native non-passive listener on purpose: React's root wheel listener is
  // passive, so preventDefault (needed to block the browser's own page zoom)
  // wouldn't work from an onWheel prop. The scale compounds per event in
  // wheelScaleRef (the committed prop lags behind a fast train), but the
  // dispatch is coalesced to one per frame — every dispatch re-renders every
  // page, and a trackpad pinch fires far more events than commits are worth.
  const wheelScaleRef = useRef(1); // what the next wheel step compounds on
  const wheelRafRef = useRef(0);
  const zoomAnchorRef = useRef(null); // viewport point to zoom around; consumed by the anchor effect, null → viewport center
  // Set when a new document mounts; consumed by the next scale change so the
  // anchor effect can tell "fit-width settling for the swapped-in document"
  // apart from a user zoom — the two need different anchoring (see below).
  const docSwapPendingRef = useRef(false);
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // LINE mode (Firefox) → ~px
      const cur = wheelScaleRef.current;
      const next = clampZoom(cur * Math.exp(-dy * 0.0015));
      if (next === cur) return; // pinned at a clamp limit — don't leave a stale anchor behind
      const r = el.getBoundingClientRect();
      zoomAnchorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      wheelScaleRef.current = next;
      docSwapPendingRef.current = false; // an explicit zoom, whatever mounted before it
      if (!wheelRafRef.current) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = 0;
          cbRef.current.onZoomTo?.(wheelScaleRef.current);
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); cancelAnimationFrame(wheelRafRef.current); };
  }, []);

  // Group find marks per page once, sharing one frozen empty array so pages
  // without marks keep referentially-equal props (memo stays effective).
  const marksByPage = useMemo(() => {
    const map = new Map();
    for (const m of findMarks || []) {
      if (!map.has(m.page)) map.set(m.page, []);
      map.get(m.page).push(m);
    }
    return map;
  }, [findMarks]);

  // Highlights grouped per page — and only for the document actually on
  // screen: during a tab switch the incoming page's highlights arrive before
  // its document does, and must not paint onto the outgoing one. Per-page
  // slices also mean editing a note re-renders just that highlight's page.
  const hlsByPage = useMemo(() => {
    const map = new Map();
    if (displayedUrl !== url) return map;
    for (const h of highlights || []) {
      const p = h.position?.boundingRect?.pageNumber ?? h.position?.rects?.[0]?.pageNumber;
      if (!p) continue;
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(h);
    }
    return map;
  }, [highlights, displayedUrl, url]);

  // Expose full-text search over the loaded document (used by the search
  // panel). Each page's text runs are joined into one string — so matches can
  // span runs — and searched through a normalized view (ligatures folded,
  // hyphenated line breaks re-joined, digit-group separators dropped) that
  // mirrors the server index's rules in gamma/textnorm.py. Every normalized
  // character remembers its source run, so a match maps back to exact rects
  // (at scale 1) even when normalization changed lengths.
  useEffect(() => {
    if (!searchRef) return;
    searchRef.current = pdfDoc ? async (re) => {
      const out = [];
      const isDash = (c) => c === "-" || (c >= "‐" && c <= "―");
      for (let p = 1; p <= pdfDoc.numPages && out.length < 200; p++) {
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const items = tc.items;
        // Page string: runs joined by their PDF line break or a space,
        // each char tagged with its source run (-1 = synthetic filler).
        const chars = [];
        for (let ii = 0; ii < items.length; ii++) {
          const str = items[ii].str || "";
          for (let k = 0; k < str.length; k++) chars.push({ ch: str[k], it: ii, off: k });
          if (items[ii].hasEOL) chars.push({ ch: "\n", it: -1, off: 0 });
          else if (str && !/\s$/.test(str) && items[ii + 1]?.str && !/^\s/.test(items[ii + 1].str)) {
            chars.push({ ch: " ", it: -1, off: 0 });
          }
        }
        // Normalized view + map back into `chars`.
        const norm = [];
        const src = [];
        for (let i = 0; i < chars.length; i++) {
          let ch = chars[i].ch;
          if (ch === "­") continue; // soft hyphen
          if (isDash(ch) && /[a-zA-Z]/.test(chars[i - 1]?.ch || "")) {
            // Hyphenated line break: "sys-⏎tem" → "system"
            let j = i + 1, brk = false;
            while (j < chars.length && /\s/.test(chars[j].ch)) { if (chars[j].ch === "\n") brk = true; j++; }
            if (brk && /[a-zA-Z]/.test(chars[j]?.ch || "")) { i = j - 1; continue; }
          }
          if ((ch === "," || ch === " " || ch === " " || ch === " ")
              && /\d/.test(chars[i - 1]?.ch || "") && /\d/.test(chars[i + 1]?.ch || "")) {
            continue; // digit-group separator: "3,000" → "3000"
          }
          if (/\s/.test(ch)) ch = " ";
          for (const c of ch.normalize("NFKC")) { norm.push(c); src.push(i); }
        }
        const pageStr = norm.join("");
        const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        let m;
        while ((m = rx.exec(pageStr)) && out.length < 200) {
          if (!m[0]) { rx.lastIndex++; continue; }
          // Match range → per-run char spans → one rect per run (sliced
          // proportionally by char position; runs are single-line).
          const spans = new Map(); // run index -> [minOff, maxOff]
          for (let n = m.index; n < m.index + m[0].length; n++) {
            const c = chars[src[n]];
            if (c.it < 0) continue;
            const s = spans.get(c.it);
            if (s) { s[0] = Math.min(s[0], c.off); s[1] = Math.max(s[1], c.off); }
            else spans.set(c.it, [c.off, c.off]);
          }
          const rects = [];
          for (const [ii, [o1, o2]] of spans) {
            const it = items[ii];
            const str = it.str || "";
            const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
            const fh = Math.hypot(tx[2], tx[3]) || 10;
            const w = it.width || fh;
            const x1 = tx[4] + w * (o1 / str.length);
            const x2 = tx[4] + w * ((o2 + 1) / str.length);
            rects.push({ x1, y1: tx[5] - fh, x2: Math.max(x1 + 2, x2), y2: tx[5] + fh * 0.25 });
          }
          if (!rects.length) continue;
          const ctxStart = Math.max(0, m.index - 40);
          out.push({
            page: p,
            snippet: pageStr.slice(ctxStart, m.index + m[0].length + 60).trim().slice(0, 140),
            rects,
            pageW: vp.width,
            pageH: vp.height,
          });
        }
      }
      return out;
    } : null;
    return () => { if (searchRef) searchRef.current = null; };
  }, [pdfDoc, searchRef]);
  // Resolve scale: numeric value as-is, "page-width" computes a scale that
  // fits the first page to the viewer width. Recomputed on viewer resize so
  // it adapts to sidebar drags / phone rotation.
  const [fitWidthScale, setFitWidthScale] = useState(1);
  const numericScale = parseFloat(pdfScaleValue);
  const isFitWidth = isNaN(numericScale);
  const scale = isFitWidth ? fitWidthScale : numericScale;
  // Resync the wheel's compounding base to the committed scale — but not
  // while a coalesced dispatch is still in flight: events that arrived since
  // are compounded into the ref, and overwriting it here would drop them
  // (measurably: a 6-notch train only zoomed ~3 notches' worth).
  useEffect(() => {
    if (!wheelRafRef.current) wheelScaleRef.current = scale;
  }, [scale]);
  useEffect(() => { onEffectiveScale?.(scale); }, [scale, onEffectiveScale]);
  useEffect(() => {
    if (!isFitWidth || !pdfDoc || !viewerRef.current) return;
    // Page 1's width is in pageWidthsRef, measured before the doc was shown —
    // no async worker round trip per sidebar drag / rotation.
    const compute = () => {
      const naturalW = pageWidthsRef.current[0];
      const containerW = viewerRef.current?.clientWidth;
      if (naturalW > 0 && containerW > 0) setFitWidthScale(Math.max(ZOOM_MIN, containerW / naturalW));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(viewerRef.current);
    return () => ro.disconnect();
  }, [isFitWidth, pdfDoc]);

  // Tell the host which document's pages are in the DOM. Layout effect on
  // purpose: it fires after the swap commit but BEFORE paint, so the host can
  // apply a restored scroll position and the user never sees the document at
  // the wrong offset.
  useLayoutEffect(() => {
    if (pdfDoc) {
      awaitingPaintRef.current = url;
      onLoadState?.(url, { phase: "rendered" });
    }
  }, [pdfDoc]);

  // The document currently on screen. Kept visible while the next one loads —
  // swapping only when the new doc is fully measured is what prevents the
  // blank flash and the scrollbar resizing repeatedly during a tab switch.
  const displayedDocRef = useRef(null);
  // No teardown on unmount: documents belong to DOC_CACHE now, which is what
  // makes coming back cheap. Its own eviction is the only thing that destroys.

  // The swap: heights, page tree, and document land in ONE commit, so the
  // scrollbar changes exactly once and the host's pre-paint scroll restore
  // sees a layout that is already final.
  const commitDoc = (docUrl, doc, heights, widths, exact) => {
    displayedDocRef.current = doc;
    heightsExactRef.current = exact;
    pageHeightsRef.current = heights;
    pageWidthsRef.current = widths;
    setPageHeights(heights);
    setNumPages(doc.numPages);
    setDocSeq((s) => s + 1);
    setDisplayedUrl(docUrl);
    setPdfDoc(doc);
  };

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        // Still alive from an earlier open — no download, no re-parse, and no
        // re-decode of the pages already rendered. Straight to the swap.
        const live = DOC_CACHE.get(url);
        if (live) {
          cacheDoc(url, live); // bump LRU position
          onLoadState?.(url, { phase: "cached" });
          commitDoc(url, live.doc, live.heights, live.widths, true);
          return;
        }
        const data = await fetchPdfData(url, onLoadState, () => cancelled);
        if (!data || cancelled) return;
        cachePdf(url, data); // insert or bump LRU position
        onLoadState?.(url, { phase: "parsing" });
        const doc = await pdfjsLib.getDocument({ data: data.slice(0), disableAutoFetch: true, disableRange: true }).promise;
        if (cancelled) { doc.destroy().catch(() => {}); return; }
        // Measure pages BEFORE showing the document: exact viewports for the
        // first pages, page-1-sized estimates beyond (refined below). The
        // swap then lands in ONE commit — heights, page tree, and document
        // together — so the scrollbar changes exactly once. Kept small: each
        // getPage is a worker round trip and this loop blocks first paint.
        const n = doc.numPages;
        const EXACT = 8;
        const measured = Math.min(n, EXACT);
        const heights = [], widths = [];
        for (let i = 1; i <= measured; i++) {
          onLoadState?.(url, { phase: "measuring", done: i - 1, total: measured });
          try {
            const vp1 = (await doc.getPage(i)).getViewport({ scale: 1 });
            heights.push(vp1.height); widths.push(vp1.width);
          } catch { heights.push(heights[0] || FALLBACK_H); widths.push(widths[0] || FALLBACK_W); }
          if (cancelled) { doc.destroy().catch(() => {}); return; }
        }
        for (let i = heights.length; i < n; i++) { heights.push(heights[0] || FALLBACK_H); widths.push(widths[0] || FALLBACK_W); }
        // Hand the live arrays to the cache: the refinement below mutates them
        // in place, so a later reopen gets the refined values, not a snapshot
        // taken before the loop ran.
        cacheDoc(url, { doc, heights, widths });
        commitDoc(url, doc, heights, widths, n <= EXACT);
        // Refine the estimated heights in the background (long docs only).
        for (let i = EXACT; i < n; i++) {
          if (cancelled) return;
          try {
            const vp1 = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
            heights[i] = vp1.height; widths[i] = vp1.width;
          } catch {}
          if ((i + 1) % 50 === 0 || i === n - 1) {
            pageHeightsRef.current = [...heights];
            pageWidthsRef.current = [...widths];
            setPageHeights([...heights]);
          }
        }
        heightsExactRef.current = true; // layout is final — the zoom settle loop can stand down
      } catch (e) {
        if (!cancelled) onLoadState?.(url, { phase: "error", detail: e?.message || "failed to open the PDF" });
      }
    })();
    return () => {
      cancelled = true;
      // No-op if the download already finished; otherwise clears the
      // now-orphaned "downloading…" task entry.
      onLoadState?.(url, { phase: "cancelled" });
    };
  }, [url, retryNonce]);

  // A document swap replaces the scroller's content wholesale: the host's
  // tab restore has just set scrollTop (pre-paint, in the "rendered"
  // callback), but the scroll-tracking refs still describe the OLD document
  // until its scroll event dispatches. Resync them now — this layout effect
  // is defined after the "rendered" one, so it sees the restored value. Also
  // flag the swap for the anchor effect below.
  useLayoutEffect(() => {
    docSwapPendingRef.current = true;
    // A settle loop from a zoom on the PREVIOUS document may still be alive
    // (its [scale] cleanup never fires when the swap keeps the scale, e.g.
    // both tabs at the same numeric zoom) — the swap's scrollHeight change
    // would trip it into stamping old-document coordinates over the restored
    // position. Kill it.
    cancelAnimationFrame(anchorRafRef.current);
    if (viewerRef.current) {
      lastScrollRef.current = viewerRef.current.scrollTop;
      lastScrollLeftRef.current = viewerRef.current.scrollLeft;
    }
  }, [docSeq]);

  // Preserve position across zoom changes by keeping one anchor point fixed
  // on screen: the mouse position for Ctrl+scroll (set in zoomAnchorRef by
  // the wheel handler), the viewport center for button zooms and fit-width
  // recomputes. The content under the anchor is found in OLD-scale
  // coordinates (page index + fraction into it — exact despite the fixed 8px
  // inter-page margins) and re-placed at the same screen point at the new
  // scale.
  //
  // Document swaps are the exception (docSwapPendingRef): when the swapped-in
  // document's fit-width scale settles, the scale change is not a zoom. The
  // restored scrollTop was computed against the OLD document's effective
  // scale — the only one known pre-paint — i.e. the ratio was applied to the
  // raw scrollTop, so its exact inverse is a TOP-of-viewport re-map
  // (anchor point 0,0), not a centered one. Anchoring the viewport center
  // here is what made tab switches land hundreds of px off.
  //
  // Layout effect + the scroll-tracked refs, on purpose: the page boxes
  // resize in this same commit, and when zooming out that shrinks the scroll
  // range — by the time this runs the browser may have clamped
  // scrollTop/scrollLeft, so reading them live would anchor on the wrong
  // content. The refs still hold the pre-zoom values (the clamp's scroll
  // event hasn't dispatched yet), and writing the corrected position before
  // paint means no visible jump at all.
  const prevScaleRef = useRef(scale);
  const anchorRafRef = useRef(0); // live settle-loop frame — cancelled on re-zoom AND on document swap
  useLayoutEffect(() => {
    const prev = prevScaleRef.current;
    prevScaleRef.current = scale;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    const docSwap = docSwapPendingRef.current;
    docSwapPendingRef.current = false;
    if (prev === scale || !viewerRef.current) return;
    const v = viewerRef.current;
    const heights = pageHeightsRef.current;
    if (heights.length === 0) return;
    const ax = docSwap ? 0 : anchor ? anchor.x : v.clientWidth / 2;
    const ay = docSwap ? 0 : anchor ? anchor.y : v.clientHeight / 2;

    // Find the page covering the anchor's content-y at the OLD scale. The
    // anchor may sit in the fixed 8px gap below the page — that slice does
    // NOT scale with the zoom, so it's kept separate (gapPx) instead of being
    // folded into the page fraction.
    const oldY = lastScrollRef.current + ay;
    let acc = 0, anchorIdx = 0, fracInPage = 0, gapPx = 0;
    for (let i = 0; i < heights.length; i++) {
      const ph = (heights[i] || FALLBACK_H) * prev;
      if (acc + ph + PAGE_GAP > oldY) {
        anchorIdx = i;
        fracInPage = Math.min(1, (oldY - acc) / ph);
        gapPx = Math.max(0, oldY - acc - ph);
        break;
      }
      acc += ph + PAGE_GAP;
    }

    // Content-x under the anchor, in base (scale-1) page coordinates. A page
    // narrower than the viewport is centered by its auto margins; a wider one
    // sits at x=0 — max(0, …) covers both layouts, before and after.
    const clientW = v.clientWidth;
    const pw = pageWidthsRef.current[anchorIdx] || FALLBACK_W;
    const oldLeft = Math.max(0, (clientW - pw * prev) / 2);
    const baseX = (lastScrollLeftRef.current + ax - oldLeft) / prev;

    const place = () => {
      v.scrollTop = pageTopAt(heights, anchorIdx, scale)
        + fracInPage * (heights[anchorIdx] || FALLBACK_H) * scale + gapPx - ay;
      const newLeft = Math.max(0, (clientW - pw * scale) / 2);
      v.scrollLeft = newLeft + baseX * scale - ax;
      lastScrollRef.current = v.scrollTop;
      lastScrollLeftRef.current = v.scrollLeft;
    };
    place();
    if (heightsExactRef.current) return; // every height is measured — nothing can shift, skip the settle loop
    // Safety net: estimated heights (long docs) can still refine right after
    // a zoom and shift the layout — re-place while scrollHeight settles. The
    // cleanup cancel is load-bearing: without it, each step of a continuous
    // Ctrl+scroll leaves this loop alive, and the NEXT step's layout change
    // trips the stale loop into re-placing old-scale coordinates over the
    // fresh ones — the zoom visibly slides off the anchor.
    let tries = 0;
    let lastSH = v.scrollHeight;
    const tick = () => {
      if (!viewerRef.current) return;
      if (viewerRef.current.scrollHeight !== lastSH) { lastSH = viewerRef.current.scrollHeight; place(); }
      if (tries++ < 30) anchorRafRef.current = requestAnimationFrame(tick);
    };
    anchorRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(anchorRafRef.current);
  }, [scale]);

  // Pre-compute every page's natural height. The values feed both the jump
  // math and the per-page placeholder height below — having every page's
  // wrapper reserve its real size keeps the DOM's scrollHeight in sync with
  // what the jump math assumes, so scrollTo() doesn't get clamped to a
  // smaller scrollable range. Computing metadata-only viewports is cheap.
  // Populated by the load flow above, before the document is shown.
  const [pageHeights, setPageHeights] = useState([]);

  // Scroll to exact highlight position. Long jumps snap instantly — smooth
  // scrolling across many pages is what made find-next feel sluggish.
  const scrollToPositionRef = useRef(null);
  useEffect(() => {
    scrollToPositionRef.current = async ({ position, behavior }) => {
      const pn = position?.pageNumber || position?.boundingRect?.pageNumber;
      if (!pn || !viewerRef.current || !pdfDoc) return;
      const r = position?.boundingRect;
      const heights = pageHeightsRef.current;

      // Lazy-compute missing page heights up to target page
      for (let i = heights.length; i < pn; i++) {
        try {
          const page = await pdfDoc.getPage(i + 1);
          heights[i] = page.getViewport({ scale: 1 }).height;
        } catch (e) {
          heights[i] = FALLBACK_H;
        }
      }

      // Compute page-top from cached heights (accurate even for unrendered pages)
      const pageTop = pageTopAt(heights, pn - 1, scale);
      const curH = (heights[pn - 1] || FALLBACK_H) * scale;
      const storedH = r?.height || 1;
      const highlightY = r ? r.y1 * curH / storedH : 0;
      const targetTop = pageTop + highlightY - 80;
      const dist = Math.abs(targetTop - viewerRef.current.scrollTop);
      viewerRef.current.scrollTo({ top: targetTop, behavior: behavior || (dist > 1500 ? "auto" : "smooth") });

      // Force-render target page if not yet visible
      const pageEl = viewerRef.current.querySelector(`[data-page="${pn}"]`);
      if (!pageEl || !pageEl.style.width) {
        setForcePages(prev => new Set([...prev, pn]));
        setTimeout(() => setForcePages(prev => { const s = new Set(prev); s.delete(pn); return s; }), 2000);
      }
    };
    if (scrollRef) scrollRef.current = scrollToPositionRef.current;
  }, [scrollRef, scale, pdfDoc]);

  // In-PDF link annotations: internal destinations jump within the document.
  async function goToDest(dest) {
    if (!pdfDoc) return;
    try {
      const d = typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
      if (!d || d[0] == null) return;
      const pageIdx = typeof d[0] === "object" ? await pdfDoc.getPageIndex(d[0]) : Number(d[0]);
      const pn = pageIdx + 1;
      onBeforeLinkJump?.(); // let the app capture "where I was" for global Back
      const page = await pdfDoc.getPage(pn);
      const vp = page.getViewport({ scale: 1 });
      // Destination y is in PDF user space (origin bottom-left); flip to top-down.
      let destY = 0;
      const kind = d[1]?.name;
      const rawY = kind === "XYZ" ? d[3] : (kind === "FitH" || kind === "FitBH") ? d[2] : null;
      if (typeof rawY === "number") destY = Math.max(0, vp.height - rawY);
      scrollToPositionRef.current?.({
        position: {
          pageNumber: pn,
          boundingRect: { x1: 0, y1: destY, x2: 0, y2: destY, width: vp.width, height: vp.height, pageNumber: pn },
          rects: [],
        },
      });
    } catch {}
  }
  const goToDestRef = useRef(null);
  goToDestRef.current = goToDest;
  const goToDestStable = useMemo(() => (d) => goToDestRef.current?.(d), []);

  // Document outline (table of contents). Loaded per document; the toggle
  // button only appears when the PDF actually has one.
  const [outline, setOutline] = useState(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setOutline(null);
    if (!pdfDoc) return;
    pdfDoc.getOutline()
      .then((o) => { if (!cancelled && o && o.length) setOutline(o); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pdfDoc]);
  // Clicking anywhere outside the panel (including a TOC jump landing in the
  // document) dismisses it, like a menu.
  useEffect(() => {
    if (!outlineOpen) return;
    function onDown(e) {
      if (e.target.closest?.(".pdfOutlinePanel") || e.target.closest?.(".pdfOutlineBtn")) return;
      setOutlineOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [outlineOpen]);

  // Text selection for highlight creation
  const [selPopup, setSelPopup] = useState(null);
  // Whether this session has ever seen a real touch — a ref, not an effect
  // local: the selection effect re-registers on every render (its callback
  // prop is a fresh closure each time), which would keep clearing a local.
  const touchSeenRef = useRef(false);
  useEffect(() => {
    function onTouchStart() { touchSeenRef.current = true; }
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    return () => document.removeEventListener("touchstart", onTouchStart);
  }, []);

  // Dismiss the color popup when the user mouses down anywhere outside it
  // (without that, removing the textarea/Cancel leaves no way to back out).
  useEffect(() => {
    if (!selPopup) return;
    function onDown(e) {
      const popup = document.querySelector(".plainTip");
      if (popup && popup.contains(e.target)) return;
      setSelPopup(null);
      window.getSelection()?.removeAllRanges();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selPopup]);

  useEffect(() => {
    if (!onSelectionFinished) return;
    function onMouseUp() {
      setTimeout(syncSelPopup, 10);
    }
    function syncSelPopup() {
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) { setSelPopup(null); return; }
      const range = sel.getRangeAt(0);
      if (!range) { setSelPopup(null); return; }
      const node = range.startContainer;
      const textEl = node?.nodeType === 3 ? node.parentElement?.closest?.(".textLayer") : node?.closest?.(".textLayer");
      if (!textEl) return;
      const pageEl = textEl.closest?.("[data-page]");
      const pageNumber = pageEl ? parseInt(pageEl.dataset.page, 10) : null;
      const text = sel.toString().trim();
      if (text && pageNumber) {
        const r = range.getBoundingClientRect();
        // Per-line rects so multi-line highlights don't render as one big block.
        // pdf.js text layer has many spans per line — getClientRects() returns one
        // rect per span, so merge those that share a line into one rect per line.
        const raw = Array.from(range.getClientRects())
          .filter(cr => cr.width > 1 && cr.height > 1)
          .map(cr => ({ top: cr.top, left: cr.left, right: cr.right, bottom: cr.bottom }))
          .sort((a, b) => a.top - b.top || a.left - b.left);
        const lineRects = [];
        for (const cr of raw) {
          const last = lineRects[lineRects.length - 1];
          if (last) {
            const overlap = Math.min(last.bottom, cr.bottom) - Math.max(last.top, cr.top);
            const minH = Math.min(last.bottom - last.top, cr.bottom - cr.top);
            if (overlap >= minH * 0.5) {
              last.left = Math.min(last.left, cr.left);
              last.right = Math.max(last.right, cr.right);
              last.top = Math.min(last.top, cr.top);
              last.bottom = Math.max(last.bottom, cr.bottom);
              continue;
            }
          }
          lineRects.push({ ...cr });
        }
        setSelPopup({ text, rect: { top: r.top, left: r.left, width: r.width, bottom: r.bottom }, lineRects, pageNumber });
      }
    }
    // iPadOS/iOS never fires mouseup for a long-press selection or for a drag
    // of the selection handles, so touch devices would never get the highlight
    // popup. selectionchange does fire — debounced, since it fires on every
    // pixel of a handle drag — and only once a touch has been seen, so mouse
    // drags keep committing on mouseup (where the modifier key is known).
    let selTimer = null;
    function onSelectionChange() {
      if (!touchSeenRef.current) return;
      clearTimeout(selTimer);
      selTimer = setTimeout(syncSelPopup, 350);
    }
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      clearTimeout(selTimer);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [onSelectionFinished]);

  function handleSelConfirm(commentText, color, extra) {
    if (!selPopup) return;
    const r = selPopup.rect;
    const pageEl = document.querySelector(`[data-page="${selPopup.pageNumber}"]`);
    const pageRect = pageEl?.getBoundingClientRect();
    const curW = pageEl ? parseFloat(pageEl.style.width) || pageEl.offsetWidth : 1;
    const curH = pageEl ? parseFloat(pageEl.style.height) || pageEl.offsetHeight : 1;
    const px = pageRect?.left || 0, py = pageRect?.top || 0;
    const x1 = r.left - px, y1 = r.top - py;
    const x2 = r.left + r.width - px, y2 = r.bottom - py;
    const lineRects = (selPopup.lineRects && selPopup.lineRects.length)
      ? selPopup.lineRects.map(lr => ({
          x1: lr.left - px, y1: lr.top - py,
          x2: lr.right - px, y2: lr.bottom - py,
          width: curW, height: curH, pageNumber: selPopup.pageNumber,
        }))
      : [{ x1, y1, x2, y2, width: curW, height: curH, pageNumber: selPopup.pageNumber }];
    const position = {
      pageNumber: selPopup.pageNumber,
      boundingRect: { x1, y1, x2, y2, width: curW, height: curH, pageNumber: selPopup.pageNumber },
      rects: lineRects,
    };
    const content = { text: selPopup.text };
    onSelectionFinished(position, content, () => { window.getSelection()?.removeAllRanges(); setSelPopup(null); }, { color, commentText, ...(extra || {}) });
  }

  return (
    <div style={{ position: "relative", height: "100%" }}>
      {outline ? (
        <button
          className={"pdfOutlineBtn" + (outlineOpen ? " open" : "")}
          onClick={() => setOutlineOpen((o) => !o)}
          title={outlineOpen ? "Hide table of contents" : "Table of contents"}
          aria-label="Toggle table of contents"
          type="button"
        >
          <OutlineIcon size={16} />
        </button>
      ) : null}
      {outline && outlineOpen ? (
        <div className="pdfOutlinePanel">
          {outline.map((it, i) => (
            <OutlineNode key={i} item={it} depth={0} onDest={goToDestStable} onUrl={stableCbs.onExternalLink} />
          ))}
        </div>
      ) : null}
      {/* overflow-anchor off: the browser's own scroll anchoring would fight
          the zoom re-placement above with adjustments of its own. */}
      <div ref={viewerRef} className="pdfViewer"
        style={{ height: "100%", overflowY: "auto", overflowX: "auto", overflowAnchor: "none" }}
        onScroll={(e) => {
          lastScrollRef.current = e.currentTarget.scrollTop;
          lastScrollLeftRef.current = e.currentTarget.scrollLeft;
        }}>
      {Array.from({ length: numPages }, (_, i) => (
        <PdfPage key={`${docSeq}-${i + 1}`} pageNumber={i + 1} pdfDoc={pdfDoc} scale={scale}
          highlights={hlsByPage.get(i + 1) || EMPTY_MARKS} onJump={stableCbs.onJump} onHighlightJump={stableCbs.onHighlightJump}
          onLinkHighlight={stableCbs.onLinkHighlight} onHighlightContext={stableCbs.onHighlightContext}
          readOnly={!onSelectionFinished} forceRender={forcePages.has(i + 1)}
          reservedHeight={pageHeights[i] ? pageHeights[i] * scale : null}
          findMarks={marksByPage.get(i + 1) || EMPTY_MARKS}
          onInternalLink={goToDestStable}
          onExternalLink={stableCbs.onExternalLink}
          onPainted={onPagePainted}
        />
      ))}
      {selPopup && onSelectionFinished && (
        <div style={{ position: "fixed", top: selPopup.rect.bottom + 8, left: selPopup.rect.left, zIndex: 9999 }}>
          <PlainTip onConfirm={handleSelConfirm} onLink={() => handleSelConfirm("", null, { link: true })} />
        </div>
      )}
      </div>
    </div>
  );
}

// One outline entry: click jumps to its destination, chevron collapses its
// children. Top-level sections start expanded, deeper levels collapsed.
// Children nest inside a wrapper whose left border draws the indent guide.
function OutlineNode({ item, depth, onDest, onUrl }) {
  const [open, setOpen] = useState(depth === 0);
  const kids = item.items || [];
  return (
    <div className="pdfOutlineNode">
      <div className="pdfOutlineRow">
        {kids.length ? (
          <button
            className={"pdfOutlineChevron" + (open ? " open" : "")}
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Collapse section" : "Expand section"}
            type="button"
          >
            <ChevronRightIcon size={10} strokeWidth={2.5} />
          </button>
        ) : (
          <span className="pdfOutlineChevron" />
        )}
        <span
          className="pdfOutlineTitle"
          title={item.title}
          onClick={() => {
            if (item.dest) onDest(item.dest);
            else if (item.url) onUrl?.(item.url);
          }}
        >
          {item.title}
        </span>
      </div>
      {open && kids.length ? (
        <div className="pdfOutlineKids">
          {kids.map((k, i) => (
            <OutlineNode key={i} item={k} depth={depth + 1} onDest={onDest} onUrl={onUrl} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const PdfPage = React.memo(function PdfPage({ pageNumber, pdfDoc, scale, highlights, onJump, onHighlightJump, onLinkHighlight, onHighlightContext, readOnly, forceRender, reservedHeight, findMarks, onInternalLink, onExternalLink, onPainted }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const pageRef = useRef(null);
  const renderTaskRef = useRef(null);
  const linksForRef = useRef(null); // page whose link annotations are already in `links`
  const [pageSize, setPageSize] = useState(null);
  const [visible, setVisible] = useState(false);
  const [links, setLinks] = useState([]); // link annotations, rects at scale 1

  useEffect(() => {
    if (forceRender) { setVisible(true); return; }
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: "900px 0px" }); // generous look-ahead so scrolling rarely hits a blank page
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageNumber, forceRender]);

  useEffect(() => {
    if (!pdfDoc || !visible) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled || !wrapRef.current) return;
        pageRef.current = page;
        const vp = page.getViewport({ scale });
        const vpBase = page.getViewport({ scale: 1 });
        // Base (scale-1) size — render multiplies by the CURRENT scale, so the
        // page box resizes in the same commit as a zoom change instead of
        // keeping its old size until this async re-render completes.
        setPageSize({ width: vpBase.width, height: vpBase.height });

        const canvas = canvasRef.current;
        // Backing resolution: at least 2× the CSS size — canvas antialiasing
        // at exactly 1× looks visibly soft next to the browser's native PDF
        // viewer, and supersampling + browser downscale is much crisper on
        // standard-DPI screens. Follows devicePixelRatio up to 3× for high-DPI
        // displays. A per-page pixel budget (the old 2×-DPR worst case) keeps
        // extreme zoom levels from allocating enormous canvases.
        let pr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
        const BUDGET = 32e6; // device pixels per page (~128 MB RGBA)
        if (vp.width * vp.height * pr * pr > BUDGET) {
          pr = Math.max(1, Math.sqrt(BUDGET / (vp.width * vp.height)));
        }
        canvas.width = Math.floor(vp.width * pr); canvas.height = Math.floor(vp.height * pr);
        const ctx = canvas.getContext("2d"); ctx.setTransform(pr, 0, 0, pr, 0, 0);
        // Cancel any in-flight render (rapid zoom changes) instead of stacking them
        try { renderTaskRef.current?.cancel(); } catch {}
        const task = page.render({ canvasContext: ctx, viewport: vp });
        renderTaskRef.current = task;
        try {
          await task.promise;
        } catch (err) {
          // instanceof, not err.name — minification renames the class
          if (err instanceof pdfjsLib.RenderingCancelledException) return;
          throw err;
        }
        if (cancelled) return;
        onPainted?.();

        const textL = textRef.current;
        textL.innerHTML = "";
        textL.style.width = vpBase.width + "px";
        textL.style.height = vpBase.height + "px";
        textL.style.transform = `scale(${scale})`;
        const tc = await page.getTextContent();
        pdfjsLib.renderTextLayer({ textContentSource: tc, container: textL, viewport: vp });

        // Link annotations (in-PDF references + external URLs), stored at
        // scale 1 and multiplied in JSX — so they only need computing once per
        // page, not again on every zoom re-render.
        if (linksForRef.current !== page) {
          const annots = await page.getAnnotations();
          if (cancelled) return;
          linksForRef.current = page;
          setLinks(annots
            .filter((a) => a.subtype === "Link" && (a.url || a.dest))
            .map((a) => {
              const r = vpBase.convertToViewportRectangle(a.rect);
              return {
                left: Math.min(r[0], r[2]), top: Math.min(r[1], r[3]),
                w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]),
                url: a.url || null, dest: a.dest || null,
              };
            }));
        }
      } catch (e) {
        // A cancelled run rejects mid-await (doc swapped, transport
        // destroyed) — that's teardown, not an error worth logging.
        if (!cancelled) console.error("PdfPage render error:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNumber, scale, visible]);

  const curW = pageSize ? pageSize.width * scale : 1, curH = pageSize ? pageSize.height * scale : 1;

  return (
    <div ref={wrapRef} data-page={pageNumber} className="pdfPageWrap"
      style={{
        margin: `0 auto ${PAGE_GAP}px`, position: "relative", background: "#fff",
        width: pageSize ? curW : undefined,
        height: pageSize ? curH : (reservedHeight || undefined),
        minHeight: pageSize || reservedHeight ? undefined : 200,
      }}>
      {/* 100% of the wrapper: on a zoom change the old bitmap stretches to the
          new size immediately (blurry for a moment) instead of sitting at its
          old size in a resized box until the sharp re-render lands. */}
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
      <div ref={textRef} className="textLayer" style={{
        userSelect: readOnly ? "none" : "text", WebkitUserSelect: readOnly ? "none" : "text",
      }} />
      {links.map((l, i) => (
        <div
          key={`lnk-${i}`}
          className="pdfLinkBox"
          title={l.url || "Jump to reference"}
          style={{
            left: l.left * scale,
            top: l.top * scale,
            width: Math.max(4, l.w * scale),
            height: Math.max(4, l.h * scale),
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (l.url) onExternalLink?.(l.url);
            else onInternalLink?.(l.dest);
          }}
        />
      ))}
      {(findMarks || []).map((m, i) => (
        <div
          key={`find-${i}`}
          style={{
            position: "absolute",
            zIndex: 3,
            pointerEvents: "none",
            left: m.rect.x1 * scale,
            top: m.rect.y1 * scale,
            width: Math.max(2, (m.rect.x2 - m.rect.x1) * scale),
            height: Math.max(2, (m.rect.y2 - m.rect.y1) * scale),
            background: m.active ? "rgba(255, 140, 0, 0.45)" : "rgba(255, 220, 0, 0.30)",
            outline: m.active ? "2px solid rgba(255, 120, 0, 0.9)" : "none",
            borderRadius: 2,
            mixBlendMode: "multiply",
          }}
        />
      ))}
      {highlights.map(h => {
        const rects = h.position?.rects || (h.position?.boundingRect ? [h.position.boundingRect] : []);
        const storedW = h.position?.boundingRect?.width || rects[0]?.width || 1;
        const storedH = h.position?.boundingRect?.height || rects[0]?.height || 1;
        const isLink = !!h.linkTarget;
        const elements = [];
        for (const r of rects) {
          elements.push(<div key={h.id + "-" + r.x1 + "-" + r.y1} data-hl-id={h.id} style={{
            position: "absolute", zIndex: 2, cursor: "pointer",
            left: r.x1 * curW / storedW, top: r.y1 * curH / storedH,
            width: Math.max(1, (r.x2 - r.x1) * curW / storedW),
            height: Math.max(1, (r.y2 - r.y1) * curH / storedH),
            background: h.color || "rgba(255,226,143,0.65)", mixBlendMode: "multiply",
            ...(isLink ? { borderBottom: "2px solid rgba(70, 130, 255, 0.9)", borderRadius: 1 } : {}),
          }} title={isLink ? (h.linkTarget.pageId ? "Open linked paper" : h.linkTarget.url) : (h.comment?.text || "")}
            onClick={function (e) {
              e.stopPropagation();
              if (isLink) onLinkHighlight?.(h);
              else onHighlightJump?.(h.id, e.ctrlKey || e.metaKey);
            }}
            onContextMenu={function (e) { e.preventDefault(); if (onHighlightContext) onHighlightContext({ id: h.id, x: e.clientX, y: e.clientY }); }}
          />);
        }
        return elements;
      })}
    </div>
  );
});

function PlainTip({ onConfirm, onLink }) {
  return (
    <div className="plainTip">
      <div className="colorRow">
        {COLORS.map((c) => (
          <button
            key={c}
            className="colorBtn"
            style={{ background: c }}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onConfirm("", c); }}
            type="button"
            title="Highlight in this color"
          />
        ))}
        {onLink ? (
          <button
            className="colorBtn linkTipBtn"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onLink(); }}
            type="button"
            title="Link this reference to a paper (DOI / arXiv / existing PDF)"
          >
            <LinkIcon size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default PdfViewer;
export { COLORS };

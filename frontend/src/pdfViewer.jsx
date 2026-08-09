// The pdf.js-based viewer: lazy page rendering, highlights, link
// annotations, text search, and the selection popup. Extracted from
// App.jsx to keep the God component shrinking.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// The legacy build, not the default one: it ships the core-js polyfills the
// modern build assumes (Promise.withResolvers is Safari 17.4+, and pdf.js
// calls it the moment a loading task is created). Without it every iPad below
// iOS 17.4 threw here at module scope and the whole app rendered blank.
// public/pdf.worker.min.mjs is the matching legacy worker — keep both legacy.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { createPortal } from "react-dom";
import { ChevronRightIcon, LinkIcon, MessageSquareIcon, OutlineIcon } from "./icons";
import { ChatMarkdown } from "./widgets";
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

// Recently downloaded PDFs, so reopening a paper (tab switch, back button)
// doesn't re-download a multi-MB file. pdf.js detaches the buffer it's
// handed, so entries are cloned on use.
const PDF_CACHE = new Map(); // url -> ArrayBuffer, insertion order = LRU
const PDF_CACHE_MAX = 4;
function cachePdf(url, buf) {
  PDF_CACHE.delete(url);
  PDF_CACHE.set(url, buf);
  while (PDF_CACHE.size > PDF_CACHE_MAX) PDF_CACHE.delete(PDF_CACHE.keys().next().value);
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

function PdfViewer({ url, highlights, pdfScaleValue, scrollRef, onJump, onHighlightJump, onLinkHighlight, onSelectionFinished, onAreaSelection, onHighlightContext, searchRef, captureRef, onEffectiveScale, onZoomTo, findMarks, onExternalLink, onBeforeLinkJump, onLoadState, retryRef, areaMode, noteBadges, hideEmbeddedAnnots }) {
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
  cbRef.current = { onJump, onHighlightJump, onLinkHighlight, onHighlightContext, onExternalLink, onLoadState, onZoomTo, onAreaSelection };
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

  // Two-finger pinch zoom. Committing a real zoom per move event (the wheel
  // path) is hopelessly janky on phones — every commit re-lays-out and
  // re-renders every page. Instead the gesture only moves a CSS transform on
  // the page stack (compositing, no layout; blurry while the fingers are
  // down, like every native PDF app), and the real zoom is committed ONCE on
  // finger-lift: scroll is re-based so the content under the fingers' final
  // midpoint is what the zoom-anchor effect (keyed on that midpoint) holds
  // in place through the re-layout. preventDefault on the two-finger move
  // blocks both native scrolling and the browser's own page zoom.
  const zoomLayerRef = useRef(null);
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    let start = null; // gesture-start snapshot: finger distance/midpoint, committed scale, scroll
    let cur = null; // latest preview: effective ratio + midpoint
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t, r) => ({
      x: (t[0].clientX + t[1].clientX) / 2 - r.left,
      y: (t[0].clientY + t[1].clientY) / 2 - r.top,
    });
    const onTouchStart = (e) => {
      if (e.touches.length !== 2) return;
      const m = mid(e.touches, el.getBoundingClientRect());
      start = {
        dist: dist(e.touches), scale: wheelScaleRef.current,
        m0x: m.x, m0y: m.y, sl: el.scrollLeft, st: el.scrollTop,
      };
      cur = null;
      if (zoomLayerRef.current) zoomLayerRef.current.style.willChange = "transform";
    };
    const onTouchMove = (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches, el.getBoundingClientRect());
      // Clamp the previewed scale too, so the preview never shows a zoom the
      // commit would refuse.
      const k = clampZoom(start.scale * (dist(e.touches) / start.dist)) / start.scale;
      cur = { k, m1x: m.x, m1y: m.y };
      // origin 0 0: keep the content that started under the midpoint glued to
      // the (moving) midpoint — visual = t + k·content − scroll, solve for t.
      const tx = m.x + start.sl - k * (start.sl + start.m0x);
      const ty = m.y + start.st - k * (start.st + start.m0y);
      const l = zoomLayerRef.current;
      if (l) l.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    };
    const finish = () => {
      if (!start) return;
      const l = zoomLayerRef.current;
      if (l) { l.style.transform = ""; l.style.willChange = ""; }
      if (cur) {
        // Re-base scroll by the midpoint's travel: afterwards the content at
        // the final midpoint (at the old scale) is the pinched content, which
        // the anchor effect then re-places there at the committed scale. The
        // refs get the unclamped values on purpose — the anchor effect reads
        // them instead of live scroll to survive pre-layout clamping.
        const sl = start.sl + start.m0x - cur.m1x;
        const st = start.st + start.m0y - cur.m1y;
        el.scrollLeft = sl; el.scrollTop = st;
        lastScrollLeftRef.current = sl; lastScrollRef.current = st;
        const next = clampZoom(start.scale * cur.k);
        if (next !== wheelScaleRef.current) {
          zoomAnchorRef.current = { x: cur.m1x, y: cur.m1y };
          wheelScaleRef.current = next;
          docSwapPendingRef.current = false;
          cbRef.current.onZoomTo?.(next);
        }
      }
      start = null; cur = null;
    };
    const onTouchEnd = (e) => { if (e.touches.length < 2) finish(); };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
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

  // Snapshot an area highlight's region as a PNG data URL. Nothing is stored
  // with the note — clicking the rectangle later re-crops it, rendered
  // offscreen straight from the document, so it works even while the page
  // isn't on screen (e.g. a click in the notes window before scrolling).
  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = pdfDoc ? async (h) => {
      const r = h?.position?.boundingRect;
      const pn = r?.pageNumber || h?.position?.pageNumber;
      if (!r || !pn) return null;
      try {
        const page = await pdfDoc.getPage(pn);
        const vpBase = page.getViewport({ scale: 1 });
        // Stored rect is page-relative at its capture-time render size — map
        // to scale-1 page coordinates first.
        const kx = vpBase.width / (r.width || vpBase.width);
        const ky = vpBase.height / (r.height || vpBase.height);
        const x1 = r.x1 * kx, y1 = r.y1 * ky;
        const w = Math.max(1, (r.x2 - r.x1) * kx), hh = Math.max(1, (r.y2 - r.y1) * ky);
        // Render sharp: at least 2×, more for small crops, capped so a
        // full-page rectangle doesn't allocate a huge canvas.
        const s = Math.min(4, Math.max(2, 1200 / w));
        const out = document.createElement("canvas");
        out.width = Math.round(w * s); out.height = Math.round(hh * s);
        const ctx = out.getContext("2d");
        // Pre-translate so the crop origin lands at the canvas origin — the
        // render then clips to the canvas (same trick as the DPR transform in
        // PdfPage).
        ctx.setTransform(1, 0, 0, 1, -Math.round(x1 * s), -Math.round(y1 * s));
        await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: s }) }).promise;
        return out.toDataURL("image/png");
      } catch {
        return null;
      }
    } : null;
    return () => { captureRef.current = null; };
  }, [pdfDoc, captureRef]);
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
  useEffect(() => () => { displayedDocRef.current?.destroy().catch(() => {}); }, []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
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
        const prev = displayedDocRef.current;
        displayedDocRef.current = doc;
        heightsExactRef.current = n <= EXACT;
        pageHeightsRef.current = heights;
        pageWidthsRef.current = widths;
        setPageHeights(heights);
        setNumPages(n);
        setDocSeq((s) => s + 1);
        setDisplayedUrl(url);
        setPdfDoc(doc);
        // Old doc torn down after the swap commit — destroying it while its
        // pages are still mounted spams transport-destroyed rejections.
        if (prev && prev !== doc) setTimeout(() => prev.destroy().catch(() => {}), 1000);
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
    scrollToPositionRef.current = async ({ position, behavior, offset }) => {
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
      const targetTop = pageTop + highlightY - (offset ?? 80);
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

  // Current-page widget (top-right): tracks scrolling, and typing a number
  // jumps. The "current" page is the one covering a point a third of the way
  // down the viewport — closer to "the page I'm reading" than the strict top
  // edge, which flips the counter while the previous page still fills most of
  // the screen. setState bails out when the value is unchanged, so scroll
  // events don't re-render.
  const [curPage, setCurPage] = useState(1);
  const [pageInput, setPageInput] = useState(null); // non-null while the box is being edited
  const syncCurPage = () => {
    const v = viewerRef.current;
    if (!v || !numPages) return;
    const heights = pageHeightsRef.current;
    const y = v.scrollTop + v.clientHeight / 3;
    let acc = 0, pn = numPages;
    for (let i = 0; i < numPages; i++) {
      acc += (heights[i] || FALLBACK_H) * scale + PAGE_GAP;
      if (acc > y) { pn = i + 1; break; }
    }
    setCurPage(pn);
  };
  // Resync outside of scroll events: document swaps (a restore to the same
  // scrollTop fires no scroll event), zoom changes, and height refinement on
  // long documents can all move the page under the reference point.
  useEffect(() => { syncCurPage(); }, [docSeq, scale, numPages, pageHeights]);
  const jumpToPage = (pn) => {
    if (!numPages || !Number.isFinite(pn)) return;
    const p = Math.max(1, Math.min(numPages, pn));
    // offset 0: land exactly on the page's top edge, not the highlight
    // jump's 80px context margin.
    scrollToPositionRef.current?.({ position: { pageNumber: p }, offset: 0 });
  };

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

  // Ctrl held (when annotating is allowed) → crosshair over the pages: the
  // cue that dragging now draws an area note instead of selecting text.
  const canAnnotate = !!onSelectionFinished;
  const [areaCursor, setAreaCursor] = useState(false);
  useEffect(() => {
    if (!canAnnotate) return;
    const kd = (e) => { if (e.key === "Control") setAreaCursor(true); };
    const ku = (e) => { if (e.key === "Control") setAreaCursor(false); };
    const off = () => setAreaCursor(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", off);
      setAreaCursor(false);
    };
  }, [canAnnotate]);

  // A finished Ctrl+drag on a page: hold the rect (drawn by that page while
  // the popup is up) and offer the same color tip as a text selection. The
  // drawn region also acts as a chat selection — its snapshot goes to the
  // host right away (like text selections attach on mouseup), whether or not
  // a note is then created.
  const onAreaSelected = useCallback(({ image, ...sel }) => {
    setSelPopup({ kind: "area", ...sel });
    if (image) cbRef.current.onAreaSelection?.(image);
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
      // "No text selected" must not dismiss an area popup — the drag that
      // created it ends in a mouseup with an empty selection by design.
      const keepArea = (p) => (p && p.kind === "area" ? p : null);
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) { setSelPopup(keepArea); return; }
      const range = sel.getRangeAt(0);
      if (!range) { setSelPopup(keepArea); return; }
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
        // Snapshot the page's offset/size NOW: the confirm click may come after
        // a scroll or zoom, when re-measuring the page would no longer agree
        // with these viewport-space selection rects.
        const pageRect = pageEl.getBoundingClientRect();
        const pageW = parseFloat(pageEl.style.width) || pageEl.offsetWidth || 1;
        const pageH = parseFloat(pageEl.style.height) || pageEl.offsetHeight || 1;
        setSelPopup({
          text, rect: { top: r.top, left: r.left, width: r.width, bottom: r.bottom }, lineRects, pageNumber,
          pageLeft: pageRect.left, pageTop: pageRect.top, pageW, pageH,
        });
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
    if (selPopup.kind === "area") {
      // Rect is already page-relative at capture-time render size. area: true
      // rides inside the position, so it flows through block storage,
      // rendering, and PDF export (/Square) without extra plumbing.
      const { pageNumber, rect, width, height } = selPopup;
      const r = { ...rect, width, height, pageNumber };
      const position = { pageNumber, boundingRect: r, rects: [r], area: true };
      onSelectionFinished(position, { text: "" }, () => setSelPopup(null), { color, commentText, ...(extra || {}) });
      return;
    }
    const r = selPopup.rect;
    // Use the page offset/size snapshotted with the selection — the current
    // page position may have drifted (scroll/zoom) since the rects were taken.
    const curW = selPopup.pageW, curH = selPopup.pageH;
    const px = selPopup.pageLeft, py = selPopup.pageTop;
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
      {numPages > 0 ? (
        <div className="pdfPageWidget" title="Type a page number and press Enter to jump">
          <input
            type="text"
            inputMode="numeric"
            value={pageInput ?? String(curPage)}
            style={{ width: `${Math.max(1, (pageInput ?? String(curPage)).length)}ch` }}
            onFocus={(e) => { setPageInput(String(curPage)); e.target.select(); }}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                jumpToPage(parseInt(pageInput, 10));
                e.currentTarget.blur();
                e.stopPropagation();
              } else if (e.key === "Escape") {
                e.currentTarget.blur();
                e.stopPropagation();
              }
            }}
            onBlur={() => setPageInput(null)}
            aria-label="Current page"
          />
          <span className="pdfPageTotal">/ {numPages}</span>
        </div>
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
      <div ref={viewerRef} className={"pdfViewer" + (areaCursor || areaMode ? " areaCursor" : "") + (areaMode ? " areaMode" : "")}
        style={{ height: "100%", overflowY: "auto", overflowX: "auto", overflowAnchor: "none" }}
        onScroll={(e) => {
          lastScrollRef.current = e.currentTarget.scrollTop;
          lastScrollLeftRef.current = e.currentTarget.scrollLeft;
          syncCurPage();
        }}>
      {/* pdfZoomLayer: the pinch preview's transform target — spans the full
          scroll content so transform-origin 0 0 coincides with content (0,0) */}
      <div ref={zoomLayerRef} className="pdfZoomLayer">
      {Array.from({ length: numPages }, (_, i) => (
        <PdfPage key={`${docSeq}-${i + 1}`} pageNumber={i + 1} pdfDoc={pdfDoc} scale={scale}
          highlights={hlsByPage.get(i + 1) || EMPTY_MARKS} onJump={stableCbs.onJump} onHighlightJump={stableCbs.onHighlightJump}
          onLinkHighlight={stableCbs.onLinkHighlight} onHighlightContext={stableCbs.onHighlightContext}
          readOnly={!onSelectionFinished} forceRender={forcePages.has(i + 1)}
          noteBadges={!!noteBadges}
          hideEmbeddedAnnots={!!hideEmbeddedAnnots}
          areaMode={canAnnotate ? !!areaMode : false}
          onAreaSelected={canAnnotate ? onAreaSelected : undefined}
          pendingArea={selPopup?.kind === "area" && selPopup.pageNumber === i + 1 ? selPopup : null}
          reservedHeight={pageHeights[i] ? pageHeights[i] * scale : null}
          findMarks={marksByPage.get(i + 1) || EMPTY_MARKS}
          onInternalLink={goToDestStable}
          onExternalLink={stableCbs.onExternalLink}
          onPainted={onPagePainted}
        />
      ))}
      </div>
      {selPopup && onSelectionFinished && (
        <div style={{
          position: "fixed", zIndex: 9999,
          top: selPopup.kind === "area" ? selPopup.tip.top : selPopup.rect.bottom + 8,
          left: selPopup.kind === "area" ? selPopup.tip.left : selPopup.rect.left,
        }}>
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

// Speech-bubble badge on a highlight that carries a typed note. The hover
// tooltip renders the note's markdown + KaTeX — a native title attribute is
// plain-text only. Portaled to <body> with fixed coordinates so the pinch
// transform on .pdfZoomLayer (an ancestor transform makes position:fixed
// resolve against it, not the viewport) can never misplace it.
function NoteBadge({ hlId, text, style, onClick, onContextMenu }) {
  const [tip, setTip] = useState(null);
  const btnRef = useRef(null);
  const timerRef = useRef(0);
  const show = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = r.top < window.innerHeight * 0.45;
      setTip({
        left: Math.max(8, Math.min(r.left - 12, window.innerWidth - 396)),
        ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }),
      });
    }, 120);
  };
  const hide = () => { clearTimeout(timerRef.current); setTip(null); };
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <>
      <button ref={btnRef} type="button" className="pdfNoteBadge" data-hl-id={hlId} style={style}
        onMouseEnter={show} onMouseLeave={hide}
        onClick={(e) => { hide(); onClick(e); }}
        onContextMenu={(e) => { hide(); onContextMenu(e); }}
      >
        <MessageSquareIcon size={10} strokeWidth={2.2} />
      </button>
      {tip ? createPortal(
        <div className="pdfNoteTip" style={tip}>
          {text ? <ChatMarkdown text={text} /> : "This highlight has a note"}
        </div>,
        document.body
      ) : null}
    </>
  );
}

const PdfPage = React.memo(function PdfPage({ pageNumber, pdfDoc, scale, highlights, onJump, onHighlightJump, onLinkHighlight, onHighlightContext, readOnly, forceRender, reservedHeight, findMarks, onInternalLink, onExternalLink, onPainted, onAreaSelected, pendingArea, areaMode, noteBadges, hideEmbeddedAnnots }) {
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
        // DISABLE keeps embedded markup annotations (e.g. highlights burned in
        // by a Gamma export, or SumatraPDF/Acrobat ones) out of the canvas so
        // they don't stack under Gamma's own overlay after an import. Link
        // regions are unaffected — they're DOM overlays from getAnnotations().
        const task = page.render({
          canvasContext: ctx, viewport: vp,
          annotationMode: hideEmbeddedAnnots ? pdfjsLib.AnnotationMode.DISABLE : pdfjsLib.AnnotationMode.ENABLE,
        });
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
  }, [pdfDoc, pageNumber, scale, visible, hideEmbeddedAnnots]);

  const curW = pageSize ? pageSize.width * scale : 1, curH = pageSize ? pageSize.height * scale : 1;

  // Rectangle drag (screenshot-style area note): Ctrl+drag with a mouse, or
  // any drag while the phone's rectangle mode (areaMode) is on. Pointer
  // events cover mouse and touch with one path; document-level move/up
  // listeners so the drag survives leaving the page box; rects are clamped
  // to it. Tiny drags are clicks — ignored, so Ctrl+click on highlights
  // (additive chat quote) keeps working.
  const [marquee, setMarquee] = useState(null); // live drag rect, current-render px
  function beginAreaDrag(e) {
    if (readOnly || !onAreaSelected) return;
    if (e.button !== 0) return;
    const viaCtrl = e.pointerType === "mouse" && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
    if (!areaMode && !viaCtrl) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    e.preventDefault(); // keep the text layer from starting a selection
    const pointerId = e.pointerId;
    const box = wrap.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const clamp = (v, max) => Math.max(0, Math.min(max, v));
    const toRect = (cx, cy) => ({
      x1: clamp(Math.min(sx, cx) - box.left, box.width),
      y1: clamp(Math.min(sy, cy) - box.top, box.height),
      x2: clamp(Math.max(sx, cx) - box.left, box.width),
      y2: clamp(Math.max(sy, cy) - box.top, box.height),
    });
    const detach = () => {
      cancelAnimationFrame(moveRaf);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel);
    };
    // High-rate pointers outpace frames, and each setMarquee re-renders the
    // whole page (highlight rects, link boxes) — coalesce to one per frame.
    let moveRaf = 0, moveX = 0, moveY = 0;
    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      moveX = ev.clientX;
      moveY = ev.clientY;
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        setMarquee(toRect(moveX, moveY));
      });
    }
    function onCancel(ev) {
      if (ev.pointerId !== pointerId) return;
      detach();
      setMarquee(null);
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      detach();
      setMarquee(null);
      const r = toRect(ev.clientX, ev.clientY);
      if (r.x2 - r.x1 < 6 || r.y2 - r.y1 < 6) return;
      // Swallow the click this drag would otherwise deliver to whatever sits
      // under the mouse (highlight overlays, link boxes). The timeout clears
      // the trap if no click follows (drag released outside the window).
      const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 0);
      // Crop the region out of the rendered canvas (backing resolution, so
      // the snapshot stays sharp) — it doubles as a chat attachment.
      let image = null;
      const canvas = canvasRef.current;
      if (canvas && canvas.width) {
        try {
          const kx = canvas.width / box.width, ky = canvas.height / box.height;
          const w = Math.round((r.x2 - r.x1) * kx), h = Math.round((r.y2 - r.y1) * ky);
          const out = document.createElement("canvas");
          out.width = w; out.height = h;
          out.getContext("2d").drawImage(canvas, Math.round(r.x1 * kx), Math.round(r.y1 * ky), w, h, 0, 0, w, h);
          image = out.toDataURL("image/png");
        } catch { /* tainted/zero canvas — note creation still works */ }
      }
      onAreaSelected({
        pageNumber, rect: r, width: box.width, height: box.height,
        tip: { left: box.left + r.x1, top: box.top + r.y2 + 8 },
        image,
      });
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel);
  }

  return (
    <div ref={wrapRef} data-page={pageNumber} className="pdfPageWrap"
      onPointerDown={beginAreaDrag}
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
        // Area notes (Ctrl+drag rectangles) draw as an outline with a faint
        // wash — a solid multiply fill would tint the figure underneath.
        const isArea = !!h.position?.area;
        const color = h.color || "rgba(255,226,143,0.65)";
        const elements = [];
        for (const r of rects) {
          elements.push(<div key={h.id + "-" + r.x1 + "-" + r.y1} data-hl-id={h.id} style={{
            position: "absolute", zIndex: 2, cursor: "pointer",
            left: r.x1 * curW / storedW, top: r.y1 * curH / storedH,
            width: Math.max(1, (r.x2 - r.x1) * curW / storedW),
            height: Math.max(1, (r.y2 - r.y1) * curH / storedH),
            mixBlendMode: "multiply",
            ...(isArea ? {
              boxSizing: "border-box", borderRadius: 3,
              border: `2px solid ${color}`,
              background: `color-mix(in srgb, ${color} 25%, transparent)`,
            } : { background: color }),
            ...(isLink ? (isArea
              ? { border: "2px solid rgba(70, 130, 255, 0.9)" }
              : { borderBottom: "2px solid rgba(70, 130, 255, 0.9)", borderRadius: 1 }) : {}),
          }} title={isLink ? (h.linkTarget.pageId ? "Open linked paper" : h.linkTarget.url) : (h.comment?.text || "")}
            onClick={function (e) {
              e.stopPropagation();
              if (isLink) onLinkHighlight?.(h);
              else onHighlightJump?.(h.id, e.ctrlKey || e.metaKey);
            }}
            onContextMenu={function (e) { e.preventDefault(); if (onHighlightContext) onHighlightContext({ id: h.id, x: e.clientX, y: e.clientY }); }}
          />);
        }
        // Speech-bubble badge at the end of the passage when the user typed a
        // note on the highlight — click behaves like clicking the highlight.
        if (noteBadges && h.hasNote && rects.length) {
          const r = rects[rects.length - 1];
          elements.push(
            <NoteBadge key={h.id + "-note"} hlId={h.id}
              text={h.comment?.text?.trim() || ""}
              style={{
                left: r.x2 * curW / storedW + 2,
                top: r.y1 * curH / storedH - 8,
              }}
              onClick={(e) => { e.stopPropagation(); onHighlightJump?.(h.id, e.ctrlKey || e.metaKey); }}
              onContextMenu={(e) => { e.preventDefault(); onHighlightContext?.({ id: h.id, x: e.clientX, y: e.clientY }); }}
            />
          );
        }
        return elements;
      })}
      {marquee ? (
        <div className="pdfAreaMarquee" style={{
          left: marquee.x1, top: marquee.y1,
          width: marquee.x2 - marquee.x1, height: marquee.y2 - marquee.y1,
        }} />
      ) : null}
      {/* Drag finished, color tip still open: keep the drawn rect visible
          (scaled — the popup survives zoom changes). */}
      {pendingArea ? (
        <div className="pdfAreaMarquee" style={{
          left: pendingArea.rect.x1 * curW / pendingArea.width,
          top: pendingArea.rect.y1 * curH / pendingArea.height,
          width: (pendingArea.rect.x2 - pendingArea.rect.x1) * curW / pendingArea.width,
          height: (pendingArea.rect.y2 - pendingArea.rect.y1) * curH / pendingArea.height,
        }} />
      ) : null}
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

// The pdf.js-based viewer: lazy page rendering, highlights, link
// annotations, text search, and the selection popup. Extracted from
// App.jsx to keep the God component shrinking.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// The legacy build, not the default one: it ships the core-js polyfills the
// modern build assumes (Promise.withResolvers is Safari 17.4+, and pdf.js
// calls it the moment a loading task is created). Without it every iPad below
// iOS 17.4 threw here at module scope and the whole app rendered blank.
// The worker is the matching legacy build, bundled by Vite as a content-hashed
// asset (?url): always the installed pdfjs-dist version, and served immutable
// for a year like every other asset — a copy under public/ was revalidated on
// every page load, 1.3 MB each time, and that was most of a warm reopen.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { createPortal } from "react-dom";
import { ChevronRightIcon, LinkIcon, MessageSquareIcon, OutlineIcon } from "../shared/ui/Icons";
import { InkLayer } from "../ink/InkLayer";
import { canvasSize } from "../shared/lib/canvasSize.js";
import { installVerticalScrollSnap } from "./verticalScrollSnap.js";
import { segmentPage } from "./pdfTranslate";
import { captureNativeViewport } from "../native/nativeBridge.js";
import { BACKFILL_DELAY_MS, chooseTransport, docIdOf, layoutFromManifest, rangeOpenOptions } from "./pdfSource";
import { normalizeChars } from "../shared/lib/textnorm";
import { apiJson, assetUrl, withShare, withWorkspace } from "../shared/lib/utils";
import { pdfInkPlacement } from "../native/inkBlock.js";
import { inkJumpPosition } from "../native/inkNavigation.js";
import ReplayInkLayer from "../native/ReplayInkLayer.jsx";
import { ChatMarkdown } from "../shared/ui/Widgets";
import { PdfCitationOverlay } from "./PdfCitationOverlay";
import { citationRuns, runChars } from "./pdfCitation.js";
import { COLORS } from "../shared/model/highlightColors.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
// One worker for every document. pdf.js otherwise starts a fresh worker per
// getDocument — the 1.3 MB script fetched and compiled again per open — and
// a document's destroy() only tears down a worker pdf.js created itself, so
// a shared one outlives every DOC_CACHE eviction. Created at module scope,
// which is also what starts its script downloading alongside the app.
// Guarded: a throw at module scope takes down every route, PDF or not.
let PDF_WORKER = null;
try {
  PDF_WORKER = new pdfjsLib.PDFWorker({ name: "gamma-pdf" });
} catch {}
// getDocument parameters every open shares.
const openParams = (params) => (PDF_WORKER ? { ...params, worker: PDF_WORKER } : params);

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

// The bytes of the document most recently downloaded, so a reopen while the
// IndexedDB copy below is still being written never re-downloads. One entry
// only: raw bytes are the cheap half of a reopen (re-reading them from
// IndexedDB takes tens of ms) and the memory belongs to DOC_CACHE, which
// holds the expensive half. pdf.js detaches the buffer it's handed, so
// entries are cloned on use.
const PDF_CACHE = new Map(); // url -> ArrayBuffer, insertion order = LRU
const PDF_CACHE_MAX = 1;
function cachePdf(url, buf) {
  PDF_CACHE.delete(url);
  PDF_CACHE.set(url, buf);
  while (PDF_CACHE.size > PDF_CACHE_MAX) PDF_CACHE.delete(PDF_CACHE.keys().next().value);
}

// Parsed documents, kept across tab switches and viewer unmounts. Rebuilding
// a PDFDocumentProxy from cached bytes — xref, page tree, fonts — is most of
// what a reopen costs, and a document handed over ready to render also holds
// the reading position still: its geometry is final in the first frame, so
// nothing settles under the scroll restore. Eviction destroys the oldest,
// never the one being committed (it is set last).
const DOC_CACHE = new Map(); // url -> {doc, heights, widths}, insertion order = LRU
const DOC_CACHE_MAX = 2;
function rememberDoc(url, entry) {
  DOC_CACHE.delete(url);
  DOC_CACHE.set(url, entry);
  while (DOC_CACHE.size > DOC_CACHE_MAX) {
    const victim = DOC_CACHE.keys().next().value;
    const { doc } = DOC_CACHE.get(victim);
    DOC_CACHE.delete(victim);
    // Its pages may still be mounted mid-swap — destroying now would spam
    // transport-destroyed rejections; after the commit has settled is fine.
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

async function diskCacheHas(url) {
  let db;
  try {
    db = await idbOpen();
    return (await idbReq(db.transaction("pdfs").objectStore("pdfs").getKey(url))) !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

// A range open leaves nothing on disk. BACKFILL_DELAY_MS after the reader has
// their page, the whole file is fetched once into IndexedDB so the next open
// is warm — otherwise every later open would pay the round trips again.
const backfilling = new Set();
function backfillLocalCopy(url) {
  if (backfilling.has(url)) return;
  backfilling.add(url);
  setTimeout(async () => {
    try {
      if (await diskCacheHas(url)) return;
      const resp = await fetch(withShare(url), { credentials: "include" });
      if (resp.ok) diskCachePut(url, await resp.arrayBuffer());
    } catch {} finally {
      backfilling.delete(url);
    }
  }, BACKFILL_DELAY_MS);
}

// The document manifest (GET /api/pdf-info, docs/dev/pdf_loading.md): byte
// size, page count and every page's size, derived server-side once per
// stored PDF. Only uploads have one — the /api/pdf proxy has no local file to
// measure — and a missing or failed manifest just means the older path.
// ?ws= keeps the browser's HTTP cache per workspace.
async function fetchManifest(url) {
  const id = docIdOf(url);
  if (!id) return null;
  try {
    return await apiJson(withWorkspace(`/api/pdf-info/${id}`));
  } catch {
    return null;
  }
}

// The file's byte size from a HEAD (the upload route answers one with
// Content-Length), or null. Raced against the manifest for the transport
// decision: a manifest being computed for the first time (a long book,
// opened the moment it was uploaded) can take seconds, and the open must not
// wait on it — a HEAD is one round trip whatever the file.
async function fetchSize(url) {
  try {
    const r = await fetch(withShare(url), { method: "HEAD", credentials: "include" });
    const n = parseInt(r.headers.get("content-length") || "", 10);
    return r.ok && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// The first non-null value among the promises, or null when none has one.
function firstValue(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    for (const p of promises) {
      p.then((v) => { if (v != null) resolve(v); else if (--pending === 0) resolve(null); },
        () => { if (--pending === 0) resolve(null); });
    }
  });
}

// A promise's value, or null once `ms` have passed without it.
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
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
    // One plain GET. Upload URLs are content-addressed and served with an
    // immutable Cache-Control, so a normal request lets the browser HTTP cache
    // make repeat downloads free — even on plain http where Cache Storage is
    // unavailable. Files too large for this path open by range requests
    // instead (pdfSource.chooseTransport), through pdf.js's own transport.
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

// Handwriting (ink/InkLayer.jsx): inkBlocks are the page's ink groups (blocks
// with properties.ink_url / pdf_page), inkTool the armed tool or null,
// inkPenTool what a stylus draws with when nothing is armed, inkFlash
// {id, nonce} outlines a group after a jump; strokes and erasures report
// back through onInkStroke / onInkErase, a click on ink through onInkJump.
//
// Native handwriting (native/, docs/dev/handwriting.md "Native handwriting
// blocks") rides alongside, deliberately under its own names: `nativeInkBlocks`
// are this page's `pdf_ink` blocks, shown as images the browser never edits;
// `nativeInkPreviews` is the document's loaded `.inkjson` derivative set (shared
// with the Notes pane); `replay` (null, or {time, events, page, assets})
// switches those layers into timed rendering; `inkJumpRequest` ({id, nonce})
// scrolls to a block's strokes and outlines them; `headerAction` hosts the
// host app's native handoff button in the viewer's top-right control row.
function PdfViewer({ url, viewportRef, citation = null, headerAction = null, highlights, pdfScaleValue, scrollRef, onJump, onHighlightJump, onLinkHighlight, onSelectionFinished, onAreaSelection, onHighlightContext, searchRef, captureRef, onEffectiveScale, onZoomTo, findMarks, onExternalLink, onLinkContext, onBeforeLinkJump, onLoadState, retryRef, areaMode, hideEmbeddedAnnots, darkPage = false, translateKey = "", translateParallel = 3, onTranslate, translateCtlRef, onTranslateState, inkBlocks = EMPTY_MARKS, inkTool = null, inkPenTool = null, inkPenOnly = true, inkPressure = true, inkEraserMode = "stroke", inkEraserSize = 1, inkLassoMode = "free", inkSelection = null, inkFlash = null, onInkStroke, onInkErase, onInkErasePartial, onInkSelect, onInkAction, onInkMoveSelection, onInkJump, nativeInkBlocks = EMPTY_MARKS, nativeInkPreviews = null, replay = null, inkJumpRequest = null, onReplaySeek }) {
  const viewerRef = useRef(null);
  useLayoutEffect(() => {
    if (!viewportRef) return;
    viewportRef.current = () => captureNativeViewport(viewerRef.current);
    return () => { viewportRef.current = null; };
  }, [viewportRef]);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [docSeq, setDocSeq] = useState(0); // bumped per document — keys the page tree so swaps are atomic
  const [displayedUrl, setDisplayedUrl] = useState(""); // url of the document on screen (lags `url` during a load)
  const [skeletonUrl, setSkeletonUrl] = useState(""); // url whose manifest skeleton is on screen (page boxes, no document yet)
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
  cbRef.current = { onJump, onHighlightJump, onLinkHighlight, onHighlightContext, onExternalLink, onLinkContext, onLoadState, onZoomTo, onAreaSelection, onTranslate, onTranslateState, onInkStroke, onInkErase, onInkErasePartial, onInkSelect, onInkAction, onInkMoveSelection, onInkJump };
  const stableCbs = useMemo(() => ({
    onJump: (...a) => cbRef.current.onJump?.(...a),
    onHighlightJump: (...a) => cbRef.current.onHighlightJump?.(...a),
    onLinkHighlight: (...a) => cbRef.current.onLinkHighlight?.(...a),
    onHighlightContext: (...a) => cbRef.current.onHighlightContext?.(...a),
    onExternalLink: (...a) => cbRef.current.onExternalLink?.(...a),
    onLinkContext: (...a) => cbRef.current.onLinkContext?.(...a),
    onInkStroke: (...a) => cbRef.current.onInkStroke?.(...a),
    onInkErase: (...a) => cbRef.current.onInkErase?.(...a),
    onInkErasePartial: (...a) => cbRef.current.onInkErasePartial?.(...a),
    onInkSelect: (...a) => cbRef.current.onInkSelect?.(...a),
    onInkAction: (...a) => cbRef.current.onInkAction?.(...a),
    onInkMoveSelection: (...a) => cbRef.current.onInkMoveSelection?.(...a),
    onInkJump: (...a) => cbRef.current.onInkJump?.(...a),
  }), []);

  // Alt held while any page shows its translation = peek at the original:
  // the overlays hide (CSS visibility, no re-render) until the key is
  // released. The DOM check keeps the preventDefault (which stops a bare Alt
  // from focusing the browser menu bar) from firing when nothing is
  // translated.
  const [transPeek, setTransPeek] = useState(false);
  useEffect(() => {
    const anyTrans = () => !!viewerRef.current?.querySelector(".pdfTransLayer");
    const kd = (e) => { if (e.key === "Alt" && anyTrans()) { e.preventDefault(); setTransPeek(true); } };
    const ku = (e) => { if (e.key === "Alt" && anyTrans()) { e.preventDefault(); setTransPeek(false); } };
    const off = () => setTransPeek(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", off);
    };
  }, []);

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

  // Reset pending touch alignment on zoom/document changes. The helper never
  // writes scroll offsets while a finger or native momentum is moving.
  useEffect(() => {
    const el = viewerRef.current;
    if (el) return installVerticalScrollSnap(el);
  }, [pdfScaleValue, pdfDoc]);

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

  // Ink groups per page, same document guard as the highlights.
  const inkByPage = useMemo(() => {
    const map = new Map();
    if (displayedUrl !== url) return map;
    for (const b of inkBlocks || []) {
      const p = b.properties?.pdf_page;
      if (!p) continue;
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(b);
    }
    return map;
  }, [inkBlocks, displayedUrl, url]);

  // Native `pdf_ink` blocks per page, under the same document guard: they are
  // images (or replay layers) drawn above the canvas and never edited here.
  const nativeInkByPage = useMemo(() => {
    const map = new Map();
    if (displayedUrl !== url) return map;
    for (const b of nativeInkBlocks || []) {
      const p = b.properties?.pdf_page;
      if (!p) continue;
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(b);
    }
    return map;
  }, [nativeInkBlocks, displayedUrl, url]);

  // Expose full-text search over the loaded document (used by the search
  // panel). Each page's text runs are joined into one string — so matches can
  // span runs — and searched through a normalized view (ligatures folded,
  // hyphenated line breaks re-joined, digit-group separators dropped:
  // textnorm.normalizeChars, the mirror of the server index's rules). Every
  // normalized character remembers its source run, so a match maps back to
  // exact rects (at scale 1) even when normalization changed lengths.
  useEffect(() => {
    if (!searchRef) return;
    searchRef.current = pdfDoc ? async (re) => {
      const out = [];
      for (let p = 1; p <= pdfDoc.numPages && out.length < 200; p++) {
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const items = tc.items;
        // Page string: runs joined by their PDF line break or a space,
        // each char tagged with its source run (-1 = synthetic filler).
        const chars = runChars(items.map((it) => ({ text: it.str, hasEOL: it.hasEOL })), { fillSpaces: true });
        const { norm, src } = normalizeChars(chars);
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
  }, [isFitWidth, pdfDoc, skeletonUrl]);

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
  // swapping only when the new doc is fully laid out is what prevents the
  // blank flash and the scrollbar resizing repeatedly during a tab switch. No
  // teardown on unmount: documents belong to DOC_CACHE, which is what makes
  // coming back to a paper instant.
  const displayedDocRef = useRef(null);

  // The three ways a document reaches the screen (docs/dev/pdf_loading.md).
  // Every commit lands heights, page tree and document in ONE render, so the
  // scrollbar changes exactly once. A skeleton is page boxes laid out from
  // the manifest before pdf.js has a document: the reader's restored position
  // lands on it (the host's "layout" phase), and when the real document
  // arrives it fills the same boxes — same keys, nothing remounts.
  const skeletonRef = useRef(null); // url whose skeleton is on screen, else null
  const commitLayout = (heights, widths, exact) => {
    heightsExactRef.current = exact;
    pageHeightsRef.current = heights;
    pageWidthsRef.current = widths;
    setPageHeights(heights);
    setPageWidths(widths);
    setNumPages(heights.length);
  };
  const commitSkeleton = (url, { heights, widths }) => {
    skeletonRef.current = url;
    commitLayout(heights, widths, true);
    setDocSeq((s) => s + 1);
    setDisplayedUrl(url);
    setSkeletonUrl(url);
  };
  const commitDoc = (url, doc, heights, widths, exact) => {
    displayedDocRef.current = doc;
    commitLayout(heights, widths, exact);
    if (skeletonRef.current !== url) setDocSeq((s) => s + 1);
    skeletonRef.current = null;
    setDisplayedUrl(url);
    setPdfDoc(doc);
    rememberDoc(url, { doc, heights, widths });
  };
  // Skeleton boxes are in the DOM, pre-paint: the host applies its pending
  // scroll restore now, before a byte of the PDF has been parsed.
  useLayoutEffect(() => {
    if (skeletonUrl) onLoadState?.(skeletonUrl, { phase: "layout" });
  }, [skeletonUrl]);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const report = (st) => { if (!cancelled) onLoadState?.(url, st); };
    (async () => {
      try {
        report({ phase: "open" });
        // A document parsed on an earlier visit is handed over as it is.
        const live = DOC_CACHE.get(url);
        if (live) {
          report({ phase: "cached" });
          commitDoc(url, live.doc, live.heights, live.widths, true);
          return;
        }
        // The manifest and the bytes travel in parallel. On a cold open the
        // manifest alone lays the document out, while pdf.js is still
        // fetching; for an uncached upload it also decides the transport.
        const manifestP = fetchManifest(url);
        manifestP.then((m) => {
          if (cancelled || displayedDocRef.current || skeletonRef.current) return;
          const lay = layoutFromManifest(m, { width: FALLBACK_W, height: FALLBACK_H });
          if (lay) commitSkeleton(url, lay);
        });
        let data = PDF_CACHE.get(url) || (await diskCacheGet(url));
        if (cancelled) return;
        let openedByRange = false;
        if (data) {
          report({ phase: "cached" });
        } else {
          // Size from the manifest or a HEAD, whichever answers first.
          const bytes = docIdOf(url) ? await firstValue([manifestP.then((m) => m?.bytes), fetchSize(url)]) : null;
          if (cancelled) return;
          openedByRange = chooseTransport({ url, bytes }) === "range";
          if (!openedByRange) {
            data = await fetchPdfData(url, onLoadState, () => cancelled);
            if (!data || cancelled) return;
          }
        }
        report({ phase: "parsing" });
        let doc;
        if (openedByRange) {
          // pdf.js fetches the url itself (absolute, once resolved); the fetch
          // wrapper in utils.js tags same-origin absolute urls with the
          // workspace header too, so the ranges land in the right library.
          doc = await pdfjsLib.getDocument(openParams(rangeOpenOptions(withShare(url)))).promise;
        } else {
          cachePdf(url, data); // insert or bump LRU position
          doc = await pdfjsLib.getDocument(openParams({ data: data.slice(0), disableAutoFetch: true, disableRange: true })).promise;
        }
        if (cancelled) { doc.destroy().catch(() => {}); return; }
        report({ phase: "opened" }); // pdf.js has the document: xref and page tree parsed
        const n = doc.numPages;
        // Exact page sizes from the manifest when it describes this file.
        // Bytes from the cache do not wait long for it: a manifest computed
        // for the first time (a long file nobody has opened) may take a
        // second, and measuring is the older, still-correct path.
        const manifest = await (data ? withTimeout(manifestP, 250) : manifestP);
        if (cancelled) { doc.destroy().catch(() => {}); return; }
        const fromManifest = manifest && manifest.pages === n
          ? layoutFromManifest(manifest, { width: FALLBACK_W, height: FALLBACK_H }) : null;
        const EXACT = 8;
        let heights, widths;
        if (fromManifest) {
          ({ heights, widths } = fromManifest);
        } else {
          // Measure the first pages (a worker round trip each) and estimate
          // the rest from page 1, refined below. Kept small: this loop
          // blocks first paint.
          const measured = Math.min(n, EXACT);
          heights = []; widths = [];
          for (let i = 1; i <= measured; i++) {
            report({ phase: "measuring", done: i - 1, total: measured });
            try {
              const vp1 = (await doc.getPage(i)).getViewport({ scale: 1 });
              heights.push(vp1.height); widths.push(vp1.width);
            } catch { heights.push(heights[0] || FALLBACK_H); widths.push(widths[0] || FALLBACK_W); }
            if (cancelled) { doc.destroy().catch(() => {}); return; }
          }
          for (let i = heights.length; i < n; i++) { heights.push(heights[0] || FALLBACK_H); widths.push(widths[0] || FALLBACK_W); }
        }
        const exact = !!fromManifest || n <= EXACT;
        commitDoc(url, doc, heights, widths, exact);
        if (openedByRange) backfillLocalCopy(url);
        if (exact) return;
        // Refine the estimated heights in the background (long docs without
        // a manifest only). The arrays are shared with the DOC_CACHE entry,
        // so a later reopen gets the refined layout.
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
            setPageWidths([...widths]);
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
  const [pageWidths, setPageWidths] = useState([]);

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

  // Native handwriting jump: the recorded page events drive the view during
  // Replay, so the audio clock decides where we are — one frame's delay keeps
  // the scroll off the audio callback's critical path.
  useEffect(() => {
    if (replay?.page && replay.page <= numPages) {
      const frame = requestAnimationFrame(() => scrollToPositionRef.current?.({ position: { pageNumber: replay.page }, offset: 0 }));
      return () => cancelAnimationFrame(frame);
    }
  }, [replay?.page, numPages, pdfDoc]);

  // Clicking a native ink block's marker/card asks for its strokes, not just
  // its page: scroll to the block's bounds through the SAME crop/rotation
  // affine transform the ink layer draws with, then outline them briefly. The
  // nonce makes a repeat click on the same block flash again.
  const [flashingInk, setFlashingInk] = useState(null);
  const nativeInkBlocksRef = useRef(nativeInkBlocks);
  nativeInkBlocksRef.current = nativeInkBlocks;
  useEffect(() => {
    setFlashingInk(null);
    if (!inkJumpRequest || !pdfDoc) return;
    const block = nativeInkBlocksRef.current.find((b) => b.id === inkJumpRequest.id);
    const pageNumber = block?.properties?.pdf_page;
    if (!pageNumber || pageNumber > pdfDoc.numPages) return;
    let cancelled = false, timer;
    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;
        const position = inkJumpPosition(block, page.getViewport({ scale: 1 }));
        if (position) await scrollToPositionRef.current?.({ position, behavior: "auto", offset: 100 });
        if (cancelled) return;
        // At a zoom where the strokes extend past the edge, centre them
        // horizontally as well.
        const container = viewerRef.current, rectangle = position?.boundingRect;
        const element = container?.querySelector(`[data-page="${pageNumber}"]`);
        if (container && element && rectangle) {
          const pageBox = element.getBoundingClientRect(), viewBox = container.getBoundingClientRect();
          const left = pageBox.left + rectangle.x1 / rectangle.width * pageBox.width;
          const right = pageBox.left + rectangle.x2 / rectangle.width * pageBox.width;
          if (left < viewBox.left + 16 || right > viewBox.right - 16) {
            const delta = right - left > viewBox.width - 32
              ? left - viewBox.left - 16
              : (left + right - viewBox.left - viewBox.right) / 2;
            container.scrollLeft += delta;
          }
        }
        setFlashingInk({ id: block.id, nonce: inkJumpRequest.nonce });
        timer = setTimeout(() => setFlashingInk(null), 1800);
      } catch { /* the load/retry state already reports unavailable pages */ }
    })();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [inkJumpRequest, pdfDoc]);

  // Wait for this document, then mount only the cited page. Matching happens
  // after its actual text layer has rendered, including on zoom changes.
  const [activeCitation, setActiveCitation] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setActiveCitation(null);
    if (citation && pdfDoc && displayedUrl === url && citation.page <= pdfDoc.numPages) {
      Promise.resolve(scrollToPositionRef.current?.({ position: { pageNumber: citation.page }, behavior: "auto" }))
        .then(() => { if (!cancelled) setActiveCitation(citation); });
    }
    return () => { cancelled = true; };
  }, [citation, pdfDoc, displayedUrl, url]);
  useEffect(() => {
    if (!activeCitation) return;
    const dismiss = (e) => { if (e.key === "Escape") setActiveCitation(null); };
    const clickAway = (e) => {
      // The marks let pointer input through to the PDF text, so hit-test
      // their rectangles without interfering with selection or links.
      if (e.detail > 0 && viewerRef.current?.contains(e.target)) {
        const marks = viewerRef.current.querySelectorAll(".pdfCitationMark");
        for (const mark of marks) {
          const r = mark.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
        }
      }
      setActiveCitation(null);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("click", clickAway, true);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("click", clickAway, true);
    };
  }, [activeCitation]);

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

  // --- Translation engine ----------------------------------------------------
  // One queue for the whole document, driven from the host's toolbar button.
  // A producer segments queued pages in order and feeds ONE flat list of
  // small chunks; N workers (Settings → parallel requests) start on the
  // first chunk while later pages are still segmenting, and stream across
  // page boundaries — the parallel slots never idle at page ends. Each chunk
  // is retried once; the server additionally salvages miscounted batches per
  // paragraph. State per page sits in transMap; PdfPage only *renders* its
  // entry. Halting flips job.aborted: finished chunks keep their text.
  const CHUNK_PARAS = 6, CHUNK_CHARS = 1200;
  const [transMap, setTransMap] = useState(() => new Map()); // pageNo -> {key, paras, texts, done}
  const [transShown, setTransShown] = useState(true); // show/hide applies to ALL pages at once
  const [transStatus, setTransStatus] = useState({ running: false, progress: 0, label: "" });
  const transJobRef = useRef(null); // {aborted} while a job runs
  const parasCacheRef = useRef(new Map()); // pageNo -> segmented paragraph blocks
  const transMapRef = useRef(transMap);
  transMapRef.current = transMap;
  const translateKeyRef = useRef(translateKey);
  translateKeyRef.current = translateKey;
  const translateParallelRef = useRef(3);
  translateParallelRef.current = Math.min(32, Math.max(1, translateParallel || 3));
  const curPageRef = useRef(1);
  curPageRef.current = curPage;
  const numPagesRef = useRef(0);
  numPagesRef.current = numPages;

  // Everything the host's button needs to know, pushed on every change.
  // `pages` counts only pages with visible translated text under the CURRENT
  // language/model key — entries from a previous key don't render, and
  // counting them would leave the button a dead show/hide toggle after a
  // settings switch instead of translating afresh.
  useEffect(() => {
    let pages = 0;
    for (const e of transMap.values()) {
      if (e.key === translateKey && e.texts.some(Boolean)) pages += 1;
    }
    cbRef.current.onTranslateState?.({ ...transStatus, shown: transShown, pages });
  }, [transStatus, transShown, transMap, translateKey]);

  // A document swap invalidates geometry and translations wholesale.
  useEffect(() => {
    haltTransJob();
    parasCacheRef.current = new Map();
    setTransMap(new Map());
    setTransShown(true);
    setTransStatus({ running: false, progress: 0, label: "" });
  }, [docSeq]);
  useEffect(() => () => haltTransJob(), []);

  async function ensureParas(pn) {
    const cache = parasCacheRef.current;
    if (cache.has(pn)) return cache.get(pn);
    const doc = displayedDocRef.current;
    if (!doc) return [];
    const page = await doc.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const runs = tc.items.map((it) => {
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]) || 10;
      return { str: it.str || "", x: tx[4], y: tx[5], w: it.width || h, h, font: it.fontName || "" };
    });
    const paras = segmentPage(runs);
    cache.set(pn, paras);
    return paras;
  }

  // Halting a job: flip `aborted` AND abort the controller — the controller
  // cancels the in-flight fetches, so the job unwinds (and the button frees
  // up for the next job) immediately instead of waiting out slow requests.
  const haltTransJob = () => {
    const j = transJobRef.current;
    if (j) { j.aborted = true; j.ctl.abort(); }
  };

  async function runTransJob(pages, label) {
    if (transJobRef.current || !pages.length) return;
    const job = { aborted: false, ctl: new AbortController() };
    transJobRef.current = job;
    const key = translateKeyRef.current;
    setTransShown(true);
    setTransStatus({ running: true, progress: 0, label });
    const setPageTrans = (pn, entry) =>
      setTransMap((prev) => { const m = new Map(prev); m.set(pn, entry); return m; });
    // Producer/consumer: the producer segments pages in queue order and
    // appends chunks; workers pick them up immediately, so the first request
    // is in flight while later pages are still segmenting. Idle workers wait
    // on `wake` with a short timeout backstop — the timeout (not an event)
    // is what lets them notice an abort or a failure, so halting can stay a
    // plain `job.aborted = true` everywhere.
    const queue = [];
    const pageState = new Map(); // pn -> {paras, out, remaining}
    let totalChars = 0, doneChars = 0, failed = false, segDone = false;
    let wake = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const producer = async () => {
      for (const pn of pages) {
        if (job.aborted || failed) break;
        let paras = [];
        try { paras = await ensureParas(pn); } catch {}
        const texts = paras.filter((p) => p.translate).map((p) => p.text);
        if (!texts.length) {
          setPageTrans(pn, { key, paras, texts: [], done: true });
          continue;
        }
        // busy: translate-indices whose request is in flight (the page
        // shimmers those lines); partial: text streamed so far per index
        // (typed onto the page ahead of the final text).
        const st = { paras, out: new Array(texts.length).fill(undefined), remaining: 0,
                     busy: new Set(), partial: {} };
        pageState.set(pn, st);
        setPageTrans(pn, { key, paras, texts: [], done: false, queued: true });
        let start = 0, chars = 0;
        for (let i = 0; i < texts.length; i++) {
          chars += texts[i].length;
          totalChars += texts[i].length;
          if (i + 1 - start >= CHUNK_PARAS || chars >= CHUNK_CHARS || i === texts.length - 1) {
            queue.push({ pn, off: start, texts: texts.slice(start, i + 1) });
            st.remaining += 1;
            start = i + 1;
            chars = 0;
          }
        }
        notify();
      }
      segDone = true;
      notify();
    };
    const worker = async () => {
      while (!job.aborted && !failed) {
        const c = queue.shift();
        if (!c) {
          if (segDone) return;
          await new Promise((resolve) => {
            const prev = wake;
            wake = () => { prev?.(); resolve(); };
            setTimeout(resolve, 200);
          });
          continue;
        }
        let res = null;
        const st = pageState.get(c.pn);
        const paint = (done) => setPageTrans(c.pn, {
          key, paras: st.paras, texts: st.out.slice(), done, queued: !done,
          busy: new Set(st.busy), partial: { ...st.partial },
        });
        for (let j = 0; j < c.texts.length; j++) st.busy.add(c.off + j);
        paint(false);
        const onPartial = (j, text) => {
          if (job.aborted) return;
          st.partial[c.off + j] = text;
          paint(false);
        };
        // One client-side retry per chunk (transient network/provider blips);
        // the server separately salvages miscounted model replies.
        for (let attempt = 0; attempt < 2 && !res && !job.aborted; attempt++) {
          res = await Promise.resolve(cbRef.current.onTranslate?.(c.texts, job.ctl.signal, onPartial)).catch(() => null);
        }
        for (let j = 0; j < c.texts.length; j++) { st.busy.delete(c.off + j); delete st.partial[c.off + j]; }
        if (job.aborted) return;
        if (!res) { failed = true; return; }
        res.forEach((t, j) => { st.out[c.off + j] = t; });
        st.remaining -= 1;
        paint(st.remaining === 0);
        doneChars += c.texts.reduce((n, t) => n + t.length, 0);
        // While segmentation is still running the denominator is a lower
        // bound, so cap displayed progress until the total is final.
        const p = totalChars ? doneChars / totalChars : 1;
        setTransStatus({ running: true, label, progress: segDone ? p : Math.min(p, 0.95) });
      }
    };
    await Promise.all(
      [producer()].concat(Array.from({ length: translateParallelRef.current }, worker)));
    transJobRef.current = null;
    // Job over (finished, halted or failed): nothing is queued or in flight
    // any more — drop the working indicators, keep whatever was translated.
    setTransMap((prev) => {
      const m = new Map(prev);
      for (const [pn, e] of m) {
        if (e.queued || e.busy?.size || (e.partial && Object.keys(e.partial).length)) {
          m.set(pn, { ...e, queued: false, busy: null, partial: null });
        }
      }
      return m;
    });
    setTransStatus({ running: false, label, progress: totalChars ? doneChars / totalChars : 1 });
  }

  // Imperative surface for the host's toolbar button + its menu.
  useEffect(() => {
    if (!translateCtlRef) return;
    translateCtlRef.current = {
      running: () => !!transJobRef.current,
      halt: haltTransJob,
      setShown: setTransShown,
      translatePage: () => runTransJob([curPageRef.current], `p.${curPageRef.current}`),
      translateDoc: () => {
        const key = translateKeyRef.current;
        const cur = curPageRef.current;
        const pages = [];
        for (let p = 1; p <= numPagesRef.current; p++) {
          const e = transMapRef.current.get(p);
          if (!(e && e.done && e.key === key)) pages.push(p);
        }
        // The page being read paints first, then outward by distance
        // (forward before backward at equal distance) — a whole-document job
        // never keeps the reader waiting on page 1.
        pages.sort((a, b) =>
          (Math.abs(a - cur) - Math.abs(b - cur))
          || ((a < cur ? 1 : 0) - (b < cur ? 1 : 0))
          || (a - b));
        runTransJob(pages, "document");
      },
    };
    return () => { translateCtlRef.current = null; };
  });

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
      if (e.target.closest?.(".pdfOutlinePanel") || e.target.closest?.(".pdfOutlineBox")) return;
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
        <div className="pdfCtlBox pdfOutlineBox">
          <button
            className={outlineOpen ? "modeActive" : ""}
            onClick={() => setOutlineOpen((o) => !o)}
            title={outlineOpen ? "Hide table of contents" : "Table of contents"}
            aria-label="Toggle table of contents"
            type="button"
          >
            <OutlineIcon size={15} />
          </button>
        </div>
      ) : null}
      {numPages > 0 || headerAction ? (
        // One top-right row: the host's own action (the iPad's native handoff
        // button) and the current-page widget share it, so on a narrow or
        // portrait viewport they wrap instead of overlapping.
        <div className="pdfTopRightControls">
          {headerAction}
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
      <div ref={viewerRef} className={"pdfViewer" + (areaCursor || areaMode ? " areaCursor" : "") + (areaMode ? " areaMode" : "") + (darkPage ? " pdfDark" : "") + (transPeek ? " transPeek" : "") + (inkTool ? " inkArmed" : "") + (inkTool && !inkPenOnly ? " inkTouchDraw" : "") + (inkTool?.tool === "select" ? " inkSelect" : "")}
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
          citation={displayedUrl === url && activeCitation?.page === i + 1 ? activeCitation : null}
          readOnly={!onSelectionFinished} forceRender={forcePages.has(i + 1) || activeCitation?.page === i + 1}
          hideEmbeddedAnnots={!!hideEmbeddedAnnots}
          areaMode={canAnnotate ? !!areaMode : false}
          onAreaSelected={canAnnotate ? onAreaSelected : undefined}
          pendingArea={selPopup?.kind === "area" && selPopup.pageNumber === i + 1 ? selPopup : null}
          reservedHeight={pageHeights[i] ? pageHeights[i] * scale : null}
          reservedWidth={pageWidths[i] ? pageWidths[i] * scale : null}
          findMarks={marksByPage.get(i + 1) || EMPTY_MARKS}
          trans={transMap.get(i + 1) || null}
          transKey={translateKey}
          transShown={transShown}
          onInternalLink={goToDestStable}
          onExternalLink={stableCbs.onExternalLink}
          onLinkContext={stableCbs.onLinkContext}
          onPainted={onPagePainted}
          inkBlocks={inkByPage.get(i + 1) || EMPTY_MARKS}
          inkTool={inkTool}
          inkPenTool={inkPenTool}
          inkPenOnly={inkPenOnly}
          inkPressure={inkPressure}
          inkEraserMode={inkEraserMode}
          inkEraserSize={inkEraserSize}
          inkLassoMode={inkLassoMode}
          inkSelection={inkSelection && inkSelection.page === i + 1 ? inkSelection : null}
          inkFlash={inkFlash && inkByPage.get(i + 1)?.some((b) => b.id === inkFlash.id) ? inkFlash : null}
          onInkStroke={onInkStroke ? stableCbs.onInkStroke : undefined}
          onInkErase={onInkErase ? stableCbs.onInkErase : undefined}
          onInkErasePartial={onInkErasePartial ? stableCbs.onInkErasePartial : undefined}
          onInkSelect={onInkSelect ? stableCbs.onInkSelect : undefined}
          onInkAction={onInkAction ? stableCbs.onInkAction : undefined}
          onInkMoveSelection={onInkMoveSelection ? stableCbs.onInkMoveSelection : undefined}
          onInkJump={onInkJump ? stableCbs.onInkJump : undefined}
          nativeInkBlocks={nativeInkByPage.get(i + 1) || EMPTY_MARKS}
          nativeInkPreviews={nativeInkPreviews}
          replay={replay}
          flashingInk={flashingInk}
          onReplaySeek={onReplaySeek}
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
// .pdfNoteTip's CSS max-width is min(NOTE_TIP_W, 100vw - 2·VIEWPORT_PAD) —
// keep these in sync with app.css.
const NOTE_TIP_W = 520;
const VIEWPORT_PAD = 8;
function NoteBadge({ hlId, text, style, onClick, onContextMenu }) {
  const [tip, setTip] = useState(null);
  const btnRef = useRef(null);
  const tipRef = useRef(null);
  const timerRef = useRef(0);
  // Whether the press that is being handled came from a finger/pen. Touch has
  // no hover, so a tap opens the tip instead of jumping to the note — the
  // notes panel it would jump to isn't even on screen in the phone layout.
  const touchRef = useRef(false);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.top < window.innerHeight * 0.45;
    // Clamp so the tip's max width fits: .pdfNoteTip caps at NOTE_TIP_W px
    // (app.css) plus VIEWPORT_PAD of breathing room on each side.
    setTip({
      left: Math.max(VIEWPORT_PAD, Math.min(r.left - 12, window.innerWidth - NOTE_TIP_W - 2 * VIEWPORT_PAD)),
      ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }),
    });
  };
  const show = () => {
    if (touchRef.current) return; // a tap fires compatibility mouse events too
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(place, 120);
  };
  // Hide on a short delay so the pointer can cross the gap into the tip;
  // entering the tip cancels it — the tip scrolls, so it must survive hover.
  const hide = () => { clearTimeout(timerRef.current); timerRef.current = setTimeout(() => setTip(null), 200); };
  const hideNow = () => { clearTimeout(timerRef.current); setTip(null); };
  const hold = () => clearTimeout(timerRef.current);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  // Tapped-open tip: no pointer leaves a touch screen, so it closes on the
  // next tap outside it (or on the badge again).
  useEffect(() => {
    if (!tip || !touchRef.current) return;
    const away = (e) => {
      if (tipRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      hideNow();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [tip]);
  return (
    <>
      <button ref={btnRef} type="button" className="pdfNoteBadge" data-hl-id={hlId} style={style}
        onPointerDown={(e) => { touchRef.current = e.pointerType !== "mouse"; }}
        onMouseEnter={show} onMouseLeave={hide}
        onClick={(e) => {
          if (touchRef.current) { e.stopPropagation(); clearTimeout(timerRef.current); if (tip) setTip(null); else place(); return; }
          hideNow(); onClick(e);
        }}
        onContextMenu={(e) => { hideNow(); onContextMenu(e); }}
      >
        <MessageSquareIcon size={10} strokeWidth={2.2} />
      </button>
      {tip ? createPortal(
        <div ref={tipRef} className="pdfNoteTip" style={tip} onMouseEnter={hold} onMouseLeave={hide}>
          {text ? <ChatMarkdown text={text} /> : "This highlight has a note"}
        </div>,
        document.body
      ) : null}
    </>
  );
}

// One translated paragraph. Two independent layers inside the block box:
// masks that cover EXACTLY the original text lines (per-line rects, so a
// figure the paragraph wraps around is never painted over), and the
// translated text with an inline background behind each rendered line
// (box-decoration-break: clone) — so text and mask stay readable even where
// the browser's line breaks don't coincide with the original's. The text is
// drawn at the original font size, shrunk in steps until it fits the box —
// the page layout never reflows. The measured shrink loop runs a handful of
// synchronous reflows per block; pages have tens of blocks, which is fine.
function TransPara({ box, lines, baseSize, text, streaming }) {
  const ref = useRef(null); // the text container (the fit-measured element)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let size = baseSize;
    el.style.fontSize = size + "px";
    let guard = 0;
    while (guard++ < 24 && size > 6
        && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
      size *= 0.93;
      el.style.fontSize = size + "px";
    }
  }, [text, baseSize, box.width, box.height]);
  return (
    <div className={"pdfTransPara" + (streaming ? " streaming" : " landed")}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      {lines.map((l, i) => (
        <div key={i} className="pdfTransMask" style={{ left: l.left, top: l.top, width: l.width, height: l.height }} />
      ))}
      <div ref={ref} className="pdfTransText" style={{ fontSize: baseSize }}>
        <span>{text}</span>
      </div>
    </div>
  );
}

// The working indicator over a paragraph whose translation has not arrived:
// its original lines stay readable under a faint accent wash — shimmering
// while the request is in flight, still while it is only queued.
function TransPending({ lines, busy }) {
  return (
    <div className={"pdfTransPending" + (busy ? " busy" : "")}>
      {lines.map((l, i) => (
        <div key={i} className="pdfTransPendingLine" style={{ left: l.left, top: l.top, width: l.width, height: l.height }} />
      ))}
    </div>
  );
}

const PdfPage = React.memo(function PdfPage({ citation, pageNumber, pdfDoc, scale, highlights, onJump, onHighlightJump, onLinkHighlight, onHighlightContext, readOnly, forceRender, reservedHeight, reservedWidth, findMarks, onInternalLink, onExternalLink, onLinkContext, onPainted, onAreaSelected, pendingArea, areaMode, hideEmbeddedAnnots, trans, transKey, transShown, inkBlocks = EMPTY_MARKS, inkTool, inkPenTool, inkPenOnly, inkPressure, inkEraserMode, inkEraserSize, inkLassoMode, inkSelection, inkFlash, onInkStroke, onInkErase, onInkErasePartial, onInkSelect, onInkAction, onInkMoveSelection, onInkJump, nativeInkBlocks = EMPTY_MARKS, nativeInkPreviews = null, replay = null, flashingInk = null, onReplaySeek }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const pageRef = useRef(null);
  const linksForRef = useRef(null); // page whose link annotations are already in `links`
  const [pageSize, setPageSize] = useState(null);
  const [textReady, setTextReady] = useState(null);
  const [visible, setVisible] = useState(false);
  const renderVisible = visible || forceRender;
  const [links, setLinks] = useState([]); // link annotations, rects at scale 1
  // Translation entry for this page (from the viewer's engine) — display
  // only; the queue and all fetching live in PdfViewer.
  const transEntry = trans && trans.key === transKey ? trans : null;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      setVisible(entries[0].isIntersecting);
    }, { root: el.closest(".pdfViewer"), rootMargin: "900px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageNumber]);

  useEffect(() => {
    const canvas = canvasRef.current;
    return () => { canvas.width = 0; canvas.height = 0; };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdfDoc || !renderVisible) {
      // Keep page geometry/text/overlays, but release distant raster backing
      // stores. Otherwise a long reading session retains every visited page.
      canvas.width = 0; canvas.height = 0;
      return;
    }
    let cancelled = false;
    let task = null;
    let textTask = null;
    setTextReady(null);
    // Render privately: resizing the visible canvas clears its paper and
    // exposes incomplete paints during rapid zoom changes.
    const nextCanvas = document.createElement("canvas");
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

        // Supersample normal zooms, but cap area AND dimensions on all devices
        // (including iPads that identify as Macs). CSS geometry stays exact.
        const size = canvasSize(vp.width, vp.height, Math.min(3, Math.max(2, window.devicePixelRatio || 1)));
        nextCanvas.width = size.width; nextCanvas.height = size.height;
        const ctx = nextCanvas.getContext("2d");
        if (!ctx) throw new Error("PDF canvas allocation failed");
        ctx.setTransform(size.width / vp.width, 0, 0, size.height / vp.height, 0, 0);
        // DISABLE keeps embedded markup annotations (e.g. highlights burned in
        // by a Gamma export, or SumatraPDF/Acrobat ones) out of the canvas so
        // they don't stack under Gamma's own overlay after an import. Link
        // regions are unaffected — they're DOM overlays from getAnnotations().
        task = page.render({
          canvasContext: ctx, viewport: vp,
          annotationMode: hideEmbeddedAnnots ? pdfjsLib.AnnotationMode.DISABLE : pdfjsLib.AnnotationMode.ENABLE,
        });
        try {
          await task.promise;
        } catch (err) {
          // instanceof, not err.name — minification renames the class
          if (err instanceof pdfjsLib.RenderingCancelledException) return;
          throw err;
        }
        if (cancelled) return;
        canvas.width = 0; canvas.height = size.height; canvas.width = size.width;
        canvas.getContext("2d").drawImage(nextCanvas, 0, 0);
        nextCanvas.width = 0; nextCanvas.height = 0;
        onPainted?.();

        const textL = textRef.current;
        textL.innerHTML = "";
        textL.style.width = vpBase.width + "px";
        textL.style.height = vpBase.height + "px";
        textL.style.transform = `scale(${scale})`;
        const tc = await page.getTextContent();
        if (cancelled) return;
        textTask = new pdfjsLib.TextLayer({ textContentSource: tc, container: textL, viewport: vp });
        await textTask.render();
        if (cancelled) return;
        setTextReady({ scale, pdfDoc, runs: citationRuns(tc.items, textTask.textDivs) });

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
      } finally {
        nextCanvas.width = 0; nextCanvas.height = 0;
      }
    })();
    return () => { cancelled = true; task?.cancel(); textTask?.cancel(); };
  }, [pdfDoc, pageNumber, scale, renderVisible, hideEmbeddedAnnots]);

  // The box the page occupies: pdf.js's measure once it has rendered, else
  // the reserved size from the manifest skeleton (exact too), else nothing
  // yet. Overlays scale into it, so highlights and ink are placed right on a
  // skeleton page as well.
  const curW = pageSize ? pageSize.width * scale : (reservedWidth || 1);
  const curH = pageSize ? pageSize.height * scale : (reservedHeight || 1);
  const baseW = pageSize ? pageSize.width : (reservedWidth ? reservedWidth / scale : undefined);
  const baseH = pageSize ? pageSize.height : (reservedHeight ? reservedHeight / scale : undefined);

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

  // Whether translated text is on screen: gates the overlay and flips the
  // wrap class that makes the translation selectable instead of the
  // (invisible) original.
  const transPartials = transEntry?.partial && Object.keys(transEntry.partial).length > 0;
  const transActive = transShown && !!transEntry && (transEntry.texts.some(Boolean) || !!transPartials);
  // Translation still arriving for this page: the overlay also renders the
  // working indicators (and streamed partial text), even before any final
  // text exists.
  const transWorking = transShown && !!transEntry && !transEntry.done
    && (transEntry.queued || transEntry.busy?.size > 0);

  return (
    <div ref={wrapRef} data-page={pageNumber} className={"pdfPageWrap" + (transActive ? " transShown" : "")}
      onPointerDown={beginAreaDrag}
      style={{
        margin: `0 auto ${PAGE_GAP}px`, position: "relative", background: "#fff",
        width: pageSize || reservedWidth ? curW : undefined,
        height: pageSize || reservedHeight ? curH : undefined,
        minHeight: pageSize || reservedHeight ? undefined : 200,
      }}>
      {/* 100% of the wrapper: on a zoom change the old bitmap stretches to the
          new size immediately (blurry for a moment) instead of sitting at its
          old size in a resized box until the sharp re-render lands. */}
      <canvas ref={canvasRef} className="pdfPageCanvas" style={{ display: "block", width: "100%", height: "100%" }} />
      {/* Translated view: masks + refills sit between the canvas and the text
          layer, so selecting the (invisible) original text still paints its
          selection highlight on top of the overlay. pointer-events: none —
          highlighting, links and search always act on the original. */}
      {transActive || transWorking ? (
        <div className="pdfTransLayer">
          {(() => {
            let ti = -1;
            return transEntry.paras.map((p, i) => {
              if (!p.translate) return null;
              ti += 1;
              const final = transEntry.texts[ti];
              const partial = final ? null : transEntry.partial?.[ti];
              const text = final || partial;
              const pad = 1.5;
              const lns = p.lines || [];
              const box = {
                left: p.x1 * scale - pad, top: p.y1 * scale - pad,
                width: (p.x2 - p.x1) * scale + 2 * pad, height: (p.y2 - p.y1) * scale + 2 * pad,
              };
              const lines = lns.map((l, j) => {
                // Fill the inter-line leading too: the original's line
                // pitch exceeds the glyph-box height, and slivers of the
                // original text otherwise peek through between masks.
                const next = lns[j + 1];
                const bottom = next && next.y1 - l.y2 < p.size * 1.2 ? next.y1 : l.y2;
                return {
                  left: (l.x1 - p.x1) * scale, top: (l.y1 - p.y1) * scale,
                  width: (l.x2 - l.x1) * scale + 2 * pad,
                  height: (bottom - l.y1) * scale + 2 * pad,
                };
              });
              if (!text || text === p.text) {
                // Nothing to show yet: the original stays visible, washed
                // while its translation is queued or in flight.
                if (!final && transWorking && (transEntry.busy?.has(ti) || transEntry.queued)) {
                  return (
                    <div key={i} className="pdfTransPara" style={box}>
                      <TransPending lines={lines} busy={transEntry.busy?.has(ti)} />
                    </div>
                  );
                }
                return null;
              }
              return (
                <TransPara key={i} box={box} lines={lines}
                  baseSize={p.size * scale} text={text} streaming={!final} />
              );
            });
          })()}
        </div>
      ) : null}
      <div ref={textRef} className="textLayer" style={{
        userSelect: readOnly || inkTool ? "none" : "text", WebkitUserSelect: readOnly || inkTool ? "none" : "text",
      }} />
      <PdfCitationOverlay citation={citation} wrapRef={wrapRef}
        ready={textReady?.scale === scale && textReady?.pdfDoc === pdfDoc ? textReady : null} />
      {inkBlocks.length || onInkStroke ? (
        <InkLayer pageNumber={pageNumber} wrapRef={wrapRef}
          width={baseW} height={baseH}
          blocks={inkBlocks} tool={onInkStroke ? inkTool : null} penTool={onInkStroke ? inkPenTool : null}
          penOnly={inkPenOnly} pressure={inkPressure} eraserMode={inkEraserMode} eraserSize={inkEraserSize} lassoMode={inkLassoMode} selection={inkSelection} flash={inkFlash}
          onStroke={onInkStroke} onErase={onInkErase} onErasePartial={onInkErasePartial}
          onSelect={onInkSelect} onAction={onInkAction} onMoveSelection={onInkMoveSelection} onJump={onInkJump} />
      ) : null}
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
          onContextMenu={l.url ? (e) => {
            e.preventDefault();
            e.stopPropagation();
            onLinkContext?.(l.url);
          } : undefined}
        />
      ))}
      {(findMarks || []).map((m, i) => (
        <div
          key={`find-${i}`}
          className="pdfFindMark"
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
      {/* Native handwriting (native/ReplayInkLayer.jsx). With a loaded
          per-stroke derivative the layer draws the strokes themselves — full
          PNGs for finished ones, a progressive mask for the one in progress,
          nothing for future ones; during Replay `replay` is set and a click on
          a timed stroke seeks the audio. Without one, the block's whole-block
          preview PNG is placed through the same affine transform. */}
      {pageSize && nativeInkBlocks.map((block) => {
        const viewport = pageRef.current?.getViewport({ scale });
        const manifest = (replay?.assets ?? nativeInkPreviews)?.[block.id]?.data;
        if (manifest) {
          return <ReplayInkLayer key={block.id} block={block} data={manifest} viewport={viewport}
            replay={replay} onSeek={onReplaySeek} />;
        }
        const ink = pdfInkPlacement(block, viewport);
        if (!ink) return null;
        return (
          <img key={block.id} src={assetUrl(ink.url)} alt="" aria-hidden="true"
            data-ink-block-id={block.id} draggable={false}
            style={{
              position: "absolute", left: 0, top: 0, width: ink.width, height: ink.height,
              maxWidth: "none", transformOrigin: "0 0", transform: `matrix(${ink.matrix.join(",")})`,
              pointerEvents: "none", userSelect: "none", zIndex: 3,
            }} />
        );
      })}
      {pageSize && nativeInkBlocks.filter((block) => block.id === flashingInk?.id).map((block) => {
        const ink = pdfInkPlacement(block, pageRef.current?.getViewport({ scale }));
        return ink ? (
          <div key={`${block.id}-${flashingInk.nonce}`} className="inkJumpFlash" data-ink-jump-target={block.id}
            style={{
              position: "absolute", left: 0, top: 0, width: ink.width, height: ink.height,
              transformOrigin: "0 0", transform: `matrix(${ink.matrix.join(",")})`,
              pointerEvents: "none", zIndex: 5,
            }} />
        ) : null;
      })}
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
        if (h.hasNote && rects.length) {
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

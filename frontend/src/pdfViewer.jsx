// The pdf.js-based viewer: lazy page rendering, highlights, link
// annotations, text search, and the selection popup. Extracted from
// App.jsx to keep the God component shrinking.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
// Pre-warm the pdfjs worker so it downloads in parallel with later PDF fetches
pdfjsLib.getDocument({ data: new Uint8Array() }).promise.catch(() => {});

// Highlight palette (shared with the highlight context menu in App)
const COLORS = [
  "rgba(255, 226, 143, 0.65)",
  "rgba(170, 235, 170, 0.65)",
  "rgba(155, 205, 255, 0.65)",
  "rgba(230, 180, 255, 0.65)"
];

const EMPTY_MARKS = [];

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

function PdfViewer({ url, highlights, pdfScaleValue, scrollRef, onJump, onHighlightJump, onLinkHighlight, onSelectionFinished, onHighlightContext, searchRef, onEffectiveScale, findMarks, onExternalLink, onBeforeLinkJump, onLoadState }) {
  const viewerRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [docSeq, setDocSeq] = useState(0); // bumped per document — keys the page tree so swaps are atomic
  const [forcePages, setForcePages] = useState(new Set());
  const pageHeightsRef = useRef([]); // viewport heights at scale 1, indexed 0..n-1

  // Stable callback identities so memoized pages don't re-render every time a
  // parent state change recreates the handler closures. The wrappers always
  // dispatch to the latest handlers via the ref.
  const cbRef = useRef({});
  cbRef.current = { onJump, onHighlightJump, onLinkHighlight, onHighlightContext, onExternalLink };
  const stableCbs = useMemo(() => ({
    onJump: (...a) => cbRef.current.onJump?.(...a),
    onHighlightJump: (...a) => cbRef.current.onHighlightJump?.(...a),
    onLinkHighlight: (...a) => cbRef.current.onLinkHighlight?.(...a),
    onHighlightContext: (...a) => cbRef.current.onHighlightContext?.(...a),
    onExternalLink: (...a) => cbRef.current.onExternalLink?.(...a),
  }), []);

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

  // Expose full-text search over the loaded document (used by the search
  // panel). Matches carry the text item's rect (at scale 1) so they can be
  // highlighted on the page and jumped to.
  useEffect(() => {
    if (!searchRef) return;
    searchRef.current = pdfDoc ? async (re) => {
      const out = [];
      for (let p = 1; p <= pdfDoc.numPages && out.length < 200; p++) {
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        for (const it of tc.items) {
          if (out.length >= 200) break;
          const str = it.str || "";
          if (!str) continue;
          const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
          let m;
          while ((m = rx.exec(str)) && out.length < 200) {
            if (!m[0]) { rx.lastIndex++; continue; }
            const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
            const fh = Math.hypot(tx[2], tx[3]) || 10;
            // Highlight only the matched keyword: slice the run's rect
            // proportionally by character position (runs are single-line).
            const w = it.width || fh;
            const x1 = tx[4] + w * (m.index / str.length);
            const x2 = tx[4] + w * ((m.index + m[0].length) / str.length);
            const ctxStart = Math.max(0, m.index - 40);
            out.push({
              page: p,
              snippet: str.slice(ctxStart, m.index + m[0].length + 60).trim().slice(0, 140),
              rect: { x1, y1: tx[5] - fh, x2: Math.max(x1 + 2, x2), y2: tx[5] + fh * 0.25 },
              pageW: vp.width,
              pageH: vp.height,
            });
          }
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
  useEffect(() => { onEffectiveScale?.(scale); }, [scale, onEffectiveScale]);
  useEffect(() => {
    if (!isFitWidth || !pdfDoc || !viewerRef.current) return;
    let cancelled = false;
    const compute = async () => {
      try {
        const page = await pdfDoc.getPage(1);
        if (cancelled || !viewerRef.current) return;
        const naturalW = page.getViewport({ scale: 1 }).width;
        const containerW = viewerRef.current.clientWidth;
        if (naturalW > 0 && containerW > 0) {
          setFitWidthScale(Math.max(0.2, containerW / naturalW));
        }
      } catch {}
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(viewerRef.current);
    return () => { cancelled = true; ro.disconnect(); };
  }, [isFitWidth, pdfDoc]);

  // Tell the host which document's pages are in the DOM. Layout effect on
  // purpose: it fires after the swap commit but BEFORE paint, so the host can
  // apply a restored scroll position and the user never sees the document at
  // the wrong offset.
  useLayoutEffect(() => {
    if (pdfDoc) onLoadState?.(url, { phase: "rendered" });
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
        let data = PDF_CACHE.get(url);
        if (!data) {
        onLoadState?.(url, { phase: "start" });
        // Parallel range requests overlap with worker download.
        // Each range is its own HTTP/2 stream so flow-control doesn't single-stream-cap us.
        // Probe size via a 1-byte range request (backend doesn't allow HEAD).
        const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, credentials: "include" });
        if (cancelled) return;
        if (!probe.ok) { onLoadState?.(url, { phase: "error" }); return; }
        await probe.arrayBuffer();
        const cr = probe.headers.get("content-range") || "";
        const m = cr.match(/\/(\d+)$/);
        const total = m ? parseInt(m[1], 10) : 0;
        if (total > 0) {
          const N = 6;
          const chunkSize = Math.ceil(total / N);
          const parts = await Promise.all(Array.from({ length: N }, (_, i) => {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize - 1, total - 1);
            return fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: "include" })
              .then(r => r.arrayBuffer());
          }));
          if (cancelled) return;
          const buf = new Uint8Array(total);
          let off = 0;
          for (const p of parts) { buf.set(new Uint8Array(p), off); off += p.byteLength; }
          data = buf.buffer;
        } else {
          const resp = await fetch(url, { credentials: "include" });
          if (cancelled) return;
          if (!resp.ok) { onLoadState?.(url, { phase: "error" }); return; }
          data = await resp.arrayBuffer();
          if (cancelled) return;
        }
        onLoadState?.(url, { phase: "done", bytes: data.byteLength });
        } else {
          // Settles a task row registered before the load (URL-box opens);
          // ordinary cache hits have no row and ignore this.
          onLoadState?.(url, { phase: "cached" });
        }
        cachePdf(url, data); // insert or bump LRU position
        const doc = await pdfjsLib.getDocument({ data: data.slice(0), disableAutoFetch: true, disableRange: true }).promise;
        if (cancelled) { doc.destroy().catch(() => {}); return; }
        // Measure pages BEFORE showing the document: exact viewports for the
        // first pages, page-1-sized estimates beyond (refined below). The
        // swap then lands in ONE commit — heights, page tree, and document
        // together — so the scrollbar changes exactly once.
        const n = doc.numPages;
        const EXACT = 40;
        const heights = [];
        for (let i = 1; i <= Math.min(n, EXACT); i++) {
          try { heights.push((await doc.getPage(i)).getViewport({ scale: 1 }).height); }
          catch { heights.push(heights[0] || 800); }
          if (cancelled) { doc.destroy().catch(() => {}); return; }
        }
        for (let i = heights.length; i < n; i++) heights.push(heights[0] || 800);
        const prev = displayedDocRef.current;
        displayedDocRef.current = doc;
        pageHeightsRef.current = heights;
        setPageHeights(heights);
        setNumPages(n);
        setDocSeq((s) => s + 1);
        setPdfDoc(doc);
        // Old doc torn down after the swap commit — destroying it while its
        // pages are still mounted spams transport-destroyed rejections.
        if (prev && prev !== doc) setTimeout(() => prev.destroy().catch(() => {}), 1000);
        // Refine the estimated heights in the background (long docs only).
        for (let i = EXACT; i < n; i++) {
          if (cancelled) return;
          try { heights[i] = (await doc.getPage(i + 1)).getViewport({ scale: 1 }).height; } catch {}
          if ((i + 1) % 50 === 0 || i === n - 1) {
            pageHeightsRef.current = [...heights];
            setPageHeights([...heights]);
          }
        }
      } catch {
        if (!cancelled) onLoadState?.(url, { phase: "error" });
      }
    })();
    return () => {
      cancelled = true;
      // No-op if the download already finished; otherwise clears the
      // now-orphaned "downloading…" task entry.
      onLoadState?.(url, { phase: "cancelled" });
    };
  }, [url]);

  // Preserve scroll position across zoom changes by anchoring on the page
  // currently at the top of the viewport (and how far down within it),
  // then re-placing that exact page+offset after pages re-render at the
  // new size. Pure-fraction preservation drifts because of the fixed 8px
  // inter-page margins; page anchoring is exact.
  const prevScaleRef = useRef(scale);
  useEffect(() => {
    const prev = prevScaleRef.current;
    prevScaleRef.current = scale;
    if (prev === scale || !viewerRef.current) return;
    const v = viewerRef.current;
    const heights = pageHeightsRef.current;
    if (heights.length === 0) return;

    // Find the page covering the current scrollTop using the OLD scale.
    let acc = 0, anchorIdx = 0, fracInPage = 0;
    for (let i = 0; i < heights.length; i++) {
      const ph = (heights[i] || 800) * prev;
      if (acc + ph + 8 > v.scrollTop) {
        anchorIdx = i;
        fracInPage = (v.scrollTop - acc) / Math.max(1, ph);
        break;
      }
      acc += ph + 8;
    }

    // After re-render, place the same page+offset at the top.
    let tries = 0;
    let lastSH = -1;
    const restore = () => {
      if (!viewerRef.current) return;
      const v2 = viewerRef.current;
      if (v2.scrollHeight !== lastSH) {
        lastSH = v2.scrollHeight;
        let newAcc = 0;
        for (let i = 0; i < anchorIdx; i++) {
          newAcc += (heights[i] || 800) * scale + 8;
        }
        const targetH = (heights[anchorIdx] || 800) * scale;
        v2.scrollTop = newAcc + fracInPage * targetH;
      }
      if (tries++ < 30) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
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
          heights[i] = 800;
        }
      }

      // Compute page-top from cached heights (accurate even for unrendered pages)
      let pageTop = 8 * (pn - 1); // 8px margin per page
      for (let i = 0; i < pn - 1; i++) {
        pageTop += (heights[i] || 800) * scale;
      }
      const curH = (heights[pn - 1] || 800) * scale;
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

  // Text selection for highlight creation
  const [selPopup, setSelPopup] = useState(null);

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
      setTimeout(() => {
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
      }, 10);
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
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
    <div ref={viewerRef} className="pdfViewer" style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      {Array.from({ length: numPages }, (_, i) => (
        <PdfPage key={`${docSeq}-${i + 1}`} pageNumber={i + 1} pdfDoc={pdfDoc} scale={scale}
          highlights={highlights} onJump={stableCbs.onJump} onHighlightJump={stableCbs.onHighlightJump}
          onLinkHighlight={stableCbs.onLinkHighlight} onHighlightContext={stableCbs.onHighlightContext}
          readOnly={!onSelectionFinished} forceRender={forcePages.has(i + 1)}
          reservedHeight={pageHeights[i] ? pageHeights[i] * scale : null}
          findMarks={marksByPage.get(i + 1) || EMPTY_MARKS}
          onInternalLink={goToDestStable}
          onExternalLink={stableCbs.onExternalLink}
        />
      ))}
      {selPopup && onSelectionFinished && (
        <div style={{ position: "fixed", top: selPopup.rect.bottom + 8, left: selPopup.rect.left, zIndex: 9999 }}>
          <PlainTip onConfirm={handleSelConfirm} onLink={() => handleSelConfirm("", null, { link: true })} />
        </div>
      )}
    </div>
  );
}

const PdfPage = React.memo(function PdfPage({ pageNumber, pdfDoc, scale, highlights, onJump, onHighlightJump, onLinkHighlight, onHighlightContext, readOnly, forceRender, reservedHeight, findMarks, onInternalLink, onExternalLink }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const pageRef = useRef(null);
  const renderTaskRef = useRef(null);
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
        setPageSize({ width: vp.width, height: vp.height });

        const canvas = canvasRef.current;
        // Cap the backing resolution: 3-4× DPR screens quadruple the pixel
        // work for no visible gain at reading sizes.
        const pr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = vp.width * pr; canvas.height = vp.height * pr;
        canvas.style.width = vp.width + "px"; canvas.style.height = vp.height + "px";
        const ctx = canvas.getContext("2d"); ctx.scale(pr, pr);
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

        const textL = textRef.current;
        textL.innerHTML = "";
        const baseVp = page.getViewport({ scale: 1 });
        textL.style.width = baseVp.width + "px";
        textL.style.height = baseVp.height + "px";
        textL.style.transform = `scale(${scale})`;
        const tc = await page.getTextContent();
        pdfjsLib.renderTextLayer({ textContentSource: tc, container: textL, viewport: vp });

        // Link annotations (in-PDF references + external URLs), stored at scale 1.
        const annots = await page.getAnnotations();
        if (cancelled) return;
        const vp1 = page.getViewport({ scale: 1 });
        setLinks(annots
          .filter((a) => a.subtype === "Link" && (a.url || a.dest))
          .map((a) => {
            const r = vp1.convertToViewportRectangle(a.rect);
            return {
              left: Math.min(r[0], r[2]), top: Math.min(r[1], r[3]),
              w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]),
              url: a.url || null, dest: a.dest || null,
            };
          }));
      } catch (e) {
        // A cancelled run rejects mid-await (doc swapped, transport
        // destroyed) — that's teardown, not an error worth logging.
        if (!cancelled) console.error("PdfPage render error:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNumber, scale, visible]);

  const curW = pageSize?.width || 1, curH = pageSize?.height || 1;

  return (
    <div ref={wrapRef} data-page={pageNumber} className="pdfPageWrap"
      style={{
        margin: "0 auto 8px", position: "relative", background: "#fff",
        width: pageSize ? curW : undefined,
        height: pageSize ? curH : (reservedHeight || undefined),
        minHeight: pageSize || reservedHeight ? undefined : 200,
      }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
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
      {highlights.filter(h => {
        const p = h.position?.boundingRect || h.position?.rects?.[0];
        return p && p.pageNumber === pageNumber;
      }).map(h => {
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
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default PdfViewer;
export { COLORS };

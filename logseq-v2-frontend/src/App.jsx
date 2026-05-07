import React, { useEffect, useMemo, useRef, useState } from "react";

// Module-level ref for native HTML5 drag-and-drop (shared across components)
const _dragState = { draggingId: null, dropTarget: null };

import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
// Pre-warm the pdfjs worker so it downloads in parallel with later PDF fetches
pdfjsLib.getDocument({ data: new Uint8Array() }).promise.catch(() => {});
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import {
  blocksToPageMarkdown,
  setBlockText,
  setBlockEditMode,
  addSiblingBlock,
  addChildBlock,
  indentBlock,
  outdentBlock,
  toggleCollapsed,
  expandToBlock,
  updateBlockTree,
  removeBlockTree,
  flattenBlocks,
  withLegacyAccessors,
  isDescendant,
  findBlockContext,
  extractBlock,
  insertSibling,
  insertChild,
  addHighlightAsBlock,
  blocksToHighlights,
  normalizeBlocks
} from "./logseqPdfModel";
import { loadSession, saveSession, clearSession } from "./sessionState";

const API = "/api";

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getDocIdForUrl(sourceUrl) {
  return (await sha256(sourceUrl)).slice(0, 24);
}

function oldRectToNewRect(r, pageNumber) {
  const x1 = r.leftPct;
  const y1 = r.topPct;
  const width = r.widthPct;
  const height = r.heightPct;
  return {
    x1,
    y1,
    x2: x1 + width,
    y2: y1 + height,
    width,
    height,
    pageNumber
  };
}

function convertOldAnnotation(a) {
  if (a && a.position && a.position.pageNumber) return a;

  const pageNumber = a.pageNumber;
  const rects = Array.isArray(a.rects) ? a.rects.map((r) => oldRectToNewRect(r, pageNumber)) : [];

  if (!pageNumber || rects.length === 0) {
    return {
      id: a.id || makeId(),
      content: { text: a.quote || "" },
      position: {
        pageNumber: 1,
        boundingRect: { x1: 0, y1: 0, x2: 0, y2: 0, width: 0, height: 0, pageNumber: 1 },
        rects: []
      },
      comment: { text: a.note || "", emoji: "🟡" },
      color: a.color || "rgba(255, 226, 143, 0.65)"
    };
  }

  const boundingRect = {
    x1: Math.min(...rects.map((r) => r.x1)),
    y1: Math.min(...rects.map((r) => r.y1)),
    x2: Math.max(...rects.map((r) => r.x2)),
    y2: Math.max(...rects.map((r) => r.y2)),
    pageNumber
  };
  boundingRect.width = boundingRect.x2 - boundingRect.x1;
  boundingRect.height = boundingRect.y2 - boundingRect.y1;

  return {
    id: a.id || makeId(),
    content: { text: a.quote || "" },
    position: {
      pageNumber,
      boundingRect,
      rects
    },
    comment: { text: a.note || "", emoji: "🟡" },
    color: a.color || "rgba(255, 226, 143, 0.65)"
  };
}

function parseStored(payload) {
  if (!payload || !payload.data) return { version: 1, annotations: [] };
  try {
    const obj = JSON.parse(payload.data);
    const raw = Array.isArray(obj.annotations) ? obj.annotations : [];
    return {
      version: 1,
      annotations: raw.map(convertOldAnnotation)
    };
  } catch {
    return { version: 1, annotations: [] };
  }
}

async function apiJson(url, options = {}) {
  const r = await fetch(url, { ...options, credentials: "include" });
  if (r.status === 401) {
    const isShareView = new URLSearchParams(window.location.search).get("share");
    if (!isShareView) {
      window.dispatchEvent(new CustomEvent("gamma-auth-expired"));
    }
    throw new Error("401 Unauthorized");
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${text}`);
  }
  return r.json();
}

async function resolvePdfUrl(rawUrl) {
  const data = await apiJson(`${API}/resolve-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url: rawUrl })
  });
  return data.source_url;
}

const COLORS = [
  "rgba(255, 226, 143, 0.65)",
  "rgba(170, 235, 170, 0.65)",
  "rgba(155, 205, 255, 0.65)",
  "rgba(230, 180, 255, 0.65)"
];

function PdfViewer({ url, highlights, pdfScaleValue, scrollRef, onJump, onHighlightJump, onSelectionFinished, onHighlightContext }) {
  const viewerRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [forcePages, setForcePages] = useState(new Set());
  const pageHeightsRef = useRef([]); // viewport heights at scale 1, indexed 0..n-1
  // Resolve scale: numeric value as-is, "page-width" computes a scale that
  // fits the first page to the viewer width. Recomputed on viewer resize so
  // it adapts to sidebar drags / phone rotation.
  const [fitWidthScale, setFitWidthScale] = useState(1);
  const numericScale = parseFloat(pdfScaleValue);
  const isFitWidth = isNaN(numericScale);
  const scale = isFitWidth ? fitWidthScale : numericScale;
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

  useEffect(() => {
    if (!url) return;
    let cancelled = false; setPdfDoc(null);
    (async () => {
      // Parallel range requests overlap with worker download.
      // Each range is its own HTTP/2 stream so flow-control doesn't single-stream-cap us.
      // Probe size via a 1-byte range request (backend doesn't allow HEAD).
      const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, credentials: "include" });
      if (cancelled || !probe.ok) return;
      await probe.arrayBuffer();
      const cr = probe.headers.get("content-range") || "";
      const m = cr.match(/\/(\d+)$/);
      const total = m ? parseInt(m[1], 10) : 0;
      let data;
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
        if (cancelled || !resp.ok) return;
        data = await resp.arrayBuffer();
        if (cancelled) return;
      }
      pdfjsLib.getDocument({ data, disableAutoFetch: true, disableRange: true }).promise.then(doc => {
        if (!cancelled) { setPdfDoc(doc); setNumPages(doc.numPages); }
      }).catch(() => {});
    })();
    return () => { cancelled = true; };
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
  const [pageHeights, setPageHeights] = useState([]);
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    pageHeightsRef.current = [];
    (async () => {
      const acc = [];
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        if (cancelled) break;
        try {
          const page = await pdfDoc.getPage(i);
          acc.push(page.getViewport({ scale: 1 }).height);
        } catch (e) {
          acc.push(800);
        }
        // Publish in batches so the first pages reserve their space ASAP
        // without forcing one re-render per page.
        if (acc.length === 5 || acc.length === pdfDoc.numPages || acc.length % 50 === 0) {
          if (cancelled) break;
          pageHeightsRef.current = [...acc];
          setPageHeights([...acc]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc]);

  // Scroll to exact highlight position
  useEffect(() => {
    if (scrollRef) scrollRef.current = async ({ position }) => {
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
      viewerRef.current.scrollTo({ top: pageTop + highlightY - 80, behavior: "smooth" });

      // Force-render target page if not yet visible
      const pageEl = viewerRef.current.querySelector(`[data-page="${pn}"]`);
      if (!pageEl || !pageEl.style.width) {
        setForcePages(prev => new Set([...prev, pn]));
        setTimeout(() => setForcePages(prev => { const s = new Set(prev); s.delete(pn); return s; }), 2000);
      }
    };
  }, [scrollRef, scale, pdfDoc]);

  // Text selection for highlight creation
  const [selPopup, setSelPopup] = useState(null);
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

  function handleSelConfirm(commentText, color) {
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
    onSelectionFinished(position, content, () => { window.getSelection()?.removeAllRanges(); setSelPopup(null); }, { color, commentText });
  }

  return (
    <div ref={viewerRef} className="pdfViewer" style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      {Array.from({ length: numPages }, (_, i) => (
        <PdfPage key={i + 1} pageNumber={i + 1} pdfDoc={pdfDoc} scale={scale}
          highlights={highlights} onJump={onJump} onHighlightJump={onHighlightJump} onHighlightContext={onHighlightContext}
          readOnly={!onSelectionFinished} forceRender={forcePages.has(i + 1)}
          reservedHeight={pageHeights[i] ? pageHeights[i] * scale : null}
        />
      ))}
      {selPopup && onSelectionFinished && (
        <div style={{ position: "fixed", top: selPopup.rect.bottom + 8, left: selPopup.rect.left, zIndex: 9999 }}>
          <PlainTip onConfirm={handleSelConfirm}
            onCancel={() => { window.getSelection()?.removeAllRanges(); setSelPopup(null); }} />
        </div>
      )}
    </div>
  );
}

function PdfPage({ pageNumber, pdfDoc, scale, highlights, onJump, onHighlightJump, onHighlightContext, readOnly, forceRender, reservedHeight }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const pageRef = useRef(null);
  const [pageSize, setPageSize] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (forceRender) { setVisible(true); return; }
    const el = wrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: "400px 0px" });
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
        const pr = window.devicePixelRatio || 1;
        canvas.width = vp.width * pr; canvas.height = vp.height * pr;
        canvas.style.width = vp.width + "px"; canvas.style.height = vp.height + "px";
        const ctx = canvas.getContext("2d"); ctx.scale(pr, pr);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        const textL = textRef.current;
        textL.innerHTML = "";
        const baseVp = page.getViewport({ scale: 1 });
        textL.style.width = baseVp.width + "px";
        textL.style.height = baseVp.height + "px";
        textL.style.transform = `scale(${scale})`;
        const tc = await page.getTextContent();
        pdfjsLib.renderTextLayer({ textContentSource: tc, container: textL, viewport: vp });
      } catch (e) {
        console.error("PdfPage render error:", e);
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
      {highlights.filter(h => {
        const p = h.position?.boundingRect || h.position?.rects?.[0];
        return p && p.pageNumber === pageNumber;
      }).map(h => {
        const rects = h.position?.rects || (h.position?.boundingRect ? [h.position.boundingRect] : []);
        const storedW = h.position?.boundingRect?.width || rects[0]?.width || 1;
        const storedH = h.position?.boundingRect?.height || rects[0]?.height || 1;
        const elements = [];
        for (const r of rects) {
          elements.push(<div key={h.id + "-" + r.x1 + "-" + r.y1} style={{
            position: "absolute", zIndex: 2, cursor: "pointer",
            left: r.x1 * curW / storedW, top: r.y1 * curH / storedH,
            width: Math.max(1, (r.x2 - r.x1) * curW / storedW),
            height: Math.max(1, (r.y2 - r.y1) * curH / storedH),
            background: h.color || "rgba(255,226,143,0.65)", mixBlendMode: "multiply",
          }} title={h.comment?.text || ""}
            onClick={function (e) { e.stopPropagation(); onHighlightJump?.(h.id); }}
            onContextMenu={function (e) { e.preventDefault(); if (onHighlightContext) onHighlightContext({ id: h.id, x: e.clientX, y: e.clientY }); }}
          />);
        }
        return elements;
      })}
    </div>
  );
}

function PlainTip({ onConfirm, onCancel }) {
  const [text, setText] = useState("");
  const [color, setColor] = useState(COLORS[0]);

  // Live-preview the selection color while picking, before save.
  useEffect(() => {
    document.documentElement.style.setProperty("--selection-color", color);
    return () => document.documentElement.style.removeProperty("--selection-color");
  }, [color]);

  return (
    <div className="plainTip">
      <div className="colorRow">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`colorBtn ${color === c ? "selected" : ""}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
            type="button"
          />
        ))}
      </div>
      <textarea
        className="plainTipInput"
        placeholder="Note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="plainTipActions">
        <button onClick={() => onConfirm(text, color)}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const AutoGrowTextarea = React.forwardRef(function AutoGrowTextarea(props, forwardedRef) {
  const innerRef = useRef(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);

  return (
    <textarea
      {...props}
      ref={(el) => {
        innerRef.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
    />
  );
});

function BlockRow({
  block,
  depth,
  focusedId,
  setFocusedId,
  onJump,
  onEnterAttachMode,
  onUnlinkHighlight,
  onPageOpen,
  onChangeText,
  onEnterSibling,
  onAddChild,
  onIndent,
  onOutdent,
  onToggle,
  onDelete,
  onStartEdit,
  registerRef,
  readOnly,
  allBlocks,
  onBlockRefClick,
  refCache,
  onFetchRefs,
  onCacheRef,
  highlightColors,
  homeMode,
  onBlockDragOver,
  onBlockDragLeave,
  onBlockDrop,
}) {
  const ref = useRef(null);
  const clickPosRef = useRef(null);
  const [refPopup, setRefPopup] = useState(null); // { query, rect }
  const [refSelectedIdx, setRefSelectedIdx] = useState(0);
  const [searchResults, setSearchResults] = useState([]);
  const [imageDragOver, setImageDragOver] = useState(false);
  const uploadingRef = useRef(false);

  useEffect(() => {
    if (!refPopup) { setSearchResults([]); return; }
    const q = refPopup.query;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/block-search?q=${encodeURIComponent(q)}&limit=8`);
        const data = await res.json();
        setSearchResults((data.blocks || []).filter((b) => b.id !== block.id));
      } catch (_) { setSearchResults([]); }
    }, 120);
    return () => clearTimeout(timer);
  }, [refPopup?.query, block.id]);

  // Resolve cross-note refs found in content
  useEffect(() => {
    if (!block.content || !onFetchRefs) return;
    const ids = [...block.content.matchAll(/\[\[([a-zA-Z0-9_-]+)\]\]/g)].map((m) => m[1]);
    const unknown = ids.filter((id) => !allBlocks?.find((b) => b.id === id) && !refCache?.[id]);
    if (unknown.length > 0) onFetchRefs(unknown);
  }, [block.content]);

  function insertRef(b) {
    const ta = ref.current;
    if (!ta) return;
    const val = ta.value;
    const cursor = ta.selectionStart;
    const before = val.slice(0, cursor);
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (!match) return;
    const triggerStart = cursor - match[0].length;
    const newVal = val.slice(0, triggerStart) + `[[${b.id}]]` + val.slice(cursor);
    onChangeText(block.id, newVal);
    if (b.content && onCacheRef) onCacheRef(b.id, b);
    setRefPopup(null);
    requestAnimationFrame(() => {
      const newCursor = triggerStart + `[[${b.id}]]`.length;
      ta.setSelectionRange(newCursor, newCursor);
      ta.focus();
    });
  }

  useEffect(() => {
    registerRef(block.id, ref);
  }, [block.id, registerRef]);

  useEffect(() => {
    if (!block.editMode) return;
    const el = ref.current;
    if (!el) return;
    const pos = clickPosRef.current;
    clickPosRef.current = null;
    if (!pos) {
      // No click coords (e.g., entered edit via Enter/Tab) — default cursor to end
      return;
    }
    // Ask the browser which character offset in the textarea corresponds to (x, y).
    // Different browsers: caretPositionFromPoint (Firefox), caretRangeFromPoint (WebKit/Chromium).
    let offset = null;
    try {
      if (document.caretPositionFromPoint) {
        const cp = document.caretPositionFromPoint(pos.x, pos.y);
        if (cp && cp.offsetNode === el) offset = cp.offset;
      } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(pos.x, pos.y);
        if (range && range.startContainer === el) offset = range.startOffset;
      }
    } catch (_) {
      // ignore
    }
    if (offset == null) {
      // Fallback: estimate from vertical line + horizontal fraction using the textarea's metrics
      const rect = el.getBoundingClientRect();
      const relY = Math.max(0, pos.y - rect.top - parseFloat(getComputedStyle(el).paddingTop || "0"));
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const lineIndex = Math.floor(relY / lineHeight);
      const lines = (el.value || "").split("\n");
      const targetLine = Math.min(lines.length - 1, Math.max(0, lineIndex));
      const lineStart = lines.slice(0, targetLine).reduce((n, l) => n + l.length + 1, 0);
      const relX = Math.max(0, pos.x - rect.left - parseFloat(getComputedStyle(el).paddingLeft || "0"));
      // Approximate char width from font size
      const fontSize = parseFloat(getComputedStyle(el).fontSize) || 14;
      const charW = fontSize * 0.55;
      const col = Math.min(lines[targetLine]?.length || 0, Math.round(relX / charW));
      offset = lineStart + col;
    }
    try {
      el.setSelectionRange(offset, offset);
    } catch (_) {}
  }, [block.editMode]);

  const isHighlight = !!block.highlightId;
  const hasChildren = (block.children?.length || 0) > 0;

  function handleImageDragOver(e) {
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes("Files")) return;
    if (!e.dataTransfer?.items) return;
    const hasImage = Array.from(e.dataTransfer.items).some((item) => item.type?.startsWith("image/"));
    if (!hasImage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setImageDragOver(true);
  }

  function handleImageDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) setImageDragOver(false);
  }

  async function handleImageDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setImageDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload-image", { method: "POST", body: form, credentials: "include" });
      if (!res.ok) { uploadingRef.current = false; return; }
      const data = await res.json();
      onChangeText(block.id, (block.content || "") + "\n" + `![](${data.url})`);
    } finally { uploadingRef.current = false; }
  }

  return (
    <div className={`blockRowWrap${imageDragOver ? " imageDragOver" : ""}`} data-block-id={block.id}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
          handleImageDragOver(e);
          return;
        }
        onBlockDragOver?.(e, block);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        handleImageDragLeave(e);
        onBlockDragLeave?.();
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
          handleImageDrop(e);
          return;
        }
        onBlockDrop?.(e, block);
      }}
    >
      <div
        className={`blockRow ${focusedId === block.id ? "focused" : ""}`}
        onMouseDown={(e) => {
          if (e.target.closest("button, textarea, input, a")) return;
          setFocusedId(block.id);
          if (!readOnly && !block.editMode) {
            clickPosRef.current = { x: e.clientX, y: e.clientY };
            e.preventDefault();
            onStartEdit(block.id, true);
          }
        }}
      >
        {hasChildren ? (
          <button
            className="collapseBtn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(block.id);
            }}
          >
            {block.collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="collapseSpacer" />
        )}
        {isHighlight && !block.editMode ? (
          <>
            <button
              className="collapseBtn highlightDotBtn dotSlot"
              onClick={(e) => { e.stopPropagation(); onJump(block.highlightId); }}
              title={
                block.position
                  ? "Jump to highlight"
                  : block.properties?.linked_highlight_id
                    ? "Jump to linked highlight"
                    : "Jump to page (no exact position)"
              }
            >
              <span className="highlightDot" style={{
                background: block.position
                  ? (block.color || COLORS[0])
                  : block.properties?.linked_highlight_id
                    ? (highlightColors?.[block.properties.linked_highlight_id] || COLORS[0])
                    : 'rgba(140,140,140,0.5)'
              }} />
            </button>
            {!block.position && block.properties?.linked_highlight_id && onUnlinkHighlight ? (
              <button
                className="collapseBtn attachModeBtn"
                title="Unlink highlight"
                onClick={(e) => { e.stopPropagation(); onUnlinkHighlight(block.id); }}
              >⊘</button>
            ) : null}
            {!block.position && !block.properties?.linked_highlight_id && onEnterAttachMode ? (
              <button
                className="collapseBtn attachModeBtn"
                title="Attach to a PDF highlight"
                onClick={(e) => { e.stopPropagation(); onEnterAttachMode(block.id); }}
              >⊕</button>
            ) : null}
          </>
        ) : block._pageId && typeof onPageOpen === "function" ? (
          <button
            className="collapseBtn dotSlot pageBulletBtn"
            onClick={(e) => { e.stopPropagation(); onPageOpen(block); }}
            title="Open page"
          ><span className="pageBulletDot" /></button>
        ) : (
          <span className="dotSlot dotSlotEmpty" />
        )}

        <div className="blockBody">
          {block._isRecent ? <span className="recentIndicator" title="In recent">★</span> : null}
          <div className="blockMeta">
            {block._pageId ? (block._sourceUrl ? "PDF annotation" : "regular note") : block.page ? `p.${block.page}` : "note"}
          </div>

          {!readOnly && block.editMode ? (
            <AutoGrowTextarea
              ref={ref}
              autoFocus
              className="blockEditor"
              data-block-id={block.id}
              value={block.content || ""}
              onChange={(e) => {
                onChangeText(block.id, e.target.value);
                const cursor = e.target.selectionStart;
                const before = e.target.value.slice(0, cursor);
                const match = before.match(/\[\[([^\]\n]*)$/);
                if (match) {
                  setRefPopup({ query: match[1], rect: e.target.getBoundingClientRect() });
                  setRefSelectedIdx(0);
                } else {
                  setRefPopup(null);
                }
              }}
              onBlur={() => {
                onStartEdit(block.id, false);
                setTimeout(() => setRefPopup(null), 120);
              }}
              onKeyDown={(e) => {
                if (refPopup && searchResults.length > 0) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setRefSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setRefSelectedIdx((i) => Math.max(i - 1, 0)); return; }
                  if (e.key === "Enter") { e.preventDefault(); insertRef(searchResults[refSelectedIdx]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setRefPopup(null); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onEnterSibling(block.id);
                } else if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  onIndent(block.id);
                } else if (e.key === "Tab" && e.shiftKey) {
                  e.preventDefault();
                  onOutdent(block.id);
                } else if (e.key === "ArrowRight" && (block.children?.length || 0) > 0 && block.collapsed) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (e.key === "ArrowLeft" && (block.children?.length || 0) > 0 && !block.collapsed) {
                  e.preventDefault();
                  onToggle(block.id);
                } else if (e.key === "Backspace" && (block._isEmpty || !(block.content || "").trim()) && !(block.quote || "").trim()) {
                  e.preventDefault();
                  onDelete(block.id);
                }
              }}
              placeholder="Type..."
            />
          ) : (
            <div className="blockRendered">
              {(block.content || "").trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeRaw, rehypeKatex]}
                  urlTransform={(url) => url.startsWith("blockref:") ? url : defaultUrlTransform(url)}
                  components={{
                    a: ({ href, children }) => {
                      if (href?.startsWith("blockref:")) {
                        const refId = href.slice(9);
                        const refBlock = allBlocks?.find((b) => b.id === refId) || refCache?.[refId];
                        return (
                          <a
                            href={`?block=${refId}`}
                            className="blockRefChip"
                            title={refBlock?.page_title ? `From: ${refBlock.page_title}` : undefined}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey) return;
                              e.preventDefault();
                              e.stopPropagation();
                              onBlockRefClick?.(refId);
                            }}
                          >
                            {refBlock?.content || String(children)}
                          </a>
                        );
                      }
                      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
                    }
                  }}
                >
                  {(block.content || "")
                    .replace(/!\[([^\]]*)\]\(([^)]+)\)\{:width\s+(\d+)\}/g, '<img src="$2" alt="$1" width="$3" />')
                    .replace(/\[\[([a-zA-Z0-9_-]+)\]\]/g, "[$1](blockref:$1)")}
                </ReactMarkdown>
              ) : (
                <div className="blockPlaceholder">(empty)</div>
              )}
            </div>
          )}

          {block.quote?.trim() ? (
            <div className="blockQuote">
              {block.quote}
            </div>
          ) : null}
        </div>
        {!readOnly && block.id !== "root" ? (
          <button
            className="blockDeleteBtn"
            title="Delete block"
            onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
          >×</button>
        ) : null}
      </div>
      {refPopup && searchResults.length > 0 && (
        <div
          className="refPopup"
          style={{
            position: "fixed",
            top: refPopup.rect.bottom + 4,
            left: refPopup.rect.left,
            zIndex: 2000,
            background: "#1e1e1e",
            border: "1px solid #444",
            borderRadius: 6,
            minWidth: 280,
            maxHeight: 320,
            overflowY: "auto",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          {searchResults.map((b, i) => (
            <div key={b.id} style={{ borderBottom: i < searchResults.length - 1 ? "1px solid #333" : "none" }}>
              {b.ancestors && b.ancestors.length > 0 && (
                <div style={{ padding: "3px 12px 0", fontSize: 11, color: "#777", lineHeight: 1.4 }}>
                  {b.ancestors.map((a, j) => (
                    <span key={a.id}>
                      {j > 0 && <span style={{ color: "#555", margin: "0 3px" }}>&rsaquo;</span>}
                      <span>{a.content || "(untitled)"}</span>
                    </span>
                  ))}
                </div>
              )}
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertRef(b)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "6px 12px",
                  background: i === refSelectedIdx ? "#2a3a4a" : "transparent",
                  color: "#ddd",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {b.content || "(empty)"}
                </div>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SortableBlockRow({ block, ...rowProps }) {
  const depth = rowProps.depth || 0;

  function onDragStart(e) {
    e.dataTransfer.setData("text/plain", block.id);
    e.dataTransfer.effectAllowed = "move";
    _dragState.draggingId = block.id;
  }

  function onDragEnd() {
    _dragState.draggingId = null;
    _dragState.dropTarget = null;
    window._gammaSetDropTarget?.(null);
  }

  return (
    <div className="sortableBlockWrap" data-block-id={block.id} data-depth={depth}>
      <span
        className="dragHandle"
        draggable="true"
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >⋮⋮</span>
      <BlockRow block={block} {...rowProps} />
    </div>
  );
}

function BlockTree({ blocks, readOnly, rowProps, depth = 0 }) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <>
      {blocks.map((rawBlock) => { const block = withLegacyAccessors(rawBlock); return (
        <React.Fragment key={block.id}>
          {!readOnly ? (
            <SortableBlockRow block={block} depth={depth} {...rowProps} />
          ) : (
            <BlockRow block={block} depth={depth} {...rowProps} />
          )}
          {!block.collapsed && block.children && block.children.length > 0 ? (
            <div className="blockChildren">
              <BlockTree blocks={block.children} readOnly={readOnly} rowProps={rowProps} depth={depth + 1} />
            </div>
          ) : null}
        </React.Fragment>
      );})}
    </>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const initialUrl = params.get("src") || params.get("url") || "";
  const initialShare = params.get("share") || "";
  const initialBlockId = params.get("block") || params.get("page") || "";
  const initialCategory = params.get("category") || "";
  const readOnly = Boolean(initialShare);

  // Auth state: null=loading, false=logged out, {user, is_guest}=logged in
  const [authUser, setAuthUser] = useState(readOnly ? {user:"_public"} : null);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");

  async function checkSession() {
    try {
      const data = await apiJson(`${API}/session`);
      if (data.user) {
        setAuthUser({ user: data.user, is_guest: data.is_guest });
      } else {
        setAuthUser(false);
      }
    } catch {
      setAuthUser(false);
    }
  }

  async function doLogin(e) {
    e?.preventDefault();
    setLoginError("");
    try {
      const res = await fetch(`${API}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUser, password: loginPass }),
        credentials: "include",
      });
      if (!res.ok) { setLoginError("Invalid credentials"); return; }
      const data = await res.json();
      setAuthUser({ user: data.username, is_guest: false });
    } catch { setLoginError("Login failed"); }
  }

  async function doGuestLogin() {
    try {
      const res = await fetch(`${API}/login-guest`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) { setLoginError("Guest login failed"); return; }
      const data = await res.json();
      setAuthUser({ user: data.username, is_guest: true });
    } catch { setLoginError("Guest login failed"); }
  }

  async function doLogout() {
    await fetch(`${API}/logout`, { method: "POST", credentials: "include" });
    setAuthUser(false);
    clearSession();
    setBlocks([]);
    setPdfUrl("");
    setDocId("");
  }

  useEffect(() => {
    if (!readOnly) checkSession();
  }, [readOnly]);

  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [pdfUrl, setPdfUrl] = useState("");
  const [docId, setDocId] = useState("");
  const [focusedBlockId, setFocusedBlockId] = useState("");
  const [focusedBlock, setFocusedBlock] = useState(null);
  const [summary, setSummary] = useState("");
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [category, setCategory] = useState("");
  const [categoryEditing, setCategoryEditing] = useState(false);
  const [categoryInput, setCategoryInput] = useState("");
  const [categorySuggestionIdx, setCategorySuggestionIdx] = useState(-1);
  const [categoryFilter, setCategoryFilter] = useState(initialCategory);
  const [pdfPageNumber, setPdfPageNumber] = useState(() => loadSession().pdfPageNumber || 1);
  const [theme, setTheme] = useState(() => localStorage.getItem("gamma-theme") || "system");
  const restoredPdfUrlRef = useRef(null);
  const [blocks, setBlocks] = useState([]);
  const [homeBlocks, setHomeBlocks] = useState([]);
  const [refCache, setRefCache] = useState({}); // { [blockId]: { content, page_title } }
  const [backlinks, setBacklinks] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatHeight, setChatHeight] = useState(() => {
    try { const v = localStorage.getItem("gamma-chat-height"); return v ? Number(v) : 200; } catch { return 200; }
  });
  const [chatHidden, setChatHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Tracks which block we've finished loading from the server, so the save
  // effect doesn't fire (and clobber the stored chat) before the load lands.
  const chatLoadedForRef = useRef("");

  // Load chat from backend on focusedBlockId change.
  useEffect(() => {
    let cancelled = false;
    if (!focusedBlockId) {
      setChatMessages([]);
      chatLoadedForRef.current = "";
      return;
    }
    chatLoadedForRef.current = "";
    fetch(`${API}/chats/${encodeURIComponent(focusedBlockId)}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(data => {
        if (cancelled) return;
        setChatMessages(data.messages || []);
        chatLoadedForRef.current = focusedBlockId;
      })
      .catch(() => { if (!cancelled) chatLoadedForRef.current = focusedBlockId; });
    return () => { cancelled = true; };
  }, [focusedBlockId]);

  // Save chat to backend (debounced) when chatMessages changes, but only
  // after the load for the current focusedBlockId completed.
  useEffect(() => {
    if (!focusedBlockId || chatLoadedForRef.current !== focusedBlockId) return;
    const timer = setTimeout(() => {
      fetch(`${API}/chats/${encodeURIComponent(focusedBlockId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: chatMessages }),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [chatMessages, focusedBlockId]);

  useEffect(() => {
    try { localStorage.setItem("gamma-chat-height", String(chatHeight)); } catch {}
  }, [chatHeight]);

  function clearChat() {
    setChatMessages([]);
    if (focusedBlockId) {
      fetch(`${API}/chats/${encodeURIComponent(focusedBlockId)}`, {
        method: "DELETE",
        credentials: "include",
      }).catch(() => {});
    }
  }
  const [homeEditingId, setHomeEditingId] = useState(null);
  const [status, setStatus] = useState("Ready.");
  const [loading, setLoading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [sidebarHeight, setSidebarHeight] = useState(280);
  const [orientation, setOrientation] = useState("horizontal");
  const [pdfHidden, setPdfHidden] = useState(false);
  const [pdfScale, setPdfScale] = useState("page-width");
  const [pdfSaveLocal, setPdfSaveLocal] = useState(() => {
    try { return localStorage.getItem("gamma-pdf-save") !== "0"; } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem("gamma-pdf-save", pdfSaveLocal ? "1" : "0"); } catch {}
  }, [pdfSaveLocal]);
  const pageTitleSaveTimerRef = useRef(null);
  const viewerWrapRef = useRef(null);
  const appRef = useRef(null);

  function fetchHomeBlocks() {
    return apiJson(`${API}/blocks/root/children`)
      .then((data) => setHomeBlocks(Array.isArray(data.children) ? data.children : []))
      .catch(() => setHomeBlocks([]));
  }

  useEffect(() => {
    if (authUser?.user && !readOnly) fetchHomeBlocks();
  }, [authUser]);

  useEffect(() => {
    function onExpired() { setAuthUser(false); }
    window.addEventListener("gamma-auth-expired", onExpired);
    return () => window.removeEventListener("gamma-auth-expired", onExpired);
  }, []);
  const pendingJumpRef = useRef(null);
  // Phase B2a: drop indicator state
  const [dropTarget, setDropTarget] = useState(null); // { targetId, above, rect }

  useEffect(() => {
    window._gammaSetDropTarget = setDropTarget;
    return () => { window._gammaSetDropTarget = null; };
  }, []);



  const [notesVisible, setNotesVisible] = useState(true);
  const [flashingId, setFlashingId] = useState(null);
  const [highlightMenu, setHighlightMenu] = useState(null); // { id, x, y } or null
  const [focusedId, setFocusedId] = useState(null);
  const [pdfTitle, setPdfTitle] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    document.title = pdfTitle
      ? `${pdfTitle} — Gamma`
      : "Gamma — Annotate PDFs, Share Your Thinking";
  }, [pdfTitle]);

  const scrollToRef = useRef(() => {});
  const flashTimerRef = useRef(null);
  const [attachModeBlockId, setAttachModeBlockId] = useState(null);
  const attachModeBlockIdRef = useRef(null);
  const [attachContextMenu, setAttachContextMenu] = useState(null); // {x, y, highlight}
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const blockRefs = useRef({});
  const pendingFocusRef = useRef(null);
  const pendingBlockScrollRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const suppressAutosaveRef = useRef(true); // skip initial mount + doc loads

  function registerRef(id, ref) {
    blockRefs.current[id] = ref;
  }

  useEffect(() => {
    if (!pendingFocusRef.current || readOnly) return;
    const id = pendingFocusRef.current;
    const ref = blockRefs.current[id];
    if (ref?.current) {
      ref.current.focus();
      pendingFocusRef.current = null;
    }
  }, [blocks, readOnly]);

  useEffect(() => {
    if (!pendingBlockScrollRef.current) return;
    const id = pendingBlockScrollRef.current;
    const row = document.querySelector(`[data-block-id="${id}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      setFocusedId(id);
      pendingBlockScrollRef.current = null;
    } else if (flattenBlocks(blocks).some((b) => b.id === id)) {
      // Block exists but is inside a collapsed parent — expand and try again
      if (!readOnly) suppressAutosaveRef.current = true;
      setBlocks((prev) => expandToBlock(prev, id));
    } else {
      // Block not in tree yet — keep ref and wait for next blocks change
    }
  }, [blocks, readOnly]);

  // Fetch backlinks for the focused block
  useEffect(() => {
    if (!focusedBlockId) { setBacklinks([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson(`${API}/blocks/${focusedBlockId}/backlinks`);
        if (!cancelled) setBacklinks(data.backlinks || []);
      } catch { if (!cancelled) setBacklinks([]); }
    })();
    return () => { cancelled = true; };
  }, [focusedBlockId, readOnly]);

  useEffect(() => {
    if (readOnly || !focusedBlockId) return;
    if (suppressAutosaveRef.current) {
      suppressAutosaveRef.current = false;
      return;
    }
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      persistBlocks(blocks).catch((err) => setStatus(`Save failed: ${err.message}`));
    }, 500);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [blocks, readOnly]);

  useEffect(() => {
    if (readOnly) return;
    function onContext(e) {
      // PDF.js's textLayer sits above highlights, so e.target is usually the textLayer.
      // Use elementsFromPoint to get everything stacked at the click coordinate.
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const el of stack) {
        let cur = el;
        while (cur && cur !== document.body) {
          if (cur.dataset && cur.dataset.highlightId) {
            e.preventDefault();
            setHighlightMenu({ id: cur.dataset.highlightId, x: e.clientX, y: e.clientY });
            return;
          }
          cur = cur.parentElement;
        }
      }
    }
    document.addEventListener("contextmenu", onContext, true); // capture phase
    return () => document.removeEventListener("contextmenu", onContext, true);
  }, [readOnly]);

  // left-click on a PDF highlight jumps to its block in the sidebar
  useEffect(() => {
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.pointerType !== "mouse") return;
      if (attachModeBlockIdRef.current) return;
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const el of stack) {
        let cur = el;
        while (cur && cur !== document.body) {
          if (cur.dataset && cur.dataset.highlightId) {
            e.stopPropagation();
            const hlId = cur.dataset.highlightId;
            const block = flattenBlocks(blocksRef.current).find(
              (b) => b.properties?.highlight_id === hlId,
            );
            if (block) {
              const row = document.querySelector(`[data-block-id="${block.id}"]`);
              if (row) {
                row.scrollIntoView({ block: "center", behavior: "smooth" });
                setFocusedId(block.id);
                row.scrollIntoView({ block: "center", behavior: "smooth" });
                setFocusedId(block.id);
              }
            }
            return;
          }
          cur = cur.parentElement;
        }
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [readOnly]);

  function deleteHighlight(highlightId) {
    if (readOnly) return;
    // Find the block whose properties.highlight_id matches, remove it (and descendants).
    function findHighlightBlockId(list) {
      for (const b of list || []) {
        if (b.properties?.highlight_id === highlightId) return b.id;
        const found = findHighlightBlockId(b.children || []);
        if (found) return found;
      }
      return null;
    }
    const blockId = findHighlightBlockId(blocks);
    if (!blockId) return;
    const nextBlocks = removeBlockTree(blocks, blockId);
    setBlocks(nextBlocks);
    // persistBlocks will fire via autosave; no need to duplicate.
  }

  function changeHighlightColor(highlightId, newColor) {
    if (readOnly) return;
    function findHighlightBlockId(list) {
      for (const b of list || []) {
        if (b.properties?.highlight_id === highlightId) return b.id;
        const found = findHighlightBlockId(b.children || []);
        if (found) return found;
      }
      return null;
    }
    const blockId = findHighlightBlockId(blocks);
    if (!blockId) return;
    const next = updateBlockTree(blocks, blockId, (b) => ({
      ...b,
      properties: { ...b.properties, color: newColor }
    }));
    setBlocks(next);
  }

  async function onFetchRefs(ids) {
    try {
      const res = await fetch(`/api/block-search?ids=${ids.join(",")}`);
      const data = await res.json();
      if (data.blocks?.length) {
        setRefCache((prev) => {
          const next = { ...prev };
          data.blocks.forEach((b) => { next[b.id] = b; });
          return next;
        });
      }
    } catch (_) {}
  }

  function onCacheRef(id, blockData) {
    setRefCache((prev) => prev[id] ? prev : { ...prev, [id]: blockData });
  }

  function triggerFlash(highlightId) {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashingId(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setFlashingId(highlightId);
        flashTimerRef.current = setTimeout(() => setFlashingId(null), 1000);
      });
    });
  }

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();

    const isVertical = orientation === "vertical";
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = sidebarWidth;
    const startHeight = sidebarHeight;
    const target = e.currentTarget;
    const pointerId = e.pointerId;

    try { target.setPointerCapture(pointerId); } catch (_) {}

    document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev) {
      ev.preventDefault();
      if (isVertical) {
        const next = Math.max(160, Math.min(window.innerHeight * 0.75, startHeight + (startY - ev.clientY)));
        setSidebarHeight(next);
      } else {
        const next = Math.max(280, Math.min(window.innerWidth * 0.75, startWidth + (startX - ev.clientX)));
        setSidebarWidth(next);
      }
    }

    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    }

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  function startChatResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = chatHeight;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    try { target.setPointerCapture(pointerId); } catch (_) {}
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    function onMove(ev) {
      ev.preventDefault();
      const next = Math.max(100, Math.min(600, startH + (startY - ev.clientY)));
      setChatHeight(next);
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  useEffect(() => {
    if (initialShare) resolveShare(initialShare);
    else if (initialBlockId) {
      (async () => {
        try {
          const data = await apiJson(`${API}/block-search?ids=${encodeURIComponent(initialBlockId)}`);
          const block = data.blocks?.[0];
          const rootId = block?.page_root_id;
          if (rootId && rootId !== initialBlockId) {
            pendingBlockScrollRef.current = initialBlockId;
            openBlock(rootId);
          } else {
            openBlock(initialBlockId);
          }
        } catch {
          openBlock(initialBlockId);
        }
      })();
    }
    else if (initialUrl) openPdf(initialUrl);
    else if (initialCategory) {
      // Stay on home page with category filter — don't restore session
    }
    else {
      // Bare `/` — try restore last session
      const session = loadSession();
      if (session.focusedBlockId) {
        openBlock(session.focusedBlockId).catch(() => {
          clearSession();
          setFocusedBlockId("");
        });
      }
    }
  }, []);

  // Restore viewer/layout prefs from session on mount
  useEffect(() => {
    const session = loadSession();
    if (session.pdfScale != null) setPdfScale(session.pdfScale);
    if (session.orientation) setOrientation(session.orientation);
    if (session.pdfHidden != null) setPdfHidden(session.pdfHidden);
    if (session.notesVisible != null) setNotesVisible(session.notesVisible);
    if (session.sidebarWidth != null) setSidebarWidth(session.sidebarWidth);
    if (session.sidebarHeight != null) setSidebarHeight(session.sidebarHeight);
  }, []);

  // Apply theme and persist. "system" follows prefers-color-scheme.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function effective() { return theme === "system" ? (mq.matches ? "dark" : "light") : theme; }
    document.documentElement.setAttribute("data-theme", effective());
    if (theme !== "system") localStorage.setItem("gamma-theme", theme);
    else localStorage.removeItem("gamma-theme");
    if (theme === "system") {
      const onChange = () => document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
  }, [theme]);

  // Persist session state on relevant changes (skip initial mount)
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    saveSession({
      focusedBlockId: focusedBlockId || undefined,
      pdfScale,
      orientation,
      pdfHidden,
      notesVisible,
      sidebarWidth,
      sidebarHeight,
      pdfPageNumber,
    });
  }, [focusedBlockId, pdfScale, orientation, pdfHidden, notesVisible, sidebarWidth, sidebarHeight, pdfPageNumber]);

  function formatRelativeTime(iso) {
  if (!iso) return "";
  // Backend sends naive ISO (no tz suffix), but the values are UTC. Append Z so JS parses them as UTC.
  const then = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z").getTime();
  const now = Date.now();
  const secs = Math.max(1, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function getPdfPageTitle(targetDocId, targetInputUrl) {
    const tail = (targetInputUrl || "").split("/").pop() || "";
    const cleaned = decodeURIComponent(tail).trim();
    return cleaned ? `PDF Notes - ${cleaned}` : `PDF Notes - ${targetDocId}`;
  }

  async function loadBlocksForBlock(blockId) {
    try {
      const data = await apiJson(`${API}/blocks/${blockId}/subtree`);
      const children = normalizeBlocks((data.block?.children) || []);
      suppressAutosaveRef.current = true;
      setBlocks(children);
      return children;
    } catch {
      suppressAutosaveRef.current = true;
      setBlocks([]);
      return [];
    }
  }

  async function getOrCreateBlockForDoc(targetDocId, defaultTitle, sourceUrl) {
    if (!targetDocId) throw new Error("docId required");
    return await apiJson(`${API}/blocks/by-doc/${targetDocId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_title: defaultTitle || `PDF Notes - ${targetDocId}`, source_url: sourceUrl || null })
    });
  }

  async function renameTitle(newTitle) {
    if (readOnly || !focusedBlockId) return;
    const trimmed = (newTitle || "").trim();
    const finalTitle = trimmed || getPdfPageTitle(docId, inputUrl);
    setPdfTitle(finalTitle);
    setFocusedBlock((b) => b ? { ...b, content: finalTitle } : b);
    try {
      await apiJson(`${API}/blocks/${focusedBlockId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: finalTitle })
      });
      setHomeBlocks((prev) => prev.map((b) => b.id === focusedBlockId ? { ...b, content: finalTitle } : b));
      setStatus(`Renamed to "${finalTitle}"`);
    } catch (err) {
      setStatus(`Rename failed: ${err.message}`);
    }
  }

  async function persistBlocks(nextBlocks) {
    if (readOnly || !focusedBlockId) return;
    await apiJson(`${API}/blocks/${focusedBlockId}/children`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: nextBlocks })
    });
  }

  async function uploadPdf(file) {
    if (readOnly) return;
    if (!file || file.type !== "application/pdf") {
      setStatus("Not a PDF file.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setStatus("File too large (max 50 MB).");
      return;
    }
    setLoading(true);
    setStatus(`Uploading ${file.name}...`);
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`${API}/uploads`, { method: "POST", body: form, credentials: "include" });
      if (!resp.ok) {
        const msg = await resp.text();
        throw new Error(msg || `upload failed (${resp.status})`);
      }
      const data = await resp.json();
      // Open the uploaded PDF directly (bypass openPdf's URL-resolution path)
      const sourceUrl = data.source_url;
      const defaultTitle = getPdfPageTitle(data.doc_id, sourceUrl);
      const block = await getOrCreateBlockForDoc(data.doc_id, defaultTitle, sourceUrl);
      const nextBlocks = await loadBlocksForBlock(block.id);
      setDocId(data.doc_id);
      setInputUrl(sourceUrl);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || defaultTitle);
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
      setPdfUrl(sourceUrl);
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus(`Uploaded ${file.name} (${data.doc_id})`);
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function importLogseq(files) {
    if (readOnly) return;
    const all = Array.from(files);
    const pdfFile = all.find((f) => f.name.endsWith('.pdf'));
    const ednFile = all.find((f) => f.name.endsWith('.edn'));
    const mdFile  = all.find((f) => f.name.endsWith('.md'));
    if (!pdfFile || !ednFile) {
      setStatus("Select at least a .pdf and .edn file.");
      return;
    }
    setLoading(true);
    setStatus(`Importing ${pdfFile.name}...`);
    try {
      const form = new FormData();
      form.append("pdf", pdfFile);
      form.append("edn", ednFile);
      if (mdFile) form.append("md", mdFile);
      const resp = await fetch(`${API}/import/logseq`, { method: "POST", body: form });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      // Block was already created by the import endpoint; just load it.
      const block = await getOrCreateBlockForDoc(data.doc_id, pdfFile.name.replace('.pdf', ''), data.source_url);
      await loadBlocksForBlock(block.id);
      setDocId(data.doc_id);
      setInputUrl(data.source_url);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || pdfFile.name.replace('.pdf', ''));
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
      setPdfUrl(data.source_url);
      await fetchHomeBlocks();
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus(`Imported ${data.imported} highlights from ${pdfFile.name}`);
    } catch (err) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function openPdf(sourceUrl) {
    if (!sourceUrl || readOnly) return;
    setLoading(true);
    setStatus("Opening PDF...");
    try {
      // Uploaded PDFs are already hosted locally — skip external resolve and proxy.
      const isUpload = sourceUrl.startsWith("/api/uploads/") || sourceUrl.startsWith(`${API}/uploads/`);
      let finalUrl, resolvedDocId, proxiedUrl;
      if (isUpload) {
        finalUrl = sourceUrl;
        // filename is "<doc_id>.pdf" — serve directly from Caddy, bypassing uvicorn
        const m = sourceUrl.match(/\/([0-9a-f]+)\.pdf$/);
        resolvedDocId = m ? m[1] : await getDocIdForUrl(sourceUrl);
        proxiedUrl = `/pdf-files/${resolvedDocId}.pdf`;
      } else {
        finalUrl = await resolvePdfUrl(sourceUrl);
        resolvedDocId = await getDocIdForUrl(finalUrl);
        proxiedUrl = `${API}/pdf?source_url=${encodeURIComponent(finalUrl)}${pdfSaveLocal ? "&save=1" : ""}`;
      }
      // Resolve block + load children FIRST, before setPdfUrl, to avoid mid-render highlight race
      const defaultTitle = getPdfPageTitle(resolvedDocId, finalUrl);
      const block = await getOrCreateBlockForDoc(resolvedDocId, defaultTitle, finalUrl);
      const nextBlocks = await loadBlocksForBlock(block.id);
      setDocId(resolvedDocId);
      setInputUrl(finalUrl);
      setFocusedBlockId(block.id);
      setFocusedBlock(block);
      setPdfTitle(block.content || defaultTitle);
      setSummary(block.properties?.summary || "");
      setCategory(block.properties?.category || "");
      setPdfUrl(proxiedUrl);
      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(block.id)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus(`Loaded ${resolvedDocId}`);
    } catch (err) {
      setStatus(`Open failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function resolveShare(token) {
    setLoading(true);
    setStatus("Resolving share link...");
    try {
      const data = await apiJson(`${API}/share/${token}`);
      const userParam = data.username ? `?user=${encodeURIComponent(data.username)}` : "";

      let block = null;
      try { block = await apiJson(`${API}/blocks/by-doc/${data.doc_id}${userParam}`); } catch {}

      let childBlocks = [];
      if (block) {
        try {
          const subtreeData = await apiJson(`${API}/blocks/${block.id}/subtree${userParam}`);
          childBlocks = normalizeBlocks(subtreeData.block?.children || []);
        } catch {}
      }

      const props = block?.properties || {};
      const src = props.source_url || props.sourceUrl || "";
      const isLocal = src.startsWith("/api/");
      const proxiedUrl = isLocal ? src : src ? `${API}/pdf?source_url=${encodeURIComponent(src)}${userParam ? "&" + userParam.slice(1) : ""}` : "";

      suppressAutosaveRef.current = true;
      setFocusedBlockId(block?.id || "");
      setFocusedBlock(block || null);
      setPdfTitle(block?.content || getPdfPageTitle(data.doc_id, src));
      setBlocks(childBlocks);
      setDocId(data.doc_id);
      setInputUrl(src);
      setPdfUrl(proxiedUrl);
      setStatus("Loaded shared doc.");
    } catch (err) {
      setStatus(`Share open failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function openBlock(blockId) {
    if (!blockId || readOnly) return;
    setLoading(true);
    setStatus("Opening...");
    try {
      const subtreeData = await apiJson(`${API}/blocks/${blockId}/subtree`);
      const block = subtreeData.block;
      if (!block) throw new Error("Block not found");
      const props = block.properties || {};
      const childBlocks = normalizeBlocks(block.children || []);

      suppressAutosaveRef.current = true;
      setFocusedBlockId(blockId);
      setFocusedBlock(block);
      setPdfTitle(block.content || "Untitled");
      setSummary(props.summary || "");
      setCategory(props.category || "");
      setDocId(props.doc_id || "");

      if (props.source_url) {
        const src = props.source_url;
        const isLocal = src.startsWith("/api/");
        const proxiedUrl = isLocal ? src : `${API}/pdf?source_url=${encodeURIComponent(src)}`;
        setInputUrl(src);
        setPdfUrl(proxiedUrl);
        setBlocks(childBlocks);
      } else {
        setInputUrl("");
        setPdfUrl("");
        if (childBlocks.length === 0 && !readOnly) {
          const seedId = makeId();
          suppressAutosaveRef.current = true;
          pendingFocusRef.current = seedId;
          setBlocks([{ id: seedId, content: "", children: [], collapsed: false, editMode: true, properties: {} }]);
        } else {
          setBlocks(childBlocks);
        }
      }

      // Scroll notes panel to the most recently updated block, unless a
      // specific target was already queued (e.g. ?block=... deep link).
      if (!pendingBlockScrollRef.current && childBlocks.length > 0) {
        let latest = null;
        for (const b of flattenBlocks(childBlocks)) {
          if (!latest || (b.updated_at || "") > (latest.updated_at || "")) latest = b;
        }
        if (latest) pendingBlockScrollRef.current = latest.id;
      }

      const newUrl = `${window.location.pathname}?block=${encodeURIComponent(blockId)}`;
      window.history.replaceState({}, "", newUrl);
      setStatus("Ready.");
    } catch (err) {
      setStatus(`Open failed: ${err.message}`);
      // If this was a session restore attempt that failed, clear it
      if (!window.location.search.includes("block=")) clearSession();
    } finally {
      setLoading(false);
    }
  }

  async function saveSummary(newValue) {
    if (!focusedBlockId || readOnly) return;
    try {
      await apiJson(`${API}/blocks/${focusedBlockId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { summary: newValue || "" } }),
      });
    } catch (err) {
      setStatus(`Summary save failed: ${err.message}`);
    }
  }

  function addCategoryTag(tag) {
    if (!tag.trim()) return;
    setCategory(prev => {
      const tags = prev ? prev.split(",").map(t => t.trim()).filter(Boolean) : [];
      if (!tags.includes(tag.trim())) tags.push(tag.trim());
      return tags.join(",");
    });
  }

  function removeCategoryTag(index) {
    setCategory(prev => {
      const tags = prev ? prev.split(",").map(t => t.trim()).filter(Boolean) : [];
      if (index < 0) tags.pop();
      else tags.splice(index, 1);
      return tags.join(",");
    });
  }

  function commitAndCloseCategory() {
    const finalCategory = (() => {
      const tags = category ? category.split(",").map(t => t.trim()).filter(Boolean) : [];
      const input = categoryInput.trim();
      if (input && !tags.includes(input)) tags.push(input);
      return tags.join(",");
    })();
    setCategory(finalCategory);
    setCategoryInput("");
    setCategoryEditing(false);
    saveCategory(finalCategory);
  }

  async function saveCategory(newValue) {
    if (!focusedBlockId || readOnly) return;
    try {
      await apiJson(`${API}/blocks/${focusedBlockId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { category: newValue || "" } }),
      });
      // Refresh home blocks so the category carousel updates
      fetchHomeBlocks();
    } catch (err) {
      setStatus(`Category save failed: ${err.message}`);
    }
  }

  async function createShareLink() {
    if (!pdfUrl || readOnly) return;
    try {
      const data = await apiJson(`${API}/share/${docId}`, {
        method: "POST",
        credentials: "include",
      });
      const link = `${window.location.origin}${window.location.pathname}?share=${data.token}`;
      await navigator.clipboard.writeText(link);
      setStatus(`Share link copied: ${link}`);
    } catch (err) {
      setStatus(`Share failed: ${err.message}`);
    }
  }

  function addHighlight(highlight) {
    if (readOnly) return;
    const withId = { ...highlight, id: highlight.id || makeId() };
    const nextBlocks = addHighlightAsBlock(blocks, withId);
    setBlocks(nextBlocks);
    // autosave effect will persist
    setStatus("Highlight saved.");
  }

  useEffect(() => { attachModeBlockIdRef.current = attachModeBlockId; }, [attachModeBlockId]);

  // Escape cancels attach mode
  useEffect(() => {
    if (!attachModeBlockId) return;
    const onKey = (e) => { if (e.key === 'Escape') { setAttachModeBlockId(null); setAttachContextMenu(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachModeBlockId]);

  async function linkHighlightToBlock(blockId, highlight) {
    // Store a pointer to the existing highlight's id, NOT a copy of its position.
    // Copying the position would create a duplicate visual highlight on the PDF at the same spot.
    // The jump logic resolves linked_highlight_id → scrolls to the real highlight.
    await fetch(`/api/blocks/${blockId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          linked_highlight_id: highlight.id,
          pdf_page: highlight.position.pageNumber,
        },
      }),
    });
    await loadBlocksForBlock(focusedBlockId);
    setAttachModeBlockId(null);
    setAttachContextMenu(null);
  }

  async function unlinkHighlightFromBlock(blockId) {
    await fetch(`/api/blocks/${blockId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          linked_highlight_id: null,
        },
      }),
    });
    await loadBlocksForBlock(focusedBlockId);
  }

  async function sendChatMessage() {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    setChatInput("");
    const prevMessages = chatMessages;
    setChatMessages((prev) => [...prev, { role: "user", text }]);
    setChatLoading(true);
    try {
      const data = await apiJson(`${API}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, doc_id: docId || "", history: prevMessages }),
      });
      setChatMessages((prev) => [...prev, { role: "ai", text: data.response || "(no response)" }]);
    } catch (err) {
      setChatMessages((prev) => [...prev, { role: "ai", text: `Error: ${err.message}` }]);
    } finally {
      setChatLoading(false);
    }
  }

  function jumpToHighlightId(highlightId) {
    if (pdfHidden) {
      pendingJumpRef.current = highlightId;
      setPdfHidden(false);
      return;
    }
    // Try own highlight first
    const target = highlights.find((h) => h.id === highlightId);
    if (target) {
      // Pass {position} directly rather than the full highlight object so
      // react-pdf-highlighter always uses the position data, not a potentially
      // stale internal id lookup.
      scrollToRef.current({ position: target.position });
      triggerFlash(highlightId);
      return;
    }
    const block = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === highlightId);
    // Block was linked to an existing highlight via attach mode
    const linkedId = block?.properties?.linked_highlight_id;
    if (linkedId) {
      const linkedTarget = highlights.find((h) => h.id === linkedId);
      if (linkedTarget) {
        scrollToRef.current({ position: linkedTarget.position });
        triggerFlash(linkedId);
        return;
      }
    }
    // Fallback: page-level jump
    const page = block?.properties?.pdf_page;
    if (page) {
      scrollToRef.current({
        position: {
          pageNumber: page,
          boundingRect: { x1: 0, y1: 0, x2: 0, y2: 0, width: 1, height: 1, pageNumber: page },
          rects: [],
        },
      });
    }
  }

  const visibleBlocks = useMemo(() => flattenBlocks(blocks), [blocks]);
  const homeMode = !pdfUrl && !focusedBlockId && !readOnly;
  const pageOnly = !pdfUrl && !!focusedBlockId && !readOnly;
  const recentPages = useMemo(() => {
    return [...homeBlocks]
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
      .slice(0, 4);
  }, [homeBlocks]);
  const recentIds = useMemo(() => new Set(recentPages.map((b) => b.id)), [recentPages]);
  const pageBlocks = useMemo(() => {
    return homeBlocks.map((b) => ({
      id: b.id,
      content: b.content || "Untitled",
      children: [],
      collapsed: false,
      properties: { quote: b.properties?.summary || "" },
      _pageId: b.id,
      _position: b.position,
      _sourceUrl: b.properties?.source_url,
      _isRecent: recentIds.has(b.id),
      _isEmpty: !b.content,
      editMode: homeEditingId === b.id,
    }));
  }, [homeBlocks, recentIds, homeEditingId]);
  const highlights = useMemo(() => blocksToHighlights(blocks), [blocks]);
  useEffect(() => {
    if (pdfHidden) return;
    const id = pendingJumpRef.current;
    if (!id) return;
    setTimeout(() => {
      let scrollTarget = (highlights || []).find((x) => x.id === id);
      if (!scrollTarget) {
        const b = flattenBlocks(blocks).find((b) => b.properties?.highlight_id === id);
        const linkedId = b?.properties?.linked_highlight_id;
        if (linkedId) scrollTarget = (highlights || []).find((x) => x.id === linkedId);
      }
      if (scrollTarget && scrollToRef.current) {
        scrollToRef.current({ position: scrollTarget.position });
      }
      pendingJumpRef.current = null;
    }, 100);
  }, [pdfHidden, highlights]);

  // Restore PDF scroll position from session.
  // Polls until the viewer is mounted and the doc is ready (scrollToRef is set
  // and a page element exists), so it works on PDFs with no highlights and on
  // slow loads. Doesn't depend on highlights.
  useEffect(() => {
    if (pdfHidden) return;
    if (restoredPdfUrlRef.current === pdfUrl) return;
    const saved = loadSession().pdfPageNumber;
    if (!saved || saved <= 1) return;
    let cancelled = false;
    let tries = 0;
    const tryRestore = () => {
      if (cancelled) return;
      if (tries++ > 50) return; // give up after ~5s
      if (!scrollToRef.current || !document.querySelector('[data-page]')) {
        setTimeout(tryRestore, 100);
        return;
      }
      restoredPdfUrlRef.current = pdfUrl;
      scrollToRef.current({
        position: {
          pageNumber: saved,
          boundingRect: { x1: 0, y1: 0, x2: 1, y2: 1, width: 1, height: 1, pageNumber: saved },
          rects: [],
        },
      });
    };
    tryRestore();
    return () => { cancelled = true; };
  }, [pdfUrl, pdfHidden]);

  // Track PDF scroll position — poll via scrollable container
  useEffect(() => {
    if (!pdfUrl || pdfHidden) return;
    let container = null;
    let ticking = false;
    function findContainer() {
      const p = document.querySelector('[data-page]');
      if (!p) return null;
      let el = p.parentElement;
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }
      return null;
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (!container) return;
        const pages = container.querySelectorAll('[data-page]');
        if (pages.length === 0) return;
        const cr = container.getBoundingClientRect();
        const midY = cr.top + cr.height / 2;
        for (const el of pages) {
          const r = el.getBoundingClientRect();
          if (r.top <= midY && r.bottom >= midY) {
            const n = parseInt(el.dataset.page);
            if (n) setPdfPageNumber(n);
            break;
          }
        }
      });
    }
    // Retry finding container until pages render
    let tries = 0;
    const retry = setInterval(() => {
      container = findContainer();
      if (container) {
        clearInterval(retry);
        container.addEventListener('scroll', onScroll, { passive: true });
      }
      if (++tries > 30) clearInterval(retry);
    }, 300);
    return () => {
      clearInterval(retry);
      if (container) container.removeEventListener('scroll', onScroll);
    };
  }, [pdfUrl, pdfHidden]);

  // Login page state
  if (authUser === null) {
    return <div className="app"><div className="loginPage"><div className="loginCard"><div className="loginTitle">Gamma</div><p style={{color:"var(--text-muted)",textAlign:"center",marginBottom:24}}>Loading...</p></div></div></div>;
  }

  if (authUser === false) {
    return (
      <div className="app">
        <div className="loginPage">
          <div className="loginCard">
            <div className="loginTitle">Gamma</div>
            <p className="loginSubtitle">Annotate PDFs, Share Your Thinking</p>
            <form onSubmit={doLogin}>
              <input
                type="text"
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                placeholder="Username"
                className="loginInput"
                autoFocus
              />
              <input
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="Password"
                className="loginInput"
              />
              {loginError ? <div className="loginError">{loginError}</div> : null}
              <button type="submit" className="loginBtn" disabled={!loginUser.trim() || !loginPass.trim()}>
                Log in
              </button>
              <button type="button" className="loginGuestBtn" onClick={doGuestLogin}>
                Continue as guest
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={appRef}
      className={`app layout-${orientation} ${readOnly ? "readOnlyMode" : ""}`}
      onDragOver={readOnly ? undefined : (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
        e.preventDefault();
        if (e.target.closest(".blockRowWrap")) {
          appRef.current?.classList.remove("dragOver");
        } else {
          appRef.current?.classList.add("dragOver");
        }
      }}
      onDragLeave={readOnly ? undefined : (e) => {
        if (e.currentTarget === e.target) appRef.current?.classList.remove("dragOver");
      }}
      onDrop={readOnly ? undefined : (e) => {
        appRef.current?.classList.remove("dragOver");
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (file.type === "application/pdf") {
          e.preventDefault();
          uploadPdf(file);
        }
      }}
    >
      {!readOnly ? (
        <>
          <div className="topbar">
            <button
              className="homeBtn"
              onClick={() => { clearSession(); window.location.href = "/"; }}
              title="Home"
              aria-label="Home"
            >
              Γ
            </button>
            {authUser?.user && (
              <span className="userBadge" title={authUser.is_guest ? "Guest account — resets daily" : ""}>
                {authUser.is_guest ? "guest" : authUser.user}
                <button className="logoutBtn" onClick={doLogout} title="Log out">↪</button>
              </span>
            )}
            <input
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="Enter PDF URL"
              onKeyDown={(e) => { if (e.key === "Enter") openPdf(inputUrl); }}
            />
            <button onClick={() => openPdf(inputUrl)} disabled={loading} className="openBtn">
              Open
            </button>
            <button
              className="menuToggleBtn"
              onClick={() => setMenuOpen((v) => !v)}
              title="More actions"
              aria-label="More actions"
            >
              {menuOpen ? "✕" : "⋮"}
            </button>
            <div className={`topbarOverflow ${menuOpen ? "open" : ""}`}>
              <button onClick={createShareLink} disabled={!pdfUrl || loading}>
                Share link
              </button>
              {pdfUrl && pdfHidden ? (
                <button
                  className="pdfShowBtn"
                  onClick={() => { setPdfHidden(false); setMenuOpen(false); }}
                  title="Show PDF"
                >Show PDF</button>
              ) : null}
              <button
                className="orientationBtn"
                onClick={() => { setOrientation((o) => (o === "horizontal" ? "vertical" : "horizontal")); setMenuOpen(false); }}
                title={orientation === "horizontal" ? "Switch to stacked layout" : "Switch to side-by-side layout"}
              >
                {orientation === "horizontal" ? "⬍ Stack" : "⬌ Side-by-side"}
              </button>
              <button
                className="notesBtn"
                onClick={() => { setNotesVisible((v) => !v); setMenuOpen(false); }}
                title={notesVisible ? "Hide notes" : "Show notes"}
              >
                {notesVisible ? "Hide notes" : "Show notes"}
              </button>
              <button
                className="themeToggle"
                onClick={() => setTheme((t) => t === "dark" ? "light" : t === "light" ? "system" : "dark")}
                title={theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto"}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
              </button>
              <label
                className="importLogseqBtn"
                title="Import Logseq PDF highlights (.pdf + .edn)"
                style={{ cursor: loading ? "not-allowed" : "pointer" }}
              >
                Import Logseq
                <input
                  type="file"
                  multiple
                  accept=".pdf,.edn,.md"
                  style={{ display: "none" }}
                  disabled={loading}
                  onChange={(e) => { importLogseq(e.target.files); e.target.value = ""; setMenuOpen(false); }}
                />
              </label>
            </div>
          </div>
          <div className="status">{status}</div>
        </>
      ) : (
        <div className="topbar">
          <button
            className="homeBtn"
            disabled
            title="Home"
            aria-label="Home"
          >
            Γ
          </button>
          <button
            className="menuToggleBtn"
            onClick={() => setMenuOpen((v) => !v)}
            title="More actions"
            aria-label="More actions"
          >
            {menuOpen ? "✕" : "⋮"}
          </button>
          <div className={`topbarOverflow ${menuOpen ? "open" : ""}`}>
            <button
              className="orientationBtn"
              onClick={() => { setOrientation((o) => (o === "horizontal" ? "vertical" : "horizontal")); setMenuOpen(false); }}
            >
              {orientation === "horizontal" ? "⬍ Stack" : "⬌ Side-by-side"}
            </button>
            {pdfUrl && pdfHidden ? (
              <button className="pdfShowBtn" onClick={() => { setPdfHidden(false); setMenuOpen(false); }}>
                Show PDF
              </button>
            ) : null}
            <button className="notesBtn" onClick={() => { setNotesVisible((v) => !v); setMenuOpen(false); }}>
              {notesVisible ? "Hide notes" : "Show notes"}
            </button>
            <button className="themeToggle"
              onClick={() => setTheme((t) => t === "dark" ? "light" : t === "light" ? "system" : "dark")}
              title={theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto"}
            >
              {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
            </button>
          </div>
        </div>
      )}

      {attachModeBlockId && (
        <div className="attachModeBanner">
          Click a PDF highlight to link it
          <button onClick={() => { setAttachModeBlockId(null); setAttachContextMenu(null); }}>Cancel</button>
        </div>
      )}
      {attachContextMenu && (
        <div
          className="attachContextMenu"
          style={{ left: attachContextMenu.x, top: attachContextMenu.y }}
          onMouseLeave={() => setAttachContextMenu(null)}
        >
          <button onClick={() => linkHighlightToBlock(attachModeBlockId, attachContextMenu.highlight)}>
            Link highlight here
          </button>
        </div>
      )}

      <div className={`main ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`}>
        <div className={`viewerWrap ${(pdfHidden || homeMode || pageOnly) ? "pdfHidden" : ""}`} ref={viewerWrapRef}>
          {pdfUrl && !pdfHidden ? (
            <button
              className="pdfCloseBtn"
              onClick={() => setPdfHidden(true)}
              title="Close PDF"
              aria-label="Close PDF"
            >×</button>
          ) : null}
          {pdfUrl && !pdfHidden ? (
            <div className="pdfZoomOverlay">
              <button onClick={() => setPdfScale((s) => { const n = parseFloat(s); return isNaN(n) ? "0.8" : String(Math.max(0.4, +(n - 0.2).toFixed(1))); })} title="Zoom out">−</button>
              <span className="pdfZoomLevel">{isNaN(parseFloat(pdfScale)) ? "Width" : `${Math.round(parseFloat(pdfScale) * 100)}%`}</span>
              <button onClick={() => setPdfScale((s) => { const n = parseFloat(s); return isNaN(n) ? "1.2" : String(Math.min(4, +(n + 0.2).toFixed(1))); })} title="Zoom in">+</button>
              <button className="pdfFitWidthBtn" onClick={() => setPdfScale("page-width")} title="Fit to width">Width</button>
            </div>
          ) : null}
          {pdfUrl ? (
            <PdfViewer url={pdfUrl} highlights={highlights}
              pdfScaleValue={pdfScale} scrollRef={scrollToRef}
              onJump={jumpToHighlightId}
              onHighlightJump={(hlId) => {
                const b = flattenBlocks(blocks).find(b => b.properties?.highlight_id === hlId);
                if (b) { pendingBlockScrollRef.current = b.id; setBlocks(prev => expandToBlock(prev, b.id)); }
              }}
              onHighlightContext={setHighlightMenu}
              onSelectionFinished={readOnly ? undefined : (position, content, hideTip, extras) => {
                addHighlight({
                  content: content || { text: "" },
                  position,
                  comment: { text: extras?.commentText || "" },
                  color: extras?.color || COLORS[0],
                });
                hideTip?.();
              }}
            />
          ) : (
            <div className="status">No PDF open.</div>
          )}
        </div>

        {notesVisible && (<div className={`splitter splitter-${orientation}`}><div className="splitterGrab" onPointerDown={startResize} aria-label="Drag to resize" role="separator"><span className="splitterGrabDot" /></div></div>)}

        {notesVisible && (<div className="sidebar" style={{ "--sidebar-width": `${sidebarWidth}px`, "--sidebar-height": `${sidebarHeight}px` }}>
          {!homeMode && <div className="pageTitleRow">
            {titleEditing && !readOnly && focusedBlockId ? (
              <input
                className="titleEdit"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => { renameTitle(titleDraft); setTitleEditing(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.currentTarget.blur(); }
                  else if (e.key === "Escape") { setTitleDraft(pdfTitle); setTitleEditing(false); }
                }}
              />
            ) : (
              <h3
                className={!readOnly && focusedBlockId ? "titleText editable" : "titleText"}
                title={!readOnly && focusedBlockId ? "Click to rename" : undefined}
                onClick={() => {
                  if (readOnly || !focusedBlockId) return;
                  setTitleDraft(pdfTitle || (docId ? getPdfPageTitle(docId, inputUrl) : "Untitled"));
                  setTitleEditing(true);
                }}
              >{focusedBlockId ? (pdfTitle || (docId ? getPdfPageTitle(docId, inputUrl) : "Untitled")) : "PDF Notes"}</h3>
            )}
            {!readOnly && focusedBlockId ? (
              <button
                className="pageDeleteBtn"
                title="Delete this page"
                onClick={async () => {
                  if (!window.confirm("Delete this page and all its notes?")) return;
                  try {
                    await apiJson(`${API}/blocks/${focusedBlockId}`, { method: "DELETE" });
                  } catch {}
                  clearSession();
                  window.location.href = "/";
                }}
              >🗑</button>
            ) : null}

          </div>}

          {inputUrl ? (
            <div className="pageHeaderMeta">
              <div className="pageHeaderLabel">Source PDF</div>
              <div className="pageHeaderUrl">{inputUrl}</div>
              {inputUrl && !inputUrl.startsWith("/api/") ? (
                <label className="pdfSaveToggle" title={readOnly ? (pdfSaveLocal ? "PDF saved on server" : "PDF streamed from source") : undefined}>
                  <span className={`pdfSaveSwitch${readOnly ? " disabled" : ""}`}>
                    <input type="checkbox" checked={pdfSaveLocal} onChange={(e) => setPdfSaveLocal(e.target.checked)} disabled={readOnly} />
                    <span className="pdfSaveSlider" />
                  </span>
                  {pdfSaveLocal ? "Saved on server" : "Streaming only"}
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="blockList">
            {focusedBlockId && !readOnly && !homeMode ? (
              <>
                <div className="summaryFrontmatter">
                  <span className="summaryFrontmatterLabel">summary::</span>
                  {summaryEditing ? (
                    <textarea
                      className="summaryFrontmatterInput"
                      value={summary}
                      onChange={(e) => {
                        setSummary(e.target.value);
                        e.target.style.height = "auto";
                        e.target.style.height = e.target.scrollHeight + "px";
                      }}
                      onBlur={() => {
                        setSummaryEditing(false);
                        saveSummary(summary);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          setSummaryEditing(false);
                          saveSummary(summary);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setSummaryEditing(false);
                          saveSummary(summary);
                        }
                      }}
                      ref={(el) => {
                        if (el) {
                          el.style.height = "auto";
                          el.style.height = el.scrollHeight + "px";
                        }
                      }}
                      autoFocus
                      rows={1}
                      placeholder="Add a summary..."
                    />
                  ) : (
                    <span
                      className={`summaryFrontmatterValue ${summary ? "" : "empty"}`}
                      onClick={() => setSummaryEditing(true)}
                      title="Click to edit"
                    >
                      {summary || "Add a summary..."}
                    </span>
                  )}
                </div>
                <div className="categoryFrontmatter">
                  <span className="summaryFrontmatterLabel">category::</span>
                  {categoryEditing ? (() => {
                    const currentTags = category.split(",").map(t => t.trim()).filter(Boolean);
                    const q = categoryInput.trim();
                    const suggestions = q ? [...new Set(homeBlocks.flatMap(b =>
                      (b.properties?.category || "").split(",").map(t => t.trim()).filter(Boolean)
                    ))].filter(t =>
                      t.toLowerCase().includes(q.toLowerCase()) &&
                      !currentTags.includes(t)
                    ).sort().slice(0, 8) : [];
                    return (
                    <div className="categoryTagInputContainer">
                      <div className="categoryTagInputWrap">
                        {category.split(",").map((t, i) => t.trim() ? (
                          <span key={i} className="categoryTag">
                            {t.trim()}
                            <button className="categoryTagRemove" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeCategoryTag(i); }}>×</button>
                          </span>
                        ) : null)}
                        <input
                          className="categoryFrontmatterInput"
                          value={categoryInput}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCategorySuggestionIdx(-1);
                            if (val.includes(",")) {
                              const parts = val.split(",");
                              for (let i = 0; i < parts.length - 1; i++) {
                                const tag = parts[i].trim();
                                if (tag) addCategoryTag(tag);
                              }
                              setCategoryInput(parts[parts.length - 1].trimStart());
                            } else {
                              setCategoryInput(val);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              if (suggestions.length > 0) {
                                setCategorySuggestionIdx(i => Math.min(i + 1, suggestions.length - 1));
                              }
                            } else if (e.key === "ArrowUp") {
                              e.preventDefault();
                              setCategorySuggestionIdx(i => Math.max(i - 1, -1));
                            } else if (e.key === "Enter" && categorySuggestionIdx >= 0 && categorySuggestionIdx < suggestions.length) {
                              e.preventDefault();
                              addCategoryTag(suggestions[categorySuggestionIdx]);
                              setCategoryInput("");
                              setCategorySuggestionIdx(-1);
                            } else if (e.key === "Enter") {
                              e.preventDefault();
                              commitAndCloseCategory();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              commitAndCloseCategory();
                            } else if (e.key === "Backspace" && !categoryInput) {
                              removeCategoryTag(-1);
                            }
                          }}
                          onBlur={commitAndCloseCategory}
                          autoFocus
                          placeholder="type to add..."
                        />
                      </div>
                      {suggestions.length > 0 ? (
                        <div className="categorySuggestions">
                          {suggestions.map((s, i) => (
                            <button key={s} className={`categorySuggestionItem${i === categorySuggestionIdx ? " selected" : ""}`}
                              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); addCategoryTag(s); setCategoryInput(""); setCategorySuggestionIdx(-1); }}
                              onMouseEnter={() => setCategorySuggestionIdx(i)}
                            >{s}</button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    );
                  })() : (
                    <span
                      className={`categoryFrontmatterValue ${category ? "" : "empty"}`}
                      onClick={() => { setCategoryInput(""); setCategorySuggestionIdx(-1); setCategoryEditing(true); }}
                      title="Click to edit"
                    >
                      {category ? (
                        category.split(",").map((t, i) => t.trim() ? <span key={i} className="categoryBadge">{t.trim()}</span> : null)
                      ) : "Add categories..."}
                    </span>
                  )}
                </div>
              </>
            ) : null}
            {!homeMode && backlinks.length > 0 ? (
              <div className="backlinksPanel">
                <div className="backlinksLabel">Backlinks ({backlinks.length})</div>
                <div className="backlinksList">
                  {backlinks.map((bl) => {
                    const isPrivate = bl.page_root_id && bl.page_root_id !== focusedBlockId;
                    return isPrivate ? (
                      <div key={bl.id} className="backlinkItem private">
                        <div className="backlinkContent private">private block</div>
                      </div>
                    ) : (
                      <button
                        key={bl.id}
                        className="backlinkItem"
                        title={bl.page_title ? `From: ${bl.page_title}` : undefined}
                        onClick={() => {
                          const row = document.querySelector(`[data-block-id="${bl.id}"]`);
                          if (row) {
                            row.scrollIntoView({ block: "center", behavior: "smooth" });
                            setFocusedId(bl.id);
                          } else if (bl.page_root_id && bl.page_root_id !== focusedBlockId) {
                            pendingBlockScrollRef.current = bl.id;
                            openBlock(bl.page_root_id);
                          } else {
                            pendingBlockScrollRef.current = bl.id;
                            setBlocks((prev) => expandToBlock(prev, bl.id));
                          }
                        }}
                      >
                        <div className="backlinkContent">{bl.content || "(empty)"}</div>
                        {bl.page_title && bl.page_title !== bl.content ? (
                          <div className="backlinkPage">{bl.page_title}</div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {homeMode ? (() => {
              const sorted = [...homeBlocks].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
              // Group blocks by category (comma-separated — a page can be in multiple)
              const categories = {};
              const seenInCategory = new Set();
              for (const b of homeBlocks) {
                const raw = (b.properties?.category || "").trim();
                if (raw) {
                  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
                  for (const t of tags) {
                    if (!categories[t]) categories[t] = [];
                    categories[t].push(b);
                  }
                  seenInCategory.add(b.id);
                }
              }
              const uncategorized = homeBlocks.filter((b) => !seenInCategory.has(b.id));
              for (const cat of Object.keys(categories)) {
                categories[cat].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
              }
              const catNames = Object.keys(categories).sort();

              if (categoryFilter) {
                // Filtered view — show pages in this category only
                const filtered = categories[categoryFilter] || [];
                return (
                  <>
                    <button className="categoryBackBtn" onClick={() => { setCategoryFilter(""); window.history.replaceState(null, "", "/"); }}>
                      ← All pages
                    </button>
                    <div className="categoryFilterHeading">{categoryFilter}</div>
                    <div className="carouselRow">
                      <div className="carouselTrackWrap">
                        <div className="carouselTrack">
                          {filtered.map((b) => (
                            <button key={b.id} className="recentCard" onClick={() => openBlock(b.id)} title={b.content}>
                              <div className="recentCardTitle">{b.content || "Untitled"}</div>
                              <div className="recentCardMeta">
                                {b.properties?.summary && <span className="recentCardSummary">{b.properties.summary}</span>}
                                <span className="recentCardTime">{formatRelativeTime(b.updated_at)}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                );
              }

              return (
                <>
                  {/* Recent — all pages, scrollable carousel */}
                  <div className="carouselRow">
                    <div className="carouselLabel">Recent</div>
                    <div className="carouselTrackWrap">
                      <button className="carouselArrow carouselArrowLeft" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: -220, behavior: 'smooth' }); }}>‹</button>
                      <div className="carouselTrack" ref={(el) => { if (el) { el._scroll = el; } }}>
                        {sorted.map((b) => (
                          <button key={b.id} className="recentCard" onClick={() => openBlock(b.id)} title={b.content}>
                            <div className="recentCardTitle">{b.content || "Untitled"}</div>
                            <div className="recentCardMeta">
                              {b.properties?.summary && <span className="recentCardSummary">{b.properties.summary}</span>}
                              <span className="recentCardTime">{formatRelativeTime(b.updated_at)}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                      <button className="carouselArrow carouselArrowRight" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: 220, behavior: 'smooth' }); }}>›</button>
                    </div>
                  </div>
                  {/* Categories — one card per category */}
                  {catNames.length > 0 ? (
                    <div className="carouselRow">
                      <div className="carouselLabel">Categories</div>
                      <div className="carouselTrackWrap">
                        <button className="carouselArrow carouselArrowLeft" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: -220, behavior: 'smooth' }); }}>‹</button>
                        <div className="carouselTrack">
                          {catNames.map((cat) => (
                            <button key={cat} className="categoryCard" onClick={() => { setCategoryFilter(cat); window.history.replaceState(null, "", `/?category=${encodeURIComponent(cat)}`); }}>
                              <div className="categoryCardName">{cat}</div>
                              <div className="categoryCardCount">{categories[cat].length} {categories[cat].length === 1 ? "paper" : "papers"}</div>
                            </button>
                          ))}
                        </div>
                        <button className="carouselArrow carouselArrowRight" onClick={(e) => { const t = e.currentTarget.parentElement.querySelector('.carouselTrack'); if (t) t.scrollBy({ left: 220, behavior: 'smooth' }); }}>›</button>
                      </div>
                    </div>
                  ) : null}
                </>
              );
            })() : null}
            {homeMode && categoryFilter ? null : (
            (homeMode ? pageBlocks : visibleBlocks).length === 0 ? (
              <div className="empty">{homeMode ? "No pages yet — open a PDF above to get started." : "No blocks yet."}</div>
            ) : (
              (() => {
                const rowProps = {
                  homeMode,
                  focusedId,
                  setFocusedId,
                  onJump: jumpToHighlightId,
                  onEnterAttachMode: readOnly ? null : setAttachModeBlockId,
                  onUnlinkHighlight: readOnly ? null : unlinkHighlightFromBlock,
                  registerRef,
                  readOnly,
                  allBlocks: flattenBlocks(blocks),
                  highlightColors: Object.fromEntries(highlights.map(h => [h.id, h.color])),
                  refCache,
                  onFetchRefs,
                  onCacheRef,
                  onBlockRefClick: async (id) => {
                    function findBlock(list) {
                      for (const b of list || []) {
                        if (b.id === id) return b;
                        const found = findBlock(b.children || []);
                        if (found) return found;
                      }
                      return null;
                    }
                    if (findBlock(blocks)) {
                      suppressAutosaveRef.current = true;
                      pendingBlockScrollRef.current = id;
                      setBlocks((prev) => expandToBlock(prev, id));
                    } else {
                      pendingBlockScrollRef.current = id;
                      const cached = refCache[id];
                      const rootId = cached?.page_root_id;
                      if (rootId && rootId !== id) {
                        await openBlock(rootId);
                      } else {
                        await openBlock(id);
                      }
                    }
                  },
                  onPageOpen: (pageBlock) => {
                    if (pageBlock._pageId) openBlock(pageBlock._pageId);
                  },
                  onChangeText: (id, text) => {
                    if (readOnly) return;
                    if (homeMode) {
                      setHomeBlocks((prev) => prev.map((b) => b.id === id ? { ...b, content: text } : b));
                      if (pageTitleSaveTimerRef.current) clearTimeout(pageTitleSaveTimerRef.current);
                      pageTitleSaveTimerRef.current = setTimeout(() => {
                        apiJson(`${API}/blocks/${id}`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ content: text }),
                        }).catch((err) => setStatus(`Rename failed: ${err}`));
                      }, 500);
                      return;
                    }
                    setBlocks(setBlockText(blocks, id, text));
                  },
                  onStartEdit: (id, editMode) => {
                    if (readOnly) return;
                    if (homeMode) {
                      if (editMode) pendingFocusRef.current = id;
                      setHomeEditingId(editMode ? id : null);
                      return;
                    }
                    if (editMode) pendingFocusRef.current = id;
                    const next = setBlockEditMode(blocks, id, editMode);
                    setBlocks(next);
                    if (!editMode) {
                      persistBlocks(next).catch((err) => setStatus(`Save failed: ${err.message}`));
                    }
                  },
                  onEnterSibling: (id) => {
                    if (readOnly) return;
                    if (homeMode) {
                      const idx = pageBlocks.findIndex((b) => b.id === id);
                      if (idx < 0) return;
                      const before = pageBlocks[idx]._position || null;
                      const after = pageBlocks[idx + 1]?._position || null;
                      apiJson(`${API}/blocks`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ parent_id: "root", content: "", before, after }),
                      })
                        .then((created) => fetchHomeBlocks().then(() => {
                          pendingFocusRef.current = created.id;
                          setHomeEditingId(created.id);
                          setFocusedId(created.id);
                        }))
                        .catch((err) => setStatus(`Create failed: ${err}`));
                      return;
                    }
                    const { blocks: next, newId } = addSiblingBlock(blocks, id);
                    pendingFocusRef.current = newId;
                    setBlocks(next);
                    setFocusedId(newId);
                  },
                  onAddChild: (id) => {
                    if (readOnly) return;
                    const { blocks: next, newId } = addChildBlock(blocks, id);
                    pendingFocusRef.current = newId;
                    setBlocks(next);
                    setFocusedId(newId);
                  },
                  onIndent: (id) => {
                    if (readOnly || homeMode) return;
                    const next = indentBlock(blocks, id);
                    setBlocks(next);
                    setFocusedId(id);
                  },
                  onOutdent: (id) => {
                    if (readOnly || homeMode) return;
                    const next = outdentBlock(blocks, id);
                    setBlocks(next);
                    setFocusedId(id);
                  },
                  onToggle: (id) => {
                    const next = toggleCollapsed(blocks, id);
                    setBlocks(next);
                  },
                  onDelete: (id) => {
                    if (readOnly) return;
                    if (homeMode) {
                      apiJson(`${API}/blocks/${id}`, { method: "DELETE" })
                        .then(() => fetchHomeBlocks())
                        .catch((err) => setStatus(`Delete failed: ${err}`));
                      return;
                    }
                    apiJson(`${API}/blocks/${id}`, { method: "DELETE" })
                      .catch((err) => setStatus(`Delete failed: ${err}`));
                    setBlocks(removeBlockTree(blocks, id));
                  },
                  onBlockDragOver: (e, block) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const wrap = e.currentTarget.closest(".sortableBlockWrap");
                    const r = wrap ? wrap.getBoundingClientRect() : e.currentTarget.getBoundingClientRect();
                    const px = e.clientX;
                    const py = e.clientY;
                    const above = (py - r.top) <= 16;
                    const td = parseInt((wrap || e.currentTarget).getAttribute("data-depth") || "0", 10);
                    const nested = (px - r.left) > 50;
                    const dt = { targetId: block.id, above, depth: nested ? td + 1 : td, rect: { top: r.top, left: r.left, width: r.width, bottom: r.bottom } };
                    _dragState.dropTarget = dt;
                    setDropTarget(dt);
                  },
                  onBlockDragLeave: () => {
                    setDropTarget(null);
                    _dragState.dropTarget = null;
                  },
                  onBlockDrop: (e, block) => {
                    e.preventDefault();
                    const dt = _dragState.dropTarget;
                    setDropTarget(null);
                    _dragState.dropTarget = null;
                    const sourceId = e.dataTransfer.getData("text/plain");
                    if (!sourceId || !dt || sourceId === dt.targetId || readOnly) return;
                    if (homeMode) {
                      const pages = [...pageBlocks];
                      const srcIdx = pages.findIndex((b) => b.id === sourceId);
                      const tgtIdx = pages.findIndex((b) => b.id === dt.targetId);
                      if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
                      const remaining = pages.filter((_, i) => i !== srcIdx);
                      const adjTgt = tgtIdx > srcIdx ? tgtIdx - 1 : tgtIdx;
                      const dropIdx = dt.above ? adjTgt : adjTgt + 1;
                      const before = remaining[dropIdx - 1]?._position ?? null;
                      const after = remaining[dropIdx]?._position ?? null;
                      const pageId = pages[srcIdx]._pageId;
                      if (!pageId) return;
                      apiJson(`${API}/blocks/${pageId}/reorder`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ before, after }),
                      }).then(() => fetchHomeBlocks()).catch((err) => setStatus(`Reorder failed: ${err}`));
                      return;
                    }
                    if (isDescendant(blocks, sourceId, dt.targetId)) return;
                    const extracted = extractBlock(blocks, sourceId);
                    if (!extracted) return;
                    const { extracted: sourceBlock, remaining } = extracted;
                    const targetCtx = findBlockContext(remaining, dt.targetId);
                    if (!targetCtx) return;
                    const targetDepth = targetCtx.depth;
                    let next;
                    if (dt.depth === targetDepth + 1) {
                      next = insertChild(remaining, dt.targetId, sourceBlock, false);
                    } else if (dt.depth === targetDepth) {
                      next = insertSibling(remaining, dt.targetId, sourceBlock, !dt.above);
                    } else if (dt.depth < targetDepth) {
                      const ancestorId = targetCtx.ancestors[dt.depth];
                      if (!ancestorId) return;
                      next = insertSibling(remaining, ancestorId, sourceBlock, !dt.above);
                    } else { return; }
                    if (next) setBlocks(next);
                    _dragState.draggingId = null;
                  },
                };
                return (
                  <>
                    <BlockTree blocks={homeMode ? pageBlocks : blocks} readOnly={readOnly} rowProps={rowProps} />
                    {dropTarget && (() => {
                      const indentStep = 14;
                      const baseOffset = 28;
                      const lineLeft = dropTarget.rect.left + baseOffset + dropTarget.depth * indentStep;
                      return (
                        <div
                          className="dropIndicator"
                          style={{
                            position: "fixed",
                            top: dropTarget.above ? dropTarget.rect.top : dropTarget.rect.bottom,
                            left: lineLeft,
                            width: Math.max(40, dropTarget.rect.width - (baseOffset + dropTarget.depth * indentStep)),
                            height: 2,
                            background: "#4a9eff",
                            pointerEvents: "none",
                            zIndex: 1000,
                            transform: "translateY(-1px)",
                            transition: "left 25ms ease-out",
                          }}
                        />
                      );
                    })()}
                  </>
                );
              })()
            ))}
          </div>

          {!homeMode && !readOnly ? (
            <>
              {!chatHidden ? (
                <div className="chatSplitter" onPointerDown={startChatResize} aria-label="Drag to resize chat" role="separator">
                  <span className="chatSplitterDot" />
                </div>
              ) : null}
              {!chatHidden ? (
                <div className="chatPanel" style={{ height: chatHeight }}>
                  <div className="chatPanelHeader">
                    <span className="chatPanelTitle">AI Chat</span>
                    <div className="chatPanelHeaderBtns">
                      <button className="chatClearBtn" onClick={clearChat} title="Clear chat">Clear</button>
                      <button className="chatHideBtn" onClick={() => setChatHidden(true)} title="Hide chat">×</button>
                    </div>
                  </div>
                  <div className="chatMessages">
                    {chatMessages.length === 0 ? (
                      <div className="chatEmpty">Ask AI about this page…</div>
                    ) : (
                      chatMessages.map((m, i) => (
                        <div key={i} className={`chatMsg ${m.role}`}>
                          <div className="chatMsgText">{m.text}</div>
                        </div>
                      ))
                    )}
                    {chatLoading ? <div className="chatMsg ai"><div className="chatMsgText">…</div></div> : null}
                  </div>
                  <form
                    className="chatInputRow"
                    onSubmit={(e) => { e.preventDefault(); sendChatMessage(); }}
                  >
                    <input
                      className="chatInput"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Ask about this page…"
                      disabled={chatLoading}
                    />
                    <button className="chatSendBtn" type="submit" disabled={chatLoading || !chatInput.trim()}>Send</button>
                  </form>
                </div>
              ) : (
                <div className="chatHiddenBar">
                  <button className="chatShowBtn" onClick={() => setChatHidden(false)}>Show AI Chat</button>
                </div>
              )}
            </>
          ) : null}

        </div>)}
      </div>
      {highlightMenu ? (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setHighlightMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setHighlightMenu(null); }}
          />
          <div
            style={{
              position: "fixed",
              left: highlightMenu.x,
              top: highlightMenu.y,
              zIndex: 1000,
              background: "#222",
              border: "1px solid #444",
              borderRadius: 6,
              padding: "4px 0",
              minWidth: 120,
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
            }}
          >
            <div style={{ padding: "6px 10px 4px", borderBottom: "1px solid #444", display: "flex", gap: 6 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    changeHighlightColor(highlightMenu.id, c);
                    setHighlightMenu(null);
                  }}
                  title="Change color"
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: c,
                    border: "2px solid #555",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0
                  }}
                />
              ))}
            </div>
            <button
              onClick={() => {
                deleteHighlight(highlightMenu.id);
                setHighlightMenu(null);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 14px",
                background: "transparent",
                color: "#eee",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                fontSize: 14
              }}
            >
              Delete
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

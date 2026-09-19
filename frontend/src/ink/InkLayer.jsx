// Handwriting on the PDF (docs/dev/handwriting.md): InkLayer is one page's
// ink — the retained strokes as SVG paths in the page's scale-1 frame
// (the viewBox does the zoom), a low-latency canvas for the stroke (or
// lasso) being drawn, and the pointer handling that turns a pen (or, with
// a tool armed, any pointer) into samples, erasures, a lasso selection or
// a move of that selection. InkCard is the same strokes as a picture in
// the notes; InkToolbar the tool strip. Strokes come from inkStore (drafts
// ahead of uploads, files behind block URLs); App owns the tool state,
// the selection, the stroke history and the commits.
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenu } from "../shared/ui/Menus";
import { getStroke } from "perfect-freehand";
import {
  CopyIcon, ErasePartialIcon, EraserIcon, EraseStrokeIcon, HandIcon, HighlightIcon, LassoIcon, PenIcon,
  FileTextIcon, LineWidthIcon, PaletteIcon, RectSelectIcon, RedoIcon, ResizeIcon, TrashIcon, UndoIcon, XIcon,
} from "../shared/ui/Icons";
import {
  HIGHLIGHTER_COLORS, HIGHLIGHTER_OPACITY, MAX_STROKE_SIZE, MAX_TOOLS, PEN_COLORS, boundsOf, encodeStroke, hitStrokes,
  inkBounds, nearestInkStroke, outlineOptions, sizesFor, strokePath, strokesInLasso, svgPathFromPoints, toolId,
  transformPoint, unionBox,
} from "./ink";
import * as inkStore from "./inkStore";
import { appendInkSample, predictedInkSamples } from "./inkInput.js";
import { canvasSize } from "../shared/lib/canvasSize.js";

// Re-render when any draft or file changes.
function useInkVersion() {
  const [v, setV] = useState(inkStore.currentVersion());
  useEffect(() => inkStore.subscribe(setV), []);
  return v;
}

// Eraser radius on screen (css px) per S/M/L index.
export const ERASER_SIZES = [5, 9, 16];
const SIZE_LABELS = ["Small", "Medium", "Large"];

function Strokes({ ink, onClick, hide }) {
  return ink.strokes.map((s) => {
    if (hide?.has(s.id)) return null;
    const p = strokePath(s);
    return p.stroke ? (
      <path key={s.id} d={p.d} fill="none" stroke={s.color} strokeWidth={p.width} strokeOpacity={s.opacity}
        strokeLinecap="round" strokeLinejoin="round" style={{ mixBlendMode: "multiply" }} onClick={onClick} />
    ) : (
      <path key={s.id} d={p.d} fill={s.color} fillOpacity={s.opacity} onClick={onClick} />
    );
  });
}

// tool: the armed tool {tool: pen|highlighter|eraser|select, color, size}
// or null; penTool: what a stylus draws with when nothing is armed;
// eraserMode: "stroke" (whole strokes) | "partial" (cuts through them),
// eraserSize its S/M/L index; lassoMode: "free" (a drawn loop) | "box";
// blocks: this page's ink blocks; selection: {page, items: [{id, ids}]};
// flash: {id, nonce} outlines a group briefly.
export function InkLayer({ pageNumber, wrapRef, width, height, blocks, tool, penTool, penOnly, pressure, eraserMode,
  eraserSize = 1, lassoMode = "free", selection, flash, onStroke, onErase, onErasePartial, onSelect, onAction, onMoveSelection, onJump }) {
  useInkVersion();
  const canvasRef = useRef(null);
  const cursorRef = useRef(null);
  const refreshCursorRef = useRef(null);
  const [dragOffset, setDragOffset] = useState(null);   // while moving the selection: {dx, dy} in pt
  const [transform, setTransform] = useState(null);
  useLayoutEffect(() => { setTransform(null); }, [selection]);
  const live = useRef({});

  const groups = [];
  for (const b of blocks || []) {
    const ink = inkStore.inkFor(b);
    if (ink?.strokes?.length) groups.push({ id: b.id, ink });
  }
  // This page's selection: the ids per group and their box.
  const sel = selection && selection.page === pageNumber ? selection : null;
  const selectedIds = new Set();
  let selBox = null;
  if (sel) {
    for (const item of sel.items) {
      const g = groups.find((x) => x.id === item.id);
      if (!g) continue;
      item.ids.forEach((id) => selectedIds.add(id));
      selBox = unionBox(selBox, boundsOf(g.ink, item.ids));
    }
  }
  live.current = { tool, penTool, penOnly, pressure, eraserMode, eraserSize, lassoMode, width, height, groups, selBox,
    onStroke, onErase, onErasePartial, onSelect, onMoveSelection };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let drawing = null; // {mode: stroke|erase|lasso|move, …}
    let pending = null; // A possible tap/hold; swipes retain native scrolling.
    const contacts = new Set();
    let hover = null;
    const hideCursor = () => {
      hover = null;
      if (cursorRef.current) cursorRef.current.style.display = "none";
      el.classList.remove("inkHovering");
    };
    const showCursor = (e) => {
      if (e.pointerType === "touch" || e.target.closest?.(".inkSelectionHit, .inkTransformHandle, .inkEditMenu")) { hideCursor(); return; }
      const L = live.current, use = L.tool || (e.pointerType === "pen" ? L.penTool : null);
      if (!use || !L.width || !cursorRef.current) { hideCursor(); return; }
      const rect = el.getBoundingClientRect(), k = rect.width / L.width;
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) { hideCursor(); return; }
      const eraser = use.tool === "eraser" || !!(e.buttons & 34);
      const diameter = eraser ? 2 * (ERASER_SIZES[L.eraserSize] ?? ERASER_SIZES[1])
        : use.tool === "select" ? 12 : use.size * k;
      const cursor = cursorRef.current;
      cursor.dataset.tool = eraser ? "eraser" : use.tool;
      Object.assign(cursor.style, { display: "block", left: `${x}px`, top: `${y}px`,
        width: `${Math.max(1, diameter)}px`, height: `${Math.max(1, diameter)}px` });
      el.classList.add("inkHovering");
      hover = e;
    };
    // Tool changes and zooms update a stationary pointer as well.
    refreshCursorRef.current = () => { if (hover) showCursor(hover); };
    const clearPending = (revert = false) => {
      clearTimeout(pending?.timer);
      if (revert && pending?.shown) live.current.onSelect?.(pageNumber, []);
      pending = null;
    };
    const trackDown = (e) => {
      contacts.add(e.pointerId);
      if (pending && pending.id !== e.pointerId) clearPending(true);
    };
    const trackUp = (e) => contacts.delete(e.pointerId);

    const setup = (e, forcedTool) => {
      const L = live.current;
      if (!L.width) return null;
      let use = forcedTool || L.tool;
      if (!use) {
        if (!(L.penTool && e.pointerType === "pen")) return null;
        use = L.penTool;
      }
      if (!forcedTool && L.penOnly && e.pointerType === "touch") return null;
      if (e.button !== 0 && !(e.pointerType === "pen" && (e.buttons & 34))) return null;
      const rect = el.getBoundingClientRect();
      const k = rect.width / L.width;                             // css px per pt
      const eraser = use.tool === "eraser" || !!(e.buttons & 32) || !!(e.buttons & 2);
      return { use, eraser, rect, k, pointerType: e.pointerType,
        toPt: (ev) => ({ x: (ev.clientX - rect.left) / k, y: (ev.clientY - rect.top) / k }) };
    };

    const eraseUnder = (ctx, ev) => {
      const { x, y } = ctx.toPt(ev);
      const L = live.current;
      const r = (ERASER_SIZES[L.eraserSize] ?? ERASER_SIZES[1]) / ctx.k;
      for (const g of L.groups) {
        if (L.eraserMode === "partial") { L.onErasePartial?.(pageNumber, g.id, x, y, r); continue; }
        const ids = hitStrokes(g.ink, x, y, r);
        if (ids.length) L.onErase?.(pageNumber, g.id, ids);
      }
    };

    const canvasCtx = (d) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext("2d", { desynchronized: true });
      if (!ctx) return null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / d.rect.width * d.k, 0, 0, canvas.height / d.rect.height * d.k, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.setLineDash([]);
      return ctx;
    };
    const paint = () => {
      const d = drawing;
      if (!d) return;
      d.raf = 0;
      const ctx = canvasCtx(d);
      if (!ctx) return;
      if (d.mode === "lasso") {
        ctx.strokeStyle = "rgba(80, 140, 255, 0.95)";
        ctx.lineWidth = 1 / d.k;
        ctx.setLineDash([4 / d.k, 3 / d.k]);
        ctx.beginPath();
        d.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
        return;
      }
      const { use } = d;
      if (use.tool === "highlighter") {
        ctx.globalAlpha = use.opacity ?? 1;
        ctx.globalCompositeOperation = "multiply";
        ctx.strokeStyle = use.color;
        ctx.lineWidth = use.size;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.beginPath();
        d.samples.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y)));
        if (d.samples.length === 1) ctx.lineTo(d.samples[0].x + 0.01, d.samples[0].y);
        ctx.stroke();
      } else {
        ctx.fillStyle = use.color;
        const pts = getStroke([...d.samples, ...(d.predicted || [])].map((s) => [s.x, s.y, s.p]),
          outlineOptions({ size: use.size, pen: d.pen }));
        ctx.fill(new Path2D(svgPathFromPoints(pts)));
      }
    };
    const showCanvas = (ctx) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const size = canvasSize(ctx.rect.width, ctx.rect.height, window.devicePixelRatio || 1);
      canvas.width = 0; canvas.height = size.height; canvas.width = size.width;
      canvas.style.display = "block";
    };
    const hideCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = 0; canvas.height = 0;
      canvas.style.display = "none";
    };

    const onDown = (e) => {
      // Menu controls are portalled; React events must not start page ink.
      if (e.target.closest?.(".inkEditMenu, .inkTransformHandle")) { hideCursor(); return; }
      showCursor(e);
      const L = live.current;
      const selectionDrag = !!L.onSelect && e.target.closest?.(".inkSelectionHit")
        && (e.pointerType === "touch" || !L.tool || L.tool.tool === "select") && e.pointerType !== "pen";
      const ctx = setup(e, selectionDrag ? { tool: "select" } : null);
      // A pen takes priority even if the palm landed first in finger-draw mode.
      if (drawing?.pointerType === "touch" && e.pointerType === "pen" && ctx) {
        finish({ pointerId: drawing.id }, true);
      }
      if (drawing) {
        if (drawing.pointerType === "pen" && e.pointerType === "touch") {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (contacts.size > 1 && e.pointerType === "touch") return;
      const navigation = e.pointerType === "touch" ? (L.penOnly || !L.tool) : e.pointerType === "mouse" && !L.tool;
      if (!selectionDrag && navigation && L.onSelect && L.width && e.button === 0) {
        clearPending();
        const probe = setup(e, { tool: "select" });
        if (!probe) return;
        const pt = probe.toPt(e);
        const hit = nearestInkStroke(L.groups, pt.x, pt.y, (e.pointerType === "touch" ? 10 : 5) / probe.k);
        pending = { id: e.pointerId, x: e.clientX, y: e.clientY, hit, shown: false };
        if (hit && e.pointerType === "touch") {
          pending.timer = setTimeout(() => {
            if (!pending || drawing) return;
            pending.shown = true;
            live.current.onSelect?.(pageNumber, [pending.hit]);
          }, 450);
        }
        // Leave default touch behavior intact so scrolling can cancel the tap.
        if (hit || L.selBox) e.stopPropagation();
        return;
      }
      if (!ctx) return;
      clearPending();
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
      if (ctx.eraser) {
        drawing = { ...ctx, id: e.pointerId, mode: "erase" };
        eraseUnder(ctx, e);
        return;
      }
      if (ctx.use.tool === "select") {
        const pt = ctx.toPt(e), box = live.current.selBox;
        if (box && pt.x >= box[0] && pt.x <= box[2] && pt.y >= box[1] && pt.y <= box[3]) {
          drawing = { ...ctx, id: e.pointerId, mode: "move", start: pt, dx: 0, dy: 0 };
          return;
        }
        showCanvas(ctx);
        drawing = { ...ctx, id: e.pointerId, mode: "lasso", box: live.current.lassoMode === "box", start: pt,
          poly: [[pt.x, pt.y]], raf: 0 };
        return;
      }
      L.onSelect?.(pageNumber, []);
      showCanvas(ctx);
      drawing = { ...ctx, id: e.pointerId, mode: "stroke", samples: [], t0: Date.now(),
        startTime: e.timeStamp, pressure: live.current.pressure, pen: e.pointerType === "pen", raf: 0 };
      appendInkSample(drawing, e);
      paint();
    };
    const onMove = (e) => {
      showCursor(e);
      if (pending?.id === e.pointerId && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 8) clearPending(true);
      const d = drawing;
      if (!d || e.pointerId !== d.id) return;
      e.preventDefault();
      if (d.mode === "erase") { eraseUnder(d, e); return; }
      if (d.mode === "move") {
        const pt = d.toPt(e);
        d.dx = pt.x - d.start.x;
        d.dy = pt.y - d.start.y;
        if (!d.raf) d.raf = requestAnimationFrame(() => { d.raf = 0; setDragOffset({ dx: d.dx, dy: d.dy }); });
        return;
      }
      const events = e.getCoalescedEvents?.() || [];
      for (const ev of events.length ? events : [e]) {
        if (d.mode === "lasso") {
          const pt = d.toPt(ev);
          // A box is the rectangle from the start to the pointer, as a polygon.
          if (d.box) d.poly = [[d.start.x, d.start.y], [pt.x, d.start.y], [pt.x, pt.y], [d.start.x, pt.y]];
          else d.poly.push([pt.x, pt.y]);
        } else appendInkSample(d, ev);
      }
      if (d.mode === "stroke") {
        d.predicted = predictedInkSamples(d, e);
        clearTimeout(d.predictionTimer);
        if (d.predicted.length) d.predictionTimer = setTimeout(() => {
          if (drawing !== d) return;
          d.predicted = [];
          if (!d.raf) d.raf = requestAnimationFrame(paint);
        }, 32);
      }
      if (!d.raf) d.raf = requestAnimationFrame(paint);
    };
    const swallowClick = () => {
      // The click this pointer-up would deliver to whatever lies under it
      // (a highlight rect, a link box) is not a click on that thing.
      const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 0);
    };
    const finish = (e, cancelled) => {
      if (pending?.id === e.pointerId) {
        const p = pending;
        const isTap = !cancelled && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 8;
        clearPending(cancelled);
        if (isTap) {
          live.current.onSelect?.(pageNumber, p.hit ? [p.hit] : []);
          if (p.hit || live.current.selBox) { e.preventDefault(); e.stopPropagation(); swallowClick(); }
        }
        return;
      }
      const d = drawing;
      if (!d || e.pointerId !== d.id) return;
      drawing = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (d.raf) cancelAnimationFrame(d.raf);
      clearTimeout(d.predictionTimer);
      const L = live.current;
      if (d.mode === "erase") { if (!cancelled) swallowClick(); return; }
      if (d.mode === "move") {
        setDragOffset(null);
        if (!cancelled) {
          const pt = d.toPt(e);
          d.dx = pt.x - d.start.x; d.dy = pt.y - d.start.y;
        }
        if (!cancelled && (Math.abs(d.dx) > 0.5 || Math.abs(d.dy) > 0.5)) L.onMoveSelection?.(pageNumber, d.dx, d.dy);
        swallowClick();
        return;
      }
      hideCanvas();
      if (cancelled) return;
      swallowClick();
      if (d.mode === "lasso") {
        const items = [];
        if (d.poly.every(([x, y]) => Math.hypot(x - d.start.x, y - d.start.y) * d.k <= 8)) {
          const hit = nearestInkStroke(L.groups, d.start.x, d.start.y, 10 / d.k);
          if (hit) items.push(hit);
        } else if (d.poly.length >= 3) {
          for (const g of L.groups) {
            const ids = strokesInLasso(g.ink, d.poly);
            if (ids.length) items.push({ id: g.id, ids });
          }
        }
        L.onSelect?.(pageNumber, items);
        return;
      }
      if (!d.samples.length) return;
      appendInkSample(d, e, true);
      const { use } = d;
      const stroke = encodeStroke({
        tool: use.tool, color: use.color, size: use.size, opacity: use.opacity ?? 1, pen: d.pen,
        t0: d.t0, samples: d.samples, ch: d.pen ? "xypt" : "xyt",
      });
      L.onStroke?.(pageNumber, stroke, { width: L.width, height: L.height });
    };
    const onUp = (e) => finish(e, false);
    const onCancel = (e) => { contacts.delete(e.pointerId); finish(e, true); hideCursor(); };
    // iPad Safari can pan with Pencil even after pointerdown.preventDefault().
    // Cancel its matching touch gesture before scrolling cancels the pointer
    // stream. Keep touch-action available for finger scrolling and pinch zoom.
    const onTouch = (e) => {
      const L = live.current;
      if (!L.width || !(L.tool || L.penTool)) return;
      const pencil = Array.from(e.changedTouches).some((t) =>
        t.touchType === "stylus" || (!t.touchType && drawing?.pointerType === "pen"));
      // While the pen is down, direct contacts are palms, not pan/pinch.
      // As soon as it lifts, fingers can navigate again.
      if (e.touches.length > 1) clearPending(true);
      if (!pencil && drawing?.pointerType !== "pen" && drawing?.mode !== "move") return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation(); // Do not feed Pencil into the viewer's pan/pinch handlers.
    };
    el.addEventListener("touchstart", onTouch, { capture: true, passive: false });
    el.addEventListener("touchmove", onTouch, { capture: true, passive: false });
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", hideCursor);
    const resizeObserver = new ResizeObserver(() => { if (hover) showCursor(hover); });
    resizeObserver.observe(el);
    window.addEventListener("scroll", hideCursor, true);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("lostpointercapture", onCancel);
    const onContext = (e) => {
      if (pending?.hit || e.target.closest?.(".inkSelectionHit")) e.preventDefault();
    };
    const onBlur = () => { hideCursor(); clearPending(true); contacts.clear(); if (drawing) finish({ pointerId: drawing.id }, true); };
    el.addEventListener("contextmenu", onContext);
    document.addEventListener("pointerdown", trackDown, true);
    document.addEventListener("pointerup", trackUp, true);
    document.addEventListener("pointercancel", trackUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      el.removeEventListener("touchstart", onTouch, true);
      el.removeEventListener("touchmove", onTouch, true);
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", hideCursor);
      window.removeEventListener("scroll", hideCursor, true);
      resizeObserver.disconnect();
      hideCursor();
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("blur", onBlur);
      el.removeEventListener("contextmenu", onContext);
      document.removeEventListener("pointerdown", trackDown, true);
      document.removeEventListener("pointerup", trackUp, true);
      document.removeEventListener("pointercancel", trackUp, true);
      clearPending();
      if (drawing?.raf) cancelAnimationFrame(drawing.raf);
      clearTimeout(drawing?.predictionTimer);
      if (drawing) {
        try { el.releasePointerCapture(drawing.id); } catch { /* already released */ }
      }
      hideCanvas();
    };
  }, [wrapRef, pageNumber]);

  useEffect(() => { refreshCursorRef.current?.(); }, [tool, penTool, eraserSize]);

  if (!width || !height) return null;
  const flashGroup = flash && groups.find((g) => g.id === flash.id);
  const fb = flashGroup ? inkBounds(flashGroup.ink) : null;
  const armed = !!tool;
  const dragging = !!((dragOffset || transform) && selectedIds.size);
  const previewTransform = transform
    ? `translate(${transform.cx} ${transform.cy}) rotate(${transform.angle * 180 / Math.PI}) scale(${transform.scale}) translate(${-transform.cx} ${-transform.cy})`
    : `translate(${dragOffset?.dx || 0} ${dragOffset?.dy || 0})`;
  // Controls follow the same preview as the ink, but retain their screen
  // size. Keep selBox unchanged: gesture math uses the original geometry.
  const previewPoint = (x, y) => transform ? transformPoint(x, y, transform)
    : [x + (dragOffset?.dx || 0), y + (dragOffset?.dy || 0)];
  const handlePositions = selBox ? {
    resize: previewPoint(selBox[2], selBox[3]), rotate: previewPoint(selBox[2], selBox[1]),
  } : null;
  const hitCorners = selBox ? [[selBox[0] - 4, selBox[1] - 4], [selBox[2] + 4, selBox[1] - 4],
    [selBox[2] + 4, selBox[3] + 4], [selBox[0] - 4, selBox[3] + 4]].map(([x, y]) => previewPoint(x, y)) : null;
  const hitBox = hitCorners ? [Math.min(...hitCorners.map(([x]) => x)), Math.min(...hitCorners.map(([, y]) => y)),
    Math.max(...hitCorners.map(([x]) => x)), Math.max(...hitCorners.map(([, y]) => y))] : null;
  return (
    <>
      <svg className="inkLayer" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {groups.map((g) => (
          <g key={g.id} data-ink-id={g.id}
            style={{ pointerEvents: armed || !onJump ? "none" : "visiblePainted", cursor: "pointer" }}>
            <Strokes ink={g.ink} hide={dragging ? selectedIds : null}
              onClick={!onSelect && onJump ? (e) => { e.stopPropagation(); onJump(g.id); } : undefined} />
          </g>
        ))}
        {dragging ? (
          <g transform={previewTransform}>
            {groups.map((g) => (
              <Strokes key={g.id} ink={{ strokes: g.ink.strokes.filter((s) => selectedIds.has(s.id)) }} />
            ))}
          </g>
        ) : null}
        {selBox ? (
          <rect className="inkSelRect" data-ink-selection="true"
            transform={previewTransform}
            x={selBox[0] - 4} y={selBox[1] - 4}
            width={selBox[2] - selBox[0] + 8} height={selBox[3] - selBox[1] + 8} rx={3} />
        ) : null}
        {fb ? (
          <rect key={flash.nonce} className="inkFlash" x={fb[0] - 6} y={fb[1] - 6}
            width={fb[2] - fb[0] + 12} height={fb[3] - fb[1] + 12} rx={4} />
        ) : null}
      </svg>
      {selBox && onSelect ? <div className="inkSelectionHit" aria-label="Move selected handwriting"
        style={{ left: `${hitBox[0] / width * 100}%`, top: `${hitBox[1] / height * 100}%`,
          width: `${(hitBox[2] - hitBox[0]) / width * 100}%`, height: `${(hitBox[3] - hitBox[1]) / height * 100}%` }} /> : null}
      {selBox && onAction && !dragging ? <InkSelectionMenu wrapRef={wrapRef} box={selBox} width={width}
        strokes={groups.flatMap((g) => g.ink.strokes.filter((s) => selectedIds.has(s.id)))}
        onAction={onAction} onClose={() => onSelect(pageNumber, [])} /> : null}
      {selBox && onAction ? <InkTransformHandles wrapRef={wrapRef} box={selBox} width={width} height={height}
        positions={handlePositions}
        maxScale={Math.min(10, MAX_STROKE_SIZE / Math.max(...groups.flatMap((g) => g.ink.strokes.filter((s) => selectedIds.has(s.id)).map((s) => s.size))))}
        onPreview={setTransform} onCommit={(value) => onAction("transform", value)} /> : null}
      <canvas ref={canvasRef} className="inkCanvas" />
      <div ref={cursorRef} className="inkCursor" aria-hidden="true"><span /></div>
    </>
  );
}

function InkTransformHandles({ wrapRef, box, width, height, positions, maxScale, onPreview, onCommit }) {
  const drag = useRef(null);
  const cancel = () => { drag.current = null; onPreview(null); };
  useEffect(() => {
    const escape = (e) => { if (e.key === "Escape") cancel(); };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => { drag.current = null; window.removeEventListener("blur", cancel); window.removeEventListener("keydown", escape); };
  }, []);
  const valueAt = (e) => {
    const d = drag.current;
    const x = (e.clientX - d.rect.left) / d.k - d.cx, y = (e.clientY - d.rect.top) / d.k - d.cy;
    let angle = Math.atan2(y, x) - d.startAngle;
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    if (e.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
    return { cx: d.cx, cy: d.cy, angle: d.mode === "rotate" ? angle : 0,
      scale: d.mode === "resize" ? Math.max(0.1, Math.min(d.maxScale, Math.hypot(x, y) / d.radius)) : 1 };
  };
  const begin = (e, mode) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault(); e.stopPropagation();
    const rect = wrapRef.current.getBoundingClientRect(), k = rect.width / width;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const x = (e.clientX - rect.left) / k - cx, y = (e.clientY - rect.top) / k - cy;
    drag.current = { id: e.pointerId, mode, rect, k, cx, cy, radius: Math.max(0.01, Math.hypot(x, y)), startAngle: Math.atan2(y, x), maxScale };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (drag.current?.id !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation(); onPreview(valueAt(e));
  };
  const finish = (e) => {
    if (drag.current?.id !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    const value = valueAt(e);
    cancel();
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (Math.abs(value.scale - 1) > 0.001 || Math.abs(value.angle) > 0.001) onCommit(value);
  };
  return <>
    {["resize", "rotate"].map((mode) => <button key={mode} type="button" className={`inkTransformHandle inkTransform-${mode}`}
      aria-label={mode === "resize" ? "Resize selected handwriting" : "Rotate selected handwriting"}
      title={mode === "resize" ? "Drag to resize; arrow keys change size" : "Drag to rotate; hold Shift to snap to 15°; arrow keys rotate"}
      style={{ left: `${positions[mode][0] / width * 100}%`, top: `${positions[mode][1] / height * 100}%` }}
      onPointerDown={(e) => begin(e, mode)} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={cancel} onLostPointerCapture={cancel} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const sign = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1;
        onCommit({ cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2,
          scale: mode === "resize" ? Math.min(maxScale, sign > 0 ? 1.1 : 1 / 1.1) : 1,
          angle: mode === "rotate" ? sign * Math.PI / 12 : 0 });
      }}>{mode === "resize" ? <ResizeIcon /> : <RedoIcon />}</button>)}
  </>;
}

// Native title tooltips are inconsistent for Pencil hover. Use the same
// descriptions for mouse, pen and keyboard focus, outside clipped toolbars.
function InkTooltips({ children, contentRef, ...props }) {
  const id = useId(), [tip, setTip] = useState(null), active = useRef(null), timer = useRef(null);
  const clear = () => { clearTimeout(timer.current); active.current?.removeAttribute("aria-describedby"); active.current = null; setTip(null); };
  useEffect(() => {
    window.addEventListener("scroll", clear, true);
    window.addEventListener("blur", clear);
    return () => { clearTimeout(timer.current); window.removeEventListener("scroll", clear, true); window.removeEventListener("blur", clear); };
  }, []);
  const show = (e) => {
    if (e.pointerType === "touch") return;
    const target = e.target.closest("button, label[title]");
    if (!target || target === active.current) return;
    clear(); active.current = target;
    const description = target.title || target.getAttribute("aria-label");
    if (!description) return;
    timer.current = setTimeout(() => {
      const r = target.getBoundingClientRect();
      target.setAttribute("aria-describedby", id);
      setTip({ text: description, x: Math.max(8, Math.min(r.left, window.innerWidth - 288)),
        y: r.bottom + 8, above: r.bottom > window.innerHeight - 100, top: r.top - 8 });
    }, e.type === "focus" ? 0 : 250);
  };
  return <><div {...props} ref={contentRef} onPointerOver={show} onPointerLeave={clear} onFocus={show} onBlur={clear}
    onPointerDownCapture={clear}>{children}</div>
    {tip ? createPortal(<div id={id} role="tooltip" className="inkTooltip" style={{ left: tip.x, top: tip.above ? tip.top : tip.y,
      transform: tip.above ? "translateY(-100%)" : undefined }}>{tip.text}</div>, document.body) : null}</>;
}

function InkSelectionMenu({ wrapRef, box, width, strokes, onAction, onClose }) {
  const [anchor, setAnchor] = useState(null);
  const [options, setOptions] = useState(null);
  const contentRef = useRef(null);
  const [menuHeight, setMenuHeight] = useState(96);
  useLayoutEffect(() => {
    const el = contentRef.current?.closest(".ctxMenu");
    if (!el) return;
    const observer = new ResizeObserver(() => setMenuHeight(el.getBoundingClientRect().height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [!!anchor]);
  const [x0, y0, x1, y1] = box;
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect(), viewport = el.closest(".pdfViewer").getBoundingClientRect();
      const k = rect.width / width;
      const left = rect.left + x0 * k, top = rect.top + y0 * k, bottom = rect.top + y1 * k;
      const y = top - menuHeight - 40 >= viewport.top + 8 ? top - menuHeight - 40
        : bottom + menuHeight + 40 <= viewport.bottom - 8 ? bottom + 40
        : Math.max(viewport.top + 8, Math.min(top - menuHeight - 40, viewport.bottom - menuHeight - 8));
      const next = bottom < viewport.top || top > viewport.bottom || rect.left + x1 * k < viewport.left || left > viewport.right
        ? null : { x: Math.max(viewport.left + 8, left), y, k };
      setAnchor((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [wrapRef, width, x0, y0, x1, y1, menuHeight]);
  if (!anchor) return null;
  const kinds = [...new Set(strokes.map((s) => s.tool))];
  return <ContextMenu x={anchor.x} y={anchor.y} ignoreRef={wrapRef} onClose={onClose} className="inkEditMenu">
    <InkTooltips contentRef={contentRef} role="toolbar" aria-label="Edit handwriting" onPointerDown={(e) => e.stopPropagation()}>
      <div className="inkEditRow">
        <button className={"ctlBtn" + (options === "color" ? " modeActive" : "")} aria-label="Color" title="Color" aria-expanded={options === "color"} onClick={() => setOptions(options === "color" ? null : "color")}><PaletteIcon aria-hidden="true" /></button>
        <button className={"ctlBtn" + (options === "width" ? " modeActive" : "")} aria-label="Width" title="Width" aria-expanded={options === "width"} onClick={() => setOptions(options === "width" ? null : "width")}><LineWidthIcon aria-hidden="true" /></button>
        <button className="ctlBtn" aria-label="Duplicate" title="Duplicate" onClick={() => onAction("duplicate", { dx: 12 / anchor.k, dy: 12 / anchor.k })}><CopyIcon aria-hidden="true" /></button>
        <button className="ctlBtn" aria-label="Select note" title="Select all handwriting in this note" onClick={() => onAction("select-note")}><RectSelectIcon aria-hidden="true" /></button>
        <button className="ctlBtn" aria-label="Show note" title="Show note" onClick={() => onAction("show-note")}><FileTextIcon aria-hidden="true" /></button>
        <button className="ctlBtn inkDeleteBtn" aria-label="Delete" title="Delete selected handwriting" onClick={() => onAction("delete")}><TrashIcon aria-hidden="true" /></button>
      </div>
      {options === "color" ? <div className="inkEditOptions" aria-label="Selected ink color">
        {(kinds.every((k) => k === "highlighter") ? HIGHLIGHTER_COLORS : PEN_COLORS).map((color) =>
          <button key={color} className="colorBtn inkSwatch" style={{ background: color }} aria-label={`Ink color ${color}`}
            aria-pressed={strokes.every((s) => s.color === color)} onClick={() => onAction("style", { color })} />)}
        <label className="colorBtn inkSwatch inkCustomColor" title="Custom color"><input type="color" aria-label="Selected ink custom color" value={strokes[0]?.color || PEN_COLORS[0]}
          onChange={(e) => onAction("style", { color: e.target.value })} /></label>
      </div> : null}
      {options === "width" ? kinds.map((kind) => <div className="inkEditOptions" key={kind} aria-label={`${kind} width`}>
        {kinds.length > 1 ? (kind === "highlighter" ? <HighlightIcon aria-label="Highlighter" /> : <PenIcon aria-label="Pen" />) : null}
        {sizesFor(kind).map((size, i) => <button key={size} className={"ctlBtn inkSizeBtn" + (strokes.filter((s) => s.tool === kind).every((s) => s.size === size) ? " modeActive" : "")} aria-label={`${kind} width ${size} pt`} title={`${kind} width ${size} pt`}
          aria-pressed={strokes.filter((s) => s.tool === kind).every((s) => s.size === size)}
          onClick={() => onAction("style", { tool: kind, size })}><span className="inkSizeDot" aria-hidden="true" style={{ width: 4 + i * 2, height: 4 + i * 2, background: "currentColor" }} /></button>)}
      </div>) : null}
    </InkTooltips>
  </ContextMenu>;
}

// The group as a picture in the notes tree (same strokes, cropped to its
// box). Click: jump to it on the page.
export function InkCard({ block, onJump }) {
  useInkVersion();
  const ink = inkStore.inkFor(block);
  const b = ink ? inkBounds(ink) : null;
  if (!ink) {
    return <div className="blockInkCard blockInkPending" title="Loading handwriting…" />;
  }
  if (!b) return null;
  const pad = 6;
  const w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
  return (
    <svg className="blockInkCard" viewBox={`${b[0] - pad} ${b[1] - pad} ${w} ${h}`} width={w} height={h}
      role="img" aria-label="Handwriting"
      onClick={onJump ? (e) => { e.stopPropagation(); onJump(block.id); } : undefined}>
      <Strokes ink={ink} />
    </svg>
  );
}

// The tool strip above the page, Notability-style: a row of tool presets
// (each pen / highlighter with its own colour and width), the eraser, the
// lasso and a hand. Tapping the armed tool again opens its options row —
// colours (palette + custom), widths, duplicate, remove for a preset;
// whole / partial + size for the eraser; freeform / box for the lasso.
// `tools`: the presets; `active`: a preset id, "eraser", "select" or null
// (the hand); `options`: whether the row is open.
export function InkToolbar({ tools, active, options, eraserMode, eraserSize, lassoMode,
  onPick, onToggleOptions, onChangeTools, onEraser, onLasso, onClose, onUndo, onRedo, canUndo, canRedo }) {
  const preset = tools.find((t) => t.id === active) || null;
  const tap = (id) => (id === active ? onToggleOptions() : onPick(id));
  const btn = (id, label, icon, extra) => (
    <button key={id} type="button" className={"ctlBtn inkToolBtn" + (active === id ? " modeActive" : "")}
      onClick={() => tap(id)} title={label} aria-label={label} aria-pressed={active === id}>{icon}{extra}</button>
  );
  const edit = (patch) => onChangeTools(tools.map((t) => (t.id === active ? { ...t, ...patch } : t)));
  const duplicate = () => {
    const i = tools.findIndex((t) => t.id === active);
    const copy = { ...tools[i], id: toolId() };
    onChangeTools([...tools.slice(0, i + 1), copy, ...tools.slice(i + 1)]);
    onPick(copy.id, { keepOptions: true, kind: copy.kind });   // not in the list the picker closed over yet
  };
  const remove = () => {
    const i = tools.findIndex((t) => t.id === active);
    const rest = tools.filter((t) => t.id !== active);
    onChangeTools(rest);
    onPick(rest[Math.min(i, rest.length - 1)].id);
  };
  const seg = (on, label, icon, click, title) => (
    <button type="button" className={"ctlBtn inkSegBtn" + (on ? " modeActive" : "")} onClick={click}
      title={title} aria-label={label} aria-pressed={on}>{icon}<span>{label}</span></button>
  );
  const palette = preset ? (preset.kind === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS) : null;
  return (
    <InkTooltips className="pdfInkBar" role="toolbar" aria-label="Handwriting tools">
      <div className="pdfInkRow">
        {tools.map((t, i) => {
          const hl = t.kind === "highlighter";
          const sizes = sizesFor(t.kind), k = Math.max(0, sizes.indexOf(t.size));
          const label = `${hl ? "Highlighter" : "Pen"} ${t.color}, ${t.size} pt (${i + 1})` + (active === t.id ? " — tap again for options" : "");
          return btn(t.id, label, hl ? <HighlightIcon size={15} /> : <PenIcon size={15} />,
            <span className="inkToolInk" style={{ background: t.color, height: hl ? 3 + Math.round(k / 2) : 2 + Math.round(k / 3),
              opacity: hl ? 0.85 : 1 }} />);
        })}
        {btn("eraser", "Eraser (E) — the pen's eraser end and barrel button erase too", <EraserIcon size={15} />)}
        {btn("select", "Lasso (L): circle strokes to select them, then drag the box to move or press Delete", <LassoIcon size={15} />)}
        <span className="pdfInkSep" />
        <button type="button" className={"ctlBtn inkToolBtn" + (active === null ? " modeActive" : "")}
          onClick={() => onPick(null)} title="Hand (V): scroll and select text; a stylus still writes" aria-label="Hand"
          aria-pressed={active === null}><HandIcon size={15} /></button>
        <span className="pdfInkSep" />
        <button type="button" className="ctlBtn" onClick={onClose} title="Close the handwriting tools (Esc)"><XIcon size={15} /></button>
        <span className="pdfInkHistory">
          <button type="button" className="ctlBtn" aria-label="Undo ink" title="Undo handwriting" disabled={!canUndo} onClick={onUndo}><UndoIcon aria-hidden="true" /></button>
          <button type="button" className="ctlBtn" aria-label="Redo ink" title="Redo handwriting" disabled={!canRedo} onClick={onRedo}><RedoIcon aria-hidden="true" /></button>
        </span>
      </div>
      {options && preset ? (
        <div className="pdfInkSub" data-ink-options="tool">
          {palette.map((c) => (
            <button key={c} type="button" className={"colorBtn inkSwatch" + (preset.color === c ? " selected" : "")}
              style={{ background: c }} onClick={() => edit({ color: c })} title={c} aria-label={`Colour ${c}`} />
          ))}
          <label className={"colorBtn inkSwatch inkCustomColor" + (palette.includes(preset.color) ? "" : " selected")}
            title="Custom colour" style={{ "--ink-custom": preset.color }}>
            <input type="color" value={preset.color} aria-label="Custom colour"
              onChange={(e) => edit({ color: e.target.value.toLowerCase() })} />
          </label>
          <span className="pdfInkSep" />
          {sizesFor(preset.kind).map((sz, i) => (
            <button key={sz} type="button" className={"ctlBtn inkSizeBtn" + (preset.size === sz ? " modeActive" : "")}
              onClick={() => edit({ size: sz })} title={`${sz} pt`} aria-label={`Width ${sz} pt`}>
              <span className="inkSizeDot" style={{ width: 4 + i * 2, height: 4 + i * 2, background: preset.color,
                opacity: preset.kind === "highlighter" ? HIGHLIGHTER_OPACITY + 0.2 : 1 }} />
            </button>
          ))}
          <span className="pdfInkSep" />
          <button type="button" className="ctlBtn" onClick={duplicate} disabled={tools.length >= MAX_TOOLS}
            title="Duplicate: a second copy of this tool to give its own colour and width" aria-label="Duplicate tool"><CopyIcon size={14} /></button>
          <button type="button" className="ctlBtn" onClick={remove} disabled={tools.length <= 1}
            title="Remove this tool from the strip" aria-label="Remove tool"><TrashIcon size={14} /></button>
        </div>
      ) : null}
      {options && active === "eraser" ? (
        <div className="pdfInkSub" data-ink-options="eraser">
          {seg(eraserMode !== "partial", "Whole strokes", <EraseStrokeIcon size={14} />, () => onEraser({ mode: "stroke" }),
            "Whole strokes: anything the eraser touches goes entirely")}
          {seg(eraserMode === "partial", "Partial", <ErasePartialIcon size={14} />, () => onEraser({ mode: "partial" }),
            "Partial: erase just what the eraser passes over (strokes are cut)")}
          <span className="pdfInkSep" />
          {ERASER_SIZES.map((px, i) => (
            <button key={px} type="button" className={"ctlBtn inkSizeBtn" + (eraserSize === i ? " modeActive" : "")}
              onClick={() => onEraser({ size: i })} title={`${SIZE_LABELS[i]} eraser`} aria-label={`${SIZE_LABELS[i]} eraser`}>
              <span className="inkSizeDot inkEraserDot" style={{ width: 6 + i * 4, height: 6 + i * 4 }} />
            </button>
          ))}
        </div>
      ) : null}
      {options && active === "select" ? (
        <div className="pdfInkSub" data-ink-options="select">
          {seg(lassoMode !== "box", "Freeform", <LassoIcon size={14} />, () => onLasso("free"), "Freeform: draw a loop around the strokes")}
          {seg(lassoMode === "box", "Box", <RectSelectIcon size={14} />, () => onLasso("box"), "Box: drag a rectangle over the strokes")}
        </div>
      ) : null}
    </InkTooltips>
  );
}

// Handwriting on the PDF (docs/dev/handwriting.md): InkLayer is one page's
// ink — the retained strokes as SVG paths in the page's scale-1 frame
// (the viewBox does the zoom), a low-latency canvas for the stroke being
// drawn, and the pointer handling that turns a pen (or, with a tool armed,
// any pointer) into samples. InkCard is the same strokes as a picture in
// the notes; InkToolbar the tool strip. Strokes come from inkStore (drafts
// ahead of uploads, files behind block URLs); App owns the tool state and
// the commits.
import React, { useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import { EraserIcon, HighlightIcon, PenIcon, PlusIcon, XIcon } from "./icons";
import {
  HIGHLIGHTER_SIZES, PEN_COLORS, PEN_SIZES, encodeStroke, hitStrokes, inkBounds, outlineOptions,
  strokePath, svgPathFromPoints,
} from "./ink";
import * as inkStore from "./inkStore";

// Re-render when any draft or file changes.
export function useInkVersion() {
  const [v, setV] = useState(inkStore.currentVersion());
  useEffect(() => inkStore.subscribe(setV), []);
  return v;
}

const ERASER_PX = 9;          // eraser radius on screen
const SIZE_LABELS = ["S", "M", "L"];

function Strokes({ ink, onClick }) {
  return ink.strokes.map((s) => {
    const p = strokePath(s);
    return p.stroke ? (
      <path key={s.id} d={p.d} fill="none" stroke={s.color} strokeWidth={p.width} strokeOpacity={s.opacity}
        strokeLinecap="round" strokeLinejoin="round" style={{ mixBlendMode: "multiply" }} onClick={onClick} />
    ) : (
      <path key={s.id} d={p.d} fill={s.color} fillOpacity={s.opacity} onClick={onClick} />
    );
  });
}

// tool: the armed tool {tool: pen|highlighter|eraser, color, size} or null;
// penTool: what a stylus draws with when nothing is armed (null: nothing);
// blocks: this page's ink blocks; flash: {id, nonce} outlines a group briefly.
export function InkLayer({ pageNumber, wrapRef, width, height, blocks, tool, penTool, penOnly, pressure,
  flash, onStroke, onErase, onJump }) {
  const version = useInkVersion();
  const canvasRef = useRef(null);
  const live = useRef({});
  live.current = { tool, penTool, penOnly, pressure, width, height, blocks, onStroke, onErase };

  const groups = [];
  for (const b of blocks || []) {
    const ink = inkStore.inkFor(b);
    if (ink?.strokes?.length) groups.push({ id: b.id, ink });
  }

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let drawing = null; // {samples, t0, tool, k, rect, raf}

    const setup = (e) => {
      const L = live.current;
      if (!L.width) return null;
      let use = L.tool;
      if (!use) {
        if (!(L.penTool && e.pointerType === "pen")) return null;
        use = L.penTool;
      }
      if (L.penOnly && e.pointerType === "touch") return null;   // fingers scroll
      if (e.button !== 0 && !(e.buttons & 32)) return null;        // right/middle buttons stay the browser's
      const rect = el.getBoundingClientRect();
      const k = rect.width / L.width;                             // css px per pt
      const eraser = use.tool === "eraser" || !!(e.buttons & 32) || !!(e.buttons & 2);
      return { use, eraser, rect, k, toPt: (ev) => ({ x: (ev.clientX - rect.left) / k, y: (ev.clientY - rect.top) / k }) };
    };

    const eraseAt = (ctx, ev) => {
      const { x, y } = ctx.toPt(ev);
      const r = ERASER_PX / ctx.k;
      for (const b of live.current.blocks || []) {
        const ink = inkStore.inkFor(b);
        if (!ink) continue;
        const ids = hitStrokes(ink, x, y, r);
        if (ids.length) live.current.onErase?.(pageNumber, b.id, ids);
      }
    };

    const paint = () => {
      const d = drawing, canvas = canvasRef.current;
      if (!d || !canvas) return;
      d.raf = 0;
      const ctx = canvas.getContext("2d", { desynchronized: true });
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * d.k, 0, 0, dpr * d.k, 0, 0);
      const { use } = d;
      if (use.tool === "highlighter") {
        ctx.globalAlpha = use.opacity ?? 0.5;
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
        const pts = getStroke(d.samples.map((s) => [s.x, s.y, s.p]),
          { ...outlineOptions({ size: use.size, pen: d.pen }), last: false });
        ctx.fill(new Path2D(svgPathFromPoints(pts)));
      }
    };

    const sample = (d, ev) => {
      const p = d.pen && live.current.pressure && ev.pressure > 0 ? ev.pressure : 0.5;
      d.samples.push({ ...d.toPt(ev), p, t: Date.now() - d.t0 });
    };

    const onDown = (e) => {
      const ctx = setup(e);
      if (!ctx) return;
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
      if (ctx.eraser) {
        drawing = { ...ctx, id: e.pointerId, eraser: true };
        eraseAt(ctx, e);
        return;
      }
      const canvas = canvasRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (canvas) {
        canvas.width = Math.round(ctx.rect.width * dpr);
        canvas.height = Math.round(ctx.rect.height * dpr);
        canvas.style.display = "block";
      }
      drawing = { ...ctx, id: e.pointerId, samples: [], t0: Date.now(), pen: e.pointerType === "pen", raf: 0 };
      sample(drawing, e);
      paint();
    };
    const onMove = (e) => {
      const d = drawing;
      if (!d || e.pointerId !== d.id) return;
      e.preventDefault();
      if (d.eraser) { eraseAt(d, e); return; }
      const events = e.getCoalescedEvents?.() || [];
      for (const ev of events.length ? events : [e]) sample(d, ev);
      if (!d.raf) d.raf = requestAnimationFrame(paint);
    };
    const finish = (e, cancelled) => {
      const d = drawing;
      if (!d || e.pointerId !== d.id) return;
      drawing = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (d.eraser) return;
      if (d.raf) cancelAnimationFrame(d.raf);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = "none";
      }
      if (cancelled || !d.samples.length) return;
      // The click this pointer-up would deliver to whatever lies under it
      // (a highlight rect, a link box) is not a click on that thing.
      const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 0);
      const { use } = d;
      const stroke = encodeStroke({
        tool: use.tool, color: use.color, size: use.size, opacity: use.opacity ?? 1, pen: d.pen,
        t0: d.t0, samples: d.samples, ch: d.pen ? "xypt" : "xyt",
      });
      live.current.onStroke?.(pageNumber, stroke, { width: live.current.width, height: live.current.height });
    };
    const onUp = (e) => finish(e, false);
    const onCancel = (e) => finish(e, true);
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, [wrapRef, pageNumber]);

  if (!width || !height) return null;
  const flashGroup = flash && groups.find((g) => g.id === flash.id);
  const fb = flashGroup ? inkBounds(flashGroup.ink) : null;
  const armed = !!tool;
  return (
    <>
      <svg className="inkLayer" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
        data-ink-version={version}
        style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 2,
          overflow: "visible", pointerEvents: "none" }}>
        {groups.map((g) => (
          <g key={g.id} data-ink-id={g.id}
            style={{ pointerEvents: armed || !onJump ? "none" : "visiblePainted", cursor: "pointer" }}>
            <Strokes ink={g.ink} onClick={onJump ? (e) => { e.stopPropagation(); onJump(g.id); } : undefined} />
          </g>
        ))}
        {fb ? (
          <rect key={flash.nonce} className="inkFlash" x={fb[0] - 6} y={fb[1] - 6}
            width={fb[2] - fb[0] + 12} height={fb[3] - fb[1] + 12} rx={4} />
        ) : null}
      </svg>
      <canvas ref={canvasRef} className="inkCanvas"
        style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 5,
          pointerEvents: "none", display: "none" }} />
    </>
  );
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

// The tool strip above the page. `state`: {tool, penColor, penSize, hlColor,
// hlSize} (sizes are S/M/L indexes); `onChange(patch)`.
export function InkToolbar({ state, onChange, highlightColors, onNewGroup, onClose }) {
  const { tool } = state;
  const hl = tool === "highlighter";
  const colors = hl ? highlightColors : PEN_COLORS;
  const colorKey = hl ? "hlColor" : "penColor", sizeKey = hl ? "hlSize" : "penSize";
  const pick = (t) => onChange({ tool: tool === t ? null : t });
  return (
    <div className="pdfInkBar" role="toolbar" aria-label="Handwriting tools">
      <button type="button" className={"ctlBtn" + (tool === "pen" ? " modeActive" : "")}
        onClick={() => pick("pen")} title="Pen (P)"><PenIcon size={15} /></button>
      <button type="button" className={"ctlBtn" + (hl ? " modeActive" : "")}
        onClick={() => pick("highlighter")} title="Highlighter (H)"><HighlightIcon size={15} /></button>
      <button type="button" className={"ctlBtn" + (tool === "eraser" ? " modeActive" : "")}
        onClick={() => pick("eraser")} title="Eraser (E) — the pen's eraser end and barrel button erase too"><EraserIcon size={15} /></button>
      <span className="pdfInkSep" />
      {tool && tool !== "eraser" ? (
        <>
          {colors.map((c) => (
            <button key={c} type="button" className={"inkSwatch" + (state[colorKey] === c ? " active" : "")}
              style={{ background: c }} onClick={() => onChange({ [colorKey]: c })} title={c} aria-label={`Colour ${c}`} />
          ))}
          <span className="pdfInkSep" />
          {SIZE_LABELS.map((label, i) => (
            <button key={label} type="button" className={"ctlBtn inkSizeBtn" + (state[sizeKey] === i ? " modeActive" : "")}
              onClick={() => onChange({ [sizeKey]: i })} title={`${label === "S" ? "Thin" : label === "M" ? "Medium" : "Thick"} (${(hl ? HIGHLIGHTER_SIZES : PEN_SIZES)[i]} pt)`}>{label}</button>
          ))}
          <span className="pdfInkSep" />
        </>
      ) : null}
      <button type="button" className="ctlBtn" onClick={onNewGroup}
        title="Start a new handwriting note: the next strokes make their own block instead of joining the last one"><PlusIcon size={15} /></button>
      <button type="button" className="ctlBtn" onClick={onClose} title="Close the handwriting tools (Esc)"><XIcon size={15} /></button>
    </div>
  );
}

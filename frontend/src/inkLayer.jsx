// Handwriting on the PDF (docs/dev/handwriting.md): InkLayer is one page's
// ink — the retained strokes as SVG paths in the page's scale-1 frame
// (the viewBox does the zoom), a low-latency canvas for the stroke (or
// lasso) being drawn, and the pointer handling that turns a pen (or, with
// a tool armed, any pointer) into samples, erasures, a lasso selection or
// a move of that selection. InkCard is the same strokes as a picture in
// the notes; InkToolbar the tool strip. Strokes come from inkStore (drafts
// ahead of uploads, files behind block URLs); App owns the tool state,
// the selection, the stroke history and the commits.
import React, { useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import {
  CopyIcon, ErasePartialIcon, EraserIcon, EraseStrokeIcon, HandIcon, HighlightIcon, LassoIcon, PenIcon, PlusIcon,
  RectSelectIcon, TrashIcon, XIcon,
} from "./icons";
import {
  HIGHLIGHTER_COLORS, HIGHLIGHTER_OPACITY, MAX_TOOLS, PEN_COLORS, boundsOf, encodeStroke, hitStrokes, inkBounds,
  outlineOptions, sizesFor, strokePath, strokesInLasso, svgPathFromPoints, toolId, unionBox,
} from "./ink";
import * as inkStore from "./inkStore";

// Re-render when any draft or file changes.
export function useInkVersion() {
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
  eraserSize = 1, lassoMode = "free", selection, flash, onStroke, onErase, onErasePartial, onSelect, onMoveSelection, onJump }) {
  useInkVersion();
  const canvasRef = useRef(null);
  const [dragOffset, setDragOffset] = useState(null);   // while moving the selection: {dx, dy} in pt
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
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * d.k, 0, 0, dpr * d.k, 0, 0);
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
        const pts = getStroke(d.samples.map((s) => [s.x, s.y, s.p]),
          { ...outlineOptions({ size: use.size, pen: d.pen }), last: false });
        ctx.fill(new Path2D(svgPathFromPoints(pts)));
      }
    };
    const showCanvas = (ctx) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(ctx.rect.width * dpr);
      canvas.height = Math.round(ctx.rect.height * dpr);
      canvas.style.display = "block";
    };
    const hideCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = "none";
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
      showCanvas(ctx);
      drawing = { ...ctx, id: e.pointerId, mode: "stroke", samples: [], t0: Date.now(), pen: e.pointerType === "pen", raf: 0 };
      sample(drawing, e);
      paint();
    };
    const onMove = (e) => {
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
        } else sample(d, ev);
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
      const d = drawing;
      if (!d || e.pointerId !== d.id) return;
      drawing = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (d.raf) cancelAnimationFrame(d.raf);
      const L = live.current;
      if (d.mode === "erase") return;
      if (d.mode === "move") {
        setDragOffset(null);
        if (!cancelled && (Math.abs(d.dx) > 0.5 || Math.abs(d.dy) > 0.5)) L.onMoveSelection?.(pageNumber, d.dx, d.dy);
        swallowClick();
        return;
      }
      hideCanvas();
      if (cancelled) return;
      swallowClick();
      if (d.mode === "lasso") {
        const items = [];
        if (d.poly.length >= 3) {
          for (const g of L.groups) {
            const ids = strokesInLasso(g.ink, d.poly);
            if (ids.length) items.push({ id: g.id, ids });
          }
        }
        L.onSelect?.(pageNumber, items);
        return;
      }
      if (!d.samples.length) return;
      const { use } = d;
      const stroke = encodeStroke({
        tool: use.tool, color: use.color, size: use.size, opacity: use.opacity ?? 1, pen: d.pen,
        t0: d.t0, samples: d.samples, ch: d.pen ? "xypt" : "xyt",
      });
      L.onStroke?.(pageNumber, stroke, { width: L.width, height: L.height });
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
  const dragging = !!(dragOffset && selectedIds.size);
  return (
    <>
      <svg className="inkLayer" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {groups.map((g) => (
          <g key={g.id} data-ink-id={g.id}
            style={{ pointerEvents: armed || !onJump ? "none" : "visiblePainted", cursor: "pointer" }}>
            <Strokes ink={g.ink} hide={dragging ? selectedIds : null}
              onClick={onJump ? (e) => { e.stopPropagation(); onJump(g.id); } : undefined} />
          </g>
        ))}
        {dragging ? (
          <g transform={`translate(${dragOffset.dx} ${dragOffset.dy})`}>
            {groups.map((g) => (
              <Strokes key={g.id} ink={{ strokes: g.ink.strokes.filter((s) => selectedIds.has(s.id)) }} />
            ))}
          </g>
        ) : null}
        {selBox ? (
          <rect className="inkSelRect" data-ink-selection="true"
            x={selBox[0] - 4 + (dragOffset?.dx || 0)} y={selBox[1] - 4 + (dragOffset?.dy || 0)}
            width={selBox[2] - selBox[0] + 8} height={selBox[3] - selBox[1] + 8} rx={3} />
        ) : null}
        {fb ? (
          <rect key={flash.nonce} className="inkFlash" x={fb[0] - 6} y={fb[1] - 6}
            width={fb[2] - fb[0] + 12} height={fb[3] - fb[1] + 12} rx={4} />
        ) : null}
      </svg>
      <canvas ref={canvasRef} className="inkCanvas" />
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

// The tool strip above the page, Notability-style: a row of tool presets
// (each pen / highlighter with its own colour and width), the eraser, the
// lasso and a hand. Tapping the armed tool again opens its options row —
// colours (palette + custom), widths, duplicate, remove for a preset;
// whole / partial + size for the eraser; freeform / box for the lasso.
// `tools`: the presets; `active`: a preset id, "eraser", "select" or null
// (the hand); `options`: whether the row is open.
export function InkToolbar({ tools, active, options, eraserMode, eraserSize, lassoMode,
  onPick, onToggleOptions, onChangeTools, onEraser, onLasso, onNewGroup, onClose }) {
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
    <div className="pdfInkBar" role="toolbar" aria-label="Handwriting tools">
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
        <button type="button" className="ctlBtn" onClick={onNewGroup}
          title="Start a new handwriting note: the next strokes make their own block instead of joining the last one"><PlusIcon size={15} /></button>
        <button type="button" className="ctlBtn" onClick={onClose} title="Close the handwriting tools (Esc)"><XIcon size={15} /></button>
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
    </div>
  );
}

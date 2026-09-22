// The right-edge drag grip that sizes a rendered figure (a note image, a
// Mermaid diagram) — one behavior for every resizable thing in the notes:
// drag writes a pixel width through onCommit when the pointer is released,
// double-click clears it back to the natural size (onCommit(0)), and a
// click that never moved commits nothing. The live width during the drag is
// returned so the figure can follow the pointer before the source changes.
import React, { useRef, useState } from "react";

export function useDragResize({ measure, onCommit, min = 60, max = 1600 }) {
  const [dragW, setDragW] = useState(null);
  const dragRef = useRef(null); // {startX, startW, w, moved}
  const stop = (e) => e.stopPropagation();
  function start(e) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startW: measure() || 200, w: null, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) > 2) d.moved = true;
    d.w = Math.round(Math.min(max, Math.max(min, d.startW + (e.clientX - d.startX))));
    setDragW(d.w);
  }
  function end() {
    const d = dragRef.current;
    dragRef.current = null;
    setDragW(null);
    if (d?.moved && d.w) onCommit(d.w);
  }
  const gripProps = {
    className: "mdResizeGrip",
    title: "Drag to resize · double-click for natural size",
    onMouseDown: stop,
    onClick: stop,
    onPointerDown: start,
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onDoubleClick: (e) => { e.stopPropagation(); onCommit(0); },
  };
  return { dragW, gripProps };
}

// The grip element itself; `as` picks span (inline figures) or div.
export function ResizeGrip({ as: Tag = "span", ...props }) {
  return <Tag {...props} />;
}

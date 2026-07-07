// Shared menu primitives. One dismissal + positioning story for every
// cursor-anchored menu in the app (right-click page/folder menu, highlight
// menu, attach-highlight menu), so they can't drift apart again.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A context menu positioned at a screen point (x, y). Rendered through a
// portal so it escapes the window-stack's overflow/stacking contexts, clamps
// itself inside the viewport, and dismisses on outside-pointerdown or Escape.
// Menu items still close the menu themselves via their own onClick.
function ContextMenu({ x, y, onClose, className = "", children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp inside the viewport once we know the menu's size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    let left = x, top = y;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - width - pad);
    if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }
    // Capture phase so we see the click before it lands on other handlers.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`ctxMenu ${className}`}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export { ContextMenu };

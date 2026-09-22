// LaTeX editing aids for the block editor, modeled on Overleaf/VSCode:
// a live KaTeX preview of the math span being typed, docked to the editor
// column above the caret line, and \command autocompletion (Tab/Enter to
// accept). The catalog and matching live in editor/latexCompletion.js
// (re-exported here); this file holds the two presentational components and
// their placement. editor/BlockTree.jsx owns the state and key handling.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import { escapedAt } from "./latexInput";

export {
  latexCompletions, envCompletions, fuzzyScore, insertionFor,
  latexCompletionEdit, findMathAtCursor, mathTabJump,
} from "./latexCompletion";

// --- rendering -------------------------------------------------------------

// Keystroke-hot path: memoize renders (the preview re-renders the same
// candidates constantly while the user types).
const _kcache = new Map();
export function renderKatex(tex, displayMode) {
  const key = (displayMode ? "D:" : "I:") + tex;
  let html = _kcache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(tex, { displayMode, throwOnError: false, strict: false });
    } catch (_) {
      html = null;
    }
    _kcache.set(key, html);
    if (_kcache.size > 500) _kcache.delete(_kcache.keys().next().value);
  }
  return html;
}

const sampleFor = (c) => c.sample
  || (c.args === 2 ? `\\${c.name}{a}{b}` : c.args === 1 ? `\\${c.name}{a}` : `\\${c.name}`);

// Placement of a caret-anchored tip: measure its ACTUAL size after render (a
// worst-case clamp against max-width shoved narrow tips far left of the
// caret near the right window edge) and keep it inside the viewport.
// useLayoutEffect runs pre-paint, so the off-screen first pass never shows.
//
// The anchor is {left, top, bottom} of the caret, optionally with
// getRect() for a fresh measurement. A `dock` rect ({left, right} of the
// editor's content box) makes the tip a docked strip instead: it hugs the
// editor's left edge and is capped at the editor's width, so it never spills
// over the gutter, the PDF next to a narrow notes column, or off the page.
// Vertically the tip goes above `top` (preferAbove) or below `bottom`, and
// falls back to the other side, then to `caretTop`/`caretBottom` (the line
// being typed, when the anchor spans several lines and its edges are off
// screen), then to the viewport edge.
export function useCaretAnchored(anchor, preferAbove, deps) {
  const ref = useRef(null);
  const [style, setStyle] = useState({ left: -9999, top: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame;
    const viewport = window.visualViewport;
    const place = () => {
      const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const rect = anchor.getRect?.() || anchor;
      const dock = rect.dock && rect.dock.right - rect.dock.left >= 240 ? rect.dock : null;
      el.style.setProperty("--caret-max-width",
        `${Math.max(0, dock ? Math.min(dock.right - dock.left, width - 16) : width - 16)}px`);
      el.style.setProperty("--caret-max-height", `${Math.max(0, height - 16)}px`);
      const { width: w, height: h } = el.getBoundingClientRect();
      const left = Math.max(x + 8, Math.min(dock ? dock.left : rect.left, x + width - w - 8));
      const fits = (t) => t >= y + 8 && t + h <= y + height - 8;
      const above = (b) => b - h - 6, below = (b) => b + 6;
      const first = preferAbove ? above(rect.top) : below(rect.bottom);
      const second = preferAbove ? below(rect.bottom) : above(rect.top);
      const spans = rect.caretTop != null && (rect.caretTop !== rect.top || rect.caretBottom !== rect.bottom);
      const candidates = [first, second,
        ...(spans ? [above(rect.caretTop), below(rect.caretBottom)] : [])];
      const desired = candidates.find(fits) ?? first;
      const top = Math.max(y + 8, Math.min(desired, y + height - h - 8));
      setStyle((prev) => prev.left === left && prev.top === top ? prev : { left, top });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, anchor.bottom, anchor.getRect, preferAbove, ...deps]);
  return [ref, style];
}

// A caret mark for the preview (LaTeX Workshop's hover preview draws one
// too): a thin accent bar typeset at the caret's offset in the formula, so
// a long equation shows WHERE the typing lands. Only at spots where an
// inserted token can't break the parse — never inside a \command name,
// a \begin{…}/\end{…} name, or an optional [] argument — and the preview
// falls back to the unmarked source when KaTeX still rejects the marked one
// (its render carries a katex-error span; both renders are memoized).
const CARET_MARK = "\\textcolor{#3b82f6}{\\vert}";
export function withCaretMark(tex, caret) {
  if (caret == null || caret < 0 || caret > tex.length) return null;
  const before = tex.slice(0, caret), after = tex.slice(caret);
  if (/\\[a-zA-Z]*$/.test(before) && /^[a-zA-Z]/.test(after)) return null;
  if (/\\(begin|end)\{[^}]*$/.test(before)) return null;
  if (/\[[^\]{}]*$/.test(before) && /^[^[{}]*\]/.test(after)) return null;
  if (/[\^_]$/.test(before)) return null;
  return before + CARET_MARK + after;
}

// Live preview of the math span under the caret, docked to the editor
// column: above the span's first line (below its last when there's no
// room), as wide as the editor at most. Long math scrolls inside the
// preview; interacting with it keeps the editor focused.
export function MathLivePreview({ tex, display, anchor, caret }) {
  // A trailing lone backslash is a \command being typed — render what's
  // before it instead of flashing KaTeX's red error for the half keystroke.
  const src = escapedAt(tex, tex.length) ? tex.slice(0, -1) : tex;
  const marked = src.trim() && caret != null && caret <= src.length ? withCaretMark(src, caret) : null;
  let html = null;
  if (src.trim()) {
    html = marked ? renderKatex(marked, display) : null;
    if (!html || html.includes("katex-error")) html = renderKatex(src, display);
  }
  const [ref, style] = useCaretAnchored(anchor, true, [tex, display, html]);
  if (!html) return null;
  return createPortal(
    <div
      ref={ref}
      className="mathPreviewTip"
      role="region"
      aria-label="Equation preview"
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />, document.body
  );
}

// The \command completion popup: rendered glyph + command name per row.
export function LatexAcPopup({ items, selected, anchor, onPick }) {
  const [listRef, style] = useCaretAnchored(anchor, false, [items]);
  useEffect(() => {
    listRef.current?.querySelector(".latexAcItem.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, listRef]);
  return createPortal(
    <div
      ref={listRef}
      className="latexAcPopup"
      style={style}
    >
      {items.map((c, i) => {
        const glyph = renderKatex(sampleFor(c), false);
        return (
          <button
            key={c.name}
            type="button"
            className={`latexAcItem${i === selected ? " selected" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
          >
            <span className="latexAcGlyph" dangerouslySetInnerHTML={{ __html: glyph || "" }} />
            <span className="latexAcName">
              {c.env ? `\\begin{${c.name}}${c.arg}` : `\\${c.name}${"{}".repeat(c.args || 0)}`}
            </span>
          </button>
        );
      })}
    </div>, document.body
  );
}

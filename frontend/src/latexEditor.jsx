// LaTeX editing aids for the block editor, modeled on Overleaf/VSCode:
// a caret-anchored live KaTeX preview of the math span being typed, and
// \command autocompletion (Tab/Enter to accept). Pure helpers + two small
// presentational components; blockTree.jsx owns the state and key handling.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import katex from "katex";

// --- command catalog -------------------------------------------------------
// Order = rank within an equal match tier. Entries: name, args (brace count
// appended on insert), ins/`caret via first "  "` for snippet-style inserts,
// alias (extra prefix that matches, e.g. "begin" for environments), sample
// (LaTeX rendered as the popup glyph when the default construction won't do).
const GREEK = [
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "rho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi", "chi",
  "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon",
  "Phi", "Psi", "Omega",
];
const FUNCTIONS = [
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp", "lim", "limsup",
  "liminf", "max", "min", "sup", "inf", "det", "gcd", "deg", "dim", "ker",
  "arg", "Pr", "tr",
];
const SYMBOLS = [
  "infty", "partial", "nabla", "hbar", "ell", "imath", "jmath", "Re", "Im",
  "aleph", "wp", "angle", "perp", "parallel", "prime", "emptyset",
  "varnothing", "top", "bot", "degree",
];
const OPERATORS = [
  "pm", "mp", "times", "cdot", "div", "ast", "star", "circ", "bullet",
  "oplus", "ominus", "otimes", "oslash", "odot", "dagger", "ddagger",
  "wedge", "vee", "sqcup", "sqcap", "setminus", "amalg",
];
const RELATIONS = [
  "leq", "geq", "neq", "approx", "sim", "simeq", "equiv", "propto", "ll",
  "gg", "subset", "supset", "subseteq", "supseteq", "in", "notin", "ni",
  "cup", "cap", "forall", "exists", "nexists", "neg", "land", "lor", "mid",
  "vdash", "models",
];
const ARROWS = [
  "to", "gets", "mapsto", "implies", "iff", "leftarrow", "rightarrow",
  "Leftarrow", "Rightarrow", "leftrightarrow", "Leftrightarrow",
  "longrightarrow", "longleftarrow", "uparrow", "downarrow", "nearrow",
  "searrow", "hookrightarrow", "rightharpoonup",
];
const BIG_OPS = [
  "sum", "prod", "int", "iint", "iiint", "oint", "coprod", "bigcup",
  "bigcap", "bigoplus", "bigotimes", "bigodot", "bigsqcup", "bigvee",
  "bigwedge",
];
const DOTS = ["dots", "cdots", "ldots", "vdots", "ddots"];
const DELIMS = [
  "langle", "rangle", "lvert", "rvert", "lVert", "rVert", "lfloor",
  "rfloor", "lceil", "rceil",
];
const SPACING = ["quad", "qquad"];

const CATALOG = [];
// Structures first: highest-value completions when they match.
for (const [name, args] of [
  ["frac", 2], ["sqrt", 1], ["binom", 2], ["cfrac", 2], ["dfrac", 2],
  ["tfrac", 2],
]) CATALOG.push({ name, args });
// Quantum notation (KaTeX ships braket support natively).
for (const [name, args, sample] of [
  ["ket", 1, "\\ket{\\psi}"], ["bra", 1, "\\bra{\\phi}"],
  ["braket", 1, "\\braket{\\phi|\\psi}"], ["Ket", 1, "\\Ket{\\psi}"],
  ["Bra", 1, "\\Bra{\\phi}"],
]) CATALOG.push({ name, args, sample });
for (const name of GREEK) CATALOG.push({ name });
// Accents / decorations.
for (const [name, args] of [
  ["hat", 1], ["bar", 1], ["vec", 1], ["tilde", 1], ["dot", 1], ["ddot", 1],
  ["widehat", 1], ["widetilde", 1], ["overline", 1], ["underline", 1],
  ["overbrace", 1], ["underbrace", 1], ["boxed", 1], ["not", 1],
]) CATALOG.push({ name, args });
// Fonts.
for (const [name, args, sample] of [
  ["mathbb", 1, "\\mathbb{R}"], ["mathbf", 1, "\\mathbf{x}"],
  ["mathcal", 1, "\\mathcal{H}"], ["mathrm", 1, "\\mathrm{d}"],
  ["mathit", 1], ["mathsf", 1], ["mathtt", 1],
  ["mathfrak", 1, "\\mathfrak{g}"], ["boldsymbol", 1, "\\boldsymbol{\\alpha}"],
  ["text", 1, "\\text{a}"], ["operatorname", 1, "\\operatorname{Tr}"],
]) CATALOG.push({ name, args, sample });
for (const name of BIG_OPS) CATALOG.push({ name });
for (const name of FUNCTIONS) CATALOG.push({ name });
for (const name of SYMBOLS) CATALOG.push({ name });
for (const name of OPERATORS) CATALOG.push({ name });
for (const name of RELATIONS) CATALOG.push({ name });
for (const name of ARROWS) CATALOG.push({ name });
for (const name of DOTS) CATALOG.push({ name });
for (const name of DELIMS) CATALOG.push({ name });
for (const name of SPACING) CATALOG.push({ name, sample: "\\square" });
// Stacked constructions.
for (const [name, args] of [
  ["overset", 2], ["underset", 2], ["stackrel", 2], ["xrightarrow", 1],
  ["xleftarrow", 1], ["pmod", 1], ["substack", 1],
]) CATALOG.push({ name, args });
// \left...\right pairs: snippet inserts, caret lands between the delimiters.
for (const [name, ins, sample] of [
  ["left(", "\\left(  \\right)", "\\left(\\,\\right)"],
  ["left[", "\\left[  \\right]", "\\left[\\,\\right]"],
  ["left\\{", "\\left\\{  \\right\\}", "\\left\\{\\,\\right\\}"],
  ["left|", "\\left|  \\right|", "\\left|\\,\\right|"],
  ["left\\langle", "\\left\\langle  \\right\\rangle", "\\left\\langle\\,\\right\\rangle"],
]) CATALOG.push({ name, ins, sample, alias: "left" });
// Environments: full \begin/\end snippet, caret inside. "begin" also matches.
for (const name of [
  "pmatrix", "bmatrix", "vmatrix", "Vmatrix", "Bmatrix", "matrix",
  "cases", "aligned", "gathered", "array",
]) CATALOG.push({
  name,
  ins: `\\begin{${name}}  \\end{${name}}`,
  alias: "begin",
  sample: name === "cases"
    ? "\\begin{cases}a\\\\b\\end{cases}"
    : name.endsWith("matrix")
      ? `\\begin{${name}}a&b\\\\c&d\\end{${name}}`
      : "\\square",
});

// --- matching / insertion --------------------------------------------------

export function latexCompletions(query, limit = 8) {
  if (!query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const c of CATALOG) {
    const tier = c.name === query ? 0
      : c.name.startsWith(query) ? 1
        : c.name.toLowerCase().startsWith(q) ? 2
          : c.alias && c.alias.startsWith(q) ? 3 : -1;
    if (tier >= 0) out.push([tier, out.length, c]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.slice(0, limit).map((x) => x[2]);
}

// What accepting a completion types, and where the caret lands within it
// (snippets mark the caret spot with a double space, like "\left(  \right)").
export function insertionFor(c) {
  if (c.ins) {
    const gap = c.ins.indexOf("  ");
    return { text: c.ins, caret: gap >= 0 ? gap + 1 : c.ins.length };
  }
  const text = "\\" + c.name + "{}".repeat(c.args || 0);
  return { text, caret: c.args ? c.name.length + 2 : text.length };
}

// The math span (inside $...$ / $$...$$) containing the caret, if any.
// An unclosed opener still counts — that's exactly the live-typing case —
// previewing to end-of-line for $ and end-of-text for $$.
export function findMathAtCursor(value, cursor) {
  const re = /\$\$?/g;
  let m, open = null;
  while ((m = re.exec(value))) {
    if (value[m.index - 1] === "\\") continue; // escaped \$
    const tok = { i: m.index, len: m[0].length };
    if (!open) {
      if (tok.i >= cursor) return null;
      open = tok;
    } else {
      const start = open.i + open.len, end = tok.i;
      if (cursor >= start && cursor <= end) {
        return { start, end, display: open.len === 2 };
      }
      open = null;
      if (tok.i + tok.len > cursor) return null;
    }
  }
  if (open) {
    const start = open.i + open.len;
    let end = open.len === 1 ? value.indexOf("\n", start) : value.length;
    if (end === -1) end = value.length;
    if (cursor >= start && cursor <= end) {
      return { start, end, display: open.len === 2 };
    }
  }
  return null;
}

// Viewport coordinates of a character offset inside a textarea, via the
// classic hidden-mirror trick (copy the metrics, set the text up to the
// offset, measure a marker span). The block editor auto-grows and never
// scrolls internally, which keeps this exact.
let _mirror = null;
export function caretClientPos(ta, index) {
  if (!_mirror) {
    _mirror = document.createElement("div");
    _mirror.style.cssText =
      "position:fixed;visibility:hidden;left:-9999px;top:0;" +
      "white-space:pre-wrap;overflow-wrap:break-word;";
    document.body.appendChild(_mirror);
  }
  const cs = getComputedStyle(ta);
  for (const p of [
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderLeftWidth", "borderTopWidth", "boxSizing",
  ]) _mirror.style[p] = cs[p];
  const taRect = ta.getBoundingClientRect();
  _mirror.style.width = taRect.width + "px";
  _mirror.textContent = ta.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  _mirror.appendChild(marker);
  const mRect = _mirror.getBoundingClientRect();
  const mk = marker.getBoundingClientRect();
  return {
    left: taRect.left + (mk.left - mRect.left),
    top: taRect.top + (mk.top - mRect.top),
    bottom: taRect.top + (mk.bottom - mRect.top),
  };
}

// --- rendering -------------------------------------------------------------

// Keystroke-hot path: memoize renders (the preview re-renders the same
// candidates constantly while the user types).
const _kcache = new Map();
function renderKatex(tex, displayMode) {
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

// Caret-hugging placement: measure the tip's ACTUAL size after render (a
// worst-case clamp against max-width shoved narrow tips far left of the
// caret near the right window edge) and keep it inside the viewport.
// useLayoutEffect runs pre-paint, so the off-screen first pass never shows.
function useCaretAnchored(anchor, preferAbove, deps) {
  const ref = useRef(null);
  const [style, setStyle] = useState({ left: -9999, top: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8));
    const above = anchor.top - h - 6;
    const top = preferAbove
      ? (above >= 8 ? above : anchor.bottom + 6)
      : (anchor.bottom + 6 + h <= window.innerHeight - 8 ? anchor.bottom + 6 : above);
    setStyle({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, anchor.bottom, ...deps]);
  return [ref, style];
}

// Overleaf-style floating preview of the math span under the caret. Sits
// above the caret line (below when there's no room), never intercepts the mouse.
export function MathLivePreview({ tex, display, anchor }) {
  const html = tex.trim() ? renderKatex(tex, display) : null;
  const [ref, style] = useCaretAnchored(anchor, true, [tex, display]);
  if (!html) return null;
  return (
    <div
      ref={ref}
      className="mathPreviewTip"
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// The \command completion popup: rendered glyph + command name per row.
export function LatexAcPopup({ items, selected, anchor, onPick }) {
  const [listRef, style] = useCaretAnchored(anchor, false, [items]);
  useEffect(() => {
    listRef.current?.querySelector(".latexAcItem.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, listRef]);
  return (
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
            <span className="latexAcName">\{c.name}{"{}".repeat(c.args || 0)}</span>
          </button>
        );
      })}
    </div>
  );
}

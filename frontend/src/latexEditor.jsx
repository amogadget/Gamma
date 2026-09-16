// LaTeX editing aids for the block editor, modeled on Overleaf/VSCode:
// a caret-anchored live KaTeX preview of the math span being typed, and
// \command autocompletion (Tab/Enter to accept). Pure helpers + two small
// presentational components; blockTree.jsx owns the state and key handling.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import { leftDelimiterEdit, rightDelimiterAt } from "./latexInput";

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
for (const name of BIG_OPS) CATALOG.push({ name,
  ...(["sum", "prod", "int", "oint"].includes(name)
    ? { ins: `\\${name}_{}^{}`, caret: name.length + 3 } : {}),
});
for (const name of FUNCTIONS) CATALOG.push({ name,
  ...(name === "lim" ? { ins: "\\lim_{}", caret: 6 } : {}),
});
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
  ["left\\lVert", "\\left\\lVert  \\right\\rVert", "\\left\\lVert x\\right\\rVert"],
  ["left\\lfloor", "\\left\\lfloor  \\right\\rfloor", "\\left\\lfloor x\\right\\rfloor"],
  ["left\\lceil", "\\left\\lceil  \\right\\rceil", "\\left\\lceil x\\right\\rceil"],
]) CATALOG.push({ name, ins, sample, alias: "left" });
// Explicit command snippets: no automatic rewriting of ordinary variables.
CATALOG.push(
  { name: "abs", ins: "\\left|  \\right|", sample: "\\left|x\\right|" },
  { name: "norm", ins: "\\left\\lVert  \\right\\rVert", sample: "\\left\\lVert x\\right\\rVert" },
);
// Environments: full \begin/\end snippet, caret inside (multi-line when the
// span is display math — see insertionFor). "begin" also matches, and typing
// "\begin{" completes on the environment name itself (see useMathUi).
// `arg` is a mandatory argument some environments carry (array's col spec).
// align/gather/equation-family samples render via their inner twins — the
// top-level environments error outside display mode.
const ALIGNED_SAMPLE = "\\begin{aligned}a&=b\\\\&=c\\end{aligned}";
const GATHERED_SAMPLE = "\\begin{gathered}ab\\\\c\\end{gathered}";
for (const [name, arg, sample] of [
  ["aligned", null, ALIGNED_SAMPLE],
  ["align", null, ALIGNED_SAMPLE],
  ["cases", null, "\\begin{cases}a\\\\b\\end{cases}"],
  ["pmatrix"], ["bmatrix"], ["matrix"],
  ["vmatrix"], ["Vmatrix"], ["Bmatrix"], ["smallmatrix"],
  ["rcases", null, "\\begin{rcases}a\\\\b\\end{rcases}"],
  ["align*", null, ALIGNED_SAMPLE],
  ["split", null, ALIGNED_SAMPLE],
  ["gathered", null, GATHERED_SAMPLE],
  ["gather", null, GATHERED_SAMPLE],
  ["equation", null, "\\square"],
  ["array", "{cc}", "\\begin{array}{cc}a&b\\\\c&d\\end{array}"],
]) CATALOG.push({
  name,
  env: true,
  arg: arg || "",
  ins: `\\begin{${name}}${arg || ""}  \\end{${name}}`,
  alias: "begin",
  sample: sample || `\\begin{${name}}a&b\\\\c&d\\end{${name}}`,
});

// --- matching / insertion --------------------------------------------------

export function latexCompletions(query, limit = 8) {
  if (!query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const c of CATALOG) {
    // Tiers: exact → the query already spells the whole command and the
    // name only adds a delimiter ("left" → `left(` before `leftarrow`) →
    // other prefix matches → case-insensitive prefix → alias. Ties keep
    // catalog order.
    const letters = (c.name.match(/^[a-zA-Z]+/) || [""])[0];
    const tier = c.name === query ? 0
      : c.name.startsWith(query) ? (letters === query ? 1 : 2)
        : c.name.toLowerCase().startsWith(q) ? 3
          : c.alias && c.alias.startsWith(q) ? 4 : -1;
    if (tier >= 0) out.push([tier, out.length, c]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.slice(0, limit).map((x) => x[2]);
}

// Environment-name completions for the "\begin{prefix" trigger: every
// environment when the prefix is empty (the popup doubles as a menu), prefix
// matches otherwise.
export function envCompletions(prefix, limit = 12) {
  const q = prefix.toLowerCase();
  return CATALOG.filter((c) => c.env && c.name.toLowerCase().startsWith(q))
    .slice(0, limit);
}

// What accepting a completion types, and where the caret lands within it
// (snippets mark the caret spot with a double space, like "\left(  \right)").
// Environments accepted inside $$ display math insert the multi-line form,
// caret alone on the middle line.
export function insertionFor(c, display) {
  if (c.env && display) {
    const open = `\\begin{${c.name}}${c.arg}\n`;
    return { text: `${open}\n\\end{${c.name}}`, caret: open.length };
  }
  if (c.ins) {
    const gap = c.ins.indexOf("  ");
    return { text: c.ins, caret: c.caret ?? (gap >= 0 ? gap + 1 : c.ins.length) };
  }
  const text = "\\" + c.name + "{}".repeat(c.args || 0);
  return { text, caret: c.args ? c.name.length + 2 : text.length };
}

// One atomic editor transaction for autocomplete, including a delimiter
// completed after a separately typed \left (e.g. \left\lang + Tab).
export function latexCompletionEdit(value, start, end, entry, display) {
  if (entry.env && value[end] === "}" && !value.slice(start, end).endsWith("}")) end++;
  let { text, caret } = insertionFor(entry, display);
  const candidate = value.slice(0, start) + text + value.slice(end);
  const pos = start + text.length;
  const seg = findMathAtCursor(candidate, pos);
  const pair = seg && leftDelimiterEdit(candidate, pos, pos, "", seg.start, seg.end);
  if (pair) text += pair.changes.insert;
  return { changes: { from: start, to: end, insert: text }, selection: { anchor: start + caret } };
}

// Odd run of backslashes right before pos → the char at pos is escaped
// ("\$" is a literal dollar, "\\$" is a line break followed by a real "$").
export function escapedAt(text, pos) {
  let n = 0;
  while (text[pos - 1 - n] === "\\") n++;
  return n % 2 === 1;
}

// The math span (inside $...$ / $$...$$) containing the caret, if any.
// An unclosed opener still counts — that's exactly the live-typing case —
// previewing to end-of-line for $ and end-of-text for $$.
// A "$" the caret sits right in front of is never an escaped one: "$\|$" is
// the auto-paired closer with a \command being started before it, not a
// literal dollar — reading it as "\$" would swallow the closer and preview
// the whole rest of the line as math.
export function findMathAtCursor(value, cursor) {
  const re = /\$\$?/g;
  let m, open = null;
  while ((m = re.exec(value))) {
    if (m.index !== cursor && escapedAt(value, m.index)) continue;
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

// Snippet-style Tab navigation inside raw math (Overleaf-like). Forward:
// hop into the next {…} argument group — its content selected placeholder-
// style, so typing replaces it — else out past the run of closing braces,
// else out of the math span itself. Backward: hop into the nearest group
// opened before the caret. Returns a {anchor, head} selection, or null when
// the caret isn't in math / there's nowhere to go (callers fall through to
// the outliner's block indent).
export function mathTabJump(value, cursor, dir) {
  const seg = findMathAtCursor(value, cursor);
  if (!seg) return null;
  const braceAt = (p, ch) => value[p] === ch && !escapedAt(value, p);
  // The group's content span: opener position -> [start, end] (end clamped
  // to the math span when the group is still unclosed).
  const groupContent = (p) => {
    let depth = 1, q = p + 1;
    while (q < seg.end && depth > 0) {
      if (braceAt(q, "{")) depth++;
      else if (braceAt(q, "}")) depth--;
      if (depth > 0) q++;
    }
    return [p + 1, depth === 0 ? q : seg.end];
  };
  // \begin{...}/\end{...} name groups are structure, not argument slots.
  const isEnvName = (p) =>
    /\\(begin|end)$/.test(value.slice(Math.max(seg.start, p - 6), p));
  if (dir > 0) {
    for (let p = cursor; p < seg.end; p++) {
      const right = rightDelimiterAt(value, p);
      if (right) return { anchor: p + right.length, head: p + right.length };
      if (braceAt(p, "{")) {
        const [from, to] = groupContent(p);
        if (isEnvName(p)) { p = to; continue; }
        return { anchor: from, head: to };
      }
      if ([")", "]"].includes(value[p]) && !escapedAt(value, p)) {
        return { anchor: p + 1, head: p + 1 };
      }
    }
    for (let p = cursor; p < seg.end; p++) {
      if (braceAt(p, "}")) {
        let q = p + 1;
        while (q < seg.end && braceAt(q, "}")) q++;
        return { anchor: q, head: q };
      }
    }
    const dlen = seg.display ? 2 : 1;
    if (value.slice(seg.end, seg.end + dlen) === "$".repeat(dlen)) {
      const out = seg.end + dlen;
      if (cursor < out) return { anchor: out, head: out };
    }
    return null;
  }
  for (let p = cursor - 2; p >= seg.start; p--) {
    if (braceAt(p, "{") && !isEnvName(p)) {
      const [from, to] = groupContent(p);
      if (from <= cursor && cursor <= to) continue; // move back, not reselect the current argument
      return { anchor: from, head: to };
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

// Caret-hugging placement: measure the tip's ACTUAL size after render (a
// worst-case clamp against max-width shoved narrow tips far left of the
// caret near the right window edge) and keep it inside the viewport.
// useLayoutEffect runs pre-paint, so the off-screen first pass never shows.
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
      el.style.setProperty("--caret-max-width", `${Math.max(0, width - 16)}px`);
      el.style.setProperty("--caret-max-height", `${Math.max(0, height - 16)}px`);
      const rect = anchor.getRect?.() || anchor;
      const { width: w, height: h } = el.getBoundingClientRect();
      const left = Math.max(x + 8, Math.min(rect.left, x + width - w - 8));
      const above = rect.top - h - 6, below = rect.bottom + 6;
      const desired = preferAbove
        ? (above >= y + 8 ? above : below)
        : (below + h <= y + height - 8 ? below : above);
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

// Overleaf-style floating preview of the math span under the caret. Sits
// above the caret line (below when there's no room). Long math scrolls inside
// the preview; interacting with it keeps the editor focused.
export function MathLivePreview({ tex, display, anchor }) {
  // A trailing lone backslash is a \command being typed — render what's
  // before it instead of flashing KaTeX's red error for the half keystroke.
  const src = escapedAt(tex, tex.length) ? tex.slice(0, -1) : tex;
  const html = src.trim() ? renderKatex(src, display) : null;
  const [ref, style] = useCaretAnchored(anchor, true, [tex, display]);
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

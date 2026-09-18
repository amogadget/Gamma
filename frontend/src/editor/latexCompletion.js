// The block editor's LaTeX command catalog and the pure helpers around it:
// \command completion (prefix, alias, abbreviation and VS Code-style fuzzy
// tiers), snippet insertion, the math span under the caret, and snippet-style
// Tab navigation. No DOM, no React — editor/LatexEditor.jsx re-exports these
// next to the preview and popup components; tests/latexCompletion.test.mjs
// pins the matching rules.
import { escapedAt, leftDelimiterEdit, rightDelimiterAt } from "./latexInput.js";

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
  "varnothing", "top", "bot", "degree", "therefore", "because", "square",
  "blacksquare", "triangle", "diamond", "bigstar", "checkmark", "hslash",
  "measuredangle", "complement", "backslash",
];
const OPERATORS = [
  "pm", "mp", "times", "cdot", "div", "ast", "star", "circ", "bullet",
  "oplus", "ominus", "otimes", "oslash", "odot", "dagger", "ddagger",
  "wedge", "vee", "sqcup", "sqcap", "setminus", "amalg", "ltimes", "rtimes",
  "uplus", "bigcirc", "boxplus", "boxtimes", "centerdot", "smallsetminus",
];
const RELATIONS = [
  "leq", "geq", "neq", "approx", "sim", "simeq", "equiv", "propto", "ll",
  "gg", "subset", "supset", "subseteq", "supseteq", "in", "notin", "ni",
  "cup", "cap", "forall", "exists", "nexists", "neg", "land", "lor", "mid",
  "vdash", "models", "le", "ge", "ne", "cong", "lesssim", "gtrsim",
  "leqslant", "geqslant", "prec", "succ", "preceq", "succeq", "subsetneq",
  "supsetneq", "sqsubseteq", "sqsupseteq", "asymp", "doteq", "nmid",
  "nparallel", "vDash", "lll", "ggg", "colon",
];
const ARROWS = [
  "to", "gets", "mapsto", "implies", "iff", "leftarrow", "rightarrow",
  "Leftarrow", "Rightarrow", "leftrightarrow", "Leftrightarrow",
  "longrightarrow", "longleftarrow", "uparrow", "downarrow", "nearrow",
  "searrow", "hookrightarrow", "rightharpoonup", "impliedby",
  "longleftrightarrow", "Longrightarrow", "Longleftarrow", "Longleftrightarrow",
  "longmapsto", "hookleftarrow", "twoheadrightarrow", "rightleftharpoons",
  "leftharpoonup", "Uparrow", "Downarrow", "updownarrow", "Updownarrow",
  "nwarrow", "swarrow", "curvearrowleft", "curvearrowright",
  "circlearrowleft", "circlearrowright", "dashrightarrow", "leadsto",
];
const BIG_OPS = [
  "sum", "prod", "int", "iint", "iiint", "oint", "oiint", "coprod", "bigcup",
  "bigcap", "bigoplus", "bigotimes", "bigodot", "bigsqcup", "bigvee",
  "bigwedge", "biguplus", "smallint",
];
const DOTS = ["dots", "cdots", "ldots", "vdots", "ddots", "dotsb", "dotsc"];
const DELIMS = [
  "langle", "rangle", "lvert", "rvert", "lVert", "rVert", "lfloor",
  "rfloor", "lceil", "rceil", "lgroup", "rgroup", "llbracket", "rrbracket",
];
const SPACING = ["quad", "qquad", "enspace", "thinspace", "medspace", "negthinspace"];

const CATALOG = [];
// Structures first: highest-value completions when they match.
for (const [name, args] of [
  ["frac", 2], ["sqrt", 1], ["binom", 2], ["cfrac", 2], ["dfrac", 2],
  ["tfrac", 2], ["dbinom", 2], ["tbinom", 2],
]) CATALOG.push({ name, args });
// nth root: caret in the index first, Tab hops on to the radicand.
CATALOG.push({ name: "sqrt[n]", ins: "\\sqrt[]{}", caret: 6, sample: "\\sqrt[n]{x}", alias: "root" });
// Quantum notation (KaTeX ships braket support natively).
for (const [name, args, sample] of [
  ["ket", 1, "\\ket{\\psi}"], ["bra", 1, "\\bra{\\phi}"],
  ["braket", 1, "\\braket{\\phi|\\psi}"], ["Ket", 1, "\\Ket{\\psi}"],
  ["Bra", 1, "\\Bra{\\phi}"],
]) CATALOG.push({ name, args, sample });
for (const name of GREEK) CATALOG.push({ name });
// Number sets (KaTeX macros for \mathbb{…}).
for (const name of ["R", "N", "Z", "Reals", "Complex", "natnums"]) CATALOG.push({ name });
// Accents / decorations.
for (const [name, args] of [
  ["hat", 1], ["bar", 1], ["vec", 1], ["tilde", 1], ["dot", 1], ["ddot", 1],
  ["dddot", 1], ["breve", 1], ["check", 1], ["acute", 1], ["grave", 1],
  ["mathring", 1], ["widehat", 1], ["widetilde", 1], ["widecheck", 1],
  ["overline", 1], ["underline", 1], ["boxed", 1], ["not", 1],
  ["overrightarrow", 1], ["overleftarrow", 1], ["overleftrightarrow", 1],
  ["underrightarrow", 1], ["underleftarrow", 1], ["cancel", 1],
  ["bcancel", 1], ["xcancel", 1], ["sout", 1], ["phantom", 1],
  ["hphantom", 1], ["vphantom", 1], ["smash", 1], ["mathstrut", 0],
  ["displaystyle", 0], ["textstyle", 0], ["scriptstyle", 0], ["limits", 0],
  ["nolimits", 0], ["tag", 1], ["fbox", 1], ["substack", 1],
]) CATALOG.push({ name, ...(args ? { args } : {}) });
// Braces with their label slot: caret in the brace, Tab hops to the label.
CATALOG.push(
  { name: "overbrace", ins: "\\overbrace{}^{}", caret: 11, sample: "\\overbrace{ab}^{c}" },
  { name: "underbrace", ins: "\\underbrace{}_{}", caret: 12, sample: "\\underbrace{ab}_{c}" },
  { name: "textcolor", ins: "\\textcolor{}{}", caret: 11, sample: "\\textcolor{#d33}{x}" },
  { name: "argmax", ins: "\\operatorname*{arg\\,max}_{}", caret: 26, sample: "\\operatorname*{arg\\,max}_{x}" },
  { name: "argmin", ins: "\\operatorname*{arg\\,min}_{}", caret: 26, sample: "\\operatorname*{arg\\,min}_{x}" },
  { name: "sgn", ins: "\\operatorname{sgn}", sample: "\\operatorname{sgn}" },
);
// Fonts.
for (const [name, args, sample] of [
  ["mathbb", 1, "\\mathbb{R}"], ["mathbf", 1, "\\mathbf{x}"],
  ["mathcal", 1, "\\mathcal{H}"], ["mathrm", 1, "\\mathrm{d}"],
  ["mathit", 1], ["mathsf", 1], ["mathtt", 1], ["mathscr", 1, "\\mathscr{A}"],
  ["mathnormal", 1], ["bm", 1, "\\bm{x}"],
  ["mathfrak", 1, "\\mathfrak{g}"], ["boldsymbol", 1, "\\boldsymbol{\\alpha}"],
  ["text", 1, "\\text{a}"], ["textbf", 1, "\\textbf{a}"], ["textit", 1, "\\textit{a}"],
  ["texttt", 1, "\\texttt{a}"], ["textsf", 1, "\\textsf{a}"],
  ["operatorname", 1, "\\operatorname{Tr}"],
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
  ["left.", "\\left.  \\right|", "\\left.x\\right|"],
]) CATALOG.push({ name, ins, sample, alias: "left" });
// Fixed-size delimiter pairs (\big … \Bigg), and \middle for a divider that
// grows with the enclosing \left…\right.
for (const size of ["big", "Big", "bigg", "Bigg"]) {
  for (const [open, close] of [["(", ")"], ["[", "]"], ["\\{", "\\}"], ["|", "|"]]) {
    CATALOG.push({
      name: `${size}${open}`, ins: `\\${size}${open}  \\${size}${close}`,
      sample: `\\${size}${open}x\\${size}${close}`, alias: size,
    });
  }
}
CATALOG.push({ name: "middle|", ins: "\\middle|", sample: "\\left(x\\middle|y\\right)", alias: "middle" });
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
  ["gather*", null, GATHERED_SAMPLE],
  ["equation", null, "\\square"],
  ["equation*", null, "\\square"],
  ["array", "{cc}", "\\begin{array}{cc}a&b\\\\c&d\\end{array}"],
  ["dcases", null, "\\begin{dcases}a\\\\b\\end{dcases}"],
  ["drcases", null, "\\begin{drcases}a\\\\b\\end{drcases}"],
  ["alignat", "{2}", ALIGNED_SAMPLE],
  ["alignat*", "{2}", ALIGNED_SAMPLE],
  ["alignedat", "{2}", ALIGNED_SAMPLE],
  ["darray", "{cc}", "\\begin{darray}{cc}a&b\\\\c&d\\end{darray}"],
  ["subarray", "{c}", "\\begin{subarray}{c}a\\\\b\\end{subarray}"],
  ["pmatrix*", "[r]", "\\begin{pmatrix*}[r]a&b\\\\c&d\\end{pmatrix*}"],
  ["bmatrix*", "[r]", "\\begin{bmatrix*}[r]a&b\\\\c&d\\end{bmatrix*}"],
  ["CD", null, "\\begin{CD}A@>>>B\\end{CD}"],
]) CATALOG.push({
  name,
  env: true,
  arg: arg || "",
  ins: `\\begin{${name}}${arg || ""}  \\end{${name}}`,
  alias: "begin",
  sample: sample || `\\begin{${name}}a&b\\\\c&d\\end{${name}}`,
});

// --- matching / insertion --------------------------------------------------

// Abbreviations that don't fall out of subsequence matching (the letters
// aren't in the name, or another name would win): Obsidian LaTeX Suite's
// shorthands, typed after the backslash.
const ABBR = {
  ooo: "infty", xx: "times", del: "partial", nab: "nabla", eps: "varepsilon",
  RR: "mathbb", CC: "mathbb", NN: "mathbb", ZZ: "mathbb", QQ: "mathbb",
  inv: "sqrt[n]", lra: "leftrightarrow", Lra: "Leftrightarrow",
  ra: "rightarrow", Ra: "Rightarrow", la: "leftarrow", La: "Leftarrow",
  ss: "subset", sse: "subseteq", cross: "times", ee: "exp", sq: "sqrt",
};

// Fuzzy score of a command name against the typed letters, VS Code style:
// every query character must appear in order (case-insensitive), anchored
// on the name's first letter so "mbb" finds mathbb and "lra"
// leftrightarrow without every name that merely contains the letters. Lower
// is better: a gap between matched letters costs more than a contiguous
// run, and shorter names win ties. null when it doesn't match.
export function fuzzyScore(name, query) {
  const n = name.toLowerCase(), q = query.toLowerCase();
  if (q.length < 2 || n[0] !== q[0]) return null;
  let score = 0, last = 0;
  for (let i = 1; i < q.length; i++) {
    const at = n.indexOf(q[i], last + 1);
    if (at < 0) return null;
    score += at === last + 1 ? 0 : 2 + (at - last - 1) * 0.1;
    last = at;
  }
  return score + (n.length - q.length) * 0.05;
}

export function latexCompletions(query, limit = 8) {
  if (!query) return [];
  const q = query.toLowerCase();
  const abbr = ABBR[query];
  const out = [];
  for (const c of CATALOG) {
    // Tiers: exact → the query already spells the whole command and the
    // name only adds a delimiter ("left" → `left(` before `leftarrow`) →
    // other prefix matches → abbreviation (a deliberate table entry, so
    // "Ra" means \Rightarrow, not \rangle) → case-insensitive prefix →
    // alias → fuzzy subsequence (ranked by fuzzyScore). Ties keep catalog
    // order.
    const letters = (c.name.match(/^[a-zA-Z]+/) || [""])[0];
    let tier = c.name === query ? 0
      : c.name.startsWith(query) ? (letters === query ? 1 : 2)
        : abbr === c.name ? 3
          : c.name.toLowerCase().startsWith(q) ? 4
            : c.alias && c.alias.startsWith(q) ? 5 : -1;
    let score = 0;
    if (tier < 0) {
      const f = fuzzyScore(c.name, query);
      if (f == null) continue;
      tier = 6;
      score = f;
    }
    out.push([tier, score, out.length, c]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return out.slice(0, limit).map((x) => x[3]);
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

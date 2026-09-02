// One answer to "where is the math, and is it centred?", used by the editor,
// the note renderer and the chat.
//
// There used to be two. The editor scans for `$$…$$` pairs and centres
// anything it finds, wherever the delimiters sit. remark-math instead requires
// `mathFlow`: both `$$` alone on their own lines. Everything else it mangles —
//
//   $$ E = mc^2 $$              → *inline* math (one line: mathFlow refuses,
//                                 because the rest of the opening line is an
//                                 info string and may not contain a `$`)
//   $$\begin{aligned}           → `\begin{aligned}` swallowed as the info
//   a &= b                        string, the closing `$$` left inside the
//   \end{aligned}$$               formula: KaTeX sees \end with no \begin
//
// — so a block rendered centred while you edited it went inline, or broke
// outright, the moment it lost focus. That is not a rendering bug, it is two
// tokenizers disagreeing, and no amount of patching one of them fixes the
// class of problem.
//
// So: the editor's tokenizer decides, and expandDisplayMath rewrites what it
// finds into the one layout remark-math handles correctly. The renderer then
// agrees with the editor by construction.
//
// (latexEditor.js has a third scanner, findMathAtCursor, for the LaTeX helper
// popup. It only decides where the caret is, never how anything renders, so it
// is left alone.)

/**
 * Every complete `$$…$$` or `$…$` pair, in source order.
 *
 * An unclosed opener stays raw text — it is being typed. Inline spans must sit
 * on one line and be non-empty, or "$5 and $3" in prose pairs into a formula.
 * An escaped `\$` is not a delimiter.
 *
 * @param {string} text
 * @returns {{from: number, to: number, display: boolean}[]} `to` is exclusive
 */
export function scanMathSpans(text) {
  const re = /\$\$?/g;
  const spans = [];
  let match;
  let open = null;
  while ((match = re.exec(text))) {
    if (text[match.index - 1] === "\\") continue;
    const token = { i: match.index, len: match[0].length };
    if (!open) {
      open = token;
    } else if (token.len === open.len) {
      const inner = text.slice(open.i + open.len, token.i);
      const ok = inner.trim() && (open.len === 2 || !inner.includes("\n"));
      if (ok) spans.push({ from: open.i, to: token.i + token.len, display: open.len === 2 });
      open = null;
    } else {
      // Mismatched pair ($ … $$): treat the later token as a fresh opener.
      open = token;
    }
  }
  return spans;
}

/**
 * Ranges whose contents are not markdown: fenced blocks and inline code. Math
 * inside them is text and must be left exactly as written.
 *
 * @param {string} text
 * @returns {{from: number, to: number}[]}
 */
export function scanCodeRanges(text) {
  const ranges = [];
  const fence = /^[ \t]*(```+|~~~+)[^\n]*$/gm;
  let open = null;
  let match;
  while ((match = fence.exec(text))) {
    if (!open) {
      open = { from: match.index, marker: match[1] };
    } else if (match[1].startsWith(open.marker[0])) {
      ranges.push({ from: open.from, to: match.index + match[0].length });
      open = null;
    }
  }
  // An unclosed fence runs to the end of the block, as markdown does.
  if (open) ranges.push({ from: open.from, to: text.length });

  for (const code of text.matchAll(/`[^`\n]+`/g)) {
    const from = code.index;
    const to = from + code[0].length;
    if (!ranges.some((r) => from >= r.from && to <= r.to)) ranges.push({ from, to });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/**
 * Rewrite every `$$…$$` span into the layout remark-math renders as display
 * math: both fences alone on their own lines.
 *
 * Inline `$…$` spans, and anything inside code, are untouched.
 *
 * @param {string} text markdown as the user typed it
 * @returns {string} markdown remark-math will render the way the editor does
 */
export function expandDisplayMath(text) {
  if (!text || !text.includes("$$")) return text || "";

  const code = scanCodeRanges(text);
  const inCode = (span) => code.some((r) => span.from >= r.from && span.to <= r.to);
  const spans = scanMathSpans(text).filter((s) => s.display && !inCode(s));
  if (!spans.length) return text;

  let out = "";
  let at = 0;
  for (const span of spans) {
    const before = text.slice(at, span.from);
    const inner = text.slice(span.from + 2, span.to - 2).trim();
    if (!inner) continue;
    out += before;
    // A fence must start its own line, and four spaces before it would make
    // the block an indented code block — so drop the indent first, then break
    // the line only if there is still something on it.
    out = out.replace(/[ \t]+$/, "");
    if (out && !out.endsWith("\n")) out += "\n";
    out += `$$\n${inner}\n$$`;
    at = span.to;
    // …and the closing fence needs the line to itself too.
    if (text[at] && text[at] !== "\n") out += "\n";
  }
  return out + text.slice(at);
}

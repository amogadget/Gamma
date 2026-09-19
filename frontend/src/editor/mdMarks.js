// Inline markdown marks (**bold**, *italic*, `code`, ~~strike~~,
// ==highlight==): the ONE table both the block editor's live rendering and
// its formatting hotkeys read, so "what counts as bold" is the same for the
// hidden-delimiter display and for Ctrl+B deciding between wrap and unwrap.
// Pure string functions, no CodeMirror — the editor adapts the results.

// Matched in this order — code first (its content is literal), italic last
// (most false-positive prone). Openers/closers may not hug whitespace, and a
// span never crosses a line break. Marks nest: "**a *b* c**" is bold with an
// italic inside, "*a **b** c*" the reverse, and "***x***" is
// bold+italic in one — its `layers` are what Ctrl+B / Ctrl+I peel off.
export const INLINE_MARKS = [
  { marker: "`", cls: "cmInlineCode", re: /`([^`\n]+)`/g },
  { marker: "==", cls: "cmHighlight", re: /==(?!\s)([^=\n]+?)(?<!\s)==/g },
  { marker: "***", cls: "cmStrong cmEm", layers: ["**", "*"],
    re: /\*\*\*(?![\s*])([^*\n]+?)(?<![\s*])\*\*\*/g },
  { marker: "**", cls: "cmStrong", re: /\*\*(?![\s*])((?:[^*\n]|\*(?!\*))+?)(?<![\s*])\*\*/g },
  { marker: "~~", cls: "cmStrike", re: /~~(?!\s)([^~\n]+?)(?<!\s)~~/g },
  { marker: "*", cls: "cmEm", re: /(?<!\*)\*(?![\s*])((?:[^*\n]|\*\*)+?)(?<![\s*])\*(?!\*)/g },
];

// Every inline-mark span in text: [{marker, cls, from, to}], from/to
// including the delimiters, outer spans before the spans nested in them.
// `claimed` ([[from, to], …]) holds ranges already taken by higher-priority
// constructs (fences, math, refs); spans overlapping one are skipped and
// accepted spans are pushed onto it, so the caller's later scans (links) see
// them too. Two inline spans may overlap only by proper nesting — one sits
// inside the other's content — and nothing nests inside inline code.
export function scanMarks(text, claimed = []) {
  const spans = [];
  const overlaps = (from, to) => claimed.some(([a, b]) => from < b && to > a);
  const nestsWith = (s, from, to, L) => {
    if (!(from < s.to && to > s.from)) return true;           // disjoint
    const sL = s.marker.length;
    if (s.marker === "`") return false;
    if (from >= s.from + sL && to <= s.to - sL) return true;  // inside s
    return s.from >= from + L && s.to <= to - L;              // s inside us
  };
  for (const mark of INLINE_MARKS) {
    const L = mark.marker.length;
    for (const m of text.matchAll(mark.re)) {
      const from = m.index, to = m.index + m[0].length;
      if (overlaps(from, to)) continue;
      if (!spans.every((s) => nestsWith(s, from, to, L))) continue;
      spans.push({ marker: mark.marker, cls: mark.cls, layers: mark.layers, from, to });
    }
  }
  for (const s of spans) claimed.push([s.from, s.to]);
  return spans.sort((a, b) => a.from - b.from || b.to - a.to);
}

// Whether a span carries `marker` — directly, or as one layer of "***".
const hasLayer = (mark, marker) =>
  mark.marker === marker || (mark.layers || []).includes(marker);

// The innermost span carrying `marker` whose range contains [from, to]
// (delimiters included, boundaries inclusive — the caret right after
// "**bold**" still counts).
function enclosingMark(spans, marker, from, to) {
  let best = null;
  for (const s of spans) {
    if (!hasLayer(s, marker) || s.from > from || to > s.to) continue;
    if (!best || s.from >= best.from) best = s;
  }
  return best;
}

// Toggle `marker` on the selection [from, to] of text, Obsidian-style.
// Returns {changes: [{from, to, insert}], selection: {anchor, head}} — the
// changes address the ORIGINAL text (they don't overlap), the selection the
// text after them — or null when there's nothing sensible to do.
//
//   caret in an empty pair  "**|**"        → pair removed
//   caret in / at a span    "**bo|ld**"    → span unwrapped, caret kept
//   caret elsewhere         "wo|rd"        → "wo**|**rd"
//   selection in a span     "**[bold]**"   → unwrapped, text stays selected
//   selection               "[word]"       → "**[word]**"  (inner selected,
//                                            surrounding whitespace excluded)
//   multi-line selection    each non-blank line wrapped (or all unwrapped
//                           when every one already is)
export function toggleMark(text, from, to, marker) {
  const L = marker.length;
  const spans = scanMarks(text);

  if (from === to) {
    if (text.slice(from - L, from) === marker && text.slice(from, from + L) === marker) {
      return { changes: [{ from: from - L, to: from + L, insert: "" }], selection: { anchor: from - L } };
    }
    const s = enclosingMark(spans, marker, from, from);
    if (s) return unwrap(s, L, from, from);
    return {
      changes: [{ from, to, insert: marker + marker }],
      selection: { anchor: from + L },
    };
  }

  // Whitespace at the selection's edges stays outside the delimiters — a
  // "** word**" renders as raw asterisks, here and in every markdown viewer.
  const sel = text.slice(from, to);
  const lead = sel.length - sel.trimStart().length;
  const trail = sel.length - sel.trimEnd().length;
  const a = from + lead, b = to - trail;
  if (a >= b) return null;

  if (text.slice(a, b).includes("\n")) return toggleLines(text, a, b, marker, spans);

  const s = enclosingMark(spans, marker, a, b);
  if (s) return unwrap(s, L, a, b);
  return {
    changes: [{ from: a, to: a, insert: marker }, { from: b, to: b, insert: marker }],
    selection: { anchor: a + L, head: b + L },
  };
}

// Delete a span's delimiters; the selection [a, b] maps into the new text.
function unwrap(s, L, a, b) {
  // (a position inside a delimiter clamps to the content's edge)
  const shift = (p) => Math.min(Math.max(p - L, s.from), s.to - 2 * L);
  return {
    changes: [{ from: s.from, to: s.from + L, insert: "" }, { from: s.to - L, to: s.to, insert: "" }],
    selection: { anchor: shift(a), head: shift(b) },
  };
}

// Multi-line selection: one span per non-blank line (a span can't cross a
// line break). When every such line is already wrapped, unwrap them all.
function toggleLines(text, a, b, marker, spans) {
  const L = marker.length;
  const lines = [];
  let pos = a;
  for (const raw of text.slice(a, b).split("\n")) {
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    if (lead + trail < raw.length) lines.push({ from: pos + lead, to: pos + raw.length - trail });
    pos += raw.length + 1;
  }
  if (!lines.length) return null;
  const wrapped = lines.map((ln) => enclosingMark(spans, marker, ln.from, ln.to));
  const changes = [];
  if (wrapped.every(Boolean)) {
    for (const s of wrapped) {
      changes.push({ from: s.from, to: s.from + L, insert: "" });
      changes.push({ from: s.to - L, to: s.to, insert: "" });
    }
    return { changes, selection: { anchor: a, head: b - 2 * L * lines.length } };
  }
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (wrapped[i]) continue;                  // already bold — leave it
    changes.push({ from: lines[i].from, to: lines[i].from, insert: marker });
    changes.push({ from: lines[i].to, to: lines[i].to, insert: marker });
    n++;
  }
  return { changes, selection: { anchor: a, head: b + 2 * L * n } };
}

// Ctrl+K: turn the selection into a markdown link. With a URL known (the
// clipboard's) the link is complete and the caret lands after it; otherwise
// the caret sits in the empty (…) slot ready for the address. No selection
// → "[|](url)" / "[|]()" with the caret in the text slot.
export function insertLink(text, from, to, url = "") {
  const label = text.slice(from, to);
  const insert = `[${label}](${url})`;
  let caret;
  if (!label) caret = from + 1;
  else if (url) caret = from + insert.length;
  else caret = from + 1 + label.length + 2;
  return { changes: [{ from, to, insert }], selection: { anchor: caret } };
}

export const isUrl = (s) => /^https?:\/\/\S+$/i.test((s || "").trim());

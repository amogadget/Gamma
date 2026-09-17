import { normalizeChars } from "../shared/lib/textnorm.js";

// Citations carry text, never coordinates from a different PDF engine.
export function parsePdfCitation(href, origin = "http://localhost") {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.pathname !== "/") return null;
    const pageId = url.searchParams.get("page");
    const page = Number(url.searchParams.get("pdf_page"));
    const quote = url.searchParams.get("quote") || "";
    if (!pageId || !Number.isSafeInteger(page) || page < 1 || page > 5000
        || quote.trim().length < 8 || quote.length > 2000) return null;
    return { pageId, page, quote };
  } catch { return null; }
}

// PDF.js exposes one textDiv per text item, including empty EOL items. Keep
// that correspondence: reconstructing runs from the DOM loses empty line
// breaks, font sizes and baselines (needed to distinguish citations from math).
export function citationRuns(items, textDivs) {
  const runs = items.filter(it => typeof it.str === "string").map((it, i) => ({
    text: textDivs ? (textDivs[i]?.firstChild?.textContent || "") : it.str,
    hasEOL: it.hasEOL, transform: it.transform, width: it.width,
    node: textDivs?.[i]?.firstChild,
  }));
  for (let i = 1; i < runs.length - 1; i++) {
    const run = runs[i];
    // Only multi-digit references or reference lists. Single-digit exponents
    // are intentionally retained; ordinary baseline numbers are never skipped.
    if (!/^\d{2,}(?:[,\u2013\u2014-]\d+)*$|^\d+(?:[,\u2013\u2014-]\d+)+$/.test(run.text.trim())) continue;
    let before = i - 1, after = i + 1;
    while (before >= 0 && !runs[before].text.trim()) before--;
    while (after < runs.length && !runs[after].text.trim()) after++;
    const prev = runs[before], next = runs[after];
    if (!prev || !next || !/[a-z]{3,}$/.test(prev.text.trim()) || !/^[.,;:!?]/.test(next.text.trim())) continue;
    const a = prev.transform, b = run.transform, c = next.transform;
    if (!a || !b || !c) continue;
    const size = Math.hypot(a[2], a[3]), small = Math.hypot(b[2], b[3]);
    const along = Math.hypot(a[0], a[1]);
    if (!size || !along || small > size * .82 || small < size * .45) continue;
    // Work in the text's own axes, so rotated pages have the same rules.
    const ux = a[0] / along, uy = a[1] / along;
    const rise = -(b[4] - a[4]) * uy + (b[5] - a[5]) * ux;
    const baseline = -(c[4] - a[4]) * uy + (c[5] - a[5]) * ux;
    const gap = (b[4] - a[4]) * ux + (b[5] - a[5]) * uy - prev.width;
    if (rise >= size * .18 && rise <= size * .65 && Math.abs(baseline) < size * .15
        && gap >= -size * .2 && gap <= size) run.referenceNumber = true;
  }
  return runs;
}

const fold = s => s.toLowerCase().replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2014\u0002]/g, "-");
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compoundHyphen(text, i) {
  const left = text.slice(0, i).match(/\p{L}+$/u)?.[0] || "";
  const right = text.slice(i + 1).match(/^\s*(\p{L}+)/u)?.[1] || "";
  return left && right && Math.max(left.length, right.length) > 1;
}

function normalizeCitationChars(chars) {
  // Search normalization joins any word characters across a wrapped hyphen.
  // Citations must keep ranges (53-70) and subtraction (x-y) intact, even
  // when the PDF puts the second operand on another line.
  const text = chars.map(c => c.ch).join("");
  const protectedAt = new Set();
  const guarded = chars.map((c, i) => {
    if (/[-\u2010-\u2015]/.test(c.ch) && !compoundHyphen(text, i)) {
      protectedAt.add(i);
      return { ...c, ch: "\uFFFF" };
    }
    return c;
  });
  const result = normalizeChars(guarded);
  result.norm = result.norm.map((ch, i) => protectedAt.has(result.src[i]) ? chars[result.src[i]].ch : ch);
  return result;
}

// Permit a compound-word hyphen to survive OR disappear at a line wrap.
// No fuzzy word substitution: numbers, mathematical minus signs and exponents
// still have to match, and multiple matches are reported as ambiguous.
function quotePattern(target, compact, typography) {
  let pattern = "";
  for (let i = 0; i < target.length; i++) {
    const ch = target[i];
    if (compact && /\s/.test(ch)) continue;
    pattern += typography && ch === "-" && compoundHyphen(target, i)
      ? "-?" : escapeRegex(ch);
  }
  return new RegExp(pattern, "gu");
}

export function matchCitation(runs, quote) {
  const chars = [];
  runs.forEach((run, it) => {
    for (let off = 0; off < run.text.length; off++) chars.push({ ch: run.text[off], it, off });
    if (run.hasEOL) chars.push({ ch: "\n", it: -1, off: 0 });
  });
  const source = normalizeCitationChars(chars);
  const target = fold(normalizeCitationChars(quote.split("").map(ch => ({ ch }))).norm.join(""));
  if (target.replace(/\s/g, "").length < 8) return { status: "missing", spans: [] };
  for (const [compact, typography, skipReferences] of [[false, false, false], [true, false, false], [true, true, false], [true, true, true]]) {
    let text = "", map = [];
    source.norm.forEach((ch, i) => {
      if (compact && /\s/.test(ch)) return;
      if (skipReferences && runs[chars[source.src[i]].it]?.referenceNumber) return;
      // Lowercasing can expand a character; preserve a map for every unit.
      const folded = fold(ch);
      text += folded;
      for (let j = 0; j < folded.length; j++) map.push(source.src[i]);
    });
    const pattern = quotePattern(target, compact, typography);
    const found = pattern.exec(text);
    if (!found) continue;
    const start = found.index;
    pattern.lastIndex = start + 1;
    if (pattern.exec(text)) return { status: "ambiguous", spans: [] };
    const spans = new Map();
    for (let i = start; i < start + found[0].length; i++) {
      const { it, off } = chars[map[i]];
      if (it < 0) continue;
      const span = spans.get(it);
      if (span) span.end = off + 1;
      else spans.set(it, { run: it, start: off, end: off + 1 });
    }
    return { status: "matched", spans: [...spans.values()] };
  }
  return { status: "missing", spans: [] };
}

export function citationRects(runs, wrapper, quote) {
  const match = matchCitation(runs, quote);
  const box = wrapper.getBoundingClientRect();
  const rects = [];
  for (const span of match.spans) {
    if (!runs[span.run].node) continue;
    const range = document.createRange();
    range.setStart(runs[span.run].node, span.start);
    range.setEnd(runs[span.run].node, span.end);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height || !box.width || !box.height) continue;
      rects.push({ left: (rect.left - box.left) / box.width * 100,
        top: (rect.top - box.top) / box.height * 100,
        width: rect.width / box.width * 100, height: rect.height / box.height * 100 });
    }
  }
  return { status: match.status, rects };
}

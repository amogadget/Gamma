// Pure page-segmentation for the AI translated view: pdf.js text runs in,
// paragraph blocks out. No pdf.js/react imports on purpose (like
// logseqPdfModel.js) — the geometry math is testable in isolation, and
// pdfViewer.jsx owns turning TextContent items into the flat runs consumed
// here.
//
// A run is {str, x, y, w, h}: baseline-left origin at scale-1 viewport
// coordinates, w the advance width, h the font height (both viewport units).
// A block is {x1, y1, x2, y2, size, nLines, text, translate} — the tight
// bbox the overlay masks and refills, the dominant font height, and whether
// the text is worth sending to the model at all (math-heavy runs, bare
// numbers and stray symbols stay original — a wrong "translation" of an
// equation is worse than none).

// Horizontal-gap thresholds (× line height) for splitting a visual line into
// fragments. A HARD gap always splits (scattered axis labels, table cells).
// A SOFT gap splits only with support from a vertically adjacent line whose
// own gap overlaps it — a two-column gutter (~1.4× in revtex) repeats down
// the page, while a one-off gap (removed superscript, stretched justification)
// doesn't and must not shred the line. The widest justified word gap is ~0.8×.
const GAP_HARD = 2.2;
const GAP_SOFT = 1.05;
// A fragment continues the block above it while the baseline step stays
// within this × line height; bigger steps start a new block.
const LINE_STEP = 1.7;

// --- lines → fragments -------------------------------------------------------

function buildFragments(runs) {
  const items = runs.filter((r) => r.str && r.str.trim() && r.h > 0 && r.w > 0);
  items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  // Group runs sharing a baseline into lines. Only the last few lines are
  // candidates — the y-sort means anything older can't match.
  const lines = [];
  for (const it of items) {
    let line = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
      if (Math.abs(lines[i].y - it.y) <= Math.min(lines[i].h, it.h) * 0.45) { line = lines[i]; break; }
    }
    if (!line) { line = { y: it.y, h: it.h, runs: [] }; lines.push(line); }
    line.runs.push(it);
    line.h = Math.max(line.h, it.h);
  }
  // Candidate split gaps per line (x-interval of the whitespace).
  for (const L of lines) {
    L.runs.sort((a, b) => a.x - b.x);
    L.breaks = [];
    let end = null;
    for (const r of L.runs) {
      if (end !== null && r.x - end > L.h * GAP_SOFT) {
        L.breaks.push({ x1: end, x2: r.x, hard: r.x - end > L.h * GAP_HARD });
      }
      end = end === null ? r.x + r.w : Math.max(end, r.x + r.w);
    }
  }
  // Substantive overlap only: a real gutter repeats at the same x-interval,
  // so the shared stretch covers most of the narrower gap. Sliver overlaps
  // (spaces around a superscript on the next line) don't count.
  const overlaps = (a, b) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
    > 0.5 * Math.min(a.x2 - a.x1, b.x2 - b.x1);
  const frags = [];
  lines.forEach((L, i) => {
    // A soft gap becomes a cut only when a neighboring line (within ~2.6 line
    // heights) has an overlapping gap of its own — the whitespace "river"
    // that marks a real column gutter.
    const cuts = L.breaks.filter((br) => br.hard || [lines[i - 1], lines[i + 1]].some(
      (N) => N && Math.abs(N.y - L.y) <= Math.max(L.h, N.h) * 2.6
        && N.breaks.some((nb) => overlaps(br, nb))));
    let cur = null;
    let end = null;
    for (const r of L.runs) {
      const gap = end === null ? 0 : r.x - end;
      const atCut = cur && cuts.some((c) => c.x1 >= end - 0.5 && c.x2 <= r.x + 0.5);
      if (!cur || atCut) {
        cur = { x1: r.x, x2: r.x + r.w, y: r.y, h: r.h, text: r.str, fonts: {} };
        frags.push(cur);
      } else {
        const needsSpace = gap > Math.max(cur.h, r.h) * 0.12
          && !/\s$/.test(cur.text) && !/^\s/.test(r.str);
        cur.text += (needsSpace ? " " : "") + r.str;
        cur.x2 = Math.max(cur.x2, r.x + r.w);
        cur.h = Math.max(cur.h, r.h);
      }
      cur.fonts[r.font || ""] = (cur.fonts[r.font || ""] || 0) + r.str.length;
      end = end === null ? r.x + r.w : Math.max(end, r.x + r.w);
    }
  });
  // Dominant font per fragment + how dominant it is — the block matcher uses
  // a CONFIDENT font change (roman body vs italic affiliation, an
  // all-symbols equation line) as a paragraph boundary.
  for (const f of frags) {
    let total = 0, best = 0;
    for (const k in f.fonts) {
      total += f.fonts[k];
      if (f.fonts[k] > best) { best = f.fonts[k]; f.font = k; }
    }
    f.fontShare = total ? best / total : 0;
    delete f.fonts;
  }
  frags.sort((a, b) => (a.y - b.y) || (a.x1 - b.x1));
  return frags;
}

// --- fragments → blocks ------------------------------------------------------

function xOverlap(a, b) {
  return Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
}

// Append `s` to the block text: rejoin hyphenated line breaks, no space
// between CJK, a space otherwise.
function joinLine(out, s) {
  if (!out) return s;
  if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(s)) return out.slice(0, -1) + s;
  if (/[぀-ヿ㐀-鿿]$/.test(out) && /^[぀-ヿ㐀-鿿]/.test(s)) return out + s;
  return out + " " + s;
}

// Whether a block's text should go to the model. Mostly-symbolic content
// (equations, tables of numbers, page footers) is left in place.
export function isTranslatable(text) {
  const t = text.trim();
  const dense = t.replace(/\s/g, "");
  if (dense.length < 2) return false;
  const cjk = (t.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  if (cjk >= 2) return true;
  const letters = (t.match(/[A-Za-zÀ-ɏЀ-ӿ]/g) || []).length;
  if (letters < 4 || letters / dense.length < 0.5) return false;
  // At least one real word (two adjacent letters, Latin or Cyrillic) — a
  // scatter of single-letter variables like "x y z p q" isn't prose.
  return /[A-Za-zÀ-ɏЀ-ӿ]{2}/.test(t);
}

// A block accumulated too eagerly can wrap AROUND a figure: full-width lines
// above it, short lines beside it. One bounding rect for that block covers
// the figure. Split the line list where the right edge jumps — widening
// always ends a unit (a paragraph or a figure-constrained stretch just
// finished); narrowing only when the NEXT line is narrow too (a lone short
// line is just a paragraph's last line).
function splitByWidth(lines, size) {
  const parts = [];
  let cur = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1], L = lines[i];
    const widen = L.x2 - prev.x2 > size * 2.5;
    const narrow = prev.x2 - L.x2 > size * 2.5
      && i + 1 < lines.length && Math.abs(lines[i + 1].x2 - L.x2) < size * 1.5;
    if (widen || narrow) { parts.push(cur); cur = []; }
    cur.push(L);
  }
  parts.push(cur);
  return parts;
}

export function segmentPage(runs) {
  const frags = buildFragments(runs);
  const blocks = [];
  for (const f of frags) {
    const fTop = f.y - f.h, fW = f.x2 - f.x1;
    let best = null, bestOv = 0;
    for (const b of blocks) {
      const step = f.y - b.lastY;
      // Same baseline (another column's fragment) or too far below — no merge.
      if (step <= f.h * 0.3 || step > Math.max(b.size, f.h) * LINE_STEP) continue;
      if (Math.max(b.size, f.h) / Math.min(b.size, f.h) > 1.34) continue; // font break (heading vs body)
      // First-line indent = a new paragraph (wrapped lines start at the
      // column edge; only paragraph openers sit deeper). Also keeps centered
      // author/affiliation stacks one block per line, and splits lines that
      // wrap around a figure on the LEFT (they start much deeper).
      if (f.x1 - b.x1 > f.h * 0.9) continue;
      // A confident font change (both sides ≥70% one font) is a boundary:
      // roman authors vs italic affiliations, a display-equation line inside
      // a paragraph. Mixed lines (inline math) stay mergeable.
      if (b.font !== f.font && b.fontShare > 0.7 && f.fontShare > 0.7) continue;
      const ov = xOverlap(b, f);
      if (ov >= 0.5 * Math.min(b.x2 - b.x1, fW) && ov > bestOv) { best = b; bestOv = ov; }
    }
    const line = { x1: f.x1, x2: f.x2, y1: fTop, y2: f.y + f.h * 0.25, text: f.text.trim(), h: f.h };
    if (best) {
      best.x1 = Math.min(best.x1, f.x1);
      best.x2 = Math.max(best.x2, f.x2);
      best.lastY = f.y;
      best.lines.push(line);
      // Dominant size: lean on the first lines, headings rarely mix mid-block.
      best.size = Math.min(best.size, Math.max(f.h, best.size * 0.85));
    } else {
      blocks.push({
        x1: f.x1, x2: f.x2, lastY: f.y, size: f.h, lines: [line],
        font: f.font, fontShare: f.fontShare,
      });
    }
  }
  const out = [];
  for (const b of blocks) {
    for (const lines of splitByWidth(b.lines, b.size)) {
      const x1 = Math.min(...lines.map((l) => l.x1));
      const x2 = Math.max(...lines.map((l) => l.x2));
      const y1 = Math.min(...lines.map((l) => l.y1));
      const y2 = Math.max(...lines.map((l) => l.y2));
      if (x2 - x1 <= 1 || y2 - y1 <= 1) continue;
      const text = lines.reduce((acc, l) => joinLine(acc, l.text), "");
      out.push({
        x1, x2, y1, y2, size: b.size, nLines: lines.length, text,
        // Per-line rects: the overlay masks exactly these, so a box that
        // (still) brushes a figure never paints over it.
        lines: lines.map(({ x1, x2, y1, y2 }) => ({ x1, x2, y1, y2 })),
        translate: isTranslatable(text),
      });
    }
  }
  return out;
}

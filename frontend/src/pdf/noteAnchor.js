// Where a highlight's note badge sits: the end of its last line, found from
// the highlight's stored rects by geometry. Stored order is not trusted —
// the viewer's own highlights are one rect per line, top to bottom, but
// imported ones (embedded PDF annotations, Zotero) keep per-glyph rects in
// whatever order the file listed them, and a selection can leave a sliver
// rect nowhere near the text — so "the last rect" put the bubble at the
// wrong line, or far off in the margin.

// Rects narrower than this (in the highlight's stored page units) are
// slivers, never the passage's end; ignored unless nothing else is left.
const SLIVER_W = 3;

// The rect the badge hangs off: among the solid rects, the one whose
// vertical centre is lowest picks the last line; the badge goes at the
// right edge of that line (the max x2 of every rect sharing its band) with
// that line's top. Null when there is nothing to anchor to.
export function noteBadgeAnchor(rects) {
  const all = (rects || []).filter((r) => r && Number.isFinite(r.x1) && Number.isFinite(r.x2)
    && Number.isFinite(r.y1) && Number.isFinite(r.y2));
  if (!all.length) return null;
  const solid = all.filter((r) => r.x2 - r.x1 >= SLIVER_W);
  const pool = solid.length ? solid : all;
  const mid = (r) => (r.y1 + r.y2) / 2;
  const last = pool.reduce((a, r) => (mid(r) > mid(a) ? r : a));
  const band = pool.filter((r) => mid(r) >= last.y1 && mid(r) <= last.y2);
  return {
    x1: Math.min(...band.map((r) => r.x1)),
    x2: Math.max(...band.map((r) => r.x2)),
    y1: Math.min(...band.map((r) => r.y1)),
    y2: Math.max(...band.map((r) => r.y2)),
  };
}

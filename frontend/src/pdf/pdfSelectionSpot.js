// Where a PDF selection sits, for the AI chat: the 1-based page it starts on
// and its region there as [x0, y0, x1, y1] fractions of the page (top-left
// origin). The server uses the page to place the passage (a phrase the paper
// repeats lands where it was selected) and the box to render a picture of it
// when its text layer is unreliable — a formula, a table
// (ai_context.request_selections / selection_crops).

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function boxOf(x0, y0, x1, y1, width, height) {
  if (!(width > 0 && height > 0)) return null;
  const box = [x0 / width, y0 / height, x1 / width, y1 / height].map(clamp01);
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

// A stored highlight's spot, from its position ({pageNumber, boundingRect:
// {x1, y1, x2, y2, width, height}} in the page's render size at capture).
export function highlightSpot(position) {
  const r = position?.boundingRect;
  const page = position?.pageNumber || r?.pageNumber || 0;
  if (!page) return { page: 0, box: null };
  return { page, box: r ? boxOf(r.x1, r.y1, r.x2, r.y2, r.width, r.height) : null };
}

// A live DOM selection's spot: the viewer page (`[data-page]`) its start
// sits in, and the union of the selection's rects on that page.
export function rangeSpot(range) {
  const node = range?.startContainer;
  const el = node?.nodeType === 3 ? node.parentElement : node;
  const pageEl = el?.closest?.("[data-page]");
  const page = pageEl ? parseInt(pageEl.dataset.page, 10) || 0 : 0;
  if (!page) return { page: 0, box: null };
  const p = pageEl.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of range.getClientRects()) {
    if (r.width <= 1 || r.height <= 1) continue;
    // Only the part on the start page — a selection may run onto the next.
    if (r.bottom <= p.top || r.top >= p.bottom || r.right <= p.left || r.left >= p.right) continue;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  if (!(x1 > x0 && y1 > y0)) return { page, box: null };
  return { page, box: boxOf(x0 - p.left, y0 - p.top, x1 - p.left, y1 - p.top, p.width, p.height) };
}

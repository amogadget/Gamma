// Handwriting: the client half of gamma/ink.py (docs/dev/handwriting.md).
// Pure — no React, no network — so it runs under node --test.
//
// An ink group is one `gamma-ink` file: strokes on one PDF page, in the
// page's scale-1 frame (pdf.js viewport at scale 1: points, origin
// top-left, rotation applied — the same frame highlight rects normalise
// to). Samples are stored per stroke as one flat integer array, `ch`
// naming the channels ("xy" + any of p/t/a/z); x, y (1/100 pt) and t (ms)
// are deltas after the first sample, p is 0..1000. Keep the codec here in
// step with the backend's.
import { getStroke } from "perfect-freehand";

export const FORMAT = "gamma-ink";
export const VERSION = 1;
export const COORD_UNIT = 100;
export const PRESSURE_UNIT = 1000;
export const THINNING = 0.5;      // width = size * (1 + THINNING * (p - 0.5)); mirrors ink.py
export const MAX_STROKES = 5000;

// Pen sizes (pt at scale 1, S/M/L) and highlighter sizes.
export const PEN_SIZES = [1.2, 2, 3.2];
export const HIGHLIGHTER_SIZES = [8, 12, 18];
export const PEN_COLORS = ["#1f1f1f", "#1d4ed8", "#dc2626", "#15803d", "#7c3aed", "#ea580c"];

export function newInk(page, width, height) {
  return { format: FORMAT, version: VERSION,
    space: { kind: "pdf-page", page, width, height }, strokes: [] };
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function strokeId() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

// --- codec -----------------------------------------------------------------

// samples: [{x, y, p?, t?}] with x/y in points and t in ms since t0.
export function encodeStroke({ id, tool = "pen", color = PEN_COLORS[0], size = 2, opacity = 1,
  pen = true, t0 = null, samples, ch = "xyp" }) {
  const pts = [];
  let px = 0, py = 0, pt = 0;
  for (const s of samples) {
    for (const c of ch) {
      if (c === "x") { const v = Math.round(s.x * COORD_UNIT); pts.push(v - px); px = v; }
      else if (c === "y") { const v = Math.round(s.y * COORD_UNIT); pts.push(v - py); py = v; }
      else if (c === "p") pts.push(Math.round(Math.max(0, Math.min(1, s.p ?? 0.5)) * PRESSURE_UNIT));
      else if (c === "t") { const v = Math.round(s.t || 0); pts.push(v - pt); pt = v; }
      else if (c === "a") pts.push(Math.round(s.a || 0));
      else if (c === "z") pts.push(Math.round(s.z || 0));
    }
  }
  const out = { id: id || strokeId(), tool, color, size, opacity, pen, ch, pts };
  if (t0 != null) out.t0 = t0;
  return out;
}

const decoded = new WeakMap();
// → [{x, y, p, t}] in points; p defaults to 0.5, t to null. Cached per stroke object.
export function decodeStroke(stroke) {
  const hit = decoded.get(stroke);
  if (hit) return hit;
  const { ch = "xy", pts = [] } = stroke;
  const n = ch.length, out = [];
  let x = 0, y = 0, t = 0;
  for (let i = 0; i + n <= pts.length; i += n) {
    const s = { x: 0, y: 0, p: 0.5, t: null };
    for (let k = 0; k < n; k++) {
      const c = ch[k], v = pts[i + k];
      if (c === "x") { x += v; s.x = x / COORD_UNIT; }
      else if (c === "y") { y += v; s.y = y / COORD_UNIT; }
      else if (c === "p") s.p = Math.max(0, Math.min(1, v / PRESSURE_UNIT));
      else if (c === "t") { t += v; s.t = t; }
      else if (c === "a") s.a = v;
      else if (c === "z") s.z = v;
    }
    out.push(s);
  }
  decoded.set(stroke, out);
  return out;
}

export function strokeWidth(stroke, p) {
  if (stroke.tool !== "pen" || stroke.pen === false) return stroke.size;
  return stroke.size * (1 + THINNING * (p - 0.5));
}

// --- geometry --------------------------------------------------------------

const bounds = new WeakMap();
// [x0, y0, x1, y1] around the samples, width included.
export function strokeBounds(stroke) {
  const hit = bounds.get(stroke);
  if (hit) return hit;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of decodeStroke(stroke)) {
    const r = strokeWidth(stroke, s.p) / 2;
    x0 = Math.min(x0, s.x - r); y0 = Math.min(y0, s.y - r);
    x1 = Math.max(x1, s.x + r); y1 = Math.max(y1, s.y + r);
  }
  const out = x0 === Infinity ? null : [x0, y0, x1, y1];
  bounds.set(stroke, out);
  return out;
}

export function inkBounds(ink) {
  let out = null;
  for (const s of ink?.strokes || []) {
    const b = strokeBounds(s);
    if (!b) continue;
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : [...b];
  }
  return out;
}

// The group's box in the highlight `pdf_position` shape (what jump-to-
// position, the sidebar marker and the exporters read).
export function pdfPositionOf(ink) {
  const b = inkBounds(ink);
  if (!b || ink.space?.kind !== "pdf-page") return null;
  const r2 = (v) => Math.round(v * 100) / 100;
  const rect = { x1: r2(b[0]), y1: r2(b[1]), x2: r2(b[2]), y2: r2(b[3]),
    width: ink.space.width, height: ink.space.height, pageNumber: ink.space.page };
  return { pageNumber: ink.space.page, boundingRect: rect, rects: [{ ...rect }] };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

// Ids of the strokes an eraser at (x, y) with `radius` touches: within
// half the stroke's width plus the radius of any segment. Bounding boxes
// prune the work.
export function hitStrokes(ink, x, y, radius) {
  const out = [];
  for (const s of ink?.strokes || []) {
    const b = strokeBounds(s);
    if (!b || x < b[0] - radius || x > b[2] + radius || y < b[1] - radius || y > b[3] + radius) continue;
    const pts = decodeStroke(s);
    let hit = false;
    for (let i = 0; i < pts.length && !hit; i++) {
      const a = pts[i], c = pts[Math.min(i + 1, pts.length - 1)];
      const tol = radius + Math.max(strokeWidth(s, a.p), strokeWidth(s, c.p)) / 2;
      if (segDist2(x, y, a.x, a.y, c.x, c.y) <= tol * tol) hit = true;
    }
    if (hit) out.push(s.id);
  }
  return out;
}

export function appendStroke(ink, stroke) {
  return { ...ink, strokes: [...(ink.strokes || []), stroke].slice(-MAX_STROKES) };
}

export function removeStrokes(ink, ids) {
  const drop = new Set(ids);
  return { ...ink, strokes: (ink.strokes || []).filter((s) => !drop.has(s.id)) };
}

// --- rendering -------------------------------------------------------------

const avg = (a, b) => (a + b) / 2;
// perfect-freehand's README recipe: the outline polygon as a closed path of
// quadratic curves through midpoints (smooth, no visible corners).
export function svgPathFromPoints(points) {
  const n = points.length;
  if (!n) return "";
  if (n < 3) {
    const [a] = points;
    return `M${a[0].toFixed(2)},${a[1].toFixed(2)} L${(a[0] + 0.01).toFixed(2)},${a[1].toFixed(2)}`;
  }
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)} Q`;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    d += `${a[0].toFixed(2)},${a[1].toFixed(2)} ${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `;
  }
  return d + "Z";
}

// Outline options in page units — thickness is size, so zoom scales ink
// like ink on paper.
export function outlineOptions(stroke) {
  return { size: stroke.size, thinning: stroke.pen === false ? 0 : THINNING, smoothing: 0.5,
    streamline: 0.4, simulatePressure: false, last: true };
}

// samples → the filled outline path for a pen stroke.
export function penOutline(samples, opts) {
  return svgPathFromPoints(getStroke(samples.map((s) => [s.x, s.y, s.p ?? 0.5]), opts));
}

const paths = new WeakMap();
// The SVG rendering of a stroke: {d, fill} (pen: a filled outline) or
// {d, stroke, width} (highlighter: a stroked polyline). Cached per object.
export function strokePath(stroke) {
  const hit = paths.get(stroke);
  if (hit) return hit;
  const pts = decodeStroke(stroke);
  let out;
  if (stroke.tool === "highlighter") {
    const d = pts.map((s, i) => `${i ? "L" : "M"}${s.x.toFixed(2)},${s.y.toFixed(2)}`).join(" ")
      + (pts.length === 1 ? ` L${(pts[0].x + 0.01).toFixed(2)},${pts[0].y.toFixed(2)}` : "");
    out = { d, stroke: true, width: stroke.size };
  } else {
    out = { d: penOutline(pts, outlineOptions(stroke)), stroke: false };
  }
  paths.set(stroke, out);
  return out;
}

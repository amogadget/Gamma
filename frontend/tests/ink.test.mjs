// node --test tests/  (from frontend/) — the pure stroke module.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TOOLS, HIGHLIGHTER_OPACITY, MAX_TOOLS, appendStroke, boundsOf, decodeStroke, encodeStroke, eraseAt, hitStrokes,
  inkBounds, newInk, normalizeTools, pdfPositionOf, removeStrokes, strokePath, strokeWidth, strokesInLasso, toolStyle,
  translateStrokes, transformStrokes, nearestInkStroke, restyleStrokes, duplicateStrokes, MAX_STROKES,
} from "../src/ink.js";

const samples = (n = 5, x0 = 100, y0 = 200) =>
  Array.from({ length: n }, (_, i) => ({ x: x0 + 10 * i, y: y0 + 3 * i, p: 0.2 + 0.15 * i, t: 16 * i }));

test("selection transforms share an origin, preserve non-position channels and undo without mutation", () => {
  const stroke = encodeStroke({ id: "a", size: 2, ch: "xyptaz", t0: 100,
    samples: [{ x: 20, y: 10, p: 0.3, t: 0, a: 40, z: 70 }, { x: 30, y: 10, p: 0.8, t: 25, a: 45, z: 80 }] });
  const other = encodeStroke({ id: "b", samples: samples() });
  const ink = { ...newInk(1, 612, 792), strokes: [stroke, other] };
  const moved = transformStrokes(ink, ["a"], { cx: 10, cy: 10, scale: 2, angle: Math.PI / 2 });
  assert.deepEqual(decodeStroke(moved.strokes[0]), [
    { x: 10, y: 30, p: 0.3, t: 0, a: 40, z: 70 }, { x: 10, y: 50, p: 0.8, t: 25, a: 45, z: 80 },
  ]);
  assert.equal(moved.strokes[0].size, 4);
  assert.equal(moved.strokes[0].id, "a");
  assert.equal(moved.strokes[0].t0, 100);
  assert.equal(moved.strokes[1], other);
  assert.equal(decodeStroke(stroke)[0].x, 20);
  const restored = transformStrokes(moved, ["a"], { cx: 10, cy: 10, scale: 0.5, angle: -Math.PI / 2 });
  assert.deepEqual(restored, ink);
  assert.equal(transformStrokes(ink, ["a"], { cx: 10, cy: 10 }), ink);
  assert.equal(transformStrokes(ink, ["a"], { cx: 10, cy: 10, scale: NaN }), ink);
  assert.equal(transformStrokes(ink, [], { cx: 10, cy: 10, scale: 2 }), ink);
});

test("touch selection finds a thin stroke between samples and prefers topmost ties", () => {
  const ink = { ...newInk(1, 612, 792), strokes: [
    encodeStroke({ id: "lower", size: 0.6, samples: [{ x: 10, y: 10 }, { x: 100, y: 10 }] }),
    encodeStroke({ id: "upper", size: 0.6, samples: [{ x: 10, y: 10 }, { x: 100, y: 10 }] }),
  ] };
  const groups = [{ id: "note", ink }];
  assert.deepEqual(nearestInkStroke(groups, 50, 14, 5), { id: "note", ids: ["upper"] });
  assert.equal(nearestInkStroke(groups, 50, 18, 5), null);
});

test("restyling selected ink preserves pressure and timing; mixed tools use their own widths", () => {
  const a = encodeStroke({ id: "a", samples: samples(), ch: "xypt", t0: 100 });
  const b = encodeStroke({ id: "b", tool: "highlighter", size: 14, opacity: 0.6, samples: samples() });
  const ink = { ...newInk(1, 612, 792), strokes: [a, b] };
  const edited = restyleStrokes(ink, ["a", "b"], { tool: "pen", size: 4 });
  assert.equal(edited.strokes[0].size, 4);
  assert.equal(edited.strokes[1], b);
  assert.equal(edited.strokes[0].pts, a.pts);
  assert.equal(edited.strokes[0].t0, 100);
  assert.deepEqual(decodeStroke(edited.strokes[0]), decodeStroke(a));
  const colored = restyleStrokes(edited, ["a", "b"], { color: "#DC2626" });
  assert(colored.strokes.every((s) => s.color === "#dc2626"));
  assert.equal(colored.strokes[1].opacity, 0.6);
  assert.equal(restyleStrokes(colored, ["a", "b"], { color: "#dc2626" }), colored, "same color is not an undo entry");
});

test("duplicate preserves originals and channels with fresh IDs; full notes do not evict ink", () => {
  const a = encodeStroke({ id: "a", samples: samples(), ch: "xypt", t0: 100 });
  const ink = { ...newInk(1, 612, 792), strokes: [a] };
  const copy = duplicateStrokes(ink, ["a"], 12, -8);
  assert.equal(copy.ink.strokes[0], a);
  assert.equal(copy.ids.length, 1);
  assert.notEqual(copy.ids[0], "a");
  const first = decodeStroke(copy.ink.strokes[1])[0];
  assert.deepEqual(first, { x: 112, y: 192, p: 0.2, t: 0 });
  assert.equal(copy.ink.strokes[1].t0, 100);
  const full = { ...ink, strokes: Array.from({ length: MAX_STROKES }, (_, i) => ({ ...a, id: String(i) })) };
  assert.deepEqual(duplicateStrokes(full, ["0"], 12, 12), { ink: full, ids: [] });
});

test("codec: deltas, pressure scale, exact round trip", () => {
  const s = encodeStroke({ id: "s1", samples: samples(), ch: "xypt", t0: 5 });
  // the backend's expectation for the same samples (tests/test_ink.py)
  assert.deepEqual(s.pts.slice(0, 8), [10000, 20000, 200, 0, 1000, 300, 350, 16]);
  assert.equal(s.t0, 5);
  const back = decodeStroke(s);
  assert.deepEqual(back.map((q) => [q.x, q.y, q.t]), samples().map((q) => [q.x, q.y, q.t]));
  assert.ok(Math.abs(back[1].p - 0.35) < 1e-9);
  assert.equal(decodeStroke(s), back, "decoded samples are cached per stroke object");
});

test("width follows pressure for pens only", () => {
  const pen = encodeStroke({ samples: samples() });
  assert.ok(strokeWidth(pen, 1) > pen.size && strokeWidth(pen, 0) < pen.size);
  const hl = encodeStroke({ tool: "highlighter", size: 8, samples: samples() });
  assert.equal(strokeWidth(hl, 0), 8);
  const mouse = encodeStroke({ pen: false, samples: samples() });
  assert.equal(strokeWidth(mouse, 0.1), mouse.size);
});

test("bounds, pdf_position and stroke editing", () => {
  let ink = newInk(3, 612, 792);
  assert.equal(inkBounds(ink), null);
  ink = appendStroke(ink, encodeStroke({ id: "a", samples: samples() }));
  ink = appendStroke(ink, encodeStroke({ id: "b", samples: samples(3, 300, 300) }));
  const b = inkBounds(ink);
  assert.ok(b[0] < 100 && b[1] < 200 && b[2] > 320 && b[3] > 306);
  const pos = pdfPositionOf(ink);
  assert.equal(pos.pageNumber, 3);
  assert.deepEqual([pos.boundingRect.width, pos.boundingRect.height], [612, 792]);
  assert.deepEqual(removeStrokes(ink, ["a"]).strokes.map((s) => s.id), ["b"]);
});

test("eraser hit test finds the stroke under the point and nothing else", () => {
  let ink = newInk(1, 612, 792);
  ink = appendStroke(ink, encodeStroke({ id: "a", samples: samples() }));          // (100,200)→(140,212)
  ink = appendStroke(ink, encodeStroke({ id: "b", samples: samples(3, 300, 300) })); // (300,300)→(320,306)
  assert.deepEqual(hitStrokes(ink, 120, 206, 2), ["a"]);
  assert.deepEqual(hitStrokes(ink, 310, 303, 2), ["b"]);
  assert.deepEqual(hitStrokes(ink, 200, 250, 2), []);
  assert.deepEqual(hitStrokes(ink, 120, 230, 30), ["a"], "radius reaches the stroke");
});

test("translate moves only the named strokes, by editing two integers", () => {
  let ink = newInk(1, 612, 792);
  ink = appendStroke(ink, encodeStroke({ id: "a", samples: samples() }));
  ink = appendStroke(ink, encodeStroke({ id: "b", samples: samples(3, 300, 300) }));
  const moved = translateStrokes(ink, ["a"], 10.5, -20);
  const a = decodeStroke(moved.strokes[0]), b = decodeStroke(moved.strokes[1]);
  assert.deepEqual([a[0].x, a[0].y, a[4].x, a[4].y], [110.5, 180, 150.5, 192]);
  assert.deepEqual([b[0].x, b[0].y], [300, 300]);
  assert.equal(translateStrokes(ink, ["a"], 0.001, 0), ink, "a sub-unit move is a no-op");
});

test("partial eraser cuts a stroke into the pieces outside the eraser", () => {
  let ink = newInk(1, 612, 792);
  ink = appendStroke(ink, encodeStroke({ id: "a", samples: samples(9) }));   // x = 100 … 180
  const { ink: cut, changed } = eraseAt(ink, 140, 212, 3);                   // hits the middle sample (140, 212)
  assert.equal(changed, true);
  assert.equal(cut.strokes.length, 2);
  const [p, q] = cut.strokes.map(decodeStroke);
  assert.deepEqual([p[0].x, p[p.length - 1].x], [100, 130]);
  assert.deepEqual([q[0].x, q[q.length - 1].x], [150, 180]);
  assert.ok(cut.strokes.every((s) => s.id !== "a" && s.tool === "pen" && s.size === 2), "pieces keep the look, get fresh ids");
  assert.equal(eraseAt(ink, 400, 400, 3).changed, false, "a miss changes nothing");
  // a piece of one sample is dropped
  assert.equal(eraseAt(ink, 110, 203, 3).ink.strokes.length, 1);
});

test("lasso selects strokes with most samples inside the polygon", () => {
  let ink = newInk(1, 612, 792);
  ink = appendStroke(ink, encodeStroke({ id: "a", samples: samples() }));          // 100..140 × 200..212
  ink = appendStroke(ink, encodeStroke({ id: "b", samples: samples(3, 300, 300) })); // 300..320 × 300..306
  const box = [[90, 190], [150, 190], [150, 220], [90, 220]];
  assert.deepEqual(strokesInLasso(ink, box), ["a"]);
  assert.deepEqual(strokesInLasso(ink, [[0, 0], [400, 0], [400, 400], [0, 400]]), ["a", "b"]);
  assert.deepEqual(strokesInLasso(ink, [[125, 190], [150, 190], [150, 220], [125, 220]]), [], "two of five samples inside");
  const b = boundsOf(ink, ["b"]);
  assert.ok(b[0] < 300 && b[2] > 320 && boundsOf(ink, ["zz"]) === null);
});

test("paths: pens are filled outlines, highlighters stroked polylines", () => {
  const pen = strokePath(encodeStroke({ samples: samples() }));
  assert.equal(pen.stroke, false);
  assert.ok(pen.d.startsWith("M") && pen.d.endsWith("Z") && pen.d.includes("Q"));
  const hl = strokePath(encodeStroke({ tool: "highlighter", size: 12, samples: samples(3) }));
  assert.equal(hl.stroke, true);
  assert.equal(hl.width, 12);
  assert.equal(hl.d, "M100.00,200.00 L110.00,203.00 L120.00,206.00");
  const dot = strokePath(encodeStroke({ samples: samples(1) }));
  assert.ok(dot.d.length > 0, "a single tap still draws a dot");
});

test("tool presets: a stored list is validated, bad entries dropped, nothing left → the defaults", () => {
  const stored = [
    { id: "a", kind: "pen", color: "#DC2626", size: 4 },
    { id: "a", kind: "highlighter", color: "#fde047", size: 14 },      // duplicate id → fresh id
    { kind: "pen", color: "red", size: 2 },                             // not hex
    { kind: "pen", color: "#000000", size: 99 },                        // out of range
    { kind: "pencil", color: "#000000", size: 2 },                      // unknown kind
    "junk",
  ];
  const tools = normalizeTools(stored);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0], { id: "a", kind: "pen", color: "#dc2626", size: 4 });
  assert.equal(tools[1].kind, "highlighter");
  assert.notEqual(tools[1].id, "a");
  assert.deepEqual(normalizeTools([]), DEFAULT_TOOLS);
  assert.deepEqual(normalizeTools("nope"), DEFAULT_TOOLS);
  assert.equal(normalizeTools(Array(30).fill({ kind: "pen", color: "#000000", size: 2 })).length, MAX_TOOLS);
  assert.deepEqual(toolStyle(tools[0]), { tool: "pen", color: "#dc2626", size: 4, opacity: 1 });
  assert.deepEqual(toolStyle(tools[1]), { tool: "highlighter", color: "#fde047", size: 14, opacity: HIGHLIGHTER_OPACITY });
});

// node --test tests/  (from frontend/) — the pure stroke module.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendStroke, boundsOf, decodeStroke, encodeStroke, eraseAt, hitStrokes, inkBounds, newInk, pdfPositionOf,
  removeStrokes, strokePath, strokeWidth, strokesInLasso, translateStrokes,
} from "../src/ink.js";

const samples = (n = 5, x0 = 100, y0 = 200) =>
  Array.from({ length: n }, (_, i) => ({ x: x0 + 10 * i, y: y0 + 3 * i, p: 0.2 + 0.15 * i, t: 16 * i }));

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

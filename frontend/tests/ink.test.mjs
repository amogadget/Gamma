// node --test tests/  (from frontend/) — the pure stroke module.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendStroke, decodeStroke, encodeStroke, hitStrokes, inkBounds, newInk, pdfPositionOf,
  removeStrokes, strokePath, strokeWidth,
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

import test from "node:test";
import assert from "node:assert/strict";
import { highlightSpot } from "../src/pdf/pdfSelectionSpot.js";

test("a highlight's spot is its page and its box as page fractions", () => {
  const position = {
    pageNumber: 3,
    boundingRect: { x1: 60, y1: 200, x2: 540, y2: 260, width: 600, height: 800, pageNumber: 3 },
  };
  assert.deepEqual(highlightSpot(position), { page: 3, box: [0.1, 0.25, 0.9, 0.325] });
});

test("a highlight without a usable box keeps its page", () => {
  assert.deepEqual(highlightSpot({ pageNumber: 2 }), { page: 2, box: null });
  assert.deepEqual(highlightSpot({ boundingRect: { x1: 5, y1: 5, x2: 5, y2: 9, width: 10, height: 10, pageNumber: 4 } }),
    { page: 4, box: null });
  assert.deepEqual(highlightSpot(null), { page: 0, box: null });
});

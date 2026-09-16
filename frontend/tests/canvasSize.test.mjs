import test from "node:test";
import assert from "node:assert/strict";
import { canvasSize, CANVAS_MAX_PIXELS, CANVAS_MAX_EDGE } from "../src/canvasSize.js";

test("normal pages retain high-DPI resolution", () => {
  assert.deepEqual(canvasSize(612, 792, 2), { width: 1224, height: 1584 });
});
test("400% pages and oversized formats stay inside both canvas limits", () => {
  for (const [w, h] of [[2448, 3168], [10000, 14000], [400, 50000], [50000, 400]]) {
    for (const dpr of [1, 2, 3]) {
      const size = canvasSize(w, h, dpr);
      assert(size.width * size.height <= CANVAS_MAX_PIXELS);
      assert(size.width <= CANVAS_MAX_EDGE && size.height <= CANVAS_MAX_EDGE);
      assert(Math.abs(size.width / w - size.height / h) <= 1 / Math.min(w, h));
    }
  }
  assert(canvasSize(10000, 14000, 2).width < 10000, "can reduce backing below CSS resolution");
});

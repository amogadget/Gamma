import { test } from "node:test";
import assert from "node:assert/strict";
import { noteBadgeAnchor } from "../src/pdf/noteAnchor.js";

const r = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

test("a viewer highlight anchors at the end of its last line", () => {
  const rects = [r(329, 660, 791, 679), r(242, 679, 790, 697), r(242, 697, 303, 715)];
  assert.deepEqual(noteBadgeAnchor(rects), r(242, 697, 303, 715));
});

test("imported per-glyph rects in file order still anchor at the lowest line's right edge", () => {
  // Glyph boxes of a two-line highlight, listed right-to-left and mixed.
  const rects = [r(180, 380, 220, 392), r(100, 380, 178, 392), r(120, 400, 160, 412), r(162, 400, 240, 412)];
  assert.deepEqual(noteBadgeAnchor(rects), r(120, 400, 240, 412));
});

test("tall bracket glyphs spanning both lines do not hijack the last line", () => {
  const rects = [r(100, 380, 200, 392), r(202, 370, 210, 411), r(100, 400, 180, 412)];
  const a = noteBadgeAnchor(rects);
  assert.equal(a.x2, 180);
  assert.equal(a.y1, 400);
});

test("a sliver rect left by the selection is ignored", () => {
  const rects = [r(200, 150, 830, 180), r(1290, 190, 1291, 220)];
  assert.deepEqual(noteBadgeAnchor(rects), r(200, 150, 830, 180));
  // Only slivers: still something to hang off.
  assert.deepEqual(noteBadgeAnchor([r(5, 5, 6, 9)]), r(5, 5, 6, 9));
});

test("nothing to anchor", () => {
  assert.equal(noteBadgeAnchor([]), null);
  assert.equal(noteBadgeAnchor(null), null);
  assert.equal(noteBadgeAnchor([{ x1: NaN, y1: 1, x2: 2, y2: 3 }]), null);
});

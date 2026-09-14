// The safe-triangle geometry behind submenu hover intent: is a pointer that
// was at (fromX, fromY) and is now at (x, y) heading into the open panel?
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAimingAt } from "../src/menuAim.js";

const panel = { left: 200, right: 400, top: 50, bottom: 150 };

test("a move toward the panel's near edge is an aim; away or past it is not", () => {
  assert.equal(isAimingAt(150, 100, 100, 100, panel), true, "straight at it");
  assert.equal(isAimingAt(150, 80, 100, 100, panel), true, "diagonally up, still inside the triangle");
  assert.equal(isAimingAt(150, 60, 100, 100, panel), false, "too steep: above the triangle's upper edge");
  assert.equal(isAimingAt(150, 300, 100, 100, panel), false, "sliding down the parent menu");
  assert.equal(isAimingAt(50, 100, 100, 100, panel), false, "moving away");
  assert.equal(isAimingAt(250, 100, 100, 100, panel), false, "already past the edge: the panel's own hover takes over");
});

test("the triangle is built toward whichever side the panel is on, padded by slack", () => {
  assert.equal(isAimingAt(450, 100, 500, 100, panel), true, "a panel opened to the left");
  assert.equal(isAimingAt(199, 45, 100, 100, panel, 6), true, "just above the corner, within the slack");
  assert.equal(isAimingAt(199, 30, 100, 100, panel, 6), false, "well above the corner");
});

test("no panel, or a pointer parked on its edge, never counts as aiming", () => {
  assert.equal(isAimingAt(150, 100, 100, 100, null), false);
  assert.equal(isAimingAt(200, 120, 200, 100, panel), false, "degenerate triangle");
});

// The guide's data stays consistent: every tour step names a registered
// anchor and a catalogued event, ids are unique, versions are integers, and
// every data-guide attribute in the source is registered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ANCHORS } from "../src/guide/anchors.js";
import { EVENTS, eventMatches } from "../src/guide/events.js";
import { TOURS } from "../src/guide/tours/index.js";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(name)) out.push(p);
  }
  return out;
}

test("tours reference registered anchors and catalogued events", () => {
  for (const tour of Object.values(TOURS)) {
    assert.ok(Number.isInteger(tour.version), `${tour.id}: version`);
    assert.ok(tour.steps.length > 0, `${tour.id}: steps`);
    const ids = new Set();
    for (const step of tour.steps) {
      assert.ok(step.id && !ids.has(step.id), `${tour.id}: duplicate or missing step id ${step.id}`);
      ids.add(step.id);
      if (step.anchor) assert.ok(ANCHORS[step.anchor], `${tour.id}/${step.id}: unregistered anchor ${step.anchor}`);
      if (step.advanceOn) assert.ok(EVENTS.includes(step.advanceOn.event), `${tour.id}/${step.id}: unknown event ${step.advanceOn.event}`);
    }
  }
});

test("every data-guide attribute in the source is registered", () => {
  const used = new Set();
  for (const file of walk(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bguide="([^"]+)"/g)) used.add(m[1]);
  }
  for (const id of used) assert.ok(ANCHORS[id], `data-guide="${id}" is not in guide/anchors.js`); // DockWindow passes it as guide="…"
  for (const id of Object.keys(ANCHORS)) assert.ok(used.has(id), `anchor ${id} is registered but no element carries it`);
});

test("eventMatches honours the payload match", () => {
  assert.equal(eventMatches({ event: "popover.opened", match: { name: "add" } }, "popover.opened", { name: "add" }), true);
  assert.equal(eventMatches({ event: "popover.opened", match: { name: "add" } }, "popover.opened", { name: "user" }), false);
  assert.equal(eventMatches({ event: "popover.opened" }, "page.opened", {}), false);
});

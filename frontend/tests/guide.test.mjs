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
import { canOfferTour, createGuideProgress, guideProgressKey } from "../src/guide/triggers.js";

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
    if (tour.trigger) {
      assert.ok(tour.invitation?.title && tour.invitation?.body && tour.estimate, `${tour.id}: invitation copy`);
      assert.ok(ANCHORS[tour.invitation.anchor], `${tour.id}: invitation anchor`);
      assert.ok(!tour.trigger.event || EVENTS.includes(tour.trigger.event), `${tour.id}: trigger event`);
      assert.ok(tour.trigger.event || Object.keys(tour.trigger.requires || {}).length, `${tour.id}: trigger needs an event or prerequisites`);
    }
    for (const step of tour.steps) {
      assert.ok(step.id && !ids.has(step.id), `${tour.id}: duplicate or missing step id ${step.id}`);
      ids.add(step.id);
      if (step.anchor) assert.ok(ANCHORS[step.anchor], `${tour.id}/${step.id}: unregistered anchor ${step.anchor}`);
      if (step.advanceOn) assert.ok(EVENTS.includes(step.advanceOn.event), `${tour.id}/${step.id}: unknown event ${step.advanceOn.event}`);
    }
  }
});

const aiTour = TOURS["ai-chat"];
const eligibleFacts = { aiConfigured: true, chatVisible: true, guideAvailable: true };
const contact = { name: "chat.focused", payload: {} };

test("contextual offers need both the intended interaction and current prerequisites", () => {
  assert.equal(canOfferTour(aiTour, { facts: eligibleFacts }), false, "mounting alone is not contact");
  assert.equal(canOfferTour(aiTour, { facts: eligibleFacts, event: contact }), true);
  for (const key of Object.keys(eligibleFacts)) {
    assert.equal(canOfferTour(aiTour, { facts: { ...eligibleFacts, [key]: false }, event: contact }), false, key);
  }
  assert.equal(canOfferTour(aiTour, { facts: eligibleFacts, event: { name: "chat.sent" } }), false);
  assert.equal(canOfferTour(TOURS["first-run"], { facts: eligibleFacts, event: contact }), false);
});

test("offered, dismissed, running and completed versions do not prompt again", () => {
  for (const state of ["offered", "dismissed", "running", "done"]) {
    const args = { facts: eligibleFacts, event: contact, progress: { version: aiTour.version, state } };
    assert.equal(canOfferTour(aiTour, args), false, state);
    assert.equal(canOfferTour({ ...aiTour, version: aiTour.version + 1 }, args), true, "new version can be offered");
    assert.equal(canOfferTour(aiTour, { ...args, progress: { version: aiTour.version + 1 } }), false, "downgrades never re-offer");
  }
});

test("state-only requirements and event payload filters use the same eligibility rules", () => {
  const tour = { ...aiTour, trigger: { requires: { hasPdf: true } } };
  assert.equal(canOfferTour(tour, { facts: { hasPdf: true } }), true);
  assert.equal(canOfferTour(tour, { facts: { hasPdf: false } }), false);
  assert.equal(canOfferTour(tour, { facts: { hasPdf: true }, event: contact }), false);
  tour.trigger = { event: "popover.opened", match: { name: "search" } };
  assert.equal(canOfferTour(tour, { facts: {}, event: { name: "popover.opened", payload: { name: "add" } } }), false);
  assert.equal(canOfferTour(tour, { facts: {}, event: { name: "popover.opened", payload: { name: "search" } } }), true);
});

test("progress survives reload, separates accounts, and tolerates broken browser storage", () => {
  const values = new Map();
  const storage = () => ({ getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) });
  const progress = createGuideProgress(storage);
  progress.write(aiTour, "alice", { state: "dismissed" });
  const reload = createGuideProgress(storage);
  assert.equal(reload.read(aiTour, "alice").state, "dismissed");
  assert.equal(reload.read(aiTour, "bob"), null);
  assert.equal(guideProgressKey(TOURS["first-run"], "alice"), "gamma-guide:first-run");
  values.set(guideProgressKey(aiTour, "bob"), "{broken");
  assert.equal(reload.read(aiTour, "bob"), null);
  const blocked = createGuideProgress(() => { throw new Error("Storage unavailable"); });
  blocked.write(aiTour, "alice", { state: "offered" });
  assert.equal(blocked.read(aiTour, "alice").state, "offered");
  assert.equal(blocked.read(aiTour, "bob"), null);
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

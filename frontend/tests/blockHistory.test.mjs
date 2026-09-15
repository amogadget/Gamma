// The undo stack's classifier: what a tree transition counts as. null —
// nothing undoable (a load, an editor opening, a fold); true — a structural
// or property edit; a block id — only that block's content changed (the
// candidate for merging with the previous keystroke).
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTransition, describeTransition } from "../src/blockHistory.js";

const N = (id, content = id, children = [], extra = {}) => ({ id, content, properties: {}, collapsed: false, editMode: false, children, ...extra });
const tree = () => [N("a", "a", [N("a1")]), N("b")];

test("undo descriptions name creations, deletions, text, moves, and properties", () => {
  assert.equal(describeTransition([], [N("a", "New note")]), "note creation: “New note”");
  assert.equal(describeTransition([N("a", "Old note")], []), "note deletion: “Old note”");
  assert.equal(describeTransition([N("a", "before")], [N("a", "after")]), "note text edit: “after”");
  assert.equal(describeTransition(tree(), tree().reverse()), "note move");
  assert.equal(describeTransition([N("a")], [N("a", "a", [], { properties: { color: "red" } })]), "note properties change");
  const h = N("h", "quote", [], { properties: { highlight_id: "h", color: "red" } });
  assert.equal(describeTransition([h], [{ ...h, properties: { ...h.properties, color: "blue" } }]), "highlight color change");
  assert.equal(describeTransition([N("a"), N("b")], []), "deletion of 2 notes");
});

test("identity, editor toggles and folding are not edits", () => {
  const t = tree();
  assert.equal(classifyTransition(t, t), null);
  assert.equal(classifyTransition(t, [{ ...t[0], editMode: true }, t[1]]), null);
  assert.equal(classifyTransition(t, [{ ...t[0], collapsed: true, properties: { collapsed: true } }, t[1]]), null);
});

test("one block's content names that block, nested or not", () => {
  const t = tree();
  assert.equal(classifyTransition(t, [t[0], { ...t[1], content: "b2" }]), "b");
  assert.equal(classifyTransition(t, [{ ...t[0], children: [{ ...t[0].children[0], content: "typed" }] }, t[1]]), "a1");
});

test("anything structural, a property, or two blocks' content is a plain edit", () => {
  const t = tree();
  assert.equal(classifyTransition(t, [t[0]]), true, "a block removed");
  assert.equal(classifyTransition(t, [t[1], t[0]]), true, "reordered");
  assert.equal(classifyTransition(t, [{ ...t[0], properties: { color: "red" } }, t[1]]), true, "a property");
  assert.equal(classifyTransition(t, [{ ...t[0], content: "x" }, { ...t[1], content: "y" }]), true, "two contents");
  assert.equal(classifyTransition(t, [{ ...t[0], content: "x", properties: { k: 1 } }, t[1]]), true, "content plus a property");
  assert.equal(classifyTransition(t, [{ ...t[0], children: [] }, t[1]]), true, "a child removed");
});

test("property comparison is by value and ignores the collapsed flag", () => {
  const t = [N("a", "a", [], { properties: { link: { url: "u" }, collapsed: false } })];
  assert.equal(classifyTransition(t, [{ ...t[0], properties: { link: { url: "u" }, collapsed: true } }]), null);
  assert.equal(classifyTransition(t, [{ ...t[0], properties: { link: { url: "v" } } }]), true);
});

// node --test tests/  (from frontend/) — the pure op module has no DOM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateNKeysBetween } from "fractional-indexing";
import { applyOps, diffTrees, keepUiFlags, propsPatch, pushOp, seedPositions } from "../src/blockOps.js";

const PAGE = "page1";
const N = (id, content = "", children = [], properties = {}, extra = {}) =>
  ({ id, content, properties, children, collapsed: false, editMode: false, ...extra });

// A tree as the server sends it: every node carries a position.
function served(tree, pos = new Map()) {
  const keys = ["a0", "a1", "a2", "a3", "a4", "a5", "a6"];
  const walk = (list) => list.map((n, i) => ({ ...n, position: keys[i], children: walk(n.children || []) }));
  const out = walk(tree);
  seedPositions(out, pos);
  return { tree: out, pos };
}

// Apply what diffTrees says to the base and compare with the intended
// next tree (ids, order, content, props), ignoring positions/UI flags.
const shape = (list) => (list || []).map((n) => ({
  id: n.id, content: n.content || "", properties: n.properties || {}, children: shape(n.children),
}));
function roundTrip(baseTree, nextTree) {
  const { tree: base, pos } = served(baseTree);
  const ops = diffTrees(base, nextTree, PAGE, pos);
  const got = applyOps(base, ops, PAGE, new Map(pos));
  assert.deepEqual(shape(got), shape(nextTree));
  return ops;
}

test("no change → no ops", () => {
  const { tree, pos } = served([N("a", "x"), N("b", "y", [N("c", "z")])]);
  assert.deepEqual(diffTrees(tree, tree, PAGE, pos), []);
});

test("content and property patches", () => {
  const ops = roundTrip(
    [N("a", "x", [], { color: "red", quote: "q" })],
    [N("a", "x2", [], { color: "red", n: 1 })],
  );
  // `base`: the text the change was made from (the server's three-way merge).
  assert.deepEqual(ops, [{ op: "set", id: "a", content: "x2", base: "x", props: { n: 1, quote: null } }]);
  assert.deepEqual(propsPatch({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 1 } }), {});
});

test("ui flags never travel", () => {
  const { tree, pos } = served([N("a", "x")]);
  const next = [{ ...tree[0], editMode: true, collapsed: true, depth: 3, parentId: null }];
  assert.deepEqual(diffTrees(tree, next, PAGE, pos), []);
});

test("insert at the end, in the middle, nested", () => {
  const ops = roundTrip(
    [N("a", "a"), N("c", "c")],
    [N("a", "a"), N("b", "b"), N("c", "c"), N("d", "d", [N("e", "e")])],
  );
  assert.deepEqual(ops.map((o) => [o.op, o.id, o.parent]),
    [["insert", "b", PAGE], ["insert", "d", PAGE], ["insert", "e", "d"]]);
  // b's key sorts between a and c
  assert.ok(ops[0].position > "a0" && ops[0].position < "a1", ops[0].position);
});

test("delete emits only the top-most removed subtrees", () => {
  const ops = roundTrip(
    [N("a", "a", [N("b", "b", [N("c", "c")])]), N("d", "d")],
    [N("d", "d")],
  );
  assert.deepEqual(ops, [{ op: "delete", id: "a" }]);
});

test("a block escaping a deleted parent moves out before the delete", () => {
  const ops = roundTrip(
    [N("a", "a", [N("b", "b")])],
    [N("b", "b")],
  );
  assert.deepEqual(ops.map((o) => o.op), ["move", "delete"]);
  assert.equal(ops[0].id, "b");
});

test("reorder: one moved block, the rest keep their keys", () => {
  // [a b c d] → [d a b c]: only d is re-keyed
  const ops = roundTrip(
    [N("a"), N("b"), N("c"), N("d")],
    [N("d"), N("a"), N("b"), N("c")],
  );
  assert.deepEqual(ops.map((o) => [o.op, o.id]), [["move", "d"]]);
  assert.ok(ops[0].position < "a0");
  // [a b c d] → [b c d a]: only a moves
  const ops2 = roundTrip([N("a"), N("b"), N("c"), N("d")], [N("b"), N("c"), N("d"), N("a")]);
  assert.deepEqual(ops2.map((o) => o.id), ["a"]);
  assert.ok(ops2[0].position > "a3");
});

test("indent / outdent are moves", () => {
  const ops = roundTrip([N("a"), N("b")], [N("a", "", [N("b")])]);
  assert.deepEqual(ops, [{ op: "move", id: "b", parent: "a", position: ops[0].position }]);
  const ops2 = roundTrip([N("a", "", [N("b")])], [N("a"), N("b")]);
  assert.deepEqual(ops2.map((o) => [o.op, o.id, o.parent]), [["move", "b", PAGE]]);
});

test("swapping parent and child orders the moves top-down", () => {
  const ops = roundTrip([N("x", "", [N("y")])], [N("y", "", [N("x")])]);
  assert.deepEqual(ops.map((o) => [o.op, o.id, o.parent]), [["move", "y", PAGE], ["move", "x", "y"]]);
});

test("move plus edit in one transition", () => {
  const ops = roundTrip([N("a", "a"), N("b", "b")], [N("b", "b!"), N("a", "a")]);
  assert.deepEqual(ops.map((o) => [o.op, o.id]), [["move", "b"], ["set", "b"]]);
});

test("applyOps: remote insert lands sorted, unknown ids are no-ops, re-insert re-parents", () => {
  const { tree, pos } = served([N("a", "a"), N("c", "c")]);
  let t = applyOps(tree, [{ op: "insert", id: "b", parent: PAGE, position: "a0V", content: "b", props: { k: 1 } }], PAGE, pos);
  assert.deepEqual(t.map((n) => n.id), ["a", "b", "c"]);
  assert.equal(t[1].editMode, false);
  t = applyOps(t, [{ op: "move", id: "zzz", parent: PAGE, position: "a9" }, { op: "delete", id: "nope" },
                   { op: "set", id: "ghost", content: "x" }], PAGE, pos);
  assert.deepEqual(t.map((n) => n.id), ["a", "b", "c"]);
  t = applyOps(t, [{ op: "insert", id: "b", parent: "a", position: "a0", content: "b2", props: {} }], PAGE, pos);
  assert.deepEqual(t.map((n) => n.id), ["a", "c"]);
  assert.equal(t[0].children[0].content, "b2");
  // a set on the page id is left to the caller
  assert.equal(applyOps(t, [{ op: "set", id: PAGE, content: "title" }], PAGE, pos), t);
});

test("applyOps: set patches properties but leaves the personal folding flag alone", () => {
  const { tree, pos } = served([N("a", "a", [N("b")], { collapsed: false })]);
  const t = applyOps(tree, [{ op: "set", id: "a", props: { collapsed: true, color: "c" } }], PAGE, pos);
  assert.deepEqual(t[0].properties, { collapsed: true, color: "c" });
  assert.equal(t[0].collapsed, false);
});

test("applyOps: untouched subtrees keep their identity", () => {
  const { tree, pos } = served([N("a", "a", [N("b")]), N("c", "c")]);
  const t = applyOps(tree, [{ op: "set", id: "c", content: "c2" }], PAGE, pos);
  assert.equal(t[0], tree[0]);
  assert.notEqual(t[1], tree[1]);
});

test("pushOp coalesces consecutive sets of one block", () => {
  const q = [];
  pushOp(q, { op: "set", id: "a", props: { z: 0 } });
  pushOp(q, { op: "set", id: "a", content: "1", base: "" });
  pushOp(q, { op: "set", id: "a", content: "12", base: "1", props: { x: 1 } });
  pushOp(q, { op: "set", id: "b", content: "b", base: "" });
  pushOp(q, { op: "set", id: "a", props: { y: 2 } });
  // The run of keystrokes keeps the base it started from (a props-only op
  // adopts the first content's base), and the latest content.
  assert.deepEqual(q, [
    { op: "set", id: "a", content: "12", base: "", props: { z: 0, x: 1, y: 2 } },
    { op: "set", id: "b", content: "b", base: "" },
  ]);
  pushOp(q, { op: "move", id: "a", parent: PAGE, position: "a5" });
  pushOp(q, { op: "set", id: "a", content: "after move" });
  assert.equal(q.length, 4);
});

test("keepUiFlags carries editor / folding state onto a fresh tree", () => {
  const cur = [N("a", "old", [N("b", "", [], {}, { editMode: true })], {}, { collapsed: true })];
  const fresh = [N("a", "new", [N("b", "b2"), N("c", "c")]), N("d")];
  const out = keepUiFlags(fresh, cur);
  assert.equal(out[0].collapsed, true);
  assert.equal(out[0].children[0].editMode, true);
  assert.equal(out[0].children[1].editMode, false);
  assert.equal(out[1].editMode, false);
});

test("a diff of a large flat reorder stays minimal", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const base = ids.map((id) => N(id));
  const pos = new Map();
  const keys = generateNKeysBetween(null, null, ids.length);
  ids.forEach((id, i) => pos.set(id, keys[i]));
  const rotated = [...base.slice(3), ...base.slice(0, 3)];
  const ops = diffTrees(base, rotated, PAGE, pos);
  assert.equal(ops.length, 3);
  assert.deepEqual(ops.map((o) => o.id), ["n0", "n1", "n2"]);
  const got = applyOps(base, ops, PAGE, new Map(pos));
  assert.deepEqual(got.map((n) => n.id), rotated.map((n) => n.id));
});

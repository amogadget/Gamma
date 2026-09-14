// The pure block-tree operations the outliner's keys run on.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addChildBlock, addSiblingBlock, blocksToHighlights, expandToBlock, extractBlock, findBlockContext,
  flattenBlocks, indentBlock, insertChild, insertSibling, isDescendant, makeBlockId, normalizeBlocks,
  outdentBlock, toggleCollapsed,
} from "../src/logseqPdfModel.js";

const N = (id, children = [], extra = {}) => ({ id, content: id, properties: {}, collapsed: false, editMode: false, children, ...extra });
const ids = (list) => list.map((b) => b.id);
// a(a1), b, c(c1(c1x), c2)
const tree = () => [N("a", [N("a1")]), N("b"), N("c", [N("c1", [N("c1x")]), N("c2")])];

test("indent moves a block under its previous sibling; the first sibling stays", () => {
  const t = tree();
  assert.equal(indentBlock(t, "a"), t);
  const out = indentBlock(t, "b");
  assert.deepEqual(ids(out), ["a", "c"]);
  assert.deepEqual(ids(out[0].children), ["a1", "b"]);
  assert.equal(out[0].collapsed, false, "the new parent is opened");
  assert.deepEqual(ids(t), ["a", "b", "c"], "the input is not mutated");
});

test("outdent puts a block right after its parent, at the root or inside the grandparent", () => {
  assert.deepEqual(ids(outdentBlock(tree(), "a1")), ["a", "a1", "b", "c"]);
  const out = outdentBlock(tree(), "c1x");
  assert.deepEqual(ids(out[2].children), ["c1", "c1x", "c2"]);
  assert.deepEqual(out[2].children[0].children, []);
  assert.equal(outdentBlock(tree(), "b").length, 3, "a root block has nowhere to go");
});

test("insertSibling / insertChild place a block; an unknown anchor returns the same list", () => {
  const t = tree();
  assert.deepEqual(ids(insertSibling(t, "b", N("n"), false)), ["a", "n", "b", "c"]);
  assert.deepEqual(ids(insertSibling(t, "b", N("n"), true)), ["a", "b", "n", "c"]);
  assert.deepEqual(ids(insertSibling(t, "c2", N("n"), true)[2].children), ["c1", "c2", "n"]);
  assert.equal(insertSibling(t, "nope", N("n"), true), t);
  assert.deepEqual(ids(insertChild(t, "b", N("n"))[1].children), ["n"]);
  assert.deepEqual(ids(insertChild(t, "c", N("n"), true)[2].children), ["c1", "c2", "n"]);
  assert.deepEqual(ids(insertChild(t, "c", N("n"))[2].children), ["n", "c1", "c2"]);
});

test("extractBlock returns the subtree and the tree without it, untouched elsewhere", () => {
  const t = tree();
  const { extracted, remaining } = extractBlock(t, "c1");
  assert.equal(extracted.id, "c1");
  assert.deepEqual(ids(extracted.children), ["c1x"]);
  assert.deepEqual(ids(remaining[2].children), ["c2"]);
  assert.equal(remaining[0], t[0], "untouched branches keep their identity");
  assert.equal(extractBlock(t, "nope"), null);
});

test("isDescendant and findBlockContext", () => {
  const t = tree();
  assert.equal(isDescendant(t, "c", "c1x"), true);
  assert.equal(isDescendant(t, "c", "c"), true);
  assert.equal(isDescendant(t, "a", "c2"), false);
  assert.deepEqual(findBlockContext(t, "c1x"), { block: t[2].children[0].children[0], parentId: "c1", index: 0, depth: 2, ancestors: ["c", "c1"] });
  assert.deepEqual(findBlockContext(t, "b").parentId, null);
  assert.equal(findBlockContext(t, "nope"), null);
});

test("new blocks: sibling below or above, child, with fresh 12-char ids in edit mode", () => {
  const t = tree();
  let { blocks, newId } = addSiblingBlock(t, "b");
  assert.deepEqual(ids(blocks), ["a", "b", newId, "c"]);
  assert.match(newId, /^[A-Za-z0-9_-]{12}$/);
  assert.equal(blocks[2].editMode, true);
  ({ blocks, newId } = addSiblingBlock(t, "b", { above: true }));
  assert.deepEqual(ids(blocks), ["a", newId, "b", "c"]);
  ({ blocks, newId } = addChildBlock(t, "b"));
  assert.deepEqual(ids(blocks[1].children), [newId]);
  assert.notEqual(makeBlockId(), makeBlockId());
});

test("flattenBlocks skips collapsed subtrees and annotates depth and parent", () => {
  const t = tree();
  t[2].collapsed = true;
  const flat = flattenBlocks(t);
  assert.deepEqual(flat.map((b) => [b.id, b.depth, b.parentId]), [["a", 0, null], ["a1", 1, "a"], ["b", 0, null], ["c", 0, null]]);
});

test("expandToBlock opens every ancestor of the target and nothing else", () => {
  const t = tree();
  t[2].collapsed = true; t[2].children[0].collapsed = true; t[0].collapsed = true;
  const out = expandToBlock(t, "c1x");
  assert.equal(out[2].collapsed, false);
  assert.equal(out[2].children[0].collapsed, false);
  assert.equal(out[0].collapsed, true);
});

test("toggleCollapsed keeps the flag and the stored property together", () => {
  const out = toggleCollapsed(tree(), "c");
  assert.equal(out[2].collapsed, true);
  assert.equal(out[2].properties.collapsed, true);
  assert.equal(toggleCollapsed(out, "c")[2].properties.collapsed, false);
});

test("normalizeBlocks derives the UI flags from the stored properties", () => {
  const out = normalizeBlocks([{ id: "x", content: "", properties: { collapsed: true }, children: [{ id: "y", content: "" }] }]);
  assert.deepEqual([out[0].collapsed, out[0].editMode, out[0].children[0].collapsed, out[0].children[0].editMode], [true, false, false, false]);
});

test("blocksToHighlights lists positioned highlight blocks and whether they carry a note", () => {
  const pos = { pageNumber: 2, rects: [] };
  const hl = (id, content, children = []) => N(id, children, { content, properties: { highlight_id: id, quote: "q", color: "red", pdf_page: 2, pdf_position: pos } });
  const out = blocksToHighlights([N("plain"), hl("h1", ""), hl("h2", "a comment"), hl("h3", "", [N("k", [], { content: " " }), N("m", [], { content: "note" })]),
    N("nopos", [], { properties: { highlight_id: "nopos" } })]);
  assert.deepEqual(out.map((h) => [h.id, h.hasNote]), [["h1", false], ["h2", true], ["h3", true]]);
  assert.deepEqual(out[0], { id: "h1", content: { text: "q" }, comment: { text: "" }, hasNote: false, color: "red", position: pos });
});

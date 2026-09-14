// The formatting hotkeys' pure toggle (Ctrl+B / I / E / Shift+X / Shift+H)
// and the inline-mark scanner both the editor's live rendering and the
// toggle read. Each case applies the returned changes to the text and
// checks the result plus where the selection lands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { insertLink, isUrl, scanMarks, toggleMark } from "../src/mdMarks.js";

// Apply {from, to, insert} changes addressed to the original text.
function apply(text, changes) {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}
const toggled = (text, from, to, marker) => {
  const r = toggleMark(text, from, to, marker);
  return r && { text: apply(text, r.changes), sel: r.selection };
};

test("a selection is wrapped, with the inner text still selected", () => {
  assert.deepEqual(toggled("say word now", 4, 8, "**"), { text: "say **word** now", sel: { anchor: 6, head: 10 } });
  assert.deepEqual(toggled("say word now", 4, 8, "*"), { text: "say *word* now", sel: { anchor: 5, head: 9 } });
});

test("whitespace at the selection's edges stays outside the delimiters", () => {
  assert.deepEqual(toggled("say word now", 3, 9, "**"), { text: "say **word** now", sel: { anchor: 6, head: 10 } });
  assert.equal(toggleMark("a   b", 1, 4, "**"), null, "nothing but whitespace: nothing to do");
});

test("a caret inserts an empty pair; a second press removes it", () => {
  assert.deepEqual(toggled("word", 2, 2, "**"), { text: "wo****rd", sel: { anchor: 4 } });
  assert.deepEqual(toggled("wo****rd", 4, 4, "**"), { text: "word", sel: { anchor: 2 } });
});

test("a caret inside or right after a span unwraps it", () => {
  assert.deepEqual(toggled("**bold**", 4, 4, "**"), { text: "bold", sel: { anchor: 2, head: 2 } });
  assert.deepEqual(toggled("**bold** x", 8, 8, "**"), { text: "bold x", sel: { anchor: 4, head: 4 } });
  assert.deepEqual(toggled("**bold**", 2, 6, "**"), { text: "bold", sel: { anchor: 0, head: 4 } });
});

test("a multi-line selection wraps each non-blank line, or unwraps them all", () => {
  assert.deepEqual(toggled("a\n\nb", 0, 4, "**"), { text: "**a**\n\n**b**", sel: { anchor: 0, head: 12 } });
  assert.deepEqual(toggled("**a**\n**b**", 0, 11, "**"), { text: "a\nb", sel: { anchor: 0, head: 3 } });
  // Mixed: the wrapped line is left alone, the other gets wrapped.
  assert.deepEqual(toggled("**a**\nb", 0, 7, "**"), { text: "**a**\n**b**", sel: { anchor: 0, head: 11 } });
});

test("marks nest, and *** is one bold+italic span whose layers peel off separately", () => {
  assert.deepEqual(scanMarks("**a *b* c**").map((s) => [s.marker, s.from, s.to]), [["**", 0, 11], ["*", 4, 7]]);
  assert.deepEqual(scanMarks("*a **b** c*").map((s) => [s.marker, s.from, s.to]), [["*", 0, 11], ["**", 3, 8]]);
  const [triple] = scanMarks("***x***");
  assert.deepEqual([triple.marker, triple.layers], ["***", ["**", "*"]]);
  assert.deepEqual(toggled("***x***", 3, 4, "**"), { text: "*x*", sel: { anchor: 1, head: 2 } });
  assert.deepEqual(toggled("***x***", 3, 4, "*"), { text: "**x**", sel: { anchor: 2, head: 3 } });
});

test("nothing nests inside inline code, and claimed ranges are skipped", () => {
  assert.deepEqual(scanMarks("`**a**`").map((s) => s.marker), ["`"]);
  const claimed = [[0, 5]]; // e.g. a math span the caller already took
  assert.deepEqual(scanMarks("$**a**$ **b**", claimed).map((s) => [s.marker, s.from]), [["**", 8]]);
  assert.deepEqual(claimed, [[0, 5], [8, 13]], "accepted spans are pushed onto the claimed list");
});

test("openers and closers may not hug whitespace, and a span never crosses a line", () => {
  assert.deepEqual(scanMarks("** a**"), []);
  assert.deepEqual(scanMarks("**a\nb**"), []);
  assert.deepEqual(scanMarks("==hi== ~~x~~").map((s) => s.cls), ["cmHighlight", "cmStrike"]);
});

test("insertLink builds the link and parks the caret in the empty slot", () => {
  let r = insertLink("hello world", 0, 5, "http://x");
  assert.deepEqual([apply("hello world", r.changes), r.selection.anchor], ["[hello](http://x) world", 17]);
  r = insertLink("hello world", 0, 5);
  assert.deepEqual([apply("hello world", r.changes), r.selection.anchor], ["[hello]() world", 8]);
  r = insertLink("x", 1, 1);
  assert.deepEqual([apply("x", r.changes), r.selection.anchor], ["x[]()", 2]);
  assert.equal(isUrl(" https://a.b/c "), true);
  assert.equal(isUrl("https://a b"), false);
  assert.equal(isUrl("ftp://a"), false);
});

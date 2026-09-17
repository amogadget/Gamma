import test from "node:test";
import assert from "node:assert/strict";
import { emptyLeftPair, leftDelimiterEdit, rightDelimiterAt } from "../src/editor/latexInput.js";

const apply = (value, edit) => value.slice(0, edit.changes.from) + edit.changes.insert + value.slice(edit.changes.to);

test("typing scalable openers supplies the matching right and keeps the caret inside", () => {
  for (const [open, close] of [["(", ")"], ["[", "]"], ["\\{", "\\}"], ["|", "|"],
    ["\\|", "\\|"], ["\\langle", "\\rangle"], ["\\lvert", "\\rvert"],
    ["\\lVert", "\\rVert"], ["\\lfloor", "\\rfloor"], ["\\lceil", "\\rceil"]]) {
    const prefix = "$\\left" + open.slice(0, -1);
    const edit = leftDelimiterEdit(prefix + "$", prefix.length, prefix.length, open.at(-1));
    assert.equal(apply(prefix + "$", edit), "$\\left" + open + "\\right" + close + "$");
    assert.equal(edit.selection.anchor, prefix.length + 1);
  }
});

test("nested pairs get their own closer while an already supplied closer is retained", () => {
  const value = "$\\left(\\left\\right)$";
  const pos = value.indexOf("\\right");
  assert.equal(apply(value, leftDelimiterEdit(value, pos, pos, "(")), "$\\left(\\left(\\right)\\right)$");
  const supplied = "$\\left\\right)$";
  assert.equal(apply(supplied, leftDelimiterEdit(supplied, 6, 6, "(")), "$\\left(\\right)$");
});

test("selection wrapping and empty-pair deletion preserve surrounding math", () => {
  const value = "$a+\\leftx+y$";
  const from = value.indexOf("x"), to = value.indexOf("$", 1);
  const edit = leftDelimiterEdit(value, from, to, "(");
  assert.equal(apply(value, edit), "$a+\\left(x+y\\right)$");
  assert.deepEqual(edit.selection, { anchor: from + 1, head: to + 1 });
  const pair = "$a+\\left\\langle\\right\\rangle+b$";
  const del = emptyLeftPair(pair, pair.indexOf("\\right"));
  assert.equal(pair.slice(0, del.from) + pair.slice(del.to), "$a++b$");
  assert.equal(emptyLeftPair("$\\left(x\\right)$", 8), null);
});

test("escaped commands and unrelated typing do not trigger pairing", () => {
  for (const prefix of ["$\\\\left", "$\\leftarrow", "$x+"]) {
    assert.equal(leftDelimiterEdit(prefix + "$", prefix.length, prefix.length, "("), null);
  }
  assert.equal(rightDelimiterAt("\\right\\rangle", 0), "\\right\\rangle");
  assert.equal(rightDelimiterAt("\\\\right)", 1), null);
  assert.equal(rightDelimiterAt("\\rightarrow", 0), null);
});

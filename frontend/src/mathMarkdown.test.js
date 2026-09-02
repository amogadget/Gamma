// The point of normalizeDisplayMath is what the *parser* does with its
// output, so most of these assert the parse rather than the string: a
// transformation that looks right and still yields inline math would be no
// fix at all.

import assert from "node:assert/strict";
import { test } from "node:test";

import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkBreaks from "remark-breaks";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { normalizeDisplayMath } from "./mathMarkdown.js";

/** The math nodes the note renderer's plugin chain produces, in order. */
function mathNodes(markdown) {
  const pipeline = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkBreaks);
  const tree = pipeline.runSync(pipeline.parse(markdown));
  const found = [];
  visit(tree, (node) => {
    if (node.type === "math" || node.type === "inlineMath") {
      found.push({ type: node.type, value: node.value });
    }
  });
  return found;
}

const rendered = (markdown) => mathNodes(normalizeDisplayMath(markdown));

test("a one-line $$…$$ block is inline math until normalized", () => {
  // The bug, pinned: this is what the note renderer used to receive.
  assert.deepEqual(mathNodes("$$ E = mc^2 $$"), [{ type: "inlineMath", value: "E = mc^2" }]);
  assert.deepEqual(rendered("$$ E = mc^2 $$"), [{ type: "math", value: "E = mc^2" }]);
});

test("spacing and indentation do not change the outcome", () => {
  for (const source of ["$$E=mc^2$$", "  $$ E=mc^2 $$  ", "$$   E=mc^2   $$"]) {
    const nodes = rendered(source);
    assert.equal(nodes.length, 1, source);
    assert.equal(nodes[0].type, "math", source);
    assert.equal(nodes[0].value, "E=mc^2", source);
  }
});

test("display math already in block form is left exactly as it was", () => {
  const source = "$$\n\\int_0^1 x\\,dx\n$$";
  assert.equal(normalizeDisplayMath(source), source);
  assert.deepEqual(rendered(source), [{ type: "math", value: "\\int_0^1 x\\,dx" }]);
});

test("a line inside a block-form span is not rewritten", () => {
  // `a $$ b` between the fences is content, however odd it looks.
  const source = "$$\na $$ b $$ c\n$$";
  assert.equal(normalizeDisplayMath(source), source);
});

test("inline math stays inline", () => {
  assert.deepEqual(rendered("energy is $E=mc^2$ here"), [
    { type: "inlineMath", value: "E=mc^2" },
  ]);
});

test("a span sharing a line with text is left alone", () => {
  // Making that a block would split the paragraph — and inside a table cell
  // it would destroy the table.
  const source = "see $$E=mc^2$$ inline";
  assert.equal(normalizeDisplayMath(source), source);
  assert.deepEqual(rendered(source), [{ type: "inlineMath", value: "E=mc^2" }]);
});

test("two spans on one line are left alone", () => {
  const source = "$$a$$ $$b$$";
  assert.equal(normalizeDisplayMath(source), source);
});

test("code fences are never touched", () => {
  const source = "```md\n$$ E = mc^2 $$\n```";
  assert.equal(normalizeDisplayMath(source), source);
  assert.deepEqual(rendered(source), [], "and no math node comes out of it");

  const tilde = "~~~\n$$ x $$\n~~~";
  assert.equal(normalizeDisplayMath(tilde), tilde);
});

test("inline code on its own line is not display math", () => {
  const source = "`$$ E = mc^2 $$`";
  assert.equal(normalizeDisplayMath(source), source);
});

test("an equation among prose becomes display without disturbing the prose", () => {
  const nodes = rendered("Given the mass:\n$$ E = mc^2 $$\nwhich is the result.");
  assert.deepEqual(nodes, [{ type: "math", value: "E = mc^2" }]);
  const out = normalizeDisplayMath("Given the mass:\n$$ E = mc^2 $$\nwhich is the result.");
  assert.ok(out.startsWith("Given the mass:\n"), out);
  assert.ok(out.endsWith("\nwhich is the result."), out);
});

test("several equations in one block all become display", () => {
  const nodes = rendered("$$ a = 1 $$\n$$ b = 2 $$");
  assert.deepEqual(nodes, [
    { type: "math", value: "a = 1" },
    { type: "math", value: "b = 2" },
  ]);
});

test("text without math is returned unchanged, and cheaply", () => {
  const source = "just a note about $5 and $3 in prose";
  assert.equal(normalizeDisplayMath(source), source);
  assert.equal(normalizeDisplayMath(""), "");
  assert.equal(normalizeDisplayMath(null), "");
  assert.equal(normalizeDisplayMath(undefined), "");
});

test("an empty span is not mistaken for an equation", () => {
  assert.equal(normalizeDisplayMath("$$$$"), "$$$$");
  assert.equal(normalizeDisplayMath("$$   $$"), "$$   $$");
});

// The contract: whatever the editor centres, the renderer centres — with the
// same content. So most of these assert what remark-math *parses*, not what
// the string looks like: a rewrite that reads well and still yields inline
// math, or silently drops a `\begin{aligned}`, would be no fix at all.

import assert from "node:assert/strict";
import { test } from "node:test";

import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { expandDisplayMath, scanCodeRanges, scanMathSpans } from "./mathMarkdown.js";

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

const rendered = (markdown) => mathNodes(expandDisplayMath(markdown));

/** What the editor would centre, for comparing the two against each other. */
const editorDisplayMath = (text) =>
  scanMathSpans(text)
    .filter((s) => s.display)
    .map((s) => text.slice(s.from + 2, s.to - 2).trim());

// --- the reported failures ---------------------------------------------------

test("a one-line $$…$$ is centred, not inline", () => {
  assert.deepEqual(mathNodes("$$ E = mc^2 $$"), [{ type: "inlineMath", value: "E = mc^2" }]);
  assert.deepEqual(rendered("$$ E = mc^2 $$"), [{ type: "math", value: "E = mc^2" }]);
});

test("an environment opened on the $$ line keeps its \\begin", () => {
  // The nastier half of the bug: mathFlow took `\begin{aligned}` as the
  // fence's info string and left the closing `$$` inside the formula, so
  // KaTeX saw an \end with no \begin and rendered nothing useful.
  const source = "$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$";
  const before = mathNodes(source);
  assert.equal(before.length, 1);
  assert.ok(!before[0].value.includes("\\begin{aligned}"), "the \\begin was being dropped");
  assert.ok(before[0].value.includes("$$"), "and the closing fence ended up inside the math");

  const after = rendered(source);
  assert.deepEqual(after, [
    { type: "math", value: "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}" },
  ]);
});

test("a space after the opening $$ makes no difference", () => {
  // It looked like it did; it did not — both forms were broken the same way.
  const spaced = "$$ \\begin{aligned}\na &= b\n\\end{aligned} $$";
  assert.deepEqual(rendered(spaced), [
    { type: "math", value: "\\begin{aligned}\na &= b\n\\end{aligned}" },
  ]);
});

// --- the contract: the renderer follows the editor ---------------------------

test("every span the editor centres, remark-math also centres, with the same content", () => {
  const sources = [
    "$$ E = mc^2 $$",
    "$$E=mc^2$$",
    "$$\\begin{aligned}\na &= b\n\\end{aligned}$$",
    "$$ \\begin{aligned}\na &= b\n\\end{aligned} $$",
    "$$\n\\int_0^1 x\\,dx\n$$",
    "Given:\n$$ a = 1 $$\nand also:\n$$ b = 2 $$",
    "$$ a = 1 $$\n$$ b = 2 $$",
  ];
  for (const source of sources) {
    const editor = editorDisplayMath(source);
    const renderer = rendered(source).filter((n) => n.type === "math").map((n) => n.value);
    assert.deepEqual(renderer, editor, `disagreement for ${JSON.stringify(source)}`);
  }
});

test("display math already in the canonical layout is left alone", () => {
  const source = "$$\n\\int_0^1 x\\,dx\n$$";
  assert.equal(expandDisplayMath(source), source);
});

test("prose around an equation survives", () => {
  const out = expandDisplayMath("Given the mass:\n$$ E = mc^2 $$\nwhich is the result.");
  assert.ok(out.startsWith("Given the mass:\n"), out);
  assert.ok(out.endsWith("\nwhich is the result."), out);
  assert.deepEqual(rendered("Given the mass:\n$$ E = mc^2 $$\nwhich is the result."), [
    { type: "math", value: "E = mc^2" },
  ]);
});

test("an indented equation does not become an indented code block", () => {
  const out = expandDisplayMath("    $$ E = mc^2 $$");
  assert.ok(/^\$\$\n/.test(out), JSON.stringify(out));
  assert.deepEqual(rendered("    $$ E = mc^2 $$"), [{ type: "math", value: "E = mc^2" }]);
});

// --- what must not change ----------------------------------------------------

test("inline math stays inline", () => {
  assert.deepEqual(rendered("energy is $E=mc^2$ here"), [
    { type: "inlineMath", value: "E=mc^2" },
  ]);
  assert.equal(expandDisplayMath("energy is $E=mc^2$ here"), "energy is $E=mc^2$ here");
});

test("a $$ span mid-sentence is promoted, as the editor promotes it", () => {
  // The editor centres this too, so the renderer matching it is the point —
  // even though it splits the sentence.
  const source = "see $$E=mc^2$$ inline";
  assert.deepEqual(editorDisplayMath(source), ["E=mc^2"]);
  assert.deepEqual(rendered(source), [{ type: "math", value: "E=mc^2" }]);
});

test("code is never touched", () => {
  for (const source of [
    "```md\n$$ E = mc^2 $$\n```",
    "~~~\n$$ x $$\n~~~",
    "`$$ E = mc^2 $$`",
    "```\n$$\\begin{aligned}\na\n\\end{aligned}$$\n```",
  ]) {
    assert.equal(expandDisplayMath(source), source, source);
  }
  assert.deepEqual(rendered("```md\n$$ E = mc^2 $$\n```"), [], "and yields no math node");
});

test("an unclosed fence protects everything after it", () => {
  const source = "```\n$$ E = mc^2 $$";
  assert.equal(expandDisplayMath(source), source);
});

test("an unclosed $$ is left as typed", () => {
  // Someone is mid-keystroke; rewriting it would fight them.
  assert.equal(expandDisplayMath("$$ E = mc"), "$$ E = mc");
});

test("an empty span is not an equation", () => {
  assert.equal(expandDisplayMath("$$$$"), "$$$$");
  assert.equal(expandDisplayMath("$$   $$"), "$$   $$");
});

test("text without math comes back unchanged", () => {
  assert.equal(expandDisplayMath("$5 and $3 in prose"), "$5 and $3 in prose");
  assert.equal(expandDisplayMath(""), "");
  assert.equal(expandDisplayMath(null), "");
});

test("an escaped \\$ is not a delimiter", () => {
  const source = "$$ a \\$ b $$";
  assert.deepEqual(editorDisplayMath(source), ["a \\$ b"]);
  assert.deepEqual(rendered(source), [{ type: "math", value: "a \\$ b" }]);
});

// --- the scanners ------------------------------------------------------------

test("scanMathSpans marks two dollars as display and one as inline", () => {
  assert.deepEqual(scanMathSpans("$a$ and $$b$$"), [
    { from: 0, to: 3, display: false },
    { from: 8, to: 13, display: true },
  ]);
});

test("scanCodeRanges finds fences and inline code", () => {
  const text = "a `x` b\n```\nfenced\n```\n";
  const ranges = scanCodeRanges(text);
  assert.equal(ranges.length, 2);
  assert.deepEqual(text.slice(ranges[0].from, ranges[0].to), "`x`");
  assert.ok(text.slice(ranges[1].from, ranges[1].to).startsWith("```"));
});

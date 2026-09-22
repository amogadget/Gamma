// The \command completion's matching tiers and snippets (editor/latexCompletion.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { envCompletions, fuzzyScore, insertionFor, latexCompletions } from "../src/editor/latexCompletion.js";

const names = (q, n) => latexCompletions(q, n).map((c) => c.name);

test("exact and prefix matches rank before the fuzzy tail", () => {
  assert.equal(names("frac")[0], "frac");
  assert.deepEqual(names("left", 3), ["left(", "left[", "left\\{"]);
  assert.equal(names("sq")[0], "sqrt");
  // Case-insensitive prefix after the exact-case ones.
  assert.ok(names("gamma").indexOf("gamma") < names("gamma").indexOf("Gamma"));
  // An alias ("begin") lists environments; "big" its delimiter sizes.
  assert.ok(names("begin", 20).includes("aligned"));
  assert.ok(names("big", 20).includes("big("));
});

test("fuzzy subsequence matching, anchored on the first letter (VS Code style)", () => {
  assert.equal(fuzzyScore("mathbb", "mbb") != null, true);
  assert.equal(fuzzyScore("mathbb", "abb"), null, "must start with the name's first letter");
  assert.equal(fuzzyScore("mathbb", "m"), null, "one letter is a prefix query, not fuzzy");
  assert.ok(fuzzyScore("leftrightarrow", "lra") > fuzzyScore("leftarrow", "lar"), "gaps cost");
  assert.equal(names("mbb")[0], "mathbb");
  assert.equal(names("mcal")[0], "mathcal");
  assert.equal(names("lra")[0], "leftrightarrow");
  assert.equal(names("Ra")[0], "Rightarrow");
  assert.equal(names("bsym")[0], "boldsymbol");
  assert.equal(names("ovl")[0], "overline");
  assert.equal(names("sbeq")[0], "subseteq");
  assert.ok(names("sbe").slice(0, 2).includes("subseteq"), "shorter names win close ties");
  assert.deepEqual(names("zzzz"), [], "nothing matches nothing");
});

test("abbreviations cover shorthands whose letters aren't in the name", () => {
  assert.equal(names("ooo")[0], "infty");
  assert.equal(names("xx")[0], "times");
  assert.equal(names("del")[0], "delta", "a prefix match still wins over the abbreviation");
  assert.ok(names("del").includes("partial"));
  assert.equal(names("RR")[0], "mathbb");
});

test("snippets: argument slots, limits, braces with labels, nth root, sizes", () => {
  const by = (n) => latexCompletions(n, 50).find((c) => c.name === n);
  assert.deepEqual(insertionFor(by("frac")), { text: "\\frac{}{}", caret: 6 });
  assert.deepEqual(insertionFor(by("sum")), { text: "\\sum_{}^{}", caret: 6 });
  assert.deepEqual(insertionFor(by("sqrt[n]")), { text: "\\sqrt[]{}", caret: 6 });
  assert.deepEqual(insertionFor(by("underbrace")), { text: "\\underbrace{}_{}", caret: 12 });
  assert.deepEqual(insertionFor(by("textcolor")), { text: "\\textcolor{}{}", caret: 11 });
  assert.deepEqual(insertionFor(by("argmax")), { text: "\\operatorname*{arg\\,max}_{}", caret: 26 });
  assert.deepEqual(insertionFor(by("big(")), { text: "\\big(  \\big)", caret: 6 });
  assert.deepEqual(insertionFor(by("middle|")), { text: "\\middle|", caret: 8 });
  assert.deepEqual(insertionFor(by("R")), { text: "\\R", caret: 2 });
  assert.deepEqual(insertionFor(by("displaystyle")), { text: "\\displaystyle", caret: 13 });
  // Environments: inline form in $…$, multi-line inside $$…$$; mandatory
  // arguments ride along.
  assert.deepEqual(insertionFor(by("cases"), false), { text: "\\begin{cases}  \\end{cases}", caret: 14 });
  assert.deepEqual(insertionFor(by("alignat"), true), { text: "\\begin{alignat}{2}\n\n\\end{alignat}", caret: 19 });
  assert.ok(envCompletions("", 50).length > 20, "an empty prefix lists every environment");
  assert.deepEqual(envCompletions("dc").map((c) => c.name), ["dcases"]);
});

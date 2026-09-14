// The search normalization mirror against the cases the backend runs too
// (tests/shared/textnorm.json at the repository root).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildSearchRegex, normalizeChars, normalizeQuery } from "../src/textnorm.js";

const shared = JSON.parse(await readFile(new URL("../../tests/shared/textnorm.json", import.meta.url), "utf8"));
const chars = (s) => [...s].map((ch) => ({ ch }));

test("normalizeQuery matches normalize_text on every query-shaped case", () => {
  for (const c of shared.normalize) {
    if (c.hyphen_break) continue; // a query box has no line breaks
    assert.equal(normalizeQuery(c.input), c.output, c.note);
  }
});

test("normalizeChars matches normalize_text on every case and maps back to the source", () => {
  for (const c of shared.normalize) {
    const { norm, src } = normalizeChars(chars(c.input));
    assert.equal(norm.join(""), c.output, c.note);
    assert.equal(src.length, norm.length, c.note);
    for (let i = 1; i < src.length; i++) assert.ok(src[i] >= src[i - 1], `${c.note}: source indices stay in order`);
  }
  // A folded ligature's letters all point at the one source character.
  const { norm, src } = normalizeChars(chars("eﬃcient"));
  assert.equal(norm.join(""), "efficient");
  assert.deepEqual(src.slice(1, 4), [1, 1, 1]);
});

test("buildSearchRegex matches fuzzy_pattern on every case", () => {
  for (const c of shared.fuzzy) {
    const re = buildSearchRegex(c.query, { caseSensitive: !!c.case, wholeWord: !!c.whole });
    if ("pattern" in c && c.pattern === null) { assert.equal(re, null, c.note); continue; }
    assert.ok(re, c.note);
    assert.equal(re.test(c.text), c.match, `${c.note}: ${re}`);
  }
});

test("a regex query is used as written", () => {
  assert.equal(buildSearchRegex("a.b", { regex: true }).test("axb"), true);
  assert.equal(buildSearchRegex("(", { regex: true }), null);
});

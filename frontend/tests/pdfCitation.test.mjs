import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { citationRuns, matchCitation, parsePdfCitation } from "../src/pdf/pdfCitation.js";

test("citation links preserve encoded quotes and reject invalid or external locations", () => {
  const quote = "A result (n=42) & its evidence";
  assert.deepEqual(parsePdfCitation(`/?page=paper&pdf_page=7&quote=${encodeURIComponent(quote)}`),
    { pageId: "paper", page: 7, quote });
  for (const href of ["https://evil.test/?page=p&pdf_page=1&quote=long%20enough", "/?page=p&pdf_page=-1&quote=long%20enough", "/?page=p&pdf_page=1&quote=tiny", "/?page=p&pdf_page=1.5&quote=long%20enough"])
    assert.equal(parsePdfCitation(href), null);
});

test("maps partial proportional-font runs, ligatures and hyphenation back to source offsets", () => {
  const runs = [{ text: "The efﬁcient sys-", hasEOL: true }, { text: "tem works well." }];
  const result = matchCitation(runs, "efficient system works");
  assert.equal(result.status, "matched");
  assert.deepEqual(result.spans, [{ run: 0, start: 4, end: 16 }, { run: 1, start: 0, end: 9 }]);
});

test("matches across arbitrary PDF text run boundaries and spacing differences", () => {
  assert.equal(matchCitation([{ text: "Quantum en" }, { text: "tanglement in arrays" }], "Quantum entanglement in arrays").status, "matched");
  assert.equal(matchCitation([{ text: "Measured 3,000 atoms with ‘high fidelity’." }], "Measured 3000 atoms with 'high fidelity'.").status, "matched");
});

test("does not guess missing text or repeated passages", () => {
  assert.equal(matchCitation([{ text: "Repeated sentence. Repeated sentence." }], "Repeated sentence.").status, "ambiguous");
  assert.equal(matchCitation([{ text: "We measured 53 atoms." }], "We measured 70 atoms.").status, "missing");
});

// Actual PDF.js runs from the three failing saved citations in Krantz et al.,
// A quantum engineer's guide to superconducting qubits, physical pages 20–22.
const paper = JSON.parse(fs.readFileSync(new URL("./fixtures/pdfCitationPaper.json", import.meta.url)));
for (const fixture of paper) {
  test(`real paper p.${fixture.page}: wrapped compounds and omitted superscript references`, () => {
    const runs = citationRuns(fixture.items);
    const found = matchCitation(runs, fixture.quote);
    assert.equal(found.status, "matched");
    assert(found.spans.length > 1, "passage spans multiple lines/runs");
    for (const span of found.spans) {
      assert(span.start >= 0 && span.end <= runs[span.run].text.length);
      assert(!runs[span.run].referenceNumber, "omitted reference numbers are not painted");
    }
  });
}

test("literal quoted reference numbers still match; ambiguous typography matches are rejected", () => {
  const fixture = paper[1];
  assert.equal(matchCitation(citationRuns(fixture.items), fixture.quote.replace("sequence.", "sequence158,159.")).status, "matched");
  assert.equal(matchCitation(citationRuns([...fixture.items, ...fixture.items]), fixture.quote).status, "ambiguous");
});

const transduction = JSON.parse(fs.readFileSync(new URL("./fixtures/pdfCitationTransduction.json", import.meta.url)))[0];
test("real transduction paper p.4: omitted wrapped Methods pointer preserves glyph offsets", () => {
  const runs = citationRuns(transduction.items);
  for (const quote of [transduction.quote, transduction.quote.slice(0, -1), transduction.quote.replace("state.", "state (Methods).")]) {
    assert.equal(matchCitation(runs, quote).status, "matched");
  }
  const found = matchCitation(runs, transduction.quote);
  const selected = found.spans.map(s => runs[s.run].text.slice(s.start, s.end));
  assert.equal(selected[0], transduction.items[0].str);
  assert.deepEqual(selected.slice(-2), ["state", "."]);
  assert(!selected.join("").includes("Meth"));
  assert.equal(matchCitation([...runs, ...runs], transduction.quote).status, "ambiguous");
  assert.equal(matchCitation(runs, transduction.quote.replace("35P", "36P")).status, "missing");
});

test("editorial fallback splits a text run without painting the omitted pointer", () => {
  for (const pointer of ["Methods", "Online Methods", "Supplementary Information", "Supplementary Methods", "Supplementary Material"]) {
    const text = `We measured 53 atoms (${pointer}).`;
    const result = matchCitation([{ text }], "We measured 53 atoms.");
    assert.equal(result.status, "matched");
    assert.deepEqual(result.spans.map(s => text.slice(s.start, s.end)), ["We measured 53 atoms", "."]);
    assert.equal(matchCitation([{ text }], text).status, "matched");
  }
});

test("editorial fallback keeps scientific qualifiers, numbered references and nested parentheses", () => {
  for (const pointer of ["at 4 K", "n=53", "x-y", "Fig. 2", "Methods 2", "Methods, n=53", "Methods (n=53)"]) {
    assert.equal(matchCitation([{ text: `We measured 53 atoms (${pointer}).` }], "We measured 53 atoms.").status, "missing", pointer);
  }
  const text = "We measured 53 atoms. We measured 53 atoms (Methods).";
  assert.deepEqual(matchCitation([{ text }], "We measured 53 atoms.").spans, [{ run: 0, start: 0, end: 21 }]);
  assert.equal(matchCitation([{ text: "We measured 53 atoms (Methods). We measured 53 atoms (Online Methods)." }], "We measured 53 atoms.").status, "ambiguous");
});

test("format tolerance cannot erase numbers, signs, powers or mathematical subtraction", () => {
  const item = (str, x, y = 100, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * 5 });
  for (const [items, quote] of [
    [[item("Measured 53 atoms." , 0)], "Measured 70 atoms."],
    [[item("Measured -53 atoms.", 0)], "Measured 53 atoms."],
    [[item("The result x", 0), item("2", 60, 104, 7), item(" is positive.", 64)], "The result x is positive."],
    [[item("The result x-y is positive.", 0)], "The result xy is positive."],
    [[{ ...item("The result x-", 0), hasEOL: true }, item("y is positive.", 0, 90)], "The result xy is positive."],
    [[{ ...item("Measured 53-", 0), hasEOL: true }, item("70 atoms.", 0, 90)], "Measured 5370 atoms."],
    [[item("A baseline sequence", 0), item("158,159", 95), item(".", 130)], "A baseline sequence."],
    [[item("A value in GHz", 0), item("10", 70, 104, 7), item(".", 80)], "A value in GHz."],
  ]) assert.equal(matchCitation(citationRuns(items), quote).status, "missing", quote);
});

test("superscript recognition is invariant under rotation and does not hide single-digit powers", () => {
  const fixture = paper[1];
  const rotated = fixture.items.map(it => {
    const [a,b,c,d,x,y] = it.transform;
    return { ...it, transform: [-b,a,-d,c,-y,x] };
  });
  assert.equal(matchCitation(citationRuns(rotated), fixture.quote).status, "matched");
});

test("fuzzy citations tolerate typos, changed words and omitted prose with source offsets", () => {
  const text = "We carefully measured the collective response of the atomic ensemble under stable conditions.";
  for (const quote of [
    text.replace("collective", "colective"),
    text.replace("carefully ", ""),
    text.replace("carefully", "precisely"),
    text.replace("response", "response (averaged)"),
    text.replace("response", "response;").replace("conditions.", "conditions!"),
  ]) {
    const runs = [{ text: "Unrelated preface. " + text.slice(0, 40) }, { text: text.slice(40) + " Unrelated ending." }];
    const result = matchCitation(runs, quote);
    assert.equal(result.status, "matched", quote);
    assert.equal(result.approximate, true, quote);
    assert.deepEqual(result.spans, [{ run: 0, start: 19, end: 59 }, { run: 1, start: 0, end: text.length - 41 }]);
    assert.equal(result.spans.map(s => runs[s.run].text.slice(s.start, s.end)).join(""), text.slice(0, -1));
  }
});

test("real PDF typo plus omitted reference uses the general fuzzy fallback", () => {
  const result = matchCitation(citationRuns(transduction.items), transduction.quote.replace("systematically", "systematicaly"));
  assert.equal(result.status, "matched");
  assert.equal(result.approximate, true);
  assert.equal(result.spans[0].start, 0);
  // The match ends at the source word, not an invented period in the quote.
  assert.equal(transduction.items[result.spans.at(-1).run].str.slice(result.spans.at(-1).start, result.spans.at(-1).end), "state");
});

test("general fuzzy matching handles arbitrary omitted parentheticals inside a long passage", () => {
  const text = "We carefully measured the response (Appendix) of the atomic ensemble under stable experimental conditions.";
  const result = matchCitation([{ text }], text.replace(" (Appendix)", ""));
  assert.equal(result.status, "matched");
  assert.equal(result.approximate, true);
  assert.deepEqual(result.spans, [{ run: 0, start: 0, end: text.length - 1 }]);
});

test("fuzzy matching cannot change quantities, mathematical notation or negations in long quotes", () => {
  const sentence = value => `We carefully measured ${value} in the atomic ensemble under stable experimental conditions.`;
  for (const [actual, quoted] of [
    ["53 atoms", "54 atoms"], ["-53 atoms", "53 atoms"], ["3.5 atoms", "35 atoms"],
    ["53-70 atoms", "5370 atoms"], ["x-y", "xy"], ["x2", "x"], ["x=2", "x>2"],
    ["35P1/2", "35P3/2"], ["Δ", "Ω"], ["α", "β"], ["53%", "53"],
    ["(x+y)*z", "x+y*z"], ["[x+y]*z", "x+[y*z]"], ["x!", "x"], ["x'", "x"],
    ["no response", "response"], ["response", "no response"], ["response without noise", "response with noise"],
  ]) {
    assert.deepEqual(matchCitation([{ text: sentence(actual) }], sentence(quoted)), { status: "missing", spans: [] }, `${actual} vs ${quoted}`);
  }
});

test("fuzzy matching requires a distinctive long quote and rejects competing passages", () => {
  assert.equal(matchCitation([{ text: "A collective response." }], "A colective response.").status, "missing");
  const text = "We carefully measured the collective response of the atomic ensemble under stable conditions.";
  const quote = text.replace("collective", "colective");
  assert.deepEqual(matchCitation([{ text: `${text} ${text.replace("conditions", "condtions")}` }], quote), { status: "ambiguous", spans: [] });
  assert.equal(matchCitation([{ text }], "Researchers describe a completely different experiment using photons and superconducting circuits.").status, "missing");
  // Exact matching still wins over a similar passage elsewhere on the page.
  const exact = matchCitation([{ text: `${text} ${quote}` }], quote);
  assert.equal(exact.status, "matched");
  assert.equal(exact.approximate, undefined);
  assert.equal(exact.spans[0].start, text.length + 1);
});

test("dense pages have bounded fuzzy work while exact matches remain available", () => {
  const text = "The collective response is observed under stable experimental conditions. ".repeat(2000);
  assert.equal(matchCitation([{ text }], "The colective response is observed under stable experimental conditions. ".repeat(8)).status, "missing");
  assert.equal(matchCitation([{ text: text + "A distinct final sentence." }], "A distinct final sentence.").status, "matched");
});

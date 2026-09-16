import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { citationRuns, matchCitation, parsePdfCitation } from "../src/pdfCitation.js";

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

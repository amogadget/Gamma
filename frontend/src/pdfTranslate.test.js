import assert from "node:assert/strict";
import test from "node:test";

import { isTranslatable, segmentPage } from "./pdfTranslate.js";

// A run as pdfViewer.jsx builds it: baseline-left origin, scale-1 viewport
// units. `y` grows downward, `h` is the font height.
function run(str, x, y, { w = null, h = 10, font = "g_d0_f1" } = {}) {
  return { str, x, y, w: w === null ? str.length * h * 0.5 : w, h, font };
}

// One left-aligned column of body lines starting at y0, one line per string.
function column(texts, { x = 50, y0 = 100, h = 10, pitch = 12, font = "g_d0_f1" } = {}) {
  return texts.map((t, i) => run(t, x, y0 + i * pitch, { h, font }));
}

test("isTranslatable keeps prose and rejects math, numbers and stray symbols", () => {
  assert.equal(isTranslatable("The quick brown fox jumps."), true);
  assert.equal(isTranslatable("Introduction"), true);
  // Too short / not prose.
  assert.equal(isTranslatable(""), false);
  assert.equal(isTranslatable("7"), false);
  assert.equal(isTranslatable("12"), false);
  assert.equal(isTranslatable("(3)"), false);
  assert.equal(isTranslatable("(a)"), false);
  assert.equal(isTranslatable("Fig. 2"), false);
  // Symbol-dominated: an equation must never be "translated". These are the
  // GLYPHS pdf.js extracts from rendered math, not LaTeX source.
  assert.equal(isTranslatable("H = −J ∑ σ_i σ_j"), false);
  assert.equal(isTranslatable("x² + y² = z²"), false);
  assert.equal(isTranslatable("ε = 1.602 × 10⁻¹⁹"), false);
  // A couple of CJK characters is enough to count as translatable text.
  assert.equal(isTranslatable("量子計算"), true);
});

test("isTranslatable accepts non-Latin-script prose", () => {
  // The final prose gate spans Latin AND Cyrillic, so a Russian paragraph is
  // translatable. (It used to be ASCII-only, which silently left every
  // Cyrillic paragraph in the original.)
  assert.equal(isTranslatable("Квантовые вычисления сегодня"), true);
  assert.equal(isTranslatable("Мы рассматриваем решёточную модель"), true);
  // Still not prose: a scatter of single-letter variables has no real word.
  assert.equal(isTranslatable("x y z p q r"), false);
  // Accented Latin keeps working.
  assert.equal(isTranslatable("Nous considérons un modèle réticulaire"), true);
});

test("segmentPage merges wrapped lines of one paragraph into one block", () => {
  const blocks = segmentPage(column([
    "We consider a lattice model of interacting",
    "spins and show that the ground state is",
    "unique for all values of the coupling.",
  ]));
  assert.equal(blocks.length, 1);
  const b = blocks[0];
  assert.equal(b.nLines, 3);
  assert.match(b.text, /^We consider a lattice model of interacting spins/);
  assert.equal(b.translate, true);
  // One mask rect per original visual line.
  assert.equal(b.lines.length, 3);
  // The bbox encloses every line.
  assert.ok(b.x1 <= 50 && b.y1 < b.y2);
});

test("segmentPage rejoins a hyphenated line break without a space", () => {
  // Both lines are near-full column width, as a justified paragraph's are —
  // a big right-edge jump is a separate concern (see the figure-wrap split).
  const blocks = segmentPage([
    run("We study the thermo-", 50, 100, { w: 130 }),
    run("dynamic limit of chain", 50, 112, { w: 128 }),
  ]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /thermodynamic limit/);
});

test("segmentPage joins CJK lines with no interposed space", () => {
  const blocks = segmentPage(column(["量子計算の基礎", "理論を概説する"]));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "量子計算の基礎理論を概説する");
});

test("segmentPage starts a new block at a first-line indent", () => {
  // Second paragraph's opener is indented well past the column edge.
  const runs = [
    ...column(["First paragraph line one here", "and its wrapped second line"]),
    run("Indented opener of the next one", 62, 124),
    run("wrapping back at the margin now", 50, 136),
  ];
  const texts = segmentPage(runs).map((b) => b.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /^First paragraph line one here/);
  assert.match(texts[1], /^Indented opener of the next one/);
});

test("segmentPage keeps a two-column gutter apart", () => {
  // A repeating whitespace river at the same x-interval on every line is a
  // real gutter; both sides must stay separate blocks.
  const runs = [];
  const left = ["left column line one", "left column line two", "left column line three"];
  const right = ["right column line one", "right column line two", "right column line three"];
  left.forEach((t, i) => runs.push(run(t, 50, 100 + i * 12, { w: 100 })));
  right.forEach((t, i) => runs.push(run(t, 190, 100 + i * 12, { w: 100 })));
  const blocks = segmentPage(runs);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.nLines === 3));
  // No block spans the gutter.
  assert.ok(blocks.every((b) => b.x2 <= 160 || b.x1 >= 190));
});

test("segmentPage splits a heading from the body below it", () => {
  const runs = [
    run("II. THE MODEL", 50, 100, { h: 14 }),
    ...column(["We now introduce the Hamiltonian of", "the system under consideration."], { y0: 120 }),
  ];
  const blocks = segmentPage(runs);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "II. THE MODEL");
  assert.match(blocks[1].text, /^We now introduce the Hamiltonian/);
});

test("segmentPage marks an equation block untranslatable but still returns it", () => {
  const runs = [
    ...column(["The Hamiltonian we study reads as"], { y0: 100 }),
    run("H = −J ∑ σ_i σ_j", 90, 130, { h: 11 }),
  ];
  const blocks = segmentPage(runs);
  const eq = blocks.find((b) => b.text.includes("∑"));
  assert.ok(eq, "equation block present");
  assert.equal(eq.translate, false);
});

test("segmentPage drops empty runs and degenerate boxes", () => {
  assert.deepEqual(segmentPage([]), []);
  assert.deepEqual(segmentPage([run("   ", 50, 100), { str: "x", x: 1, y: 1, w: 0, h: 0 }]), []);
});

test("segmentPage keeps every block's per-line rects inside its bbox", () => {
  const blocks = segmentPage(column([
    "A paragraph whose mask rects must stay",
    "strictly inside the reported bounding box",
    "so the overlay never paints over a figure.",
  ]));
  for (const b of blocks) {
    for (const l of b.lines) {
      assert.ok(l.x1 >= b.x1 - 1e-9 && l.x2 <= b.x2 + 1e-9, "line within x bounds");
      assert.ok(l.y1 >= b.y1 - 1e-9 && l.y2 <= b.y2 + 1e-9, "line within y bounds");
    }
  }
});

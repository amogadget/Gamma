import test from "node:test";
import assert from "node:assert/strict";
import { resolveExport, resolveImport } from "../src/transfers/transferFormats.js";

const allOff = Object.freeze({ highlights: false, notes: false, bundle: false });
const paper = { hasPdf: true, pdfStored: true };

test("fixed export contents override saved switches without changing the saved preferences", () => {
  const gamma = resolveExport({ ...allOff, format: "gamma" }, paper);
  assert.equal(gamma.needsReview, false);
  assert.deepEqual(gamma.payload, { format: "gamma", highlights: true, notes: true, bundle: true });
  const graph = resolveExport({ ...allOff, format: "logseq" }, paper);
  assert.equal(graph.needsReview, true);
  assert.deepEqual(graph.controls.map(({ key }) => key), ["bundle"]);
  assert.deepEqual(graph.payload, { format: "logseq", highlights: true, notes: true, bundle: false });
  assert.deepEqual(resolveExport({ ...allOff, format: "markdown" }, paper).payload, { format: "markdown", ...allOff });
});

test("remote PDFs export directly; note pages and folders fall back to a configurable notes PDF", () => {
  const opts = { format: "pdf", highlights: true, notes: true, bundle: true };
  const remote = resolveExport(opts, { hasPdf: true, pdfStored: false });
  assert.equal(remote.needsReview, false);
  assert.deepEqual(remote.payload, { format: "pdf", ...allOff });
  for (const context of [{ hasPdf: false }, { ...paper, folder: "Reading" }]) {
    const notes = resolveExport(opts, context);
    assert.equal(notes.needsReview, true);
    assert.deepEqual(notes.payload, { format: "notespdf", highlights: true, notes: true, bundle: false });
    assert(!notes.formats.some(({ id }) => id === "pdf"));
  }
});

test("Zotero's effective highlights follow file bundling while preserving the user's preference", () => {
  const opts = Object.freeze({ format: "zotero", highlights: true, notes: true, bundle: false });
  const metadata = resolveExport(opts, paper);
  assert.equal(metadata.payload.highlights, false);
  assert.equal(metadata.controls.find(({ key }) => key === "highlights").disabled, true);
  assert.equal(metadata.needsReview, true);
  assert.equal(resolveExport({ ...opts, bundle: true }, paper).payload.highlights, true);
  assert.equal(opts.highlights, true);
});

test("imports show options only for embedded annotations and omit inapplicable strip flags", () => {
  for (const source of ["gamma", "markdown", "logseq"]) {
    const result = resolveImport(source, { hasPdf: true, strip: true });
    assert.equal(result.needsReview, false);
    assert.deepEqual(result.payload, { source });
  }
  for (const source of ["annots", "zotero"]) {
    const result = resolveImport(source, { hasPdf: true, strip: true });
    assert.equal(result.needsReview, true);
    assert.deepEqual(result.payload, { source, strip: true });
  }
  assert.equal(resolveImport("annots", { hasPdf: false }).definition.id, "zotero");
});

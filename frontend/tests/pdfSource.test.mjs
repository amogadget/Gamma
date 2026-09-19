import { test } from "node:test";
import assert from "node:assert/strict";
import { WHOLE_MAX_BYTES, chooseTransport, docIdOf, layoutFromManifest, rangeOpenOptions } from "../src/pdf/pdfSource.js";

test("docIdOf reads upload urls only, query or not", () => {
  assert.equal(docIdOf("/api/uploads/0123abcdef0123abcdef0123.pdf"), "0123abcdef0123abcdef0123");
  assert.equal(docIdOf("/api/uploads/0123abcdef0123abcdef0123.pdf?share=tok&annots=1"), "0123abcdef0123abcdef0123");
  assert.equal(docIdOf("/api/uploads/0123abcdef0123abcdef0123.png"), null);
  assert.equal(docIdOf("/api/pdf?source_url=https%3A%2F%2Farxiv.org%2Fpdf%2F1.pdf"), null);
  assert.equal(docIdOf("https://example.org/api/uploads/abc.pdf"), null);
  assert.equal(docIdOf(""), null);
  assert.equal(docIdOf(undefined), null);
});

test("cached bytes are used from memory whatever the url", () => {
  assert.equal(chooseTransport({ url: "/api/uploads/ab.pdf", bytes: 1e9, cached: true }), "memory");
  assert.equal(chooseTransport({ url: "/api/pdf?source_url=x", cached: true }), "memory");
});

test("the proxy always downloads whole: it cannot answer ranges", () => {
  assert.equal(chooseTransport({ url: "/api/pdf?source_url=x", bytes: 1e9 }), "whole");
});

test("uploads switch to ranges above the size threshold, and only with a known size", () => {
  const url = "/api/uploads/ab.pdf";
  assert.equal(chooseTransport({ url, bytes: WHOLE_MAX_BYTES }), "whole");
  assert.equal(chooseTransport({ url, bytes: WHOLE_MAX_BYTES + 1 }), "range");
  assert.equal(chooseTransport({ url, bytes: undefined }), "whole", "no manifest: the old path");
  assert.equal(chooseTransport({ url, bytes: 0 }), "whole");
});

test("range open disables streaming and autofetch, keeps ranges", () => {
  const o = rangeOpenOptions("/api/uploads/ab.pdf?share=t");
  assert.equal(o.url, "/api/uploads/ab.pdf?share=t");
  assert.equal(o.disableStream, true);
  assert.equal(o.disableAutoFetch, true);
  assert.equal(o.disableRange, false);
  assert.ok(o.rangeChunkSize > 0);
  assert.equal(o.withCredentials, true);
});

test("layoutFromManifest turns dims into heights/widths, with fallbacks", () => {
  const lay = layoutFromManifest({ pages: 3, dims: [[612, 792], [792, 612], [0, null]] }, { width: 600, height: 800 });
  assert.deepEqual(lay.widths, [612, 792, 600]);
  assert.deepEqual(lay.heights, [792, 612, 800]);
});

test("layoutFromManifest rejects what does not describe a readable document", () => {
  assert.equal(layoutFromManifest(null), null);
  assert.equal(layoutFromManifest({ pages: 0, dims: [] }), null, "an unreadable file");
  assert.equal(layoutFromManifest({ pages: 2, dims: [[1, 1]] }), null, "count and dims disagree");
  assert.equal(layoutFromManifest({ pages: "2", dims: [[1, 1], [1, 1]] }), null);
});

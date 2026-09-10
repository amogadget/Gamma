import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { nativePDFRequest } from "./nativeBridge.js";

test("native handoff carries server page and account identity", () => {
  assert.deepEqual(nativePDFRequest({pageID: "page", docID: "doc", title: "Paper\nTitle", user: "alice"}),
    {type: "openPDF", pageID: "page", docID: "doc", title: "Paper Title", user: "alice"});
});
test("native handoff rejects missing identity and bounds Unicode titles", () => {
  assert.equal(nativePDFRequest({pageID: "page", docID: "doc", user: ""}), null);
  assert.equal(nativePDFRequest({pageID: "bad\npage", docID: "doc", user: "alice"}), null);
  const result = nativePDFRequest({pageID: "page", docID: "doc", user: "alice", title: "😀".repeat(500)});
  assert.ok(Buffer.byteLength(result.title) <= 512);
});

import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { nativePDFRequest } from "../src/native/nativeBridge.js";

test("native handoff carries server page, document, workspace and account identity", () => {
  assert.deepEqual(
    nativePDFRequest({ pageID: "page", docID: "doc", workspace: "personal-7Qk2", title: "Paper\nTitle", user: "alice" }),
    { type: "openPDF", pageID: "page", docID: "doc", workspace: "personal-7Qk2", user: "alice", title: "Paper Title" },
  );
});

test("a handoff without a workspace is refused: native routes are workspace-scoped", () => {
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", user: "alice" }), null);
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "", user: "alice" }), null);
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: 42, user: "alice" }), null);
  // A newline in any identity field would let a caller forge a second field.
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "ws\nuser=root", user: "alice" }), null);
});

test("native handoff rejects missing identity and bounds Unicode titles", () => {
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "ws", user: "" }), null);
  assert.equal(nativePDFRequest({ pageID: "bad\npage", docID: "doc", workspace: "ws", user: "alice" }), null);
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "ws", user: "alice", title: null })?.title, "PDF");
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "ws", user: "alice", title: "   " })?.title, "PDF");
  const result = nativePDFRequest({ pageID: "page", docID: "doc", workspace: "ws", user: "alice", title: "😀".repeat(500) });
  assert.ok(Buffer.byteLength(result.title) <= 512);
  // Counted in Unicode code points, so no surrogate pair is split in half.
  assert.equal(Array.from(result.title).length, 120);
  assert.equal(Array.from(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "ws", user: "alice", title: "a\t b\nc" }).title).join(""), "a b c");
  // Over-long identities are refused rather than truncated into a different id.
  assert.equal(nativePDFRequest({ pageID: "p".repeat(201), docID: "doc", workspace: "ws", user: "alice" }), null);
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "w".repeat(201), user: "alice" }), null);
});

test("an identity is bounded in characters AND UTF-8 bytes", () => {
  // 200 characters, but 600 bytes: over the native side's byte ceiling even
  // though it passes the character one.
  const wide = "€".repeat(200);
  assert.equal(wide.length, 200);
  assert.equal(Buffer.byteLength(wide), 600);
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: wide, user: "alice" }), null);
  assert.equal(nativePDFRequest({ pageID: "page", docID: "doc", workspace: "€".repeat(120), user: "alice" })?.workspace, "€".repeat(120));
  // 200 ASCII characters are 200 bytes: still accepted.
  assert.equal(nativePDFRequest({ pageID: "p".repeat(200), docID: "doc", workspace: "ws", user: "alice" })?.pageID.length, 200);
});

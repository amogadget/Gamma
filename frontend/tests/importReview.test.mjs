import test from "node:test";
import assert from "node:assert/strict";
import { allItemIds, filterImportPages, selectItems, buildImportTree, treeItemIds, resultPages } from "../src/transfers/importReview.js";
import { uploadJson } from "../src/transfers/xhrUpload.js";

test("filters preserve hidden selections; folder selection deduplicates items in multiple locations", () => {
  const pages = [
    { title: "Ready", folders: ["A", "B"], selection_ids: ["a", "alias"], missing: false },
    { title: "Missing", folders: ["B"], selection_ids: ["b"], missing: true, warnings: [{ reason: "Missing PDF" }] },
  ];
  const selected = new Set(allItemIds(pages));
  assert.equal(filterImportPages(pages, "missing", selected).length, 1);
  assert.deepEqual([...selected], ["a", "alias", "b"]);
  const next = selectItems(selected, ["b"], false);
  assert.deepEqual(filterImportPages(pages, "selected", next).map(p => p.title), ["Ready"]);
  const tree = buildImportTree(pages, true);
  assert.deepEqual(treeItemIds(tree), ["a", "alias", "b"]);
  assert.equal(resultPages({ pages: [{ id: "same", title: "First", created: true }, { id: "same", title: "First", created: false }] }).length, 1);
});

test("upload reports measured bytes, switches to processing, and sends workspace identity", async () => {
  const original = globalThis.XMLHttpRequest;
  let xhr;
  globalThis.XMLHttpRequest = class {
    constructor() { xhr = this; this.upload = {}; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send() {}
    getResponseHeader() { return null; }
    abort() { this.onabort(); }
  };
  try {
    const events = [];
    const response = uploadJson("/api/import/review", {}, { headers: { "X-Gamma-Workspace": "ws", "X-Gamma-User": "alice" }, onProgress: e => events.push(e) });
    xhr.upload.onprogress({ loaded: 5242880, total: 10485760, lengthComputable: true });
    xhr.upload.onload();
    assert.deepEqual(events[1], { phase: "upload", loaded: 5242880, total: 10485760 });
    assert.equal(events[2].phase, "processing");
    assert.equal(xhr.headers["X-Gamma-Workspace"], "ws");
    assert.equal(xhr.headers["X-Gamma-User"], "alice");
    xhr.status = 200; xhr.responseText = '{"ok":true}'; xhr.onload();
    assert.deepEqual(await response, { ok: true });
    const ctl = new AbortController();
    const cancelled = uploadJson("/api/import/review", {}, { signal: ctl.signal });
    ctl.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
  } finally { globalThis.XMLHttpRequest = original; }
});

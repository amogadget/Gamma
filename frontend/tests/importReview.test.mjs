import test from "node:test";
import assert from "node:assert/strict";
import { allItemIds, filterImportPages, selectItems, buildImportTree, treeItemIds, resultPages } from "../src/transfers/importReview.js";

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

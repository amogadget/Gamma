import assert from "node:assert/strict";
import test from "node:test";

import { CALLOUT_TYPES, calloutType, remarkCallouts } from "./callouts.js";

test("callout aliases map to the bounded canonical class set", () => {
  assert.deepEqual(CALLOUT_TYPES, ["note", "tip", "warning", "danger", "important", "quote"]);
  assert.equal(calloutType("INFO"), "note");
  assert.equal(calloutType("failure"), "danger");
  assert.equal(calloutType("unknown-user-value"), "note");
});

test("remarkCallouts strips the marker and adds text-only title metadata", () => {
  const tree = {
    type: "root",
    children: [{
      type: "blockquote",
      children: [{
        type: "paragraph",
        children: [{ type: "text", value: "[!warning] Careful\nBody text" }],
      }],
    }],
  };

  remarkCallouts()(tree);
  const quote = tree.children[0];
  assert.deepEqual(quote.data.hProperties.className, ["callout", "callout-warning"]);
  assert.equal(quote.children[0].data.hProperties.className[0], "calloutTitle");
  assert.deepEqual(quote.children[0].children, [{ type: "text", value: "Careful" }]);
  assert.equal(quote.children[1].children[0].value, "Body text");
});

test("ordinary blockquotes remain untouched", () => {
  const quote = {
    type: "blockquote",
    children: [{ type: "paragraph", children: [{ type: "text", value: "plain quote" }] }],
  };
  const tree = { type: "root", children: [quote] };
  remarkCallouts()(tree);
  assert.equal(quote.data, undefined);
  assert.equal(quote.children.length, 1);
});

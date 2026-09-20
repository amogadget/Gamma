// The callout remark plugin (editor/callouts.js): "> [!type] Title" boxes,
// type aliases, and Obsidian's fold flag making a native <details>.
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { CALLOUT_MARKER_RE, calloutType, remarkCallouts } from "../src/editor/callouts.js";

const render = (text) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkCallouts], children: text,
}));

test("a plain callout is a classed blockquote with a title line", () => {
  const html = render("> [!tip] Remember\n> body text");
  assert.match(html, /<blockquote class="callout callout-tip">/);
  assert.match(html, /<p class="calloutTitle">Remember<\/p>/);
  assert.match(html, /body text/);
  // Aliases canonicalize; a missing title is the type name.
  assert.match(render("> [!info]\n> x"), /callout-note[\s\S]*calloutTitle">Note</);
  assert.equal(calloutType("bug"), "danger");
  assert.doesNotMatch(render("> just a quote"), /callout/);
});

test("the fold flag makes a <details>: '-' collapsed, '+' open", () => {
  const closed = render("> [!note]- Proof\n> hidden until opened");
  assert.match(closed, /<details class="callout callout-note calloutFold">/);
  assert.match(closed, /<summary class="calloutTitle">Proof<\/summary>/);
  assert.doesNotMatch(closed, /<details[^>]*open/);
  assert.match(closed, /hidden until opened/);
  const open = render("> [!warning]+ Shown\n> body");
  assert.match(open, /<details class="callout callout-warning calloutFold" open="">/);
  // The editor hides the same marker (fold flag included).
  assert.deepEqual("[!note]- Proof".match(CALLOUT_MARKER_RE).slice(1), ["note", "-"]);
  assert.deepEqual("[!tip] x".match(CALLOUT_MARKER_RE).slice(1), ["tip", ""]);
});

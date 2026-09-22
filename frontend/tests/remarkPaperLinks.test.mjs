import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkPaperLinks } from "../src/shared/lib/remarkPaperLinks.js";

const render = (text) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkGfm, remarkMath, remarkPaperLinks], children: text,
}));

test("bare DOI in a saved bold citation becomes a link", () => {
  assert.equal(render("DOI: **10.1103/PhysRevA.69.062320**"),
    '<p>DOI: <strong><a href="https://doi.org/10.1103/PhysRevA.69.062320">10.1103/PhysRevA.69.062320</a></strong></p>');
});

test("sentence punctuation stays outside links; balanced DOI parentheses stay inside", () => {
  const html = render("(10.1000/abc). 10.1000/a(b); 10.1000/xyz。下一篇");
  assert.match(html, /href="https:\/\/doi.org\/10.1000\/abc">10.1000\/abc<\/a>\)\./);
  assert.match(html, /href="https:\/\/doi.org\/10.1000\/a\(b\)">10.1000\/a\(b\)<\/a>;/);
  assert.match(html, /10.1000\/xyz<\/a>。下一篇/);
});

test("modern and legacy arXiv references link to their abstract pages", () => {
  const html = render("arXiv: 2301.12345v2 and arXiv:cond-mat/0402216.");
  assert.match(html, /href="https:\/\/arxiv.org\/abs\/2301.12345v2"/);
  assert.match(html, /href="https:\/\/arxiv.org\/abs\/cond-mat\/0402216"/);
});

test("existing links, reference links, code and math are not relinked", () => {
  const html = render('[10.1000/abc](https://example.org) [arXiv:2301.12345][paper]\n\n[paper]: https://example.org/paper\n\n`10.1000/code`\n\n```\n10.1000/block\n```\n\n$10.1000/math$');
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.doesNotMatch(html, /href="https:\/\/(doi.org|arxiv.org)/);
});

test("GFM URL links remain intact and ordinary numbers are not paper links", () => {
  const html = render("https://doi.org/10.1000/abc 10.12/34 2301.12345 prefix10.1000/abc");
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.match(html, /href="https:\/\/doi.org\/10.1000\/abc"/);
});

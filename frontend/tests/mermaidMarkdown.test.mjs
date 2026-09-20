import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { mermaidFence, mermaidMath, mermaidWidth, normalizeChatMarkdown, remarkMermaid, scanMermaidFences, setMermaidWidth } from "../src/shared/lib/mermaidMarkdown.js";

const render = (text) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: [remarkMermaid], children: text,
}));

test("Mermaid waits for a matching closing fence, including lists and quotes", () => {
  for (const prefix of ["", "> ", "  "]) {
    for (const fence of ["```", "~~~~"]) {
      const open = `${prefix}${fence}mermaid\n${prefix}flowchart LR\n${prefix}A-->B`;
      assert.match(render(open), /data-mermaid-pending="true"/);
      assert.match(render(`${open}\n${prefix}${fence}`), /data-mermaid-pending="false"/);
    }
  }
  assert.match(render("- ```mermaid\n  flowchart LR\n  A-->B\n  ```"), /data-mermaid-pending="false"/);
  assert.match(render("````mermaid\nflowchart LR\nA-->B\n```"), /data-mermaid-pending="true"/);
  assert.doesNotMatch(render("```js\nlet a = 1;\n```"), /data-mermaid/);
});

test("math normalization leaves all diagram and code source intact", () => {
  const source = 'flowchart LR\nA["\\(x\\) $a|b$ $$c$$ [[node]]"] --> B';
  for (const fence of ["```", "~~~", "````"]) {
    for (const prefix of ["", "> ", "  "]) {
      const md = `${fence}mermaid\n${source}\n${fence}`.split("\n").map((s) => prefix + s).join("\n");
      assert.equal(normalizeChatMarkdown(`\\(before\\)\n\n${md}\n\n$after|pipe$`), `$before$\n\n${md}\n\n$after\\vert pipe$`);
      assert.equal(normalizeChatMarkdown(md.slice(0, md.lastIndexOf("\n"))), md.slice(0, md.lastIndexOf("\n")));
    }
  }
});

test("copy fences round-trip source containing backticks", () => {
  const source = 'flowchart LR\nA["```literal```"] --> B';
  const md = mermaidFence(source);
  assert(md.startsWith("````mermaid\n"));
  assert.match(render(md), /data-mermaid-pending="false"/);
  assert(render(md).includes("```literal```"));
});

test("a diagram's width lives in the fence info string and rides into the HTML", () => {
  assert.equal(mermaidWidth("width=420"), 420);
  assert.equal(mermaidWidth("theme=x width=420 other"), 420);
  assert.equal(mermaidWidth("widths=1 xwidth=2"), null);
  assert.equal(mermaidWidth(""), null);
  const html = render("```mermaid width=300\nflowchart LR\nA-->B\n```");
  assert.match(html, /data-mermaid-width="300"/);
  assert.doesNotMatch(render("```mermaid\nflowchart LR\nA-->B\n```"), /data-mermaid-width/);
});

test("setMermaidWidth rewrites only the nth diagram's opening line", () => {
  const note = [
    "intro",
    "```js\nconst a = 1;\n```",
    "```mermaid\nflowchart LR\nA-->B\n```",
    "> ```mermaid width=200 theme=dark\n> flowchart LR\n> C-->D\n> ```",
    "~~~~Mermaid\nsequenceDiagram\n~~~~",
  ].join("\n\n");
  const fences = scanMermaidFences(note);
  assert.deepEqual(fences.map((f) => [f.lang, f.width, f.prefix]), [["mermaid", null, ""], ["mermaid", 200, "> "], ["Mermaid", null, ""]]);
  const sized = setMermaidWidth(note, 0, 480);
  assert.match(sized, /\n```mermaid width=480\nflowchart LR\nA-->B\n```/);
  assert.equal(sized.replace("```mermaid width=480", "```mermaid"), note, "nothing else changes");
  // A quoted fence keeps its prefix and the rest of its meta; 0 clears.
  assert.match(setMermaidWidth(note, 1, 333), /> ```mermaid theme=dark width=333\n/);
  assert.match(setMermaidWidth(note, 1, 0), /> ```mermaid theme=dark\n> flowchart/);
  assert.match(setMermaidWidth(note, 2, 50), /~~~~Mermaid width=50\nsequenceDiagram/);
  assert.equal(setMermaidWidth(note, 3, 100), null, "a stale index edits nothing");
  // A fence inside another fence's code is not a diagram.
  assert.equal(scanMermaidFences("````md\n```mermaid\nx\n```\n````").length, 0);
});

test("note-style $…$ labels become the $$…$$ Mermaid typesets", () => {
  assert.equal(mermaidMath(String.raw`flowchart LR
  S(($S_z$)) -.-|$\chi$| A(($a_1$))`), String.raw`flowchart LR
  S(($$S_z$$)) -.-|$$\chi$$| A(($$a_1$$))`);
  assert.equal(mermaidMath(String.raw`A[$a_2:|\alpha\rangle$]`), String.raw`A[$$a_2:|\alpha\rangle$$]`);
  // Already Mermaid's form, escaped dollars, prices and spaced dollars stay put.
  for (const same of ["A[$$x$$] --> B", String.raw`A[costs \$5]`, "A[$5 and $6]", "A[$ x $]", "A[$a\nb$]", "A[$$]"]) {
    assert.equal(mermaidMath(same), same);
  }
});

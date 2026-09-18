import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { mermaidFence, normalizeChatMarkdown, remarkMermaid } from "../src/shared/lib/mermaidMarkdown.js";

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

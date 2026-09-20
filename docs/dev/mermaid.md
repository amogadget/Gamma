# Mermaid diagrams

Notes and AI replies render closed `mermaid` Markdown fences as SVG diagrams.
Use `/mermaid` in a note to insert a starter flowchart. Clicking a note's diagram
opens the normal source editor; leaving the editor renders the updated diagram.
Hovering a diagram shows its toolbar — the same flat icon buttons as a note
image's hover strip: show source (`</>`), copy source, download SVG. Ordinary
code blocks keep their existing behavior.

A note's diagram resizes like a note image: the right-edge grip
(`shared/ui/ResizeGrip.jsx`, shared with `MdImage`) drags the width, and
double-clicking it restores the natural size. The size is stored in the
fence's info string after the language — `` ```mermaid width=420 `` —
which other Markdown renderers ignore, so the source stays portable (the
diagram analogue of the Obsidian `![alt|420]` image size). `setMermaidWidth`
in `shared/lib/mermaidMarkdown.js` rewrites only the nth diagram's opening
line (fences in quotes and list items included, in rendered order — the
same nth-construct idiom as images and tables in `editor/MdTools.jsx`);
`remarkMermaid` carries the width into the HTML as `data-mermaid-width`. The
figure hugs the drawing even without a stored size (it reads Mermaid's own
`max-width` cap), so the grip always sits at the diagram's edge. Read-only
views and chat replies show no grip.

Math in flowchart and sequence labels uses Mermaid's `$$...$$` delimiters, not
the single-dollar syntax of surrounding Markdown. For example,
`A["$$a_1$$"] -->|"$$J$$"| B["$$a_2$$"]`. HTML label layout is enabled so Mermaid
can embed KaTeX's MathML in SVG `foreignObject` elements. Labels remain sanitized
by strict security mode. Source copying preserves the original delimiters.

`shared/ui/MermaidDiagram.jsx` is shared by `editor/BlockTree.jsx` and
`shared/ui/Widgets.jsx` (chat, note tooltips, and other chat-Markdown consumers).
It follows the app's computed light/dark color scheme, preserves original source
for selection copying, and shows source plus an error when rendering fails.
`shared/lib/mermaidMarkdown.js` protects fenced code from Markdown/math source
rewrites and annotates unfinished Mermaid fences so streaming replies wait for
the closing fence. Both backticks and tildes are supported.

`shared/lib/mermaidRenderer.js` loads the bundled Mermaid library on demand;
there is no CDN or rendering service. It serializes initialization/rendering
because Mermaid configuration is global, gives every SVG a unique ID, and drops
results belonging to an edited or unmounted component. Temporary measurement
containers are removed even after parse failures. Strict security, HTML label
layout, suppressed automatic error diagrams, a 50,000-character limit and a
500-edge limit are locked against diagram configuration overrides.
SVG anchors are unwrapped after rendering, and Mermaid event bindings are never
installed, so diagram links and callbacks stay inactive in previews/downloads.

The persisted content remains Markdown: no new block type, asset upload, or
database migration. Markdown export/import preserves the source. PDF exports
still use the existing backend code-block output; embedding rendered diagrams
in exported PDFs and live diagrams inside CodeMirror are outside this change.

Validation from `frontend/`:

```sh
node --test tests/mermaidMarkdown.test.mjs
npm run build
npm run e2e -- --only mermaid
```

The browser scenarios cover notes, editing and reload, the slash command, chat
streaming, multiple diagrams, errors, source copying, SVG downloads, theme
changes, locked security settings, ordinary code, Markdown round trips, and
the width grip (drag → `width=N` stored and kept across a reload, double-click
clears it).

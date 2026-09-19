# Mermaid diagrams

Notes and AI replies render closed `mermaid` Markdown fences as SVG diagrams.
Use `/mermaid` in a note to insert a starter flowchart. Clicking a note's diagram
opens the normal source editor; leaving the editor renders the updated diagram.
The diagram toolbar offers Source, Copy source, and Download SVG. Ordinary code
blocks keep their existing behavior.

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
containers are removed even after parse failures. Strict security, disabled HTML
labels, suppressed automatic error diagrams, a 50,000-character limit and a
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
changes, locked security settings, ordinary code, and Markdown round trips.

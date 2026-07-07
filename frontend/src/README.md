# src/

```
main.jsx            React root
App.jsx             the main component (still large): routing, autosave,
                    dockable windows, login, search, home. Being decomposed.
blockTree.jsx       the Logseq outliner — block rows, [[refs]], drag, markdown
logseqPdfModel.js   pure tree ops (insert/indent/outdent/flatten/cycle-check)
pdfViewer.jsx       custom pdf.js viewer — pages, highlights, links, text search; exports COLORS
chatDock.jsx        the AI chat window (self-contained per-page conversation)
widgets.jsx         shared chrome: DockWindow, ChatMarkdown, AutoGrowTextarea
sessionState.js     localStorage: restore last workspace on bare `/`
utils.js            API base, fetch wrapper, ids, hashing, formatting
app.css             all styles
```

## How-tos

- **Label a page** — open the page, click the 🏷 Labels chip → type comma-separated
  labels. Stored as `properties.category`. Search `:quantum:` to filter by label
  (colons let labels contain spaces; `:a::b:` requires both).
- **Highlight** — select text on the PDF → pick a color. Creates a highlight block.
- **Reference link** — right-click a highlight → *Copy as reference point*, then paste
  into a link dialog to point one paper's note at an exact spot in another.
- **Share** — a page's share menu mints a `?share=<token>` read-only public link.

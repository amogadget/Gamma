# frontend/

React 18 + Vite SPA. Talks same-origin `/api/*`; in dev Vite proxies to `:9001`.

```bash
npm install
npm run dev      # :5173
npm run build    # → dist/  (FastAPI serves this in prod)
```

## src/ map

```
main.jsx            React root
App.jsx             application orchestration: routing, autosave, docking, home
LoginPage.jsx       loading / login / session-conflict screens
blockTree.jsx       the Logseq outliner — block rows, [[refs]], drag, markdown
pdfViewer.jsx       custom pdf.js viewer — pages, highlights, links, text search; exports COLORS
search.jsx          workspace search (Ctrl+F): SearchPanel popover, buildSearchRegex
chatDock.jsx        the AI chat window (per-page conversation)
settings.jsx        settings dialog + papers/AI/search/diagnostic panes; exports QuotaMeter
fileBrowser.jsx     home library List/Grid view toggle
menus.jsx           context menus
widgets.jsx         shared chrome: dock windows, tabs, popovers, markdown, inputs
latexEditor.jsx     LaTeX note editor + paste-picture support
icons.jsx           shared SVG icons
logseqPdfModel.js   pure block-tree ops (insert/indent/outdent/flatten/cycle-check)
libraryUtils.js     pure library/paper rules (folder tags, time, metadata)
sessionState.js     localStorage: restore last workspace on bare `/`
utils.js            API base, fetch wrapper, ids, hashing, formatting
app.css             shared controls + workspace, PDF, blocks, and chat
library.css         home library, folders, file views, selection, pins
settings.css        settings dialog layout
```

- `public/` — static assets served as-is (`favicon.svg`, `pdf.worker.min.mjs`).
- `vite.config.js` — dev proxy + build config.

View modes come from the URL (no router lib): `/` home · `/?page=<id>` page ·
`/?share=<token>` public read-only · `/?block=<id>` jump-to-block.

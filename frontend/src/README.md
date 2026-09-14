# src/

The layout below describes the current code. The proposed feature folders,
state ownership, and migration order are in the
[App.jsx decomposition plan](../../docs/dev/frontend-refactor.md).

```
main.jsx            React root
App.jsx             application orchestration: routing, autosave, docking, home
libraryUtils.js     pure library/paper rules shared across application views
LoginPage.jsx       loading and login screens
settings.jsx        settings dialog and its papers/AI/search/diagnostic panes
settingsWorkspace.jsx  Settings → Members & sharing: this workspace, members/roles, all my workspaces
settingsBackups.jsx    Settings → Advanced → Server backups (admins): snapshot, download, delete
blockTree.jsx       the Logseq outliner — block rows, [[refs]], drag, markdown
fileChip.jsx        the file chip a `[name](/api/uploads/…)` link renders as; right-click
                    menu: download, and for a PDF "Open page" / "Open as page" (FileChipContext)
logseqPdfModel.js   pure tree ops (insert/indent/outdent/flatten/cycle-check)
pdfViewer.jsx       custom pdf.js viewer — pages, highlights, links, text search; exports COLORS
search.jsx          workspace search (Ctrl+F): SearchPanel popover, result groups
textnorm.js         search normalization + fuzzy regex (mirror of backend
                    gamma/textnorm.py; tests/shared/textnorm.json pins both)
collabSession.js    the page's live session as a plain state machine: op batches,
                    remote ops, reconciliation, catch-up, presence (node-tested)
collab.js           usePageCollab: collabSession wired to fetch/WebSocket/React
blockOps.js         diffTrees / applyOps / positions for the op batches
chatDock.jsx        the AI chat window (self-contained per-page conversation)
widgets.jsx         shared chrome: dock windows, tabs, popovers, markdown, inputs
sessionState.js     localStorage: restore the last open page on bare `/` (per workspace)
utils.js            API base, fetch wrapper (user + workspace headers), ids, hashing, formatting
app.css             shared controls plus workspace, PDF, blocks, and chat
library.css         home library, folders, file views, selection, and pins
settings.css        settings dialog layout and settings-specific controls
```

## How-tos

- **Label a page** — open the page, click the 🏷 Labels chip → type comma-separated
  labels. Stored as `properties.category`. Search `:quantum:` to filter by label
  (colons let labels contain spaces; `:a::b:` requires both).
- **Highlight** — select text on the PDF → pick a color. Creates a highlight block.
- **Reference link** — right-click a highlight → *Copy as reference point*, then paste
  into a link dialog to point one paper's note at an exact spot in another.
- **Share** — a page's share menu mints a `?share=<token>` read-only public link.

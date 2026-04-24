<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./logos/gamma-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./logos/gamma-logo-light.svg">
  <img alt="Logo" src="./logos/gamma-logo-light.svg">
</picture>

# Gamma PDF Annotator

A self-hosted, Logseq-inspired PDF annotation server. Highlight PDFs in your browser, organize your notes as nested outliner blocks, and share read-only annotated copies via link.

**Live example:** <https://annotation.amogadgetlab.com>
**Shared view example:** <https://annotation.amogadgetlab.com/?share=9BroHYcCcL5X6HuW>

## What it does

- Open any PDF by URL or upload it directly (drag-and-drop).
- Select text to create a highlight with optional comment and color.
- Highlights appear as top-level blocks in a Logseq-style outliner.
- Add free notes, nest them under highlights, reorder blocks by drag (siblings and children).
- Browse all your annotated pages from a home view. Pages themselves are reorderable.
- Open a page with no PDF attached — just notes, like a Logseq page.
- Everything auto-saves. Reloading a page restores highlights, notes, structure, and title.
- Generate a read-only share link for any annotated PDF.
- Password-protect the editor via Caddy basic auth; shared links remain public.

## Inspired by Logseq

Logseq is an excellent outliner-based knowledge-management tool. Gamma takes several ideas from it that work well for PDF annotation specifically:

- **Everything is a block.** Highlights and free notes aren't different entities — both are rows in the same `blocks` table, distinguished only by whether they carry a `highlight_id` property. Both can be nested, reordered, styled identically.
- **Pages are the top-level container.** A PDF corresponds to exactly one page; all its highlights and notes live as blocks inside that page.
- **Outliner editing.** Enter for sibling, Tab for indent, Shift+Tab for outdent, Backspace on empty to delete. One-click to edit, cursor lands near the click point.
- **Drop indicator for tree drags.** Like Logseq, Gamma shows a single horizontal blue line during drag; its horizontal position snaps to valid nesting depths (sibling of current, first child of target, or sibling of any ancestor).
- **Nested guide lines.** The vertical line to the left of nested blocks mimics Logseq's `.block-children` border-left pattern.
- **Fractional indexing for page order.** Custom ordering of pages persists across reorder without renumbering, using the same `a0`, `a1`, `a0V` key scheme Logseq uses for blocks.

Gamma is narrower than Logseq — no graph view, no daily journal, no queries. The feature set is tuned for "I want to annotate PDFs and keep the notes organized as a tree."

## View modes

The app has three coexisting modes, each derived from what's in the URL:

- **Home** (`/`) — when no PDF is loaded, shows a list of all your pages as blocks. Each entry shows the page title and a preview of its first block. Click a page to open it. Pages are drag-reorderable.
- **PDF + notes** (`/?page=<id>`, page has a source URL) — side-by-side (or stacked) PDF viewer and block tree. The default working view. Close-PDF (X button) temporarily hides the viewer, letting the block tree fill the width; clicking a highlight dot re-opens the PDF and jumps to that highlight.
- **Page only** (`/?page=<id>`, page has no source URL) — just the block tree, full-width. Create notes without a PDF attached, or use the home-page-style to collect thoughts.

Shared links (`/?share=<token>`) are a separate public read-only view: PDF + block tree, but editing and navigation are locked.

## Architecture

Three pieces:

1. **Backend** (`backend/app.py`) — a FastAPI app over two SQLite databases:
   - `data.db` — annotations (legacy, kept for backward compat) and shares.
   - `pages.db` — a `unified_blocks` table with a self-referential `parent_id` (root-level blocks are pages; everything else is nested blocks). Highlights and free notes are both rows, distinguished by whether they carry a `highlight_id` property in JSON. Ordering uses fractional indexing via the `position` column. Legacy `pages` and `blocks` tables remain for backward compatibility.
2. **Frontend** (`logseq-v2-frontend/`) — React + Vite.
   - `src/App.jsx` — main component. Routing, PDF loading, block tree render, drag-and-drop, autosave.
   - `src/logseqPdfModel.js` — block tree operations (insert, indent/outdent, flatten, extract, sibling/child insertion, cycle check).
   - `src/app.css` — dark-theme styling.
3. **Reverse proxy** — Caddy routes the domain to the frontend and `/api/*` to the backend. Basic auth protects everything except shared links.

## Running locally

### Prerequisites

- Python 3.11+
- Node.js 18+
- Caddy (optional, only if you want domain routing + auth)

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn aiosqlite pydantic python-multipart fractional-indexing
uvicorn app:app --host 127.0.0.1 --port 9001
```

The backend auto-creates `data.db` and `pages.db` on first start, runs all pending migrations (adds `doc_id`, `position`, and `source_url` columns to `pages` as needed), and seeds the `blocks` table from any existing `annotations` rows.

### Frontend

```bash
cd logseq-v2-frontend
npm install
npm run dev        # development server on :5173
# or
npm run build && npm run preview    # production build on :4173
```

### Putting it together

In development, proxy `/api/*` from the frontend to `127.0.0.1:9001` via a Vite proxy config or Caddy. See `vite.config.js` for the current setup.

For production-style hosting with basic auth:

```caddyfile
your-domain.com {
    @needsAuth {
        not path /api/*
        not path /assets/*
        not path *.js
        not path *.css
        not path *.mjs
        not path *.map
        not path *.ico
        not path *.png
        not path *.jpg
        not path *.svg
        not path *.woff*
        not query share=*
    }
    basic_auth @needsAuth {
        admin <bcrypt-hash>
    }
    handle /api/* {
        reverse_proxy 127.0.0.1:9001
    }
    handle {
        reverse_proxy 127.0.0.1:4173
    }
}
```

Generate the bcrypt hash with `caddy hash-password`.

## Features

- **PDF loading**: open by URL or upload (max 50 MB, content-hashed for dedup).
- **Highlights**: select text, pick color, add comment. Right-click to delete or change color.
- **Logseq EDN import**: import Logseq PDF-highlight exports (EDN + MD + PDF) — preserves highlight positions, notes, and block tree structure.
- **Attach mode**: link orphaned notes to existing PDF highlights — click ⊕ then left-click a highlight. Linked block jumps to the highlight and inherits its color.
- **Cross-note block references**: type `[[` in any block to search and insert a reference to another block. References render as clickable chips that jump to the target.
- **Outliner block tree**: highlights and free notes rendered as nested blocks with Logseq-style vertical guide lines. Enter for sibling, Tab for indent, Shift+Tab for outdent, Backspace on empty to delete.
- **Rich text**: markdown + KaTeX math in view mode, raw markdown in edit mode. One-click to edit; cursor lands near the click point.
- **Drag-and-drop blocks**: hover over a block's left edge, grab the ⋮⋮ handle. Drop as sibling or as child. Cycle prevention rejects drops that would nest a block into its own subtree. Horizontal line indicator slides to show intended depth.
- **Page home view**: all pages listed as blocks, orderable via drag, click to open.
- **Pages without PDF**: pages with no source URL open as block-tree-only; useful for free-form notes.
- **Close-PDF**: X button on the viewer hides the PDF temporarily while keeping it loaded. Clicking a highlight dot re-opens the viewer and jumps to that highlight.
- **Layout toggles**: side-by-side (default) or stacked. Hide notes to see only the PDF.
- **Renameable page title**: click the title to rename.
- **Share links**: read-only URL, public, PDF + highlights + notes all preserved.
- **Password protection**: editor gated by Caddy basic auth; shared links stay public.
- **Mobile**: dedicated drag handle on the splitter for touch.

## URL routing

- `/` → home view (pages list).
- `/?page=<page_id>` → open a page (with or without PDF).
- `/?block=<block_id>` → open the page containing this block, then scroll to it.
- `/?share=<token>` → public read-only view of a shared page.
- `/?src=<url>` → legacy, redirects to `?page=<id>` after loading.

## Known limitations

- The `pages.html` legacy page viewer is no longer reachable via the toolbar but is still served. It reads from the `pages.content` markdown field, kept in sync on every save, but isn't the source of truth.
- Shared links are exempt from auth via URL query parameter. This is a soft boundary — anyone with a valid token can view; invalid token lands on a broken page. For stronger protection, use app-level auth instead of Caddy basic auth.
- Autosave is debounced at 500 ms. Closing the tab within that window can lose the last keystroke.
- No conflict handling for simultaneous edits across tabs/devices. Last write wins.
- Uploaded PDFs are stored content-hashed under `uploads/`. No cleanup for orphans whose pages/blocks have been deleted.
- `collapsed` state on blocks is UI-only; reloading restores everything expanded.
- Block references inside collapsed parents cannot scroll into view (DOM element not rendered).

## Future work

- "Recent" carousel at the top of the home view.
- Block backlinks (reverse references — "what links here").
- Conflict resolution / multi-device sync.
- Public read-only deployment mode (no auth, share-only).
- Cleanup of orphaned uploaded PDFs.
- Persist `collapsed` state across reload.
- Migration of legacy `blocks` table data into `unified_blocks`.

## Directory layout

```
pdf-share/
├── backend/              # FastAPI + SQLite
│   ├── app.py            # all endpoints
│   ├── data.db           # annotations + shares (gitignored)
│   └── pages.db          # pages + blocks (gitignored)
├── logseq-v2-frontend/   # React + Vite
│   ├── src/
│   │   ├── App.jsx
│   │   ├── logseqPdfModel.js
│   │   ├── app.css
│   │   └── main.jsx
│   ├── public/
│   │   ├── pages.html            # legacy page viewer (not used from toolbar)
│   │   └── pdf.worker.min.mjs
│   ├── package.json
│   └── vite.config.js
├── uploads/              # user-uploaded PDFs, content-hashed (gitignored)
└── archive/              # session backups, tarballed (gitignored)
```

## History

The codebase went through several layered iterations before landing here. An earlier frontend (`rph-frontend`) accumulated feature layers — share links, colored highlights, resizable sidebar, outliner, page-sync logic, custom flash animations, overlapping CSS — to the point where debugging any one feature meant fighting the others. The current code is `logseq-v2-frontend`, started as a clean rewrite keeping only the share-link flow, with later additions built on a consistent block-based data model.

Notable architectural decisions:

- Pages are the top-level container for a PDF's annotations (Logseq model), not the annotations themselves.
- Highlights are blocks with a `highlight_id` property; free notes are blocks without. Both persist identically, both can be reordered, both can have children.
- Block ordering within a page uses a plain integer `position` column, not fractional indexing. Page ordering on the home view uses fractional indexing so reorders only touch the moved page, not every sibling.
- The `annotations` table in `data.db` is kept for backward compatibility but is no longer the source of truth — `blocks` in `pages.db` is. A one-time startup migration seeds the blocks table from existing annotations.
- URL routing moved from `?src=<url>` to `?page=<id>` as the canonical form. `?src=...` still works but redirects to `?page=...` after loading the page record.

## License

MIT

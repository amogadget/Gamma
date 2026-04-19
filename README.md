# Gamma PDF Annotator

A self-hosted, Logseq-inspired PDF annotation server. Highlight PDFs in your browser, organize your notes as nested outliner blocks, and share read-only annotated copies via link.

**Live example:** <https://annotation.amogadgetlab.com>
**Shared view example:** <https://annotation.amogadgetlab.com/?share=9BroHYcCcL5X6HuW>

## What it does

- Open any PDF by URL or upload it directly (drag-and-drop).
- Select text to create a highlight with optional comment and color.
- Highlights appear as top-level blocks in a Logseq-style outliner sidebar.
- Add free notes, nest them under highlights, reorder blocks by drag.
- Everything auto-saves. Reloading a PDF restores highlights, notes, structure, and title.
- Generate a read-only share link for any annotated PDF.
- The main editor is password-protected via Caddy basic auth; shared links remain public.

## Architecture

Three pieces:

1. **Backend** (`backend/app.py`) — a FastAPI app serving a small JSON API on top of two SQLite databases:
   - `data.db` — annotations (legacy, kept for backward compat) and shares.
   - `pages.db` — pages and blocks (the Logseq-style outliner). Every PDF gets one page; highlights and free notes are both stored as rows in the `blocks` table, keyed by `parent_id` and `position`, with highlight-specific data in a JSON `properties` column.
2. **Frontend** (`logseq-v2-frontend/`) — a React + Vite SPA.
   - `src/App.jsx` — main component. Handles routing between editor/shared mode, PDF loading, block tree rendering, drag-and-drop, autosave.
   - `src/logseqPdfModel.js` — the block tree operations (insert, indent/outdent, flatten, etc.) and highlight↔block conversions.
   - `src/app.css` — dark-theme styling.
   - `public/pages.html` — a legacy standalone page viewer (used by the "Pages" button in the toolbar). Still served, but no longer the source of truth.
3. **Reverse proxy** — Caddy routes `annotation.amogadgetlab.com` to the frontend dev server and `/api/*` to the backend. Basic auth protects everything except shared links (`?share=...`) and static assets.

## Running locally

### Prerequisites

- Python 3.11+ (FastAPI + uvicorn)
- Node.js 18+ (Vite)
- Caddy (optional, only if you want domain routing + auth)

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn aiosqlite pydantic python-multipart
uvicorn app:app --host 127.0.0.1 --port 9001
```

The backend auto-creates `data.db` and `pages.db` on first start, and migrates any existing `annotations` rows into the `blocks` table.

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

For production-style hosting with basic auth, use a Caddyfile like:

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
- **Highlights**: select text, pick color, add comment. Right-click to delete.
- **Outliner sidebar**: highlights and notes as nested blocks. Enter for sibling, Tab for indent, Shift+Tab for outdent, Backspace on empty for delete.
- **Rich text**: markdown + KaTeX math rendering in view mode, raw markdown in edit mode. Click to edit, cursor lands near the click point.
- **Drag to reorder**: hover over a root block's left edge, grab the ⋮⋮ handle, drop to reorder.
- **Layout toggles**: side-by-side (default) or stacked (PDF above notes). Hide notes to see only the PDF.
- **Renameable page title**: click the title above the blocks to rename.
- **Share links**: read-only URL, public, PDF + highlights + notes all preserved.
- **Password protection**: main editor gated by Caddy basic auth; shared links stay public.
- **Mobile**: dedicated drag handle on the splitter for touch, drop-target-friendly hit areas.

## Known limitations

- Only root-level blocks can be reordered via drag-and-drop. Nested blocks move as a unit with their parent. Dragging nested blocks between parents is not implemented — see "Future work."
- The `pages.html` legacy page viewer is still reachable via the "Pages" button in the toolbar. It doesn't fully integrate with the new block schema — it reads from the `pages.content` markdown field, which is kept in sync on every save but isn't the source of truth.
- Shared links are exempt from auth via URL query parameter. This is a soft boundary: anyone who guesses `?share=<token>` lands on a broken page (if the token's invalid) rather than the editor, but the auth prompt is bypassed. For stronger protection, use app-level auth instead of Caddy basic auth.
- Autosave is debounced at 500 ms. Closing the tab within that window after a change can lose the last keystroke.
- No conflict handling for simultaneous edits across tabs/devices. Last write wins.
- Uploaded PDFs are stored content-hashed under `uploads/`. There's no cleanup for orphans (PDFs whose pages/blocks have been deleted).

## Future work

- Drag-and-drop phase B: nested blocks, drop-on-block-as-child.
- Three-mode right pane: notes / page list / hidden.
- Close-PDF → page list view fills the screen.
- Logseq EDN import.
- Conflict resolution / multi-device sync.
- Public read-only deployment mode (no auth, share-only).

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
│   │   ├── pages.html            # legacy page viewer
│   │   └── pdf.worker.min.mjs
│   ├── package.json
│   └── vite.config.js
├── uploads/              # user-uploaded PDFs, content-hashed (gitignored)
└── archive/              # session backups, tarballed (gitignored)
```

## History

The codebase went through several layered iterations before landing here. An earlier frontend (`rph-frontend`) accumulated feature layers — share links, colored highlights, resizable sidebar, logseq-style outliner, page-sync logic, custom flash animations, overlapping CSS — to the point where debugging any one feature meant fighting the others. The current code is `logseq-v2-frontend`, started as a clean rewrite keeping only the share-link flow, with later additions built on a consistent block-based data model.

Notable architectural decisions made during the rewrite:

- Pages are the top-level container for a PDF's annotations (Logseq model), not the annotations themselves.
- Highlights are just blocks with a `highlight_id` property; free notes are blocks without. Both persist identically, both can be reordered, both can have children.
- Block ordering uses a plain integer `position` column, not fractional indexing. Simpler, fine for the expected scale.
- The `annotations` table in `data.db` is kept for backward compatibility but is no longer the source of truth — `blocks` in `pages.db` is. A one-time startup migration seeds the blocks table from existing annotations.

## License

MIT

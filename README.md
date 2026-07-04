<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./logos/gamma-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./logos/gamma-logo-light.svg">
  <img alt="Logo" src="./logos/gamma-logo-light.svg">
</picture>

# Gamma PDF Annotator

A self-hosted, Logseq-inspired PDF annotation server. Highlight PDFs in your browser, organize your notes as nested outliner blocks, and share read-only annotated copies via link.

**Live example:** <https://annotation.amogadgetlab.com>
**Shared view example:** <https://annotation.amogadgetlab.com/?share=vZ3UKgXO0LRGaUVg>

## What it does

- Open any PDF by URL or upload it directly (drag-and-drop).
- Select text to create a highlight with optional comment and color.
- Highlights appear as top-level blocks in a Logseq-style outliner.
- Add free notes, nest them under highlights, reorder blocks by drag (siblings and children).
- Browse all your annotated pages from a home view. Pages themselves are reorderable.
- Open a page with no PDF attached — just notes, like a Logseq page.
- Everything auto-saves. Reloading a page restores highlights, notes, structure, and title.
- Generate a read-only share link for any annotated PDF.
- Multi-user accounts with per-user isolated data. Guest account with daily reset.

## Quick start (Docker)

```bash
docker run -d --name gamma \
  -p 9001:9001 \
  -v gamma-data:/data \
  -e GAMMA_ADMIN_USER=admin \
  -e GAMMA_ADMIN_PASSWORD=change-me \
  ghcr.io/tim4431/gamma:latest
```

Open <http://localhost:9001> and log in. All state (accounts, notes, uploaded PDFs) lives in the `/data` volume.

Or with compose — secrets live in a `.env` file next to [docker-compose.yml](./docker-compose.yml):

```bash
cp .env.example .env   # then edit: admin password, optional AI key
docker compose up -d
```

To manage users inside a running container:

```bash
docker exec gamma python manage.py create-user alice her-password
docker exec gamma python manage.py list-users
```

## Screenshots

### Annotated PDF with block tree

![Annotated PDF with block tree and AI chat](./docs/screenshots/01-annotated-pdf.png)

The core view: PDF with colored highlights on one side, Logseq-style nested block tree on the other, and the AI chat panel anchored at the bottom of the sidebar. Click a highlight dot to jump the PDF to that position; click a PDF highlight to scroll the sidebar to its block. Drag the splitter above the chat to resize it.

### Home page with category carousels

![Home page showing category-grouped page carousels](./docs/screenshots/02-home-carousels.png)

All your pages grouped by category tag. Each row scrolls independently with arrow controls. An "All" section at the top shows recently updated pages.

### Login page

![Login form with guest option](./docs/screenshots/03-login.png)

App-level authentication with username and password. Guest accounts get a fresh workspace each day — no registration needed.

### Shared link (public view)

![Read-only shared view of an annotated PDF](./docs/screenshots/04-shared-view.png)

Generate a read-only link for any annotated PDF. Recipients see the PDF, highlights, and block tree — no login required. The editor stays gated behind authentication.

## Inspired by Logseq

Logseq is an excellent outliner-based knowledge-management tool. Gamma takes several ideas from it that work well for PDF annotation specifically:

- **Everything is a block.** Highlights and free notes aren't different entities — both are rows in the same `unified_blocks` table, distinguished only by whether they carry a `highlight_id` property. Both can be nested, reordered, styled identically.
- **Pages are the top-level container.** A PDF corresponds to exactly one page; all its highlights and notes live as blocks inside that page.
- **Outliner editing.** Enter for sibling, Tab for indent, Shift+Tab for outdent, Backspace on empty to delete. One-click to edit, cursor lands near the click point.
- **Drop indicator for tree drags.** Like Logseq, Gamma shows a single horizontal blue line during drag; its horizontal position snaps to valid nesting depths (sibling of current, first child of target, or sibling of any ancestor).
- **Nested guide lines.** The vertical line to the left of nested blocks mimics Logseq's `.block-children` border-left pattern.
- **Fractional indexing for block order.** Custom ordering persists across reorder without renumbering, using the same `a0`, `a1`, `a0V` key scheme Logseq uses.

Gamma is narrower than Logseq — no graph view, no daily journal, no queries. The feature set is tuned for "I want to annotate PDFs and keep the notes organized as a tree."

## View modes

The app has three coexisting modes, each derived from what's in the URL:

- **Home** (`/`) — when no PDF is loaded, shows a list of all your pages as blocks. Each entry shows the page title and a preview of its first block. Click a page to open it. Pages are drag-reorderable.
- **PDF + notes** (`/?page=<id>`, page has a source URL) — side-by-side (or stacked) PDF viewer and block tree. The default working view. Close-PDF (X button) temporarily hides the viewer, letting the block tree fill the width; clicking a highlight dot re-opens the PDF and jumps to that highlight.
- **Page only** (`/?page=<id>`, page has no source URL) — just the block tree, full-width. Create notes without a PDF attached, or use the home-page-style to collect thoughts.

Shared links (`/?share=<token>`) are a separate public read-only view: PDF + block tree, but editing and navigation are locked.

## Architecture

A single deployable service: a FastAPI backend that also serves the built React frontend. (In development the two run separately with a Vite proxy.)

### Backend (`backend/`)

```
backend/
├── app.py                # uvicorn entrypoint (thin shim)
├── manage.py             # user-management CLI
├── requirements.txt
└── gamma/
    ├── app.py            # FastAPI assembly: middleware, routers, startup, SPA serving
    ├── config.py         # env-driven configuration (GAMMA_DATA_DIR, AI keys, ...)
    ├── db.py             # SQLite schemas, connections, per-user paths
    ├── auth.py           # session middleware + require_user/resolve_user
    ├── seed.py           # per-user DB creation + guest welcome-page seeding
    ├── blocks_store.py   # unified_blocks tree helpers (subtree CTEs, fractional positions)
    ├── storage.py        # upload lookup + orphan cleanup
    ├── logseq_import.py  # EDN/MD parsers for Logseq imports
    └── routers/          # one module per API area
        ├── auth.py       # /api/login, /api/logout, /api/session, /api/login-guest
        ├── blocks.py     # /api/blocks/*, /api/block-search
        ├── uploads.py    # /api/uploads, /api/upload-image, /api/cleanup-uploads
        ├── pdf.py        # /api/resolve-pdf, /api/pdf (proxy + cache)
        ├── shares.py     # /api/share/*
        ├── ai.py         # /api/ai/chat, /api/chats/*
        ├── annotations.py# /api/annotations/* (legacy)
        └── imports.py    # /api/import/logseq
```

All state is SQLite + files under the data directory (`GAMMA_DATA_DIR`, defaults to `backend/`):

- `users.db` — accounts (bcrypt passwords), session tokens, and share tokens.
- `users/<name>/pages.db` — the `unified_blocks` table: everything is a block with a self-referential `parent_id` and a fractional-index `position`. Root-level blocks are pages.
- `users/<name>/data.db` — AI chat history (and a legacy `annotations` table).
- `users/<name>/uploads/` — uploaded PDFs and images, content-hash deduped.

Authentication is a session cookie resolved by middleware; no external auth provider. Share tokens allow unauthenticated read access to a specific document.

### Frontend (`logseq-v2-frontend/`)

React + Vite.

- `src/App.jsx` — main component: routing, PDF viewer (pdf.js), block tree, drag-and-drop, autosave, login, AI chat.
- `src/logseqPdfModel.js` — pure block-tree operations (insert, indent/outdent, flatten, extract, cycle check).
- `src/app.css` — dark/light themed styling.

The frontend always calls same-origin `/api/*`. In production the backend serves the built `dist/`; in development Vite proxies to the backend.

## Running from source (development)

### Prerequisites

- Python 3.11+
- Node.js 18+

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python manage.py create-user admin yourpassword
python manage.py setup      # creates guest account
uvicorn app:app --host 127.0.0.1 --port 9001
```

### Frontend

```bash
cd logseq-v2-frontend
npm install
npm run dev        # development server on :5173, proxies /api to :9001
```

### Production without Docker

Build the frontend and let the backend serve it:

```bash
cd logseq-v2-frontend && npm run build
cd ../backend
GAMMA_STATIC_DIR=../logseq-v2-frontend/dist uvicorn app:app --host 127.0.0.1 --port 9001
```

Put any TLS-terminating reverse proxy (Caddy, nginx) in front of port 9001 if you want a domain. If you previously used HTTP/3, note we hit a Chrome bug where reopening an incognito window reused a stale QUIC connection with crippled flow control, making 6 MB PDFs take 10+ seconds to download — consider limiting Caddy to `protocols h1 h2`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GAMMA_DATA_DIR` | No | `backend/` (`/data` in Docker) | Where users.db and per-user data live |
| `GAMMA_STATIC_DIR` | No | unset (`/app/static` in Docker) | Built frontend to serve as SPA; unset = API only |
| `GAMMA_PORT` | No | `9001` | Listen port (Docker entrypoint only) |
| `GAMMA_ADMIN_USER` / `GAMMA_ADMIN_PASSWORD` | No | — | Bootstrap admin account on container start |
| `GAMMA_AI_PROVIDER` | No | `anthropic` | AI chat wire protocol: `anthropic` (Messages API) or `openai` (Chat Completions) |
| `GAMMA_AI_API_KEY` | For AI chat | — | API key; unset disables the chat panel |
| `GAMMA_AI_BASE_URL` | No | per provider | `https://api.anthropic.com` / `https://api.openai.com`; point at any compatible endpoint (e.g. `https://api.deepseek.com/anthropic`) |
| `GAMMA_AI_MODEL` | No | per provider | `claude-haiku-4-5-20251001` / `gpt-4o-mini` |

For docker compose, put these in a `.env` file (see [.env.example](./.env.example)); `.env` is gitignored. The legacy names `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` still work as fallbacks for the `GAMMA_AI_*` equivalents.

## Docker image

The image is published to GitHub Container Registry on every push to `main` (`latest`) and on version tags (`v1.2.3` → `1.2.3`, `1.2`), for `linux/amd64` and `linux/arm64`:

```
ghcr.io/tim4431/gamma
```

It is a multi-stage build: a Node stage compiles the frontend, and the final Python image runs FastAPI serving both the API and the static SPA on port 9001. See [Dockerfile](./Dockerfile) and [.github/workflows/docker.yml](./.github/workflows/docker.yml).

## Features

- **PDF loading**: open by URL or upload (max 50 MB, content-hashed for dedup).
- **Highlights**: select text, pick color, add comment. Right-click to delete or change color.
- **Logseq EDN import**: import Logseq PDF-highlight exports (EDN + MD + PDF) — preserves highlight positions, notes, and block tree structure.
- **Attach mode**: link orphaned notes to existing PDF highlights — click ⊕ then left-click a highlight. Linked block jumps to the highlight and inherits its color.
- **Cross-note block references**: type `[[` in any block to search and insert a reference to another block. References render as clickable chips that jump to the target.
- **AI chat assistant**: sidebar chatbox sends your question + the PDF's extracted text (up to 8000 chars) to an Anthropic- or OpenAI-compatible API. Supports uploaded PDFs and URLs. Per-page conversation history is stored on the backend, so it follows you across devices. Configured via the `GAMMA_AI_*` env vars.
- **Category metadata**: tag-style category input with autocomplete from existing categories. Arrow-key navigation, comma to add tags. Home page shows grouped carousels by category.
- **Light/dark theme toggle**: cycles Dark ☾ / Light ☀ / Follow system ◐ (listens to `prefers-color-scheme`). Persisted in localStorage.
- **Session persistence**: last-opened page, collapsed states, zoom, orientation, PDF toggle, notes toggle, splitter position, and current PDF page survive page reload (localStorage + block properties).
- **Outliner block tree**: highlights and free notes rendered as nested blocks with Logseq-style vertical guide lines. Enter for sibling, Tab for indent, Shift+Tab for outdent, Backspace on empty to delete.
- **Rich text**: markdown + KaTeX math in view mode, raw markdown in edit mode. One-click to edit; cursor lands near the click point.
- **Drag-and-drop blocks**: hover over a block's left edge, grab the ⋮⋮ handle. Drop as sibling or as child. Cycle prevention rejects drops that would nest a block into its own subtree. Horizontal line indicator slides to show intended depth.
- **Page home view**: all pages listed as blocks, orderable via drag, click to open.
- **Pages without PDF**: pages with no source URL open as block-tree-only; useful for free-form notes.
- **Close-PDF**: X button on the viewer hides the PDF temporarily while keeping it loaded. Clicking a highlight dot re-opens the viewer and jumps to that highlight.
- **Layout toggles**: side-by-side (default) or stacked. Hide notes to see only the PDF.
- **Renameable page title**: click the title to rename.
- **Share links**: read-only URL, public, PDF + highlights + notes all preserved. Click PDF highlight → sidebar jumps to its block. Backlinks shown with "private block" for cross-page references.
- **Multi-user accounts**: per-user isolated databases and uploaded files. Session-based auth with bcrypt passwords. Guest account with daily data reset. Admin-managed via CLI — no public registration.
- **Mobile**: dedicated drag handle on the splitter for touch. PDF viewer fits page width to the viewport (no horizontal panning), and zoom changes anchor on the visible page so you don't get bumped to a different page.

## URL routing

- `/` → home view (pages list).
- `/?page=<page_id>` → open a page (with or without PDF).
- `/?block=<block_id>` → open the page containing this block, then scroll to it.
- `/?share=<token>` → public read-only view of a shared page.
- `/?src=<url>` → legacy, redirects to `?page=<id>` after loading.

## Known limitations

- Autosave is debounced at 500 ms. Closing the tab within that window can lose the last keystroke.
- No conflict handling for simultaneous edits across tabs/devices. Last write wins.
- `src/App.jsx` is still a single large component; splitting it into hooks/components is tracked as future work.

## Future work

- Password change and account deletion via the app UI (currently CLI-only).
- Conflict resolution / multi-device sync.
- Collaboration between users (shared pages, cross-user block references).
- Decompose the frontend God component (`App.jsx`) into hooks and view components.

## License

MIT

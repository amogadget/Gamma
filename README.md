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

- Open any PDF by URL (arXiv links, DOI links, and publisher article pages all resolve to the PDF automatically) or upload it directly (drag-and-drop). Annotations already saved inside the file (SumatraPDF, Acrobat) are imported as notes.
- Select text to create a highlight with optional comment and color — or link the selection to another paper (DOI / arXiv / your library).
- Highlights appear as blocks in a Logseq-style outliner; add free notes, nest, and drag-reorder.
- Paper metadata (title, authors, venue, DOI, BibTeX) is fetched automatically via arXiv → Crossref → AI, with one-click BibTeX and a slide-ready formatted citation that pastes into PowerPoint with real italics/bold.
- In-PDF links are clickable: internal references jump (with a global Back button to return), external links open in your library if you already have the paper.
- AI chat about the open paper (or several at once): both Anthropic and OpenAI models, pasted figures, native PDF attachment, editable prompts, per-page history.
- File-browser home: organize papers into folders by drag-and-drop (storage stays flat), plus category tags and full-text search across notes, highlights, and the PDF itself (Ctrl+F).
- Everything auto-saves. Share any annotated PDF via a read-only public link.
- Multi-user accounts with per-user isolated data, a daily-reset guest account, and one-click zip export of all your data.

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

Or with compose — copy the templates (both real files are gitignored so your local settings never end up in commits):

```bash
cp docker-compose.yml.example docker-compose.yml
cp .env.example .env   # then edit: admin password, optional AI key
docker compose up -d
```

To manage users inside a running container:

```bash
docker exec gamma python manage.py create-user alice her-password
docker exec gamma python manage.py list-users
```

## Screenshots

### Annotated PDF with notes and AI chat

![Annotated PDF with block tree and AI chat](./docs/screenshots/01-annotated-pdf.png)

The core view: PDF with colored highlights and clickable reference links, the Logseq-style note tree docked beside it, and the AI chat window — all dockable/resizable panels (drag a window's grip to move it left/right/bottom, double-click to collapse). Click a highlight's note card to jump the PDF; follow in-PDF links and use the global ← Back button to return.

### File-browser home

![Home page with folders, recent carousel, and categories](./docs/screenshots/02-home-carousels.png)

Your library as a file browser: drag papers into folders (storage stays flat — folders are just metadata), with a Recent carousel and category tags above.

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
        ├── auth.py       # /api/login, /api/logout, /api/session, /api/login-guest, /api/export
        ├── blocks.py     # /api/blocks/*, /api/block-search, /api/blocks-replace
        ├── uploads.py    # /api/uploads, /api/upload-image, /api/cleanup-uploads
        ├── pdf.py        # /api/resolve-pdf (arXiv/citation_pdf_url/Unpaywall), /api/pdf (proxy + cache)
        ├── shares.py     # /api/share/*
        ├── ai.py         # /api/ai/chat, /api/ai/models, /api/chats/*
        ├── metadata.py   # /api/metadata/fetch (arXiv→DOI→AI), /api/metadata/cite (BibTeX → slide citation)
        ├── annotations.py# /api/annotations/* (legacy)
        └── imports.py    # /api/import/logseq, /api/import/pdf-annotations
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
| `GAMMA_AI_ANTHROPIC_API_KEY` | For AI chat* | — | Anthropic Messages API key (also DeepSeek/Kimi/GLM-compatible endpoints) |
| `GAMMA_AI_ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | e.g. `https://api.deepseek.com/anthropic` |
| `GAMMA_AI_OPENAI_API_KEY` | For AI chat* | — | OpenAI Chat Completions API key (or compatible server) |
| `GAMMA_AI_OPENAI_BASE_URL` | No | `https://api.openai.com` | Any OpenAI-compatible endpoint |
| `GAMMA_AI_MODELS` | No | configured providers' defaults | The model switcher list: comma-separated `provider:model` entries (e.g. `anthropic:claude-sonnet-5,openai:gpt-5.5`); the first entry is the default |
| `GAMMA_CONTACT_EMAIL` | Recommended | — | Real contact email for the Unpaywall open-access lookup (paywalled DOI → arXiv fallback); `example.com` addresses are rejected by the API |

\* Set at least one provider key to enable the chat panel; set both to offer models from both in the switcher. For docker compose, put these in a `.env` file (see [.env.example](./.env.example)); `.env` is gitignored. Legacy single-provider names (`GAMMA_AI_PROVIDER`, `GAMMA_AI_API_KEY`, `GAMMA_AI_BASE_URL`, `GAMMA_AI_MODEL`, and the `ANTHROPIC_*` aliases) still work — they fill the `GAMMA_AI_PROVIDER` slot.

## Docker image

The image is published to GitHub Container Registry on every push to `main` (`latest`) and on version tags (`v1.2.3` → `1.2.3`, `1.2`), for `linux/amd64` and `linux/arm64`:

```
ghcr.io/tim4431/gamma
```

It is a multi-stage build: a Node stage compiles the frontend, and the final Python image runs FastAPI serving both the API and the static SPA on port 9001. See [Dockerfile](./Dockerfile) and [.github/workflows/docker.yml](./.github/workflows/docker.yml).

## Features

### Getting papers in

- **Open by URL**: paste any link and press Enter. arXiv abstract pages rewrite to the PDF; publisher article pages (Nature, APS, …) are resolved via their `citation_pdf_url` meta tag; DOI links that hit a paywall fall back to a legal open-access copy via Unpaywall (published > accepted > preprint, with an explicit note when a preprint is substituted — opt-out in Settings).
- **Upload / drag-and-drop** (max 50 MB, content-hashed for dedup). Annotations embedded in the file (SumatraPDF "save annotations", Acrobat, Preview) are imported as highlight blocks automatically — positions, colors, and comments preserved (also available later via ⋮ → Import PDF annotations).
- **Logseq EDN import**: Logseq PDF-highlight exports (EDN + MD + PDF) preserve positions, notes, and tree structure.
- **Transfer list**: a Chrome-style downloads/uploads button in the topbar shows live progress and final sizes.

### Paper metadata & citations

- **Automatic metadata**: on open, each paper is resolved via the arXiv API → DOI content negotiation (Crossref/DataCite) → AI extraction from the first pages. Title auto-fills, and the ⓘ popover shows authors, venue, year, DOI/arXiv links, and how the data was obtained.
- **BibTeX + slide citations**: one-click BibTeX copy, and an auto-generated minimal citation for slides (e.g. *Guo et al., Phys. Rev. Lett.* **122**, 193601 (2019)) that copies as rich text — pastes into PowerPoint with real italics and bold. Cached per paper; the generation prompt is editable.
- **Reference links**: select a citation in the PDF and link it to a paper (paste a DOI/arXiv id, or pick from your library — ranked by likelihood against the selected text). Links render as blue underlined regions; right-click to change or remove. Native PDF link annotations are clickable too: internal jumps within the document, and external links open directly in your library when the DOI/arXiv id matches a paper you already have.
- **Global Back**: following any link records where you were; the ← button beside Home (or Alt+←) unwinds jumps — across documents, restoring the exact scroll position. Right-click it to clear.

### Notes

- **Outliner block tree**: highlights and free notes are the same kind of block — nested, Logseq-style guide lines, Enter/Tab/Shift+Tab editing, Backspace-on-empty deletes.
- **Rich text**: markdown + KaTeX in view mode; one-click to edit with the cursor landing where you clicked.
- **Cross-note block references**: type `[[` to search and insert a reference chip that jumps to the target; backlinks are listed per page.
- **Drag-and-drop blocks** with a depth-snapping drop indicator and cycle prevention.
- **Click a highlight's card** to jump the PDF to it (and vice versa: click a PDF highlight to scroll to its note).
- **Attach mode**: link an orphaned note to an existing PDF highlight (⊕, then click the highlight).

### AI chat

- **ChatGPT-style panel**: multi-line input (Shift+Enter), copy any message, edit-and-resend your messages, find-in-chat (Ctrl+F while focused), and a stop button while the model responds.
- **Models**: mix Anthropic and OpenAI models in one switcher (`GAMMA_AI_MODELS`), with a reasoning-effort selector and three editable prompts (chat system, metadata extraction, slide citation).
- **Context**: by default the open paper's extracted text rides along; the **PDF** button sends the file itself (model sees figures & tables — on by default for a fresh chat, auto-off after sending so follow-ups stay cheap, with chips in the bubble showing which PDFs went). The **+** picker selects multiple papers and optionally your notes/highlights — ask for a cross-paper report right in the chat. Paste screenshots/figures directly into the input. Select text in the PDF (or click a highlight) to focus the next question on it.
- **Per-page history** stored on the backend, following you across devices.

### Library & search

- **File-browser home**: drag papers into folders (a paper's folder is just a property — storage stays flat, links and shares are unaffected); folders show counts, papers can be dragged back out; plus a Recent carousel and category tags with autocomplete.
- **Search everything** (Ctrl+F): notes, highlights, and the PDF's own text, with VSCode-style match-case / whole-word / regex toggles and replace-across-notes. PDF matches are highlighted on the page (keyword-only) with ▲▼ next/previous navigation.
- **Tabs**: Chrome-style — click to switch, middle-click to close, drag to reorder (animated), persisted per browser.

### Workspace

- **Dockable windows**: notes and chat live in a shared docking system — drag a window's grip to the left/right/bottom, resize with sashes, double-click the grip to collapse to a header bar.
- **PDF viewer**: fit-width or 20%-stepped zoom with an editable percentage, lazy page rendering, fast find-jumps, and scroll position preserved across zoom changes.
- **Automatic theme** following the OS light/dark preference; session persistence for the open page, layout, zoom, and scroll position.
- **Mobile**: touch-friendly drag handles; the viewer fits page width to the viewport.

### Sharing & accounts

- **Share links**: read-only public URL preserving PDF, highlights, links, and notes.
- **Multi-user**: per-user isolated databases and uploads, bcrypt session auth, daily-reset guest account, admin-managed via CLI.
- **Export**: account menu → "Export my data" downloads a zip with consistent SQLite snapshots plus all uploads; restore by unpacking into `users/<name>/`.
- **Settings** (account menu): open-access fallback, auto-metadata, save-external-PDFs-on-server, AI prompts.

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
- Paywalled papers can't be fetched server-side (publishers block it); Gamma substitutes an open-access copy when one exists, otherwise download in your browser and drop the file in.

## Future work

- Import/restore of the exported zip via the UI (export exists; restore is currently manual unpacking).
- Password change and account deletion via the app UI (currently CLI-only).
- Conflict resolution / multi-device sync.
- Collaboration between users (shared pages, cross-user block references).
- Decompose the frontend God component (`App.jsx`) into hooks and view components.

## License

MIT

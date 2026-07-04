# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gamma is a self-hosted, Logseq-inspired PDF annotation server: highlight PDFs in the browser, organize notes as nested outliner blocks, share read-only annotated copies via link. Multi-user with per-user isolated SQLite databases; app-level session auth (no external provider).

## Commands

### Backend (FastAPI, Python 3.11+)

```bash
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py setup                  # idempotent: creates guest account + missing per-user DBs
python manage.py create-user <name> <password>
uvicorn app:app --host 127.0.0.1 --port 9001 --reload
```

### Frontend (React + Vite)

```bash
cd logseq-v2-frontend
npm install
npm run dev      # dev server on :5173, proxies /api → 127.0.0.1:9001 (vite.config.js)
npm run build    # outputs to dist/
```

There is no test suite and no linter configured. Verify changes by running the app.

### Docker

```bash
docker build -t gamma .                 # multi-stage: builds frontend, serves it from FastAPI
docker run -p 9001:9001 -v gamma-data:/data ghcr.io/tim4431/gamma
```

## Architecture

Two deployable pieces; the Docker image bundles both (FastAPI serves the built frontend).

### Backend (`backend/`)

- All state is SQLite + files on disk under a data directory (env `GAMMA_DATA_DIR`, defaults to `backend/`):
  - `users.db` — global: accounts (bcrypt), session tokens, share tokens.
  - `users/<username>/pages.db` — the core data model: one `unified_blocks` table. Everything is a block (self-referential `parent_id`, fractional-index `position` strings like `a0`, `a0V` from the `fractional-indexing` package). Root-level blocks (parent `'root'`) are pages; a page with a `doc_id` property is a PDF page. Highlights are blocks with `highlight_id`/`pdf_position` in their JSON `properties` column; free notes are blocks without.
  - `users/<username>/data.db` — legacy `annotations` table + AI `chats` history.
  - `users/<username>/uploads/` — PDFs and images, filenames are content sha256[:24] (dedup).
- Auth: `session` cookie → middleware resolves `request.state.user`. Guest account data is wiped and re-seeded daily (checked lazily in the middleware). Share tokens allow unauthenticated read access — endpoints that support shared views resolve the user from `?user=` query param as fallback (`_resolve_user`), write endpoints require the session (`_require_user`). Keep that distinction when touching endpoints.
- Route order matters for `/api/blocks/*`: static-prefix routes (`by-doc`, `children`, `subtree`) must be registered before `/{block_id}`.
- AI chat (`/api/ai/chat`) speaks either the Anthropic Messages API or the OpenAI Chat Completions API, selected by `GAMMA_AI_PROVIDER` with `GAMMA_AI_API_KEY` / `GAMMA_AI_BASE_URL` / `GAMMA_AI_MODEL` (legacy `ANTHROPIC_*` names still work as fallbacks); it extracts PDF text with PyPDF2 (first 8000 chars) as context.
- `manage.py` — user CRUD CLI. Shares the guest welcome-page seeding with the app (`gamma/seed.py`).
- Package layout: `gamma/config.py` (env config), `gamma/db.py` (schemas/paths), `gamma/auth.py` (middleware), `gamma/seed.py` (user DB creation), `gamma/blocks_store.py` (tree CTE helpers), `gamma/storage.py` (uploads), `gamma/logseq_import.py` (EDN/MD parsers), `gamma/routers/*` (one module per API area), `gamma/app.py` (assembly + SPA serving).

### Frontend (`logseq-v2-frontend/`)

- `src/App.jsx` — nearly the whole app: routing (URL query params, no router lib), PDF viewer (react-pdf-highlighter), block tree editor, drag-and-drop (dnd-kit), autosave (500 ms debounce), login, AI chat panel.
- `src/logseqPdfModel.js` — pure block-tree operations (insert/indent/outdent/flatten/cycle-check).
- View modes are derived from the URL: `/` home, `/?page=<id>` page (with PDF if it has `source_url`), `/?share=<token>` public read-only, `/?block=<id>` jump-to-block.
- Frontend always talks same-origin `/api/*`; in dev Vite proxies to :9001.

### Data-model invariants

- Block positions are fractional-index strings; sibling order is lexicographic on `position`. Use `generate_key_between` — never invent position strings.
- `PUT /api/blocks/{id}/children` replaces the entire subtree (delete + reinsert); it and block deletion trigger orphan-upload cleanup (files no longer referenced by any block content/properties get deleted).
- Timestamps are UTC ISO strings with `Z` suffix (`page_now()`); clients parse them, keep the format.

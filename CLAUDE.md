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
cd frontend
npm install
npm run dev      # dev server on :5173, proxies /api → 127.0.0.1:9001 (vite.config.js)
npm run build    # outputs to dist/
```

### Tests (backend)

```bash
cd backend
pip install -r requirements-dev.txt   # pytest + httpx
python -m pytest tests -q
```

In-process API tests (FastAPI TestClient) against a throwaway data directory — no server, no network. Frontend has no test suite or linter; verify UI changes by running the app.

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
- AI chat (`/api/ai/chat`) speaks both the Anthropic Messages API and the OpenAI Chat Completions API — each provider configured via `GAMMA_AI_<PROVIDER>_API_KEY`/`_BASE_URL`, models registered via `GAMMA_AI_MODELS` as `provider:model` entries (first = default; legacy single-provider vars fill the `GAMMA_AI_PROVIDER` slot). Requests carry a model-registry id, optional `effort` (→ Anthropic `output_config.effort` / OpenAI `reasoning_effort`; omitted unless set — some models reject it), optional `system` override, pasted `images` (data URLs → native image content parts), and `pages`/`include_notes` for multi-paper context. `stream: true` (the chat UI's mode) returns NDJSON lines of `{"delta"}`/`{"error"}` parsed from the provider's SSE; upstream failures before the first byte still return normal HTTP errors. Context is PyPDF2-extracted text by default, or the PDF itself as a native document/file content part when the request sets `attach_pdf`. Reasoning models burn invisible tokens — keep `max_tokens` generous (empty responses raise with the finish reason). `/api/ai/models` feeds the chat panel's switchers and the prompt editor (three editable prompts: chat system, metadata extraction, PPT citation — defaults live in `ai.py`).
- Paper metadata (`gamma/routers/metadata.py`): `/api/metadata/fetch` resolves a page's paper via arXiv API → DOI content negotiation (doi.org, with glued-suffix DOI candidates) → AI extraction from the first pages; result + BibTeX cached on the page block (`properties.meta` / `properties.bibtex`). `/api/metadata/cite` turns the BibTeX into a PPT-style markdown citation via AI. No Google Scholar — it has no API and blocks scraping.
- PDF resolution (`/api/resolve-pdf`): arXiv abs→pdf rewrite → direct fetch → HTML pages inspected for the `citation_pdf_url` meta tag → Unpaywall open-access fallback for DOIs (prefers published > accepted > submitted version; disabled when the request sends `allow_oa: false`; needs `GAMMA_CONTACT_EMAIL`). Non-published substitutions return a `note` the frontend surfaces.
- `/api/import/pdf-annotations` converts annotations embedded in the PDF file (SumatraPDF/Acrobat highlights, notes) into highlight blocks — idempotent via `properties.imported_annot` keys; PyPDF2 dict access returns `IndirectObject`s, always `.get_object()` them.
- Endpoints doing slow work (downloads, AI calls, PyPDF2) are deliberately sync `def` — FastAPI runs them in its threadpool so they don't block the event loop. Don't convert them back to `async def` while they hold blocking calls.
- `manage.py` — user CRUD CLI. Shares the guest welcome-page seeding with the app (`gamma/seed.py`).
- Package layout: `gamma/config.py` (env config), `gamma/db.py` (schemas/paths), `gamma/auth.py` (middleware), `gamma/seed.py` (user DB creation), `gamma/blocks_store.py` (tree CTE helpers), `gamma/storage.py` (uploads), `gamma/logseq_import.py` (EDN/MD parsers), `gamma/routers/*` (one module per API area), `gamma/app.py` (assembly + SPA serving).

### Frontend (`frontend/`)

- `src/App.jsx` — still the main component (decomposition in progress): routing (URL query params, no router lib), block tree editor, dockable windows (react-resizable-panels v2 — v4 has an incompatible API), autosave (500 ms debounce), login, ChatGPT-style AI chat (copy/edit/find/stop, pasted images, per-message PDF attach), search, background-tasks popover.
- `src/pdfViewer.jsx` — the custom pdf.js viewer (`PdfViewer`/`PdfPage`/`PlainTip`, exports `COLORS`): lazy memoized pages, capped DPR, cancelable render tasks, highlight/link overlays, text search with keyword rects.
- `src/logseqPdfModel.js` — pure block-tree operations (insert/indent/outdent/flatten/cycle-check).
- View modes are derived from the URL: `/` home, `/?page=<id>` page (with PDF if it has `source_url`), `/?share=<token>` public read-only, `/?block=<id>` jump-to-block.
- Reference links: a highlight block with `properties.link_url` / `link_page_id` is a clickable link region on the PDF (blue underline); `link_highlight_id` additionally targets an exact highlight in that paper (created via a highlight's "Copy as reference point" context-menu item, then offered in link dialogs). Document links (native PDF annotations and manual ones) resolve against the library by DOI/arXiv id before offering fetch-vs-browser.
- Home library: folders are "folder labels" — `properties.folder` on a page block is a comma-separated list of paths (`"readout/nondestructive, cooling"`); `/` nests, a page can be in several folders (drag/add is a soft link, only an ancestor tag gets refined away), no tags = library root. The folder tree is derived from the paths in use (plus localStorage-only empties); rename/delete are prefix rewrites across pages. Standard labels stay in `properties.category` — the two are distinguished by property, never by string convention. The root view is a sortable (updated/created/title) recents feed of ALL pages, rendered incrementally (30 + IntersectionObserver load-more). Search chips (Tab autosuggest) cover both kinds: label chips match exactly, folder chips match by prefix.
- User preferences (OA fallback, auto-metadata, save-external-PDFs, prompts, model/effort) live in `localStorage`; provider keys/models are server-side env.
- Frontend always talks same-origin `/api/*`; in dev Vite proxies to :9001.

### Data-model invariants

- Block positions are fractional-index strings; sibling order is lexicographic on `position`. Use `generate_key_between` — never invent position strings.
- `PUT /api/blocks/{id}/children` replaces the entire subtree (delete + reinsert); it and block deletion trigger orphan-upload cleanup (files no longer referenced by any block content/properties get deleted).
- Timestamps are UTC ISO strings with `Z` suffix (`page_now()`); clients parse them, keep the format.

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
  - `users/<username>/data.db` — legacy `annotations` table + AI `chats` history + `prefs` (small JSON KV synced across browsers via `/api/prefs/{key}`, e.g. `open-tabs`). The reserved `ai-settings` prefs key holds the user's AI provider entries (a LIST of {id, name, protocol, api_key, base_url, models} managed via `POST/PUT/DELETE /api/ai/providers[/{id}]`) — the generic prefs endpoints refuse the key; the only read path is the masked `GET /api/ai/settings` (last-4 hint, never the key), guests can't write. There are NO env API keys; `ai_runtime(user)` in `gamma/ai_settings.py` builds the per-request config and model registry (ids are `<entryId>:<model>`; the wire format comes from the entry's `protocol`, never from the provider id) — AI endpoints must use it, not module-level config constants.
  - `users/<username>/uploads/` — PDFs and images, filenames are content sha256[:24] (dedup).
- Auth: `session` cookie → middleware resolves `request.state.user`. Guest account data is wiped and re-seeded daily (checked lazily in the middleware). Share tokens allow unauthenticated read access — endpoints that support shared views resolve the user from `?user=` query param as fallback (`_resolve_user`), write endpoints require the session (`_require_user`). Keep that distinction when touching endpoints.
- Route order matters for `/api/blocks/*`: static-prefix routes (`by-doc`, `children`, `subtree`) must be registered before `/{block_id}`.
- AI chat (`/api/ai/chat`) speaks both the Anthropic Messages API and the OpenAI Chat Completions API — providers are per-user GUI entries resolved through `ai_runtime(user)`; env vars only set each protocol's default base URL (`GAMMA_AI_ANTHROPIC_BASE_URL` / `GAMMA_AI_OPENAI_BASE_URL`). Requests carry a model-registry id, optional `effort` (→ Anthropic `output_config.effort` / OpenAI `reasoning_effort`; omitted unless set — some models reject it), optional `system` override, pasted `images` (data URLs → native image content parts), and `pages`/`include_notes` for multi-paper context. `stream: true` (the chat UI's mode) returns NDJSON lines of `{"delta"}`/`{"error"}` parsed from the provider's SSE; upstream failures before the first byte still return normal HTTP errors. Context is PyPDF2-extracted text by default, or the PDF itself as a native document/file content part when the request sets `attach_pdf`. Reasoning models burn invisible tokens — keep `max_tokens` generous (empty responses raise with the finish reason). `/api/ai/models` feeds the chat panel's switchers and the prompt editor (three editable prompts: chat system, metadata extraction, PPT citation — defaults live in `ai.py`).
- Paper metadata (`gamma/routers/metadata.py`): `/api/metadata/fetch` resolves a page's paper via arXiv API → DOI content negotiation (doi.org, with glued-suffix DOI candidates) → AI extraction from the first pages; result + BibTeX cached on the page block (`properties.meta` / `properties.bibtex`). `/api/metadata/cite` turns the BibTeX into a PPT-style markdown citation via AI. No Google Scholar — it has no API and blocks scraping.
- PDF resolution (`/api/resolve-pdf`): arXiv abs→pdf rewrite → direct fetch → HTML pages inspected for the `citation_pdf_url` meta tag → Unpaywall open-access fallback for DOIs (prefers published > accepted > submitted version; disabled when the request sends `allow_oa: false`; identifies itself with a fixed project email in `pdf.py` — no config). Non-published substitutions return a `note` the frontend surfaces.
- `/api/import/pdf-annotations` converts annotations embedded in the PDF file (SumatraPDF/Acrobat highlights, notes) into highlight blocks — idempotent via `properties.imported_annot` keys; PyPDF2 dict access returns `IndirectObject`s, always `.get_object()` them.
- Endpoints doing slow work (downloads, AI calls, PyPDF2) are deliberately sync `def` — FastAPI runs them in its threadpool so they don't block the event loop. Don't convert them back to `async def` while they hold blocking calls.
- Search: `/api/pdf-search` is an FTS5 index (per-user `data.db`) over PDF text extracted with pypdfium2 (PyPDF2 fallback), built lazily in a background thread (`/api/tasks` reports progress). Text and queries are both normalized through `gamma/textnorm.py` (ligatures, hyphenated line breaks, digit-group separators — "3000" finds "3,000-qubit"); bump `textnorm.INDEX_VERSION` when extraction/normalization changes and stale docs re-index lazily; `POST /api/search-reindex` (the Settings "Rebuild" button) forces a full rebuild. `/api/block-search` uses the same module's `fuzzy_pattern` and tags each hit with a `kind` (page/note/highlight/link). The index stores no positions — the frontend re-finds matches with pdf.js when a hit is opened, so highlight rects always agree with the rendered page. The same normalization rules are mirrored in `frontend/src/search.jsx` and `pdfViewer.jsx`; keep all three in sync.
- `manage.py` — user CRUD CLI (create-user, set-password, set-admin, rename-user, delete-user, list-users, reset-guest, setup).
- First-run admin: the APP seeds it, not launcher scripts — `seed.ensure_admin_seed()` runs at startup and creates an "admin" account with a RANDOM password printed once to the console (env-overridable via `GAMMA_ADMIN_USER`/`GAMMA_ADMIN_PASSWORD`) ONLY while zero non-guest accounts exist. Deliberately not keyed on "no admin exists": auto-adding an admin login to an upgraded multi-user instance would be a backdoor — those get a startup hint to run `manage.py set-admin`. Shares the guest welcome-page seeding with the app (`gamma/seed.py`). rename-user updates users/sessions/shares rows and moves the data dir — on Windows the move needs the server stopped (open SQLite handles lock the directory).
- User management GUI (`gamma/routers/admin.py`, `/api/admin/users*`): admins (users.is_admin flag — a privilege, not a name; `require_admin`) create/delete/rename accounts, set passwords, grant/revoke admin from the account popover. Rails: guest untouchable, no self-delete, the last admin can't be demoted or deleted. Rename moves the data dir FIRST (aborts clean on Windows file locks) then updates users/sessions/shares rows, so sessions survive — including a self-rename. The Docker `GAMMA_ADMIN_USER` bootstrap and `manage.py set-admin` seed the first admin; `connect_users_db()` lazily ALTERs old users.db to add the column.
- Package layout: `gamma/config.py` (env config), `gamma/db.py` (schemas/paths), `gamma/auth.py` (middleware), `gamma/seed.py` (user DB creation), `gamma/blocks_store.py` (tree CTE helpers), `gamma/storage.py` (uploads), `gamma/textnorm.py` (search normalization + fuzzy matching), `gamma/logseq_import.py` (EDN/MD parsers), `gamma/routers/*` (one module per API area), `gamma/app.py` (assembly + SPA serving).

### Frontend (`frontend/`)

- `src/App.jsx` — still the main component (decomposition in progress): routing (URL query params, no router lib), block tree editor, dockable windows (react-resizable-panels v2 — v4 has an incompatible API), autosave (500 ms debounce), login, ChatGPT-style AI chat (copy/edit/find/stop, pasted images, per-message PDF attach), background-tasks popover.
- `src/search.jsx` — the whole workspace search (Ctrl+F): `SearchPanel` popover with label-filter chips, VSCode-style toggles, replace-in-notes, and results grouped titles → this paper's notes → this PDF (highlighted, navigable matches) → other notes → reference links → library-wide PDF content. `buildSearchRegex` mirrors the backend's fuzzy rules. Opening a library hit "pins" the search: after the paper renders (App bumps `docNonce`), the query is re-found via pdf.js and the match is highlighted and scrolled to. App only holds the glue: `findMarks` state for the viewer and the `pdfSearchRef` hook.
- `src/pdfViewer.jsx` — the custom pdf.js viewer (`PdfViewer`/`PdfPage`/`PlainTip`, exports `COLORS`): lazy memoized pages, capped DPR, cancelable render tasks, highlight/link overlays. Its `searchRef` searches each page's runs joined into one normalized string (same rules as `gamma/textnorm.py`) with a char-level map back to per-run rects, so matches span runs/line breaks and rects are exact.
- `src/logseqPdfModel.js` — pure block-tree operations (insert/indent/outdent/flatten/cycle-check).
- View modes are derived from the URL: `/` home, `/?page=<id>` page (with PDF if it has `source_url`), `/?share=<token>` public read-only, `/?block=<id>` jump-to-block.
- Reference links: a highlight block with `properties.link_url` / `link_page_id` is a clickable link region on the PDF (blue underline); `link_highlight_id` additionally targets an exact highlight in that paper (created via a highlight's "Copy as reference point" context-menu item, then offered in link dialogs). Document links (native PDF annotations and manual ones) resolve against the library by DOI/arXiv id before offering fetch-vs-browser.
- Home library: folders are "folder labels" — `properties.folder` on a page block is a comma-separated list of paths (`"readout/nondestructive, cooling"`); `/` nests, a page can be in several folders (drag/add is a soft link, only an ancestor tag gets refined away), no tags = library root. The folder tree is derived from the paths in use (plus localStorage-only empties); rename/delete are prefix rewrites across pages. Standard labels stay in `properties.category` — the two are distinguished by property, never by string convention. The root view is a sortable (updated/created/title) recents feed of ALL pages, rendered incrementally (30 + IntersectionObserver load-more). Search chips (Tab autosuggest) cover both kinds: label chips match exactly, folder chips match by prefix.
- User preferences (OA fallback, auto-metadata, save-external-PDFs, prompts, model/effort) live in `localStorage`. Open tabs additionally sync through `/api/prefs/open-tabs` (server wins on load/focus, local edits debounce-push; localStorage is just the instant-paint cache). AI providers are per-user entries managed via Settings → "AI providers & keys…" (OpenAI-platform-style add/edit/remove list; keys masked, never echoed back); env vars only supply per-protocol base-URL defaults.
- Frontend always talks same-origin `/api/*`; in dev Vite proxies to :9001.

### Data-model invariants

- Block positions are fractional-index strings; sibling order is lexicographic on `position`. Use `generate_key_between` — never invent position strings.
- `PUT /api/blocks/{id}/children` replaces the entire subtree (delete + reinsert); it and block deletion trigger orphan-upload cleanup (files no longer referenced by any block content/properties get deleted).
- Timestamps are UTC ISO strings with `Z` suffix (`page_now()`); clients parse them, keep the format.

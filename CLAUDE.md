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
  - `users/<username>/data.db` — legacy `annotations` table + AI `chats` history + `prefs` (small JSON KV synced across browsers via `/api/prefs/{key}`, e.g. `open-tabs`). The reserved `ai-settings` prefs key holds the user's AI provider entries (a LIST of {id, name, protocol, api_key, base_url, models} managed via `POST/PUT/DELETE /api/ai/providers[/{id}]`) — the generic prefs endpoints refuse the key; the only read path is the masked `GET /api/ai/settings` (last-4 hint, never the key), guests can't write. A third protocol, `chatgpt`, holds OAuth tokens instead of a key (Codex CLI's PKCE flow in `gamma/chatgpt_oauth.py`; entries created only via `POST /api/ai/oauth/chatgpt/start`+`complete` — the user pastes the localhost:1455 callback URL since nothing listens there; access tokens refresh lazily in `ai_runtime`). Its wire is the Responses API on `chatgpt.com/backend-api/codex` (stream-only SSE; non-stream callers join deltas), and PDF attachments go as native `input_file` parts with an automatic retry as extracted text if the backend rejects them. There are NO env API keys; `ai_runtime(user)` in `gamma/ai_settings.py` builds the per-request config and model registry (ids are `<entryId>:<model>`; the wire format comes from the entry's `protocol`, never from the provider id) — AI endpoints must use it, not module-level config constants.
  - `users/<username>/uploads/` — PDFs and images, filenames are content sha256[:24] (dedup).
- Auth: `session` cookie → middleware resolves `request.state.user`. Guest account data is wiped and re-seeded daily (checked lazily in the middleware). Share tokens allow unauthenticated read access — endpoints that support shared views resolve the user from `?user=` query param as fallback (`_resolve_user`), write endpoints require the session (`_require_user`). Keep that distinction when touching endpoints.
- Tab session guard: the `session` cookie is browser-wide, so signing in from a second tab silently repoints every other tab's writes at the new account. Each tab declares its identity with an `X-Gamma-User` header (injected by a `window.fetch` wrapper in `frontend/src/utils.js`, so every call site is covered); the middleware answers `409` + `X-Gamma-Session-User` on mismatch and the frontend shows `SessionConflictPage`. Requests without the header (share views, pdf.js range requests) are unaffected — don't make the header mandatory. Auth endpoints are exempt by design.
- Request logging: `session_middleware` stamps `request.state.request_id` and echoes it as `X-Gamma-Request-ID`. Uvicorn already logs every access, so `_finish_request_log` prints a `[http]` line only for failures, auth operations, and requests over 2 s; the frontend mirrors the same rule into the Settings → Diagnostics log.
- Route order matters for `/api/blocks/*`: static-prefix routes (`by-doc`, `children`, `subtree`) must be registered before `/{block_id}`.
- AI chat (`/api/ai/chat`) speaks both the Anthropic Messages API and the OpenAI Chat Completions API — providers are per-user GUI entries resolved through `ai_runtime(user)`; env vars only set each protocol's default base URL (`GAMMA_AI_ANTHROPIC_BASE_URL` / `GAMMA_AI_OPENAI_BASE_URL`). Requests carry a model-registry id, optional `effort` (→ Anthropic `output_config.effort` / OpenAI `reasoning_effort`; omitted unless set — some models reject it), optional `system` override, pasted `images` (data URLs → native image content parts), and `pages`/`include_notes` for multi-paper context. `stream: true` (the chat UI's mode) returns NDJSON lines of `{"delta"}`/`{"error"}` parsed from the provider's SSE; upstream failures before the first byte still return normal HTTP errors. Context is PyPDF2-extracted text by default, or the PDF itself as a native document/file content part when the request sets `attach_pdf`. Reasoning models burn invisible tokens — keep `max_tokens` generous (empty responses raise with the finish reason). `/api/ai/models` feeds the chat panel's switchers and the prompt editor (three editable prompts: chat system, metadata extraction, PPT citation — defaults live in `ai.py`).
- Paper metadata (`gamma/routers/metadata.py`): `/api/metadata/fetch` resolves a page's paper via arXiv API → DOI content negotiation (doi.org, with glued-suffix DOI candidates) → AI extraction from the first pages; result + BibTeX cached on the page block (`properties.meta` / `properties.bibtex`). `/api/metadata/update` saves hand-edited fields from the metadata popover (rebuilds BibTeX, source `manual`, invalidates the cached citation). `/api/metadata/cite` turns the BibTeX into a PPT-style markdown citation via AI. No Google Scholar — it has no API and blocks scraping.
- PDF resolution (`/api/resolve-pdf`): arXiv abs→pdf rewrite → direct fetch → HTML pages inspected for the `citation_pdf_url` meta tag → Unpaywall open-access fallback for DOIs (prefers published > accepted > submitted version; disabled when the request sends `allow_oa: false`; identifies itself with a fixed project email in `pdf.py` — no config). Non-published substitutions return a `note` the frontend surfaces.
- `/api/import/pdf-annotations` converts annotations embedded in the PDF file (SumatraPDF/Acrobat highlights, notes) into highlight blocks — idempotent via `properties.imported_annot` keys; PyPDF2 dict access returns `IndirectObject`s, always `.get_object()` them.
- Endpoints doing slow work (downloads, AI calls, PyPDF2) are deliberately sync `def` — FastAPI runs them in its threadpool so they don't block the event loop. Don't convert them back to `async def` while they hold blocking calls.
- Search: `/api/pdf-search` is an FTS5 index (per-user `data.db`) over PDF text extracted with pypdfium2 (PyPDF2 fallback), built lazily in a background thread (`/api/tasks` reports progress). Text and queries are both normalized through `gamma/textnorm.py` (ligatures, hyphenated line breaks, digit-group separators — "3000" finds "3,000-qubit"); bump `textnorm.INDEX_VERSION` when extraction/normalization changes and stale docs re-index lazily; `POST /api/search-reindex` (the Settings "Rebuild" button) forces a full rebuild. `/api/block-search` uses the same module's `fuzzy_pattern` and tags each hit with a `kind` (page/note/highlight/link). The index stores no positions — the frontend re-finds matches with pdf.js when a hit is opened, so highlight rects always agree with the rendered page. The same normalization rules are mirrored in `frontend/src/search.jsx` and `pdfViewer.jsx`; keep all three in sync.
- `manage.py` — user CRUD CLI (create-user, set-password, set-admin, rename-user, delete-user, list-users, reset-guest, setup).
- First-run admin: the APP seeds it, not launcher scripts — `seed.ensure_admin_seed()` runs at startup and creates an "admin" account with a RANDOM password printed once to the console (env-overridable via `GAMMA_ADMIN_USER`/`GAMMA_ADMIN_PASSWORD`) ONLY while zero non-guest accounts exist. Deliberately not keyed on "no admin exists": auto-adding an admin login to an upgraded multi-user instance would be a backdoor — those get a startup hint to run `manage.py set-admin`. Shares the guest welcome-page seeding with the app (`gamma/seed.py`). rename-user updates users/sessions/shares rows and moves the data dir — on Windows the move needs the server stopped (open SQLite handles lock the directory).
- User management GUI (`gamma/routers/admin.py`, `/api/admin/users*`): admins (users.is_admin flag — a privilege, not a name; `require_admin`) create/delete/rename accounts, set passwords, grant/revoke admin from the account popover. Rails: guest untouchable, no self-delete, the last admin can't be demoted or deleted. Rename moves the data dir FIRST (aborts clean on Windows file locks) then updates users/sessions/shares rows, so sessions survive — including a self-rename. The Docker `GAMMA_ADMIN_USER` bootstrap and `manage.py set-admin` seed the first admin; `connect_users_db()` lazily ALTERs old users.db to add the column.
- Package layout: `gamma/config.py` (env config), `gamma/db.py` (schemas/paths), `gamma/auth.py` (middleware), `gamma/seed.py` (user DB creation), `gamma/blocks_store.py` (tree CTE helpers), `gamma/storage.py` (uploads), `gamma/textnorm.py` (search normalization + fuzzy matching), `gamma/logseq_import.py` (EDN/MD parsers), `gamma/ai_client.py` (provider wire protocols), `gamma/ai_context.py` (PDF/chat context assembly), `gamma/routers/*` (one module per API area, including separate AI orchestration and chat-history routers), `gamma/app.py` (assembly + SPA serving).

### Frontend (`frontend/`)

- `src/App.jsx` — still the main component (decomposition in progress): routing (URL query params, no router lib), block tree editor, dockable windows (react-resizable-panels v2 — v4 has an incompatible API), autosave (500 ms debounce), ChatGPT-style AI chat (copy/edit/find/stop, pasted images, per-message PDF attach), background-tasks popover. It owns the state and handlers; the Settings and login *views* live elsewhere (below) and receive them as grouped prop objects.
- `src/settings.jsx` — the whole Settings modal (`SettingsDialog` + one pane component per section: papers, AI providers, prompts, context limits, search, diagnostics). App passes one object per pane. The AI pane's `ProviderForm` holds the ChatGPT OAuth flow's UI; the handler (`startChatGPTAuth`) stays in App.jsx because the popup watcher outlives the modal.
- `src/LoginPage.jsx` — `LoginPage`, `AuthLoading`, and `SessionConflictPage` (shown when this tab's identity no longer matches the browser session — see the session guard below).
- `src/libraryUtils.js` — pure helpers for the home library (folder-path parsing, sorting, label matching).
- CSS is split by area: `app.css` (shell, viewer, chat, blocks), `library.css` (home/file browser), `settings.css` (settings modal).
- `src/search.jsx` — the whole workspace search (Ctrl+F): `SearchPanel` popover with label-filter chips, VSCode-style toggles, and results grouped titles → this paper's notes → this PDF (highlighted, navigable matches) → other notes → reference links → library-wide PDF content. The detail lists collapse behind the left chevron into a compact browser-style find bar (match counter + nav only); the default state is a Settings → Search preference (`gamma-search-details` in localStorage). No replace UI (the `/api/blocks-replace` endpoint still exists, unused by the frontend). `buildSearchRegex` mirrors the backend's fuzzy rules. Opening a library hit "pins" the search: after the paper renders (App bumps `docNonce`), the query is re-found via pdf.js and the match is highlighted and scrolled to. App only holds the glue: `findMarks` state for the viewer and the `pdfSearchRef` hook.
- `src/pdfViewer.jsx` — the custom pdf.js viewer (`PdfViewer`/`PdfPage`/`PlainTip`, exports `COLORS`): lazy memoized pages, capped DPR, cancelable render tasks, highlight/link overlays. Zoom (toolbar buttons and Ctrl/Cmd+scroll, which is also what a trackpad pinch reports) goes through one clamp — `clampZoom`, exported and used by App too. Position is preserved across scale changes by a `useLayoutEffect` that re-places a single anchor point (mouse position for Ctrl+scroll, viewport centre otherwise) using `lastScrollRef`/`lastScrollLeftRef`, the values from the last *scroll event*: by the time the effect runs the browser may already have clamped a live `scrollTop` read to the new, smaller scroll range. `overflow-anchor: none` on the scroller keeps the browser's own scroll anchoring from fighting those writes. Document swaps take the `docSwapPendingRef` branch and anchor at viewport top, matching how the host computed the restored `scrollTop` pre-paint. Its `searchRef` searches each page's runs joined into one normalized string (same rules as `gamma/textnorm.py`) with a char-level map back to per-run rects, so matches span runs/line breaks and rects are exact.
- `src/logseqPdfModel.js` — pure block-tree operations (insert/indent/outdent/flatten/cycle-check).
- View modes are derived from the URL: `/` home, `/?page=<id>` page (with PDF if it has `source_url`), `/?share=<token>` public read-only, `/?block=<id>` jump-to-block.
- Reference links: a highlight block with `properties.link_url` / `link_page_id` is a clickable link region on the PDF (blue underline); `link_highlight_id` additionally targets an exact highlight in that paper (created via a highlight's "Copy as reference point" context-menu item, then offered in link dialogs). Document links (native PDF annotations and manual ones) resolve against the library by DOI/arXiv id before offering fetch-vs-browser.
- Home library: folders are "folder labels" — `properties.folder` on a page block is a comma-separated list of paths (`"readout/nondestructive, cooling"`); `/` nests, a page can be in several folders (drag/add is a soft link, only an ancestor tag gets refined away), no tags = library root. The folder tree is derived from the paths in use (plus localStorage-only empties); rename/delete are prefix rewrites across pages. Standard labels stay in `properties.category` — the two are distinguished by property, never by string convention. The root view is a sortable (updated/created/title) recents feed of ALL pages, rendered incrementally (30 + IntersectionObserver load-more). Search chips (Tab autosuggest) cover both kinds: label chips match exactly, folder chips match by prefix.
- User preferences (OA fallback, auto-metadata, save-external-PDFs, prompts, model/effort) live in `localStorage`. Open tabs additionally sync through `/api/prefs/open-tabs` (server wins on load/focus, local edits debounce-push; localStorage is just the instant-paint cache). AI providers are per-user entries managed via Settings → "AI providers & keys…" (OpenAI-platform-style add/edit/remove list; keys masked, never echoed back); env vars only supply per-protocol base-URL defaults.
- Reading positions: `tabScrollRef` (block id → `{top, scale, notesTop}`) persists to `localStorage` under `gamma-tab-scroll`, capped at 200 entries. It is loaded **synchronously in the ref initializer** — gating it on `authUser` loses the race against the mount-time session restore, which is why earlier attempts silently did nothing. Capture is driven by `leaveCurrentPage` plus `beforeunload`/`pagehide`/`visibilitychange→hidden` (via a ref to the latest closure), never a live scroll listener: a listener also records the swap-clamped scrolls a document change fires, which corrupts the outgoing tab's entry. `restorePdfScroll` re-asserts the anchor until `scrollHeight` and the effective scale stop moving, and only then un-gates capture.
- Enter handling: use `isEnterCommit(e)` from `utils.js` rather than `e.key === "Enter"` anywhere Enter commits an action. It excludes IME composition commits (Pinyin, Kotoeri, …), which otherwise submit a half-typed candidate.
- Frontend always talks same-origin `/api/*`; in dev Vite proxies to :9001.

### Data-model invariants

- Block positions are fractional-index strings; sibling order is lexicographic on `position`. Use `generate_key_between` — never invent position strings.
- `PUT /api/blocks/{id}/children` replaces the entire subtree (delete + reinsert); it and block deletion trigger orphan-upload cleanup (files no longer referenced by any block content/properties get deleted).
- Timestamps are UTC ISO strings with `Z` suffix (`page_now()`); clients parse them, keep the format.

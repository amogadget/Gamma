# Running, testing & debugging

## Run it

Backend (FastAPI, Python 3.11+):

```bash
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py setup          # idempotent: guest account + missing workspace files
uvicorn app:app --host 127.0.0.1 --port 9001 --reload
```

Frontend (React + Vite):

```bash
cd frontend
npm install
npm run dev     # :5173, proxies /api → 127.0.0.1:9001
npm run build   # outputs dist/ (FastAPI serves it in the Docker image)
```

First run: the app seeds an `admin` account with a random password printed
once to the console (only while zero non-guest accounts exist). User CRUD
also via `python manage.py` (create-user, set-password, set-admin,
rename-user, delete-user, list-users, list-workspaces, set-member,
reset-guest, migrate, backups).

Docker:

```bash
docker build -t gamma .
docker run -p 9001:9001 -v gamma-data:/data ghcr.io/tim4431/gamma
```

## Tests

```bash
cd backend
pip install -r requirements-dev.txt   # pytest, pytest-xdist, httpx
python -m pytest tests -q -n auto --dist loadfile   # parallel, ~15 s
python -m pytest tests -q                           # serial, ~50 s (simpler tracebacks)
```

In-process API tests (FastAPI TestClient) against a throwaway data
directory — no server, no network: an autouse fixture in `conftest.py`
refuses every non-loopback socket connect and DNS lookup, so a test that
forgets to stub a metadata / PDF / AI fetch fails at once instead of
passing slowly on the network. `pytest.ini` names `tests/`, so a bare
`pytest` from `backend/` works too. The suite runs in parallel with
pytest-xdist: every worker process imports `conftest.py` and so gets its own
throwaway data directory, and `--dist loadfile` keeps each file's tests on
one worker in file order (tests inside a file may build on each other;
files never may). The shared `client` fixture carries the cookie of the last
login on that worker, so a "not signed in" check uses the `anon` fixture (a
fresh client), never `client`. Run them with the project venv's
interpreter (`venv/Scripts/python.exe` on Windows): the two vector-math
tests need `ziamath` from `requirements.txt`, and a system/conda `python`
without it fails them with "ziamath is not importable" rather than a
puzzling path count.

The AI agent's tests are split by area — `test_ai_tools_registry.py`
(scopes, permissions, the system prompt), `test_ai_tools_pages.py`,
`test_ai_tools_blocks.py`, `test_ai_tools_search.py` (the executors),
`test_ai_wire.py` (provider wire formats, SSE parsing, history replay; pure)
and `test_ai_agent_loop.py` (`/api/ai/chat` with a faked provider) — over the
fixtures in `tests/ai_fixtures.py`. Its `org` fixture creates one account
per test module (the module's name is in the username), so the files never
see each other's pages or provider entries.

Rules the frontend mirrors — search normalization (`gamma/textnorm.py` ↔
`frontend/src/textnorm.js`) and folder-label paths (`gamma/foldertags.py` ↔
`frontend/src/libraryUtils.js`) — are pinned by ONE set of cases both sides
read: `tests/shared/*.json` at the repository root, run by
`backend/tests/test_shared_fixtures.py` and the matching node tests. Add a
case there when a rule changes; whichever side drifts fails.

The frontend has **no linter** and no component tests. Its pure modules have
`node --test` tests (`npm test` from `frontend/`, the files in
`frontend/tests/*.test.mjs`): `blockOps` (diff/apply), `collabSession` (the
page session's transport logic over fakes — ordering, reconciliation,
retries, presence, the caret throttle), `sessionState`, `settings`
(navigation, presets), `textnorm` and `libraryUtils` (the shared cases
above), `mdMarks` (the formatting hotkeys' toggle), `logseqPdfModel` (tree
ops), `blockHistory` (the undo classifier) and `menuAim` (the safe-triangle
geometry). A module is testable there when its relative imports carry the
`.js` extension (node resolves nothing else); modules that import React can
still be imported for their pure exports. Actual React rendering and
interactions are exercised by the browser suite below.

### Browser end-to-end suite

```bash
cd frontend
npm run build                   # the suite drives frontend/dist
npm run e2e                     # ~30 s; exit 1 on any failure
npm run e2e -- --only collab    # steps whose name contains "collab"
npm run e2e -- --continue       # keep going after a failure
npm run e2e -- --headed         # watch the browser
npm run e2e -- --keep           # keep the temp data dir + server.log
```

`frontend/tests/e2e/run.mjs` starts an ISOLATED backend (the project venv's
python — or the interpreter `GAMMA_E2E_PYTHON` names — over a fresh
`GAMMA_DATA_DIR` under the OS temp dir, on a free port, serving
`frontend/dist`), creates the accounts `alice` / `bob`, and drives Playwright's
Chromium (`playwright` is a devDependency; the browser is downloaded once on
first launch). A failed step saves a screenshot of every open page plus the
pages' recorded problems and the server log's tail under the temp dir's
`failures/`, and the temp dir is kept (the summary prints its path). The
`check` workflow runs the suite on every PR and uploads those folders as the
`e2e-failures` artifact. `harness.mjs` holds the server lifecycle, `Account` (session
cookie + `X-Gamma-Workspace` for API seeding, browser contexts logged in as
that account), `makePdf` (a small real PDF with a text layer), and `step()`.
The scenarios live in `tests/e2e/scenarios/`:

- `notes.mjs`: New page → title → first block (the seed-block insert),
  Shift+Enter / Tab / Shift+Tab / Backspace, Enter as a line break vs the
  Enter-as-new-block preference, Ctrl+Z, the handle menu, todo checkboxes,
  an uploaded image (its URL must carry the workspace), the workspace
  switcher. Runs in a NON-default workspace on purpose.
- `pdf.mjs`: upload + page by attachment, the viewer's text layer, a
  highlight from a text selection (overlay, quote row, persisted position),
  the find bar hitting page 2, the library card.
- `ink.mjs`: handwriting — the tool strip and its presets (options row,
  duplicate, remove, persistence), two mouse strokes becoming an
  ink block with an `.ink` upload, persistence across a reload, the eraser
  (by its key), stroke undo/redo, the partial eraser cutting a stroke, a
  lasso move + delete, the notes card's jump + outline, `/Ink` in the
  exported PDF.
- `pdfload.mjs`: PDF loading, in a non-default workspace — the timing probe
  (a 300-page, 20 MB document opened cold at an emulated 20 Mbps, the
  IndexedDB backfill, a warm reopen, a same-tab return; reports the per-phase
  `performance.mark("pdf-<phase>")` stamps and the bytes on the wire as each
  step's note, asserts only that it paints), then the behaviours: page boxes
  from the manifest (a landscape page below the fold), the last-read page
  after a reload, two large documents through the parsed-document cache, the
  anonymous share view by ranges ([pdf_loading.md](pdf_loading.md)).
  `npm run e2e -- --only "pdf load"`.
- `files.mjs`: files dropped on a block row / the page body become file
  chips (a `dropFiles` helper builds a real DataTransfer; the paste step
  builds a `ClipboardEvent` in the page, since Playwright's `dispatchEvent`
  cannot), a PDF chip's right-click "Add to library" makes the document page
  in the project's folder and the chip gets an open-page button, a markdown
  chip's "Add to library" imports a note page and leaves the file untouched,
  the upload endpoint's lab-file / executable rule.
- `collab.mjs`: two accounts in a shared workspace: presence, live ops, edits
  to different blocks, same-block last-writer-wins, undo after a remote edit,
  rename propagation, edits made offline replaying, remote delete, a
  highlight made by the other person.
- `run.mjs`: login, guest access, and refusing an inaccessible explicit
  workspace without opening a different library.
- `share.mjs`: the share dialog, the anonymous share view (PDF, highlight,
  image through the share token, no editor), an edit share.

Every step also asserts that no API call failed (4xx/5xx), no console error
and no page error happened meanwhile (`openPage` records them;
`EXPECTED_FAILURES` in the harness lists designed refusals such as the
metadata fetch's 404 for a PDF without identifiers). Wait for the state a
step needs with `until()` / `waitForFunction` / `waitForEvent`, never a fixed
`sleep` — the one left (the view-only share's "no editor opens") is a
negative check with nothing to wait for. New UI work touching the
save path, workspaces, auth or rendering of URLs should add a step here; the
`/verify` skill runs this suite.

## Debugging surfaces

- **Server log** — Settings → Server → "Server log" (admin only): the
  in-memory ring buffer behind `GET /api/admin/logs`. Backend code must log
  through `gamma/logbuf.py`'s `log` (never `print()`); secrets are masked at
  insert time. Gone on restart.
- **Session log + debug tracing** — Settings → Advanced: browser-side event
  log; the "Debug logging" toggle traces reading-position/restore/sync
  events into it and the console. Every PDF load phase lands here as
  `pdf <phase> +<ms>` (ms since the viewer started opening that url) and as
  a `performance.mark("pdf-<phase>")` for devtools' Performance panel — the
  phases and what a healthy open looks like: [pdf_loading.md](pdf_loading.md).
- **Background tasks** — the tasks popover (`GET /api/tasks`) shows indexing
  and download progress. The client polls it every 2 s only while the popover
  is open or indexing is known to run; otherwise a 60 s heartbeat, and
  nothing at all while the tab is hidden (one refresh when it comes back).
  Anything that starts indexing (the search panel's library query, the
  Settings reindex buttons) calls `wakeTasks` so the button appears at once
  instead of waiting for the heartbeat. Work started elsewhere (the AI chat's
  own extraction, another tab) shows up within the heartbeat.
- **Status bar** — Settings → Advanced turns the floating status pill into a
  persistent bar under the tabs.
- **Library health** — Settings → Library maintenance lists, per paper:
  metadata state, extracted-text chars, and search-index coverage, with
  per-row retry/reindex buttons plus batch actions: Fetch needed / Refetch
  all for metadata, and Reindex needed (only papers the index is missing,
  holds stale, or hasn't visited — a targeted `/api/search-reindex` with
  `doc_ids`, unlike the Index section's full Rebuild).

## Gotchas worth knowing

- The guest account's data is wiped and re-seeded daily (lazily, in the auth
  middleware) — don't park test data there.
- Slow endpoints (downloads, AI calls, PyPDF2) are deliberately **sync
  `def`** so FastAPI's threadpool runs them; don't convert them to
  `async def` while they hold blocking calls.
- All state is SQLite + files under the data dir (`GAMMA_DATA_DIR`, default
  the repo's `data/`): global `users.db` (accounts, workspaces, memberships,
  shares, personal prefs), per-workspace `workspaces/<id>/pages.db`,
  `data.db`, `uploads/`. Safe to inspect with any SQLite client while the
  server runs; on Windows, open handles lock the directory (matters for the
  migration's moves — stop the server before `manage.py migrate`).
- The server upgrades the data directory at startup (`gamma/migrations.py`,
  snapshot first, log line `[migrate]`) and refuses to start on a directory
  written by a newer Gamma — [migrations.md](migrations.md). `python
  manage.py migrate --status` says where a directory stands.
- Every API call names its workspace (`X-Gamma-Workspace` header from the
  fetch wrapper, `?ws=` on the websocket and in URLs); a 403 "not a member"
  on an otherwise fine request means the tab's workspace is not the one you
  expect — the id is in the URL.
- Timestamps are UTC ISO strings with `Z` (`page_now()`); keep the format.

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
pip install -r requirements-dev.txt   # pytest + httpx
python -m pytest tests -q
```

In-process API tests (FastAPI TestClient) against a throwaway data
directory — no server, no network. Run them with the project venv's
interpreter (`venv/Scripts/python.exe` on Windows): the two vector-math
tests need `ziamath` from `requirements.txt`, and a system/conda `python`
without it fails them with "ziamath is not importable" rather than a
puzzling path count. The frontend has **no linter**. `npm test` from
`frontend/` runs the block-operation tests, session-storage isolation tests,
and collaboration transport tests with a stubbed React layer. Actual React
rendering and interactions are exercised by the browser suite below.

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
python, a fresh `GAMMA_DATA_DIR` under the OS temp dir, a free port, serving
`frontend/dist`), creates the accounts `alice` / `bob`, and drives Playwright's
Chromium (`playwright` is a devDependency; the browser is downloaded once on
first launch). `harness.mjs` holds the server lifecycle, `Account` (session
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
metadata fetch's 404 for a PDF without identifiers). New UI work touching the
save path, workspaces, auth or rendering of URLs should add a step here; the
`/verify` skill runs this suite.

## Debugging surfaces

- **Server log** — Settings → Server → "Server log" (admin only): the
  in-memory ring buffer behind `GET /api/admin/logs`. Backend code must log
  through `gamma/logbuf.py`'s `log` (never `print()`); secrets are masked at
  insert time. Gone on restart.
- **Session log + debug tracing** — Settings → Advanced: browser-side event
  log; the "Debug logging" toggle traces reading-position/restore/sync
  events into it and the console.
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
- **Library health** — Settings → Library lists, per paper: metadata state,
  extracted-text chars, and search-index coverage, with retry/reindex
  buttons.

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

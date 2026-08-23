# Running, testing & debugging

## Run it

Backend (FastAPI, Python 3.11+):

```bash
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py setup          # idempotent: guest account + missing per-user DBs
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
rename-user, delete-user, list-users, reset-guest).

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
directory — no server, no network. The frontend has **no test suite or
linter**: verify UI changes by running the app (at minimum, `npm run build`
must pass).

## Debugging surfaces

- **Server log** — Settings → Advanced → "Server log" (admin only): the
  in-memory ring buffer behind `GET /api/admin/logs`. Backend code must log
  through `gamma/logbuf.py`'s `log` (never `print()`); secrets are masked at
  insert time. Gone on restart.
- **Session log + debug tracing** — Settings → Advanced: browser-side event
  log; the "Debug logging" toggle traces reading-position/restore/sync
  events into it and the console.
- **Background tasks** — the tasks popover (`GET /api/tasks`) shows indexing
  and download progress.
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
  `backend/`): global `users.db`, per-user `users/<name>/pages.db`,
  `data.db`, `uploads/`. Safe to inspect with any SQLite client while the
  server runs; on Windows, open handles lock the directory (matters for
  renames/moves).
- Timestamps are UTC ISO strings with `Z` (`page_now()`); keep the format.

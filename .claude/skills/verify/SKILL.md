---
name: verify
description: Build, launch, and drive Gamma end-to-end in an isolated environment to verify a change at the real UI.
---

# Verifying Gamma changes end-to-end

Isolated full-stack launch + Playwright drive, without touching the real data
in `backend/users/`.

## Build & launch (isolated)

```bash
# frontend build (node is fnm-managed, not on tool-shell PATH)
export PATH="$HOME/AppData/Roaming/fnm/aliases/default:$PATH"
cd frontend && npm run build

# throwaway data dir + guest account
cd ../backend
GAMMA_DATA_DIR=<scratch>/data venv/Scripts/python.exe manage.py setup

# backend serves the built SPA itself — no vite dev server needed
GAMMA_DATA_DIR=<scratch>/data GAMMA_STATIC_DIR=/d/Codes/Github/gamma/frontend/dist \
  venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 9002   # background
```

Port 9002 avoids colliding with the user's real instance on 9001.
`GAMMA_STATIC_DIR` accepts a Git-Bash-style path.

## Seed data via API (curl + cookie jar)

```bash
curl -s -c $JAR -X POST :9002/api/login-guest
curl -s -b $JAR -F "file=@<some>.pdf;type=application/pdf" :9002/api/uploads   # → doc_id
curl -s -b $JAR -X POST :9002/api/blocks/by-doc/<doc_id> -H "Content-Type: application/json" \
  -d '{"default_title": "…", "source_url": "/api/uploads/<doc_id>.pdf"}'      # → PDF page
```

Real PDFs to upload live in `backend/users/admin/uploads/` (read-only use).

## Drive the UI

Playwright is available via `npx playwright` (chromium cached in
`%LOCALAPPDATA%/ms-playwright`). `npm i playwright` in a scratch dir, then a
node script: create a context, inject the `session` cookie from the curl jar
(`{name: 'session', value, url: 'http://127.0.0.1:9002'}`), goto `/`,
keyboard/click/screenshot.

Gotchas:
- Search popover: Ctrl+F opens it; the input keeps its previous query —
  Ctrl+A before typing a new one.
- PDF render takes a few seconds after opening a page; wait ~5 s before
  screenshotting highlights.
- Windows GBK console: pipe extracted PDF text through
  `PYTHONIOENCODING=utf-8` or ascii-encode before printing.

Kill the uvicorn task when done.

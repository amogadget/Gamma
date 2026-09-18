---
name: verify
description: Build, launch, and drive Gamma end-to-end in an isolated environment to verify a change at the real UI.
---

# Verifying Gamma changes end-to-end

The checked-in browser suite is the first thing to run; a one-off Playwright
script is for flows the suite does not cover yet (and then the flow belongs
in the suite). Nothing below touches the developer's real data directory.

## 1. The suite (`frontend/tests/e2e/`)

```bash
# node is fnm-managed and not on the tool shell's PATH
eval "$(fnm env --shell bash)"        # Git Bash; PowerShell: fnm env --use-on-cd | Out-String | Invoke-Expression
cd frontend
npm run build                         # the suite drives frontend/dist
npm run e2e -- --continue             # every step; exit 1 on any failure
npm run e2e -- --only notes           # steps whose name contains "notes" / "pdf" / "collab" / "share"
npm run e2e -- --headed --keep        # watch it; keep the temp data dir + server.log
```

What it does: starts the backend from `backend/venv` over a fresh
`GAMMA_DATA_DIR` in the OS temp dir on a free port, creates `alice` / `bob`,
launches Playwright's Chromium (a devDependency; the browser is fetched once
on first launch), and runs the scenarios in `tests/e2e/scenarios/` — notes
editing, PDF + highlights + search, two-account collaboration, share links.
Every step also fails on any 4xx/5xx API call, console error or page error
that happened meanwhile. Details and the step list:
[docs/dev/debugging.md](../../../docs/dev/debugging.md).

**After a change, add or extend a step** rather than hand-driving the UI: the
harness (`harness.mjs`) gives you `Account.api()` for seeding through the API
(session cookie + `X-Gamma-Workspace`), `Account.context(browser)` for a
logged-in browser context, `makePdf([...pages])` for a real PDF with a text
layer, `openPage` / `assertNoProblems`, `until()` for debounced or
websocket-delivered state. Selectors the scenarios already use: `.folderNewBtn`
(New page), `.titleEdit`, `.blockRow` / `.blockBody` (click opens the editor),
`.blockEditorCm .cm-content`, `.sortableBlockWrap .dragHandle` → `.ctxMenuItem`,
`[data-page="N"] .textLayer span`, `.plainTip .colorBtn`, `[data-hl-id]`,
`.searchPopover .searchInput`, `button[aria-label='Share']` → `.shareDialog`,
`.presenceBar .peerAvatar`, `.peerChips`. Editor rules that matter: plain
Enter is a line break and Shift+Enter a new block (unless the
`gamma-enter-new-note` preference is set), Escape does not close the editor
(blur does: `closeEditor` in `scenarios/notes.mjs`), Tab / Shift+Tab remount
the row (`reopenFocused`).

## 2. One-off drives

For a flow outside the suite, write a short script against the same harness
(`import { Server, Account, launchBrowser, openPage } from "./tests/e2e/harness.mjs"`)
so it gets the isolated server for free, or start things by hand:

```bash
cd backend
GAMMA_DATA_DIR=<scratch>/data venv/Scripts/python.exe manage.py setup           # guest account + files
GAMMA_DATA_DIR=<scratch>/data venv/Scripts/python.exe manage.py create-user tim pw
GAMMA_DATA_DIR=<scratch>/data GAMMA_STATIC_DIR=/d/Codes/Github/gamma/frontend/dist \
  venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 9002        # background; 9001 is the real one
```

Seed through the API with a cookie jar (`curl -c jar -X POST :9002/api/login
-d '{"username":"tim","password":"pw"}'`, then `-b jar` plus
`-H "X-Gamma-Workspace: <id>"`): `POST /api/uploads` (a PDF) →
`POST /api/blocks/by-doc/<doc_id>` (the page), `POST /api/pages` (a text
page), `POST /api/blocks` (`{parent_id, content}`).

Gotchas:
- Search popover: Ctrl+F opens it; the input keeps its previous query — Ctrl+A
  before typing a new one. On the paper view it opens as a compact find bar
  (a `1/1` count, no rows) until "Toggle result details".
- PDF render takes a moment after opening a page; wait for
  `[data-page="1"] .textLayer span` before selecting text or screenshotting.
- Windows GBK console: decode subprocess output as UTF-8 yourself
  (`PYTHONIOENCODING=utf-8`), or ascii-encode before printing.
- `POST /api/metadata/fetch` answers 404 for a PDF without an arXiv id / DOI —
  designed, not a failure.

Kill the uvicorn process when done (the suite does this itself).

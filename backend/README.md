# backend/

FastAPI server. All state is SQLite + files under a data directory
(`GAMMA_DATA_DIR`; defaults to `./data` at the repo root, `/data` in Docker).

```
backend/
├── app.py             uvicorn entrypoint — imports gamma.app:app
├── manage.py          user CRUD CLI (setup / create-user / set-password / …)
├── gamma/             the application package
│   ├── app.py           FastAPI assembly (middleware, routers, startup, SPA serving)
│   ├── config.py        env config (data dir, upload caps, AI protocol defaults)
│   ├── db.py            schemas + per-user DB paths
│   ├── auth.py          session middleware → request.state.user
│   ├── seed.py          first-run admin + guest welcome page
│   ├── blocks_store.py  recursive-CTE tree helpers
│   ├── storage.py       content-addressed uploads + orphan cleanup
│   ├── textnorm.py      search normalization + fuzzy matching
│   ├── ai_client.py     provider wire protocols (Anthropic / OpenAI / ChatGPT)
│   ├── ai_context.py    PDF extraction + chat context assembly
│   ├── ai_settings.py   per-user provider config → ai_runtime(user)
│   ├── flatten_mrc.py   MRC scan flattening (stencil-mask removal)
│   ├── flatten_queue.py background flatten worker
│   ├── logbuf.py        scrubbed in-memory server log
│   ├── *_export.py      markdown / PDF / Logseq-graph exporters
│   ├── logseq_import.py EDN / Markdown importers
│   └── routers/         one module per API area (see below)
└── tests/             in-process TestClient tests (no server, no network)
```

## Run

```bash
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py setup                            # seed guest + per-user DBs (idempotent)
uvicorn app:app --host 127.0.0.1 --port 9001 --reload
```

## Test

```bash
pip install -r requirements-dev.txt
python -m pytest tests -q
```

## Data model — everything is a block

`users/<name>/pages.db` has one table, `unified_blocks`. Rows form a tree via
`parent_id`; sibling order is the lexicographic `position` (fractional-index
strings like `a0`, `a0V`). A root-level block (parent `'root'`) is a page; one
with `properties.doc_id` is a PDF page. Highlights are blocks with
`highlight_id`/`pdf_position`; free notes are blocks without.

Invariants:

- Positions come from `generate_key_between` — never hand-write them.
- `PUT /blocks/{id}/children` replaces the whole subtree and triggers
  orphan-upload cleanup.
- Timestamps are UTC ISO strings with a `Z` suffix (`page_now()`).

## Routers (one module per API area, mounted in `gamma/app.py`)

`auth`, `admin`, `ai`, `chats`, `prefs`, `metadata`, `search`, `shares`,
`pdf`, `uploads`, `pageimage`, `blocks`, `imports`, `export`.

Gotchas:

- Read endpoints resolve the user from `?user=` (share fallback); writes
  require the session cookie.
- Slow endpoints (downloads, AI, PyPDF2) are intentionally sync `def` — FastAPI
  threadpools them. Don't convert them to `async`.
- All backend logging goes through `logbuf.log`, never `print()`.

# API reference

All endpoints are same-origin under `/api`. The frontend never talks anywhere
else; in dev, Vite proxies `/api` → `127.0.0.1:9001`.

## Auth model

- A `session` cookie identifies the user (middleware sets
  `request.state.user`). Write endpoints require it.
- Share tokens (`?share=<token>`) give unauthenticated, document-scoped
  **read** access. A username alone never grants shared access; endpoints must
  validate the share token and its document scope. Keep that read/write
  distinction when adding endpoints.
- `/api/admin/*` additionally requires the `is_admin` flag.

## Endpoints

### Session & account (`auth.py`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/login`, `/login-guest`, `/logout` | session management |
| GET | `/session` | who am I (identity only — quota lives in `/quota`) |
| GET | `/export` (+ `/export-progress`) | backup zip (everything or DB-only); admins may target `?user=` |
| POST | `/import-data` | restore/merge a backup zip |

### Blocks (`blocks.py`) — the core data model
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/blocks/by-doc/{doc_id}` | blocks of a PDF page. POST accepts `original_filename`, reduced to a leaf and used as the automatic title; the page stores it as an `auto_title` compare-and-swap marker |
| GET | `/blocks/{id}/children`, `/{id}/subtree`, `/{id}/backlinks` | tree reads |
| POST/PUT/DELETE | `/blocks`, `/blocks/{id}` | CRUD |
| PUT | `/blocks/{id}/children` | replace the whole subtree (delete + reinsert; triggers orphan-upload cleanup) |
| POST | `/blocks/{id}/reorder` | sibling reorder |
| GET | `/block-search` | fuzzy note/page/highlight search; empty `q` returns up to 50 recently edited blocks from the authenticated user's workspace |
| POST | `/blocks-replace` | bulk replace (no frontend UI currently) |

Route order matters: the static-prefix routes (`by-doc`, `children`,
`subtree`) must stay registered before `/blocks/{block_id}`.

### PDFs & uploads (`pdf.py`, `uploads.py`, `shares.py`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/resolve-pdf` | URL/arXiv/DOI → fetchable PDF (citation_pdf_url sniffing, Unpaywall OA fallback) |
| GET | `/pdf` | proxy/download a PDF (`save=1` caches it server-side) |
| POST | `/uploads`, `/upload-image` | store files (content-hash names, dedup'd; quota-gated) |
| GET | `/uploads/{filename}` | serve stored files |
| GET | `/quota` | effective limits + usage for the session user |
| POST/GET | `/share/{doc_id}`, `/share/{token}` | create/resolve read-only share links |

### Search (`search.py`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/pdf-search` | FTS5 over extracted PDF text (built lazily in background) |
| POST | `/search-reindex` | full rebuild, or just `doc_ids` from the body |
| GET | `/tasks` | background task progress (indexing, downloads) |

### Link previews (`links.py`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/link-preview?url=` | webpage title for the frontend's link chips (`{url, host, title}`); authenticated, fetch goes through the SSRF guard, only the first 128 KB is read, results cached in-process (TTL 24 h, bounded). A blocked or unreachable URL degrades to a host-only chip rather than erroring |

### Metadata (`metadata.py`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/metadata/fetch` | resolve a paper (arXiv → DOI → AI extraction), cache meta + BibTeX on the page. Renames the page to the resolved title **only** while the stored title still equals the `auto_title` marker (or the legacy `PDF Notes - ` prefix), under `BEGIN IMMEDIATE`; reports the outcome as `title_updated`/`page_title`. Any explicit `PUT /blocks/{id}` content write clears the marker, so a rename made during a slow lookup always wins |
| POST | `/metadata/update` | save hand-edited fields (rebuilds BibTeX) |
| POST | `/metadata/cite` | BibTeX → PPT-style citation via AI |
| GET | `/metadata/status` | library-wide health table (feeds Settings → Library) |

### AI (`ai.py`) — all config is per-user GUI entries, no env API keys
| Method | Path | Purpose |
|---|---|---|
| POST | `/ai/chat` | chat; NDJSON stream of `{delta}`/`{action}`/`{error}`; carries model id, effort, context, images, files, and the agent scope (see [agent.md](agent.md)) |
| GET | `/ai/models` | model registry + default prompts (feeds the model switchers and prompt editor) |
| GET | `/ai/settings` | masked provider list (key hints only) |
| POST/PUT/DELETE | `/ai/providers[/{id}]` | manage provider entries |
| POST | `/ai/providers/{id}/test` | live probe of one credential (model: the entry's `test_model`, else the request's `model` — the client sends its metadata model — else the first model); failures carry an `auth` flag for expired/rejected credentials |
| POST | `/ai/providers/{id}/usage` | ChatGPT subscription allowance windows; explicitly unavailable for generic API-key providers. Best-effort: any provider failure degrades to 502 "unavailable" and never returns a token. Uses the protocol-owned base URL, never the saved entry value, and caches per (user, provider) for 60s; an expired sign-in returns `{available: false, auth: true}` in-body rather than a 502 |
| POST | `/ai/health` | login connection check of one entry (`{provider_id, mode}`; `""` = first entry): `mode: "ping"` is the free credential check (OAuth → usage endpoint, API key → `/v1/models`; 404/405 = gateway without a listing → ok-but-unverified), `"test"` the tiny live completion; always answers in-body `{configured, ok, auth?, error?}`. Upstream error bodies are summarized before display (`upstream_detail`): JSON → its message field, an HTML error page → its `<title>` |
| POST | `/ai/model-catalog` | list models available to a credential |
| POST | `/ai/oauth/chatgpt/start`, `/complete` | ChatGPT OAuth (PKCE, pasted callback URL) |
| POST | `/ai/transcribe` | voice dictation |
| POST | `/ai/translate` | translate PDF paragraphs for the viewer's translated view: `{texts[], lang, model, effort}` → `{translations[], model, cached}`. Authenticated owner only (never share tokens); the selected page text is sent to the user's configured provider. Bounded to 200 paragraphs / 60k chars per call and rate-limited per user; duplicate paragraphs within one request collapse to a single upstream call. Translations are cached in memory only, keyed by user + language + model name + source text, behind a lock (the route is sync `def`, so the viewer's parallel calls land in the threadpool at once). A malformed model reply is salvaged paragraph-by-paragraph — concurrently, but capped at 4 workers so one bad batch can't fan out into hundreds of provider calls — then degrades to the original text rather than erroring. Clients should pass an `AbortSignal`: the viewer cancels in-flight chunks when the user stops a job |
| GET | `/pdf-text-status` | whether a doc has extractable text |

### Chats (`chats.py`, prefix `/api/chats`)
| Method | Path | Purpose |
|---|---|---|
| GET/PUT/DELETE | `/chats/{key:path}` | chat history per bucket: page id, `home`, or `home:<folder>` (hence `:path`) |
| POST | `/chats/folder-rename` | migrate folder buckets on rename/move/delete (`{src, dst}`, dst `""` deletes) |

### Import & export (`imports.py`, `export.py`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/import/logseq` | Logseq .pdf + .edn import |
| POST | `/import/markdown` | UTF-8 `.md`/`.markdown` file → note page and nested blocks (optional `folder`). Max 5 MB / 5000 blocks; filename reduced to a leaf; parsed into pages.db with no file stored on disk. Idempotent by content digest — re-importing the same bytes returns the existing page (`duplicate: true`) instead of a second copy |
| POST | `/import/pdf-annotations` | import annotations embedded in the PDF (idempotent; optional `strip`) |
| POST | `/import/zotero` | Zotero library import: zip of a "Zotero RDF" export (multipart `file`; `strip`, optional `folder` prefix). Items→pages+metadata, collections→folders, tags→labels, notes→blocks; embedded annotations via the same importer. Idempotent by file hash / `zotero_key` |
| POST | `/import-data?mode=merge` | additive import for full backups and scoped Gamma exports; scoped archives reject replace mode, validate DB/chat/upload scope, and never overwrite existing pages, chats, or files |
| GET | `/pages/{id}/export` | page export (`?mode=readable\|notes-pdf\|logseq-graph\|zotero-rdf\|gamma` plus format flags); `notes-pdf` returns the notes typeset as their own PDF document (title, metadata, the block tree as nested bullets with quotes, code, images and math) — a single file, not a zip, and the one PDF format a page without a paper can produce; `gamma` is an authenticated-owner-only scoped `gamma-backup-1` ZIP containing exactly that page subtree, its chat, and referenced local uploads, for additive `mode=merge` import; other share-capable modes remain document-scoped |
| GET | `/pages/{id}/export-pdf` | PDF with annotations written back (`?highlights=&notes=`) |
| GET | `/folders/export` | authenticated folder export (`?name=&mode=readable\|notes-pdf\|logseq-graph\|zotero-rdf\|gamma`); `notes-pdf` is one PDF document holding every page, each starting on a fresh sheet; Gamma contains matching page subtrees, page chats, matching `home:<folder>` chat buckets, and referenced uploads; optional `op` enables operation-scoped progress |
| GET | `/folders/export-progress` | progress for the authenticated user's exact `?op=` (`{active,total,done,title}`); concurrent operations are isolated |

### Prefs (`prefs.py`)
| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/prefs/{key}` | small synced JSON KV (`open-tabs`, `recent-views`, `ai-provider`, …); refuses the reserved `ai-settings` key |
| GET | `/page-snaps` | all recents-card cover thumbnails `{snaps: {pageId: {img, at}}}`; `?after=<iso>` returns only newer ones (the focus-pull delta) |
| PUT | `/page-snaps/{page_id}` | store a cover (JPEG data URL body `{img, at}`; per-page newest-`at` wins, count-capped server-side) |
| DELETE | `/page-snaps/{page_id}` | drop a cover (the recents card's ×) |

### Admin (`admin.py`, prefix `/api/admin`)
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/admin/users` | list (with usage) / create accounts |
| PUT/DELETE | `/admin/users/{name}` | password, admin flag, storage overrides / delete |
| POST | `/admin/users/{name}/rename` | rename (moves the data dir first; sessions survive) |
| GET/PUT | `/admin/settings` | server-wide storage defaults |
| GET | `/admin/logs?after=<seq>` | scrubbed in-memory server log |

Rails: the guest account is untouchable, no self-delete, the last admin
can't be demoted or deleted.

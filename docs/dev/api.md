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
| GET/POST | `/blocks/by-doc/{doc_id}` | blocks of a PDF page |
| GET | `/blocks/{id}/children`, `/{id}/subtree`, `/{id}/backlinks` | tree reads |
| POST/PUT/DELETE | `/blocks`, `/blocks/{id}` | CRUD |
| PUT | `/blocks/{id}/children` | replace the whole subtree (delete + reinsert; triggers orphan-upload cleanup) |
| POST | `/blocks/{id}/reorder` | sibling reorder |
| GET | `/block-search` | fuzzy note/page/highlight search |
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

### Metadata (`metadata.py`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/metadata/fetch` | resolve a paper (arXiv → DOI → AI extraction), cache meta + BibTeX on the page |
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
| POST | `/ai/providers/{id}/test` | live probe of one credential |
| POST | `/ai/model-catalog` | list models available to a credential |
| POST | `/ai/oauth/chatgpt/start`, `/complete` | ChatGPT OAuth (PKCE, pasted callback URL) |
| POST | `/ai/transcribe` | voice dictation |
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
| POST | `/import/pdf-annotations` | import annotations embedded in the PDF (idempotent; optional `strip`) |
| POST | `/import/zotero` | Zotero library import: zip of a "Zotero RDF" export (multipart `file`; `strip`, optional `folder` prefix). Items→pages+metadata, collections→folders, tags→labels, notes→blocks; embedded annotations via the same importer. Idempotent by file hash / `zotero_key` |
| GET | `/pages/{id}/export` | page export (`?mode=readable\|logseq-graph\|zotero-rdf` plus `highlights=&notes=&pdf=`); Zotero image-bearing highlight comments use a plain PDF placeholder and, when `notes=1`, a linked Memo with page/quote context; share tokens remain document-scoped |
| GET | `/pages/{id}/export-pdf` | PDF with annotations written back (`?highlights=&notes=`) |
| GET | `/folders/export` | authenticated folder export in the same three modes (`?name=`); optional `op` enables operation-scoped progress; Zotero maps subfolders to collections |
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

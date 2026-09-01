# API reference

All endpoints are same-origin under `/api`. The frontend never talks anywhere
else; in dev, Vite proxies `/api` → `127.0.0.1:9001`.

## Auth model

- A `session` cookie identifies the user (middleware sets
  `request.state.user`). Write endpoints require it (`require_user`).
- Share tokens (`?share=<token>`) are the ONLY unauthenticated **read** path.
  `resolve_user` returns the session user, or the owner named by a valid
  `?share=` token — there is no `?user=` fallback (it used to trust any
  username and leaked whole accounts). A share is scoped to one document:
  read endpoints that can serve a share view also call `share_scope_doc()` and
  `blocks_store.assert_block_in_doc()`, so a token can only reach its own
  document's subtree and assets — root listing, backlinks, other docs, and
  folder export are refused (403). Keep that read/write + scope distinction when
  adding endpoints.
- Outbound fetches of user-supplied URLs (PDF proxy/resolver, AI PDF
  re-download) go through `gamma.net_guard.guarded_urlopen`, which blocks
  non-http(s) schemes (`file:`, `ftp:`, …) and hosts that resolve to
  loopback/private/link-local/metadata addresses (SSRF), re-checking on every
  redirect.
- Usernames and doc ids are validated (`db.safe_username` / `db.safe_doc_id`,
  used by `user_db_path` / `user_uploads_dir` / `pdf_upload_path`) before they
  become filesystem paths — no traversal.
- The session cookie is `HttpOnly; SameSite=Lax`, and `Secure` when the request
  is HTTPS (auto via scheme / `X-Forwarded-Proto` — off on plain-HTTP LAN so
  login still works there). Sessions are enforced server-side against
  `SESSION_MAX_AGE` (expired rows are deleted in the middleware) and are revoked
  when the account's password is changed.
- `/api/login` and `/api/login-guest` are rate-limited per IP/username
  (`gamma/ratelimit.py`, in-process fixed windows → 429). Not an edge WAF; add
  one for large public deployments.
- Every response carries baseline hardening headers (`X-Content-Type-Options`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Content-Security-Policy:
  frame-ancestors 'self'`, and HSTS on HTTPS). SVG uploads are served
  `Content-Disposition: attachment` + `CSP: sandbox` so they can't run inline as
  stored XSS.
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
| GET | `/block-search` | fuzzy note/page/highlight search; empty `q` returns recently edited blocks (feeds the `[[ref]]` popup's initial suggestions) |
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
| GET | `/link-preview?url=` | webpage title for the frontend's link chips (`{url, host, title}`); fetch goes through the SSRF guard, results cached in-process (TTL 24 h) |

### Browser extension (`clip.py`) — see [extension.md](extension.md)
| Method | Path | Purpose |
|---|---|---|
| POST | `/clip` | one-shot "save this paper": dedup by DOI/arXiv/URL → resolve → fetch + store (`save_copy`) → page (`get_or_create_doc_page`) → folder/labels → metadata in a background thread. Body: `source_url, pdf_url, doi, arxiv_id, doc_id (pre-uploaded bytes), title, folder, labels, allow_oa, save_copy`. Returns `{block_id, doc_id, title, existed, open_url, note?}`; a dead link is a 400 and creates no page |
| GET | `/library/lookup?doi=&arxiv_id=&url=` | is this paper in the library (`properties.meta`, `source_url`, `web_url`, URL hash)? 404 when not |
| GET | `/library/folders` | `{folders, labels}` in use (folder paths include their ancestors) — the popup's pickers |
| POST | `/clip/note` | append `> quote — [title](url)` as the last block of `page_id`, or of the "Web clips" page (created on first use) |

All four are session-only (`require_user`), never share-token readable.

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
| POST | `/ai/chat` | chat; NDJSON stream of `{context}` (first line: per-document coverage — native/text, pages shown of total) then `{delta}`/`{action}`/`{error}`; carries model id, effort, context, images, files, and the agent scope (see [agent.md](agent.md)) |
| GET | `/ai/models` | model registry (each model carries `native_pdf`: whether its provider accepts the PDF file itself) + default prompts (feeds the model switchers and prompt editor) |
| GET | `/ai/settings` | masked provider list (key hints only) |
| POST/PUT/DELETE | `/ai/providers[/{id}]` | manage provider entries |
| POST | `/ai/providers/{id}/test` | live probe of one credential (model: the entry's `test_model`, else the request's `model` — the client sends its metadata model — else the first model); failures carry an `auth` flag for expired/rejected credentials |
| POST | `/ai/providers/{id}/usage` | ChatGPT subscription allowance windows; explicitly unavailable for generic API-key providers; an expired sign-in returns `{available: false, auth: true}` in-body |
| POST | `/ai/health` | login connection check of one entry (`{provider_id, mode}`; `""` = first entry): `mode: "ping"` is the free credential check (OAuth → usage endpoint, API key → `/v1/models`), `"test"` the tiny live completion; always answers in-body `{configured, ok, auth?, error?}` |
| POST | `/ai/model-catalog` | list models available to a credential |
| POST | `/ai/oauth/chatgpt/start`, `/complete` | ChatGPT OAuth (PKCE, pasted callback URL) |
| POST | `/ai/transcribe` | voice dictation |
| POST | `/ai/translate` | translate paragraph texts for the viewer's translated view (`{texts, lang, model, effort}` → `{translations}`; in-memory per-paragraph cache) |
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
| POST | `/import/markdown` | UTF-8 `.md`/`.markdown` file → note page and nested blocks (optional `folder`) |
| POST | `/import/pdf-annotations` | import annotations embedded in the PDF (idempotent; optional `strip`) |
| POST | `/import/zotero` | Zotero library import: zip of a "Zotero RDF" export (multipart `file`; `strip`, optional `folder` prefix). Items→pages+metadata, collections→folders, tags→labels, notes→blocks; embedded annotations via the same importer. Idempotent by file hash / `zotero_key` |
| GET | `/pages/{id}/export` | page export (`?mode=readable|notes-pdf|logseq-graph|zotero-rdf|gamma` + `highlights=&notes=&pdf=`); `notes-pdf` = the notes typeset as their own PDF (works without a paper); `gamma` = scoped backup for `/import-data?mode=merge` |
| GET | `/pages/{id}/export-pdf` | the page's own PDF with annotations written back (`?highlights=&notes=`) |
| GET | `/folders/export` | whole-folder export, same modes/flags (`?name=` + `mode=`); subfolders become Zotero collections, `notes-pdf` one PDF for the whole folder |
| GET | `/folders/export-progress` | per-page progress of a running folder export (`{active, total, done, title}`) |

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

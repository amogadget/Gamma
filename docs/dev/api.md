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

### Native text highlights (`native_highlights.py`)

`PUT /api/blocks/{canonical UUID}/highlight` creates an ordinary page-scoped highlight with the owner's authenticated session. Body: `{parent_id, quote, color, pdf_position: {pageNumber, boundingRect, rects, area:false}}`. Rectangles carry `x1/y1/x2/y2/width/height/pageNumber` in the Web viewport coordinate convention; a native selection spanning pages creates one block per page. Returns the complete block with `highlight_id` equal to its stable UUID, `quote`, `color`, `pdf_page` and `pdf_position` properties. A retry for the same existing highlight/parent returns its current state without overwriting subsequent Web edits; unrelated UUID/parent collisions are rejected. Later text/comment changes use normal block CRUD.

### Native iPad ink (`ink.py`)

Native asset and mutation routes require the owner's session cookie, never a share token or
`?user=`. One explicit multi-stroke annotation is one ordinary unified block
under an existing Gamma PDF page; audio is a separate block, not one block per stroke.

- `POST /api/assets`: multipart `file`. `.pkdrawing` accepts
  `application/octet-stream` or `application/x-pkdrawing`; `.png` requires
  `image/png` and a validated PNG. `.inkjson` requires `application/json` and
  the strict `gamma-ink-replay-v1` schema (bounded page/strokes/points, monotonic
  timestamps, base64 PNGs decoded with Pillow, and no data URLs). PKDrawing is
  opaque binary, not decoded or validated by Linux. M4A support is described in the
  audio section below. Empty files or unsupported types return 400. Hard asset cap: 32 MiB.
  Returns 200 `{filename, url, size, already_existed}`, where filename is the
  full lowercase SHA-256 plus extension and URL is `/api/assets/{filename}`.
  Dedup is per-user. New bytes use existing per-file (413) and storage quota
  (507) rules; existing bytes do not consume quota again.
- `GET /api/assets/{filename}`: authenticated own-user file only; 404 if absent.
  `Cache-Control: private, no-cache`, `Vary: Cookie, Authorization`, and
  `nosniff`. The legacy uploads alias uses this same private policy.
- `PUT /api/blocks/{block_id}/ink`: `block_id` must be a canonical lowercase
  client-generated UUID. Body (unknown fields rejected):

  ```json
  {
    "parent_id": "existing-gamma-pdf-page-block-id",
    "pdf_page": 1,
    "ink_asset": "/api/assets/<64hex>.pkdrawing",
    "preview_asset": "/api/assets/<64hex>.png",
    "replay_asset": "/api/assets/<64hex>.inkjson",
    "bounds": {"x": 20, "y": 30, "width": 100, "height": 40},
    "crop_box": {"width": 612, "height": 792},
    "coordinate_space": "pdf-crop-top-left-v1",
    "expected_revision": 0
  }
  ```

  `pdf_page` is one-based within the parent's PDF (not another Gamma page).
  Coordinates are **unrotated PDF crop-box points, origin upper-left**, x right,
  y down; viewport scale, scroll, device pixels and PDF rotation are excluded.
  PKDrawing uses those same page coordinates. PNG depicts `bounds`, not the
  whole page. `crop_box` describes unrotated width/height, not its PDF media-box
  offset. Bounds must be finite, positive-sized and crop-contained; empty ink
  may use a transparent PNG with a small positive rectangle. Clients validate
  actual PDF page count/dimensions; backend validates geometry but does not
  open the PDF. `coordinate_space` defaults to the shown version.

  Returns 200 the ordinary full block `{id,parent_id,position,content,properties,
  created_at,updated_at}`. Properties contain `type: "pdf_ink"`, the ink fields
  above (excluding parent/expected revision), and `ink_revision` starting at 1.
  New blocks append with empty content. Updates preserve content, children,
  order, creation timestamp and unrelated properties. Generic block PUT rejects
  changes to reserved ink fields or native-note revision markers (409); use
  these dedicated endpoints instead. Existing IDs must already
  be ink blocks under the same parent and same PDF page; otherwise 409.
  Missing parent/assets return 404; parent without PDF identity returns 409;
  invalid UUID/body/geometry returns 422.

  `replay_asset` is optional. When present it must be an existing local
  `.inkjson` whose `source_sha256` equals the 64-hex digest in `ink_asset`.
  Omitted replay refs preserve the existing replay only when the ink source is
  unchanged; changing the source removes the stale ref. Explicit `null` clears it.
  Generic block PUT treats `replay_asset` as reserved. `expected_revision` is
  optional: 0 means create-only; a positive value must match current `ink_revision`. Mismatch returns 409 with
  `detail: {message, current_revision}`. An exact payload replay returns the
  existing block without incrementing revision, even with an old expectation.
  Without an expectation, differing saves are last-write-wins. Serialize saves
  per annotation, persist UUID/body/assets before upload, upload both assets,
  then PUT; on 409 reconcile instead of blind retry. Delayed retries following
  a newer save conflict when using expected revisions. `PUT
  /api/blocks/{canonical UUID}/replay-preview` accepts only
  `{ink_asset, replay_asset}` for an existing own `pdf_ink` block. It verifies
  the expected current ink source and replay `source_sha256`, then updates only
  `replay_asset` without changing `ink_revision`, content, children, or other
  properties; source mismatch returns 409. Delete via normal block
  DELETE; deletion has no tombstone, so cancel queued saves before deleting.
- `PUT /api/blocks/{block_id}/note`: idempotent native child-note upsert with
  canonical UUID and `{parent_id, content, expected_revision?}`. Parent must be
  an existing `pdf_ink` block or a `native_note: true` descendant of one.
  Ancestor validation is bounded to 64 blocks (ink included), rejects cycles
  and plain-text intermediary blocks, and requires ink directly beneath an
  existing Gamma PDF page root. Returns the ordinary full block with
  `properties: {native_note: true, note_revision: 1}` on create. Same revision
  and exact replay semantics as ink. Updates preserve children and other
  properties. Only marked native notes under that same parent may be edited;
  unrelated blocks return 409. Normal note editing via `/blocks/{id}` also
  increments `note_revision` when its content changes. Notes are otherwise
  normal Gamma blocks, including their own ordinary note children.

Assets live in the per-user uploads directory, count toward quota, and are
included in full backups, scoped Gamma exports/imports and readable Markdown
bundles (preview plus editable drawing). Unreferenced native assets have a
seven-day staging grace period; reupload renews it. Existing orphan cleanup
then removes expired unreferenced assets but retains referenced assets. Clients
must retain local bytes until successful save and reupload after long outages.
No schema migration. PDF/Zotero exports do not flatten PencilKit strokes.

### Native audio recordings (`ink.py`)

`POST /api/assets` also accepts `.m4a` with `audio/mp4` or `audio/x-m4a`. The
32 MiB hard cap applies; bytes must contain a plausible ISO-BMFF `ftyp` box.
Audio is intentionally opaque (no server decoding), with a maximum 24-hour
recording and 1,000 segments per block. `GET /api/assets/<sha>.m4a` is private,
same-user only, and returns `audio/mp4`.

`PUT /api/blocks/{canonical-uuid}/audio` accepts `{parent_id, expected_revision,
audio_state, segments, replay_events?}` where each segment has a canonical UUID,
local `/api/assets/<64hex>.m4a` ref, and finite positive duration. It creates or
updates a unified block, preserving content/children/other properties, and
returns `type: audio`, `audio_revision`, cumulative `start_time`, total
`duration`, and `replay_events` when present.

`replay_events` is optional for compatibility: omitting it preserves an existing
timeline, while explicit `[]` clears it. Each event is `{id, kind, segment_id,
start, end, pdf_page, block_id?, stroke_id?}`. IDs are canonical lowercase UUIDs
and unique; `kind` is `stroke`, `page`, or `note`; times are finite,
nonnegative segment-relative seconds with `end >= start` and a 24-hour cap;
`pdf_page` is a positive strict integer. Stroke events require nonempty `block_id`
and `stroke_id`; note events require `block_id`; page events require neither.
At most 20,000 events are accepted, and each `segment_id` must name a segment in
the same payload. Block references are weak references only: the server neither
fetches nor discloses cross-user data. Exact retries, including the timeline, are
idempotent; divergent stale revisions return 409.

Generic block PUT cannot alter reserved audio fields, including `replay_events`.
Audio assets are included in backups and scoped exports/imports and follow native
orphan cleanup.

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

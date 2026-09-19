# API reference

All endpoints are same-origin under `/api`. The frontend never talks anywhere
else; in dev, Vite proxies `/api` → `127.0.0.1:9001`.

## Auth model

- A `session` cookie identifies the user (middleware sets
  `request.state.user`). Identity-only endpoints use `require_user`.
- Every data endpoint works in a **workspace** ([workspaces.md](workspaces.md)):
  `?ws=` or the `X-Gamma-Workspace` header names it, nothing means the
  account's default personal workspace. `require_ws(request)` admits any member
  or signed-in non-guest account allowed by public workspace access,
  `require_ws(request, write=True)` editors and owners (a viewer gets 403);
  a caller without effective access gets 403. The returned workspace id is what the data helpers
  take; `request.state.user` stays the actor.
- Share tokens (`?share=<token>`) are the ONLY unauthenticated **read** path.
  `resolve_ws` returns the session's workspace, or the workspace of the page
  named by a valid `?share=` token — there is no `?user=` fallback (it used
  to trust any username and leaked whole accounts). A share is keyed by
  (workspace, PAGE) — the page's root block, so note pages without a PDF
  share exactly like papers; the PDF is just the page's `doc_id`/`source_url`
  — and scoped to it: read endpoints that can serve a share view also call
  `share_scope_page()` and `blocks_store.assert_block_in_page()`, so a token
  can only reach its own page's subtree and assets (its PDF, uploads its
  blocks reference, its own `source_url` through the proxy) — root listing,
  backlinks, other pages, and folder export are refused (403).
- Share reads are readable **cross-origin**: a GET carrying `?share=` or
  resolving `/share/{token}` answers `Access-Control-Allow-Origin: *`
  (`auth._apply_share_cors`), so another Gamma's frontend can pull a shared
  page into its own library browser-side (a share link pasted into the "+"
  box, the share view's "Add to my library" —
  [import_export.md](import_export.md)). `*` makes browsers drop credentials,
  so a cross-origin fetch is a stranger's: only `anyone` links open that way.
  Writes and every other endpoint keep the same-origin default.
- **Share permissions** (`shares.audience` / `role` / `allowed_users`,
  `auth.share_access`) are Notion-shaped and additive: members of the page's
  workspace keep their workspace role (editors/owners edit, viewers view);
  the sharer INVITES people (`users: [{name, role}]`, stored as
  `carol:edit,dave:view`) who get in with their own `view`/`edit` whatever
  general access says; everyone else goes through general access —
  `audience` `anyone` (no session, always view), `users` (any signed-in
  non-guest account, with the share's `role`), `list` (nobody beyond the
  invited). When a request carries `?share=`, the token decides WHICH
  WORKSPACE is read (the page's — a signed-in visitor sees the shared page,
  not their own library) while the session decides whether the audience gate
  admits them; a refused token is 401 when signing in could help, else 403.
  `edit` shares (never valid with `anyone`) let `require_ws_writer` resolve
  the workspace for the block writers — `POST /blocks`, `PUT /blocks/{id}`,
  `DELETE /blocks/{id}`, `PUT /blocks/{id}/children`, `POST /blocks/{id}/reorder`,
  `POST /pages/{id}/ops` (and the page websocket, view or edit),
  `POST /upload-image`, `POST /upload-file`, and the native annotation writers
  (`POST /assets`, `PUT /blocks/{id}/ink|replay-preview|audio|note|highlight`) —
  each of which confines the touched blocks to the
  shared page (no new pages, no deleting/moving the page itself, no changes to
  the page root's properties). Everything else stays session-only.
  Keep that read/write + scope distinction when adding endpoints.
- **Assets** are served from the request's workspace
  (`GET /uploads/{filename}`, `GET /assets/{filename}`), and a `?share=` request
  is confined to the files its own page's subtree references
  (`uploads._share_can_read_upload`, `native_ink._asset_in_page`) — a token
  cannot walk the rest of the workspace by guessing content hashes. Browser
  media elements (`<img>`, `<audio>`) cannot send the workspace header, so
  asset URLs may carry the scope explicitly: the frontend's
  `shared/lib/assetUrl.js` appends `?ws=` / `?share=` to `/api/uploads/…` and
  `/api/assets/…` links.
- Outbound fetches of user-supplied URLs (PDF proxy/resolver, AI PDF
  re-download) go through `gamma.net_guard.guarded_urlopen`, which blocks
  non-http(s) schemes (`file:`, `ftp:`, …) and hosts that resolve to
  loopback/private/link-local/metadata addresses (SSRF), re-checking on every
  redirect.
- Workspace ids and doc ids are validated (`db.safe_ws_id` / `db.safe_doc_id`,
  used by `ws_db_path` / `ws_uploads_dir` / `pdf_upload_path`) before they
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
| GET | `/session` | who am I, plus `workspaces: [{id, name, kind, role, access, public_role, personal, default, members}]` (memberships + every public workspace) and `default_workspace` (quota lives in `/quota`) |
| GET | `/accounts` | the account directory for the invite / owner pickers: `{accounts: [{username, is_admin}]}`, non-guest accounts only (signed-in non-guest callers) |
| GET | `/export` (+ `/export-progress`) | backup zip of a workspace (everything or `uploads=0`; the `gamma-backup-1` zip of `gamma/ws_backup.py`): the request's, `?ws=` (any member), or — admins — `?user=` for an account's default workspace |
| GET | `/export-all` | every personal workspace of the account in one zip, one `/export` zip per workspace inside (`uploads=0` for databases only; guests 403) |
| POST | `/import-data` | restore (`mode=replace`, owners) / merge (`mode=merge`, editors) a backup zip into a workspace (same targeting); never into the guest workspace |

### Workspaces (`workspaces.py`) — see [workspaces.md](workspaces.md)
| Method | Path | Purpose |
|---|---|---|
| POST | `/workspaces` | create a personal one (`{name}`; guests 403); admins may add `kind: "shared"`, `owner`, `access`, `public_role`, `quota_mb` |
| GET | `/workspaces/mine` | Settings → Workspaces: every workspace I can open with its `used_bytes`, plus `account` (my limits and the usage of all my personal workspaces) |
| GET/PUT/DELETE | `/workspaces/{id}` | kind + members + quota + `personal_of` + `default` (any member; admins) / rename `{name}` (owner), `default: true` (a personal workspace's owner), kind, access + public role, workspace quota (admin) / delete (owner; not an account's last personal one) |
| GET/POST | `/workspaces/{id}/backups` | the workspace's server-kept snapshots (any member) / take one now `{label?, uploads?}` (owner; at most `ws_backup.MAX_PER_WORKSPACE`) |
| GET | `/workspaces/{id}/backups/{name}/download` | the snapshot as a zip — the same zip `/export` gives (any member) |
| POST | `/workspaces/{id}/backups/{name}/restore?mode=` | restore it in place: `replace` (owner) / `merge` (editor), the same rules as `/import-data` |
| DELETE | `/workspaces/{id}/backups/{name}` | delete a snapshot (owner) |
| PUT/DELETE | `/workspaces/{id}/members/{user}` | shared workspaces: invite or set a role `{role}`, incl. owner (owner) / remove (owner) or leave (yourself) |
| GET | `/workspaces/find-page/{page_id}` | which of my workspaces holds the page (deep links without `ws`) |

`PUT /workspaces/{id}` applies all supplied changes in one transaction.
Authorization or validation failure leaves the name, kind, access, quota and
account default unchanged. Creation limits count explicit memberships, not
public workspaces the account can merely open.

The generic preference endpoints scope `appearance` and `ai-provider` to the
account without requiring workspace access. Other supported preference keys
require access to the named workspace. `ai-settings` remains reserved and is
never returned by the generic endpoint.

### Blocks (`blocks.py`) — the core data model
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/blocks/by-doc/{doc_id}` | lookup / create the page BY ATTACHMENT — the page whose PDF is `doc_id` (POST creates it: `{default_title, source_url?, original_filename?, folder?}`, `folder` files a NEW page only); the PDF-ingest + extension-dedup path, and what "Open as document" on a PDF file chip calls (the file is already stored under that hash). Text-only pages come from `POST /pages` |
| GET | `/blocks/{id}/children`, `/{id}/subtree`, `/{id}/backlinks` | tree reads; the root listing (`/blocks/root/children`) additionally gives every page a `preview` — the first ~240 chars of its first non-highlight child blocks joined with ` · ` (one window query, `""` when empty) |
| POST/PUT/DELETE | `/blocks`, `/blocks/{id}` | CRUD — inside a page these are thin wrappers over the op path (`gamma/ops.py`): logged, fanned out to the page's room; `PUT` takes `content` and/or a properties PATCH (a null value deletes the key). A new page (`parent_id: "root"`) and deleting a page stay direct writes |
| PUT | `/blocks/{id}/children` | replace the whole subtree (delete + reinsert; triggers orphan-upload cleanup) — bulk paths only (imports, tests); the page's room gets a `reload`. The editor itself sends ops |
| POST | `/blocks/{id}/reorder` | move within the page (an op) or, with `parent_id` on another page, across pages (the source room sees a `delete`, the target reloads) |
| GET | `/block-search` | fuzzy note/page/highlight search; empty `q` returns recently edited blocks (feeds the `[[ref]]` popup's initial suggestions) |

Route order matters: the static-prefix routes (`by-doc`, `children`,
`subtree`) must stay registered before `/blocks/{block_id}`.
`GET /blocks/{id}/subtree` on a page also returns `seq`, the op-log position
the tree reflects (the live session catches up from it).

### Collaboration (`collab.py`) — see [collab.md](collab.md)
| Method | Path | Purpose |
|---|---|---|
| POST | `/pages/{id}/ops` | apply a batch of block ops `{client, ops: [set / insert / move / delete], cursor?: {block, anchor, head}}` (a `set` may carry `base`, the text its `content` was edited from: when the block changed meanwhile the edit is applied as a patch onto the current text — a three-way merge, `gamma/textmerge.py` — and the echoed op carries the merged text) (`cursor`: the writer's caret in the text after the batch, fanned out with it and stored as the writer's presence) in one transaction → `{seq, at, ops (as applied — re-keyed positions carry their final value), removed_uploads}`; a workspace editor or an edit share (confined to the shared page; the page root's properties stay the workspace's); a bad op fails the whole batch (400/403/404/413) |
| GET | `/pages/{id}/ops?since=` | the op log after a seq → `{seq, batches: [{seq, actor, client, at, ops}]}`; 410 when pruned past `since` (reload the tree) |
| WS | `/ws/page/{id}[?ws=&share=&client=]` | the page's live channel: `hello` / `join` / `leave` / `cursor` presence, every applied `ops` batch (with the writer's `cursor` when the batch carried one), `reload`; the client only ever sends `cursor`. Auth like HTTP (session cookie + `?ws=` (else the default workspace) or share token, resolved in the handler — the middleware doesn't run for websockets); viewers join too |

### Pages (`pages.py`) — page first, PDF as an action on it
| Method | Path | Purpose |
|---|---|---|
| POST | `/pages` | create a text-only root page: body `{title?, folder?}` (title defaults to `Untitled`, `folder` → `properties.folder`) → the block dict |
| POST | `/pages/by-docs` | which pages these stored files became: body `{doc_ids: [<hash>, ...]}` (≤500) → `{pages: {hash: {id, title}}}` — a hash matches the page carrying it as its PDF (`doc_id`) or the note page imported from it (a markdown upload's `markdown_import`); hashes with no page absent; any member. The file chips ask once per page render for their "open page" button and the menu's "Open page" / "Add to library" |
| POST | `/pages/from-file` | "Add to library" on a markdown file chip: body `{filename: "<hash>.md", original?, folder?}` → `{page, created, imported?}` — the stored upload becomes a note page through the `/import/markdown` importer (title from front matter, else `original` minus its extension), filed in `folder`; idempotent (a page whose `markdown_import` is the hash is returned with `created: false`); the file is untouched, the page is a copy. 400 for anything but a stored markdown name, 404 when the file is not in the workspace; workspace editors |
| POST | `/pages/{page_id}/attachment` | attach a PDF to a page that has none: body `{doc_id?, source_url?, original_filename?}` (at least one of `doc_id`/`source_url`; `doc_id` is shape-validated only — a URL-opened PDF's id is the URL hash and the proxy fetches it lazily, like `by-doc`; `source_url` defaults to `/api/uploads/<doc_id>.pdf`). While the title is still automatic (`Untitled`/empty) it becomes the file name / URL tail and is marked `auto_title`. → the updated block. 400 bad input / not a root page, 404 unknown page, 409 `{"detail": "page already has an attachment"}`, 409 `{"detail": "attachment belongs to another page", "page_id"}` |
| DELETE | `/pages/{page_id}/attachment` | drop `doc_id`/`source_url`/`original_filename` (highlights keep their `pdf_position`; the orphan sweep deletes the file unless another page references it) → `{ok, block, removed_uploads}`; 404 when the page has no attachment |

The writers need a workspace editor (`require_ws(write=True)`): a share token
never creates pages or touches a page's attachment. `GET /pages/{id}/export*` live
in `export.py`.

### PDFs & uploads (`pdf.py`, `uploads.py`, `shares.py`)

Publisher connections use `routers/publisher_sessions.py` and require a personal
account; guest and share-token access is rejected.

| Method | Endpoint | Behavior |
|---|---|---|
| GET | `/publisher-sessions` | Connection metadata and supported `publisher_roots`; never cookie values |
| POST | `/publisher-sessions` | Save `{host, cookies}` for the signed-in account; requires HTTPS or localhost, JSON, and a body of at most 256 KiB |
| DELETE | `/publisher-sessions/{host}` | Disconnect that account's host; returns `{ok: true}` |

See [publisher sessions](paper_metadata.md#connected-publisher-sessions) for
encryption, expiry and request scoping. The PDF endpoints below use the same
guarded fetch path.

| Method | Path | Purpose |
|---|---|---|
| POST | `/resolve-pdf` | URL/arXiv/DOI → fetchable PDF (citation_pdf_url sniffing, Unpaywall OA fallback) |
| GET | `/pdf` | proxy/download a PDF (`save=1` caches it server-side) |
| POST | `/uploads`, `/upload-image` | store a PDF / an image (content-hash names, dedup'd; quota-gated) |
| PUT | `/blank-pdfs/{page_id}` | create (or recognize, by creation fingerprint) a blank notebook page — see [Blank notebooks](#blank-notebooks-blank_pdfpy) |
| POST | `/upload-file` | store a file for a block to reference as `[name](/api/uploads/<hash>.<ext>)` — the file chip. Any extension except executables (`storage.BLOCKED_EXTENSIONS`: exe, msi, bat, dll, ps1, …; 400 "not accepted (executable)"); the extension comes from the uploaded name, lowercased, `.bin` when there is none; images route like `/upload-image`, a `.pdf` must be a real PDF and lands under the same `<hash>.pdf` the PDF ingest mints (so it can be opened as a document page later); same hashing + limits → `{url, name, size, already_existed}` |
| POST | `/upload-ink` | store a handwriting group's `gamma-ink` JSON (the request body; validated against `gamma/ink.py`'s schema and limits, canonical bytes so identical strokes dedup) as `<hash>.ink` → `{url, size, strokes, bbox, pdf_position, already_existed}`; editors and edit shares. [handwriting.md](handwriting.md) |
| GET | `/pdf-info/{doc_id}` | the document manifest the viewer lays a PDF out from before pdf.js has parsed it (`gamma/pdf_meta.py`, [pdf_loading.md](pdf_loading.md)): `{doc_id, bytes, pages, dims: [[w, h], …]}` in PDF points, rotation applied; same access rule as the file; computed in pdfium on first request when the upload-time background walk has not run (`pages: 0` for an unreadable file, not cached); 400 malformed id, 404 no such file |
| GET, HEAD | `/uploads/{filename}` | serve stored files (HEAD: the headers alone, which is how the viewer learns a file's size before choosing its transport); with their media type (`storage.FILE_MEDIA_TYPES`, else `application/octet-stream`); pdf / images / txt / md render inline, everything else is `Content-Disposition: attachment` (html additionally sandboxed like svg); blocked or malformed extensions 400. A native asset name (`<64hex>.pkdrawing|png|m4a|inkjson`) is served by the native handler instead — same bytes, same scope and private cache headers as `/assets/{filename}` (`native_ink.asset_response`) |
| GET | `/quota` | the limits that apply to uploads into the request's workspace — the account's for a personal one (`used_bytes` = all its personal workspaces), the workspace's own for a shared one — with `workspace_bytes` and `account` (the person, or "") |
| POST | `/share/{page_id}` | create the page's share link (defaults `anyone`/`view`; optional body `{audience, role, users}` applies to a NEW link) or return the existing one unchanged — root blocks only (400 otherwise); workspace editors and owners |
| GET/PUT/DELETE | `/share-settings/{page_id}` | read settings (`{token: null}` when unshared; any member) / change `audience`, `role`, `users` (`["carol"]` or `[{name, role}]`; validated: `edit`+`anyone` → 400, unknown usernames or roles → 400; the token stays) / stop sharing (the token dies) — editors and owners |
| GET | `/share/{token}` | resolve a link for this viewer → `{page_id, doc_id, username (who shared it), workspace_id, audience, role, can_edit, viewer, viewer_is_guest}` (`doc_id` = the page's PDF attachment id via `page_attachment`, `""` without one; `viewer`/`viewer_is_guest` let the share view offer "Open in my library" or "Add to my library"); 404 unknown, 401 sign in first, 403 signed in but not allowed |

#### Blank notebooks (`blank_pdf.py`)

`PUT /api/blank-pdfs/{page_id}` mints a blank notebook: a normal root page whose
PDF is generated here (A4/Letter, portrait/landscape, 1–100 empty pages), so the
viewer, notes, highlights, AI context and export all work on it unchanged — an
iPad PencilKit annotation targets it like any other page (`pdf_page` is the
sheet it was written on). `page_id` is the canonical lowercase UUID the client
minted (422 otherwise) and the call is **idempotent on the creation payload**:
the request's fingerprint is stored as `properties.blank_pdf_creation`, so a
retry returns the page as it stands — a rename in between included — while the
same id with a different payload is 409. Body `{title, page_size, orientation,
page_count, folder}` (unknown fields 422, blank title 422; `folder` is
normalized through `foldertags.clean_path`). → the ordinary full block, with the
PDF attachment props (`doc_id`, `source_url` — the generated file, whose
metadata carries `/GammaNotebookID: <page_id>` so two identical-geometry
notebooks never share a document identity), `pdf_kind: "blank"` and the geometry
in `blank_pdf`. Quota applies (413/507) and a refusal publishes nothing. Editors
and owners only; a `?share=` request is refused (creating a page is a library
action, like `POST /blocks` with `parent_id: "root"`).

### Native iPad annotations (`native_ink.py`, `native_highlights.py`)

Two handwriting generations coexist and share the file store, quota, backups and
exports, but not a route or a property: the browser's `gamma-ink` stroke groups
(`POST /upload-ink`, a block's `properties.ink_url` — [handwriting.md](handwriting.md))
and the iPad client's native payloads below. Native assets and mutations are
workspace-scoped exactly like every other writer (`?ws=` / the
`X-Gamma-Workspace` header; `?user=` is never read), and a `?share=` edit token
may write only inside its own page. Every mutation is one `gamma/ops.py` batch
(CAS check, write, op-log row and room fan-out in one transaction —
[collab.md](collab.md)), so a native save shows up live in an open Web editor.

| Method | Path | Purpose |
|---|---|---|
| POST | `/assets` | store one native asset. Multipart `file`; `.pkdrawing` accepts `application/octet-stream`/`application/x-pkdrawing` and stays opaque (Linux cannot validate Apple's serialization), `.png` requires `image/png` and a structurally valid PNG (signature + chunk CRCs + IHDR, no image library), `.m4a` requires `audio/mp4`/`audio/x-m4a` and a plausible ISO-BMFF `ftyp` box, `.inkjson` requires `application/json` and the strict `gamma-ink-replay-v1` schema (bounded strokes/points, monotonic times, base64 PNGs, no data URLs). Empty or mismatched types 400, over 32 MiB 413. → `{filename, url, size, already_existed}` with `filename` the FULL sha256 plus extension and `url` `/api/assets/<filename>`; quota gates new bytes only (413/507); native assets are excluded from automatic cleanup |
| GET | `/assets/{filename}` | one stored asset (`<64hex>.pkdrawing|png|m4a|inkjson`), 404 unknown; any workspace member, or a share confined to its own page's references; `Cache-Control: private, no-cache`, `Vary: Cookie, Authorization`, `nosniff`. `/uploads/<same name>` serves identical bytes and headers |
| PUT | `/blocks/{id}/ink` | create/update one PencilKit annotation (canonical lowercase UUID or 422). Body `{parent_id, pdf_page, ink_asset, preview_asset, replay_asset?, bounds, crop_box, coordinate_space?, expected_revision?}` (unknown fields 422): coordinates are **unrotated PDF crop-box points, origin top-left**; `bounds` must be finite, positive and crop-contained. `parent_id` must be an existing top-level Gamma PDF page (404 unknown, 409 not a PDF page); an existing id must already be an ink block under the same parent and page (409). Stores `type: "pdf_ink"`, the fields and `ink_revision` from 1. Assets must already be stored (404), and a replay's `source_sha256` must equal the drawing's digest. An exact payload replay returns the block unchanged — no new revision, even with a stale expectation; otherwise `expected_revision` (0 = create-only) must match `ink_revision` or it is 409 `{message, current_revision}`; omitted `replay_asset` keeps the stored replay only while the drawing is unchanged, explicit `null` clears it |
| PUT | `/blocks/{id}/replay-preview` | attach a replay generated later: body `{ink_asset, replay_asset}` only. The block must be an existing `pdf_ink` one and `ink_asset` its CURRENT drawing; the replay must exist, parse and match that digest. Touches `replay_asset` alone — no `ink_revision`, content, children or other properties. Idempotent; source mismatch 409 |
| PUT | `/blocks/{id}/audio` | create/update one recording block. Body `{parent_id, audio_state, segments, replay_events?, expected_revision?}`; each segment `{id (canonical UUID), asset (/api/assets/<64hex>.m4a), duration}` — unique ids, ≤1,000 segments, ≤24 h total, assets must be stored. The server derives each segment's cumulative `start_time` and the block's `duration`; the same idempotency and `expected_revision` rules as ink (comparing the client-owned segment fields, plus the timeline when one is sent). `replay_events` is optional for compatibility — omitting it preserves a stored timeline, `[]` clears it; each event `{id, kind: stroke|page|note, segment_id, start, end, pdf_page, block_id?, stroke_id?}` must reference a segment in the same payload, with unique canonical UUID ids and `end >= start`. Block references are WEAK: the server never resolves or discloses them |
| PUT | `/blocks/{id}/note` | idempotent native child-note upsert (the offline outbox path): body `{parent_id, content, expected_revision?}`. `parent_id` must be an existing ink block or a `native_note` descendant of one, within 64 levels — cycles, plain-text intermediaries and detached ink are 409. Creates `{native_note: true, note_revision: 1}`; an unchanged content replay returns the block; `expected_revision` otherwise gates the write. Updates preserve children and other properties |
| PUT | `/blocks/{id}/highlight` | create one ordinary page-scoped highlight with a client-minted UUID: body `{parent_id, quote, color, pdf_position}` in the Web viewport convention (`pdf_position.pageNumber` must match every rect, 422 otherwise). A retry returns the block as it stands — later Web edits included — and a UUID already used by another block, or by a different parent, is 409 rather than hijacked |

**Reserved properties.** `gamma/native_ink.py` owns everything that describes a
recording; generic writers (the block endpoints, the page-ops endpoint, the AI
tools, `PUT /blocks/{id}/children`) may edit a native block's text, children and
unrelated properties but not those keys — `type`, `ink_asset`, `preview_asset`,
`replay_asset`, `ink_revision`, `bounds`, `crop_box`, `coordinate_space`,
`pdf_page` on ink; `type`, `audio_state`, `segments`, `duration`,
`replay_events`, `audio_revision` on audio; `native_note`, `note_revision` on a
native note — and may not invent them on a new block (409; deleting counts as
touching). A Web text edit of a native note moves `note_revision`, so a queued
offline save conflicts instead of overwriting it. Copying an annotation is
therefore a native write (a fresh UUID through the endpoint above), not a
generic insert.

For native ink/audio saves, `parent_id` names the anchoring root PDF page.
A browser may indent an existing annotation within that same page; native
updates preserve this nesting and verify its actual page root. Naming a
different PDF page remains a conflict, not an implicit move.

**Assets in the data directory.** They live in the workspace `uploads/`
directory under their full digest, so quota, the backup zip (`/api/export`,
`/api/import-data`) and scoped exports cover them: `?mode=gamma` bundles them
under `uploads/`, `?mode=readable` under `assets/` (and renders the preview,
the editable drawing and the replay as links), and the orphan sweep keeps a file
that any block's content or properties reference as `/api/uploads/<name>` or
`/api/assets/<name>`. **Native assets are never automatically deleted**, even
when old and unreferenced: they can belong to an offline outbox, an older
editable drawing or a delayed replay. Block deletion and startup do not reclaim
these bytes. They remain quota-accounted and included in whole-workspace
backups (page exports include only that page's references). There is currently
no native garbage-collection endpoint; reclaiming these files requires a
separate explicitly approved, backup-first administrative procedure. Ordinary
non-native upload cleanup is unchanged. No schema migration was needed.

### Search (`search.py`, `gamma/block_index.py`, `gamma/pdf_index.py`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/search?q=&limit=&scope=` | one search over the knowledge base: notes (`block_fts`) + PDF text (`pdf_fts`). `scope` = `""` (library) or a folder path (that folder and its subfolders). → `{"results": [...], "indexing": n}`; results are notes hits first (bm25 order) then PDF hits, each capped at `limit` (default 20, max 100). A notes hit is `{"source": "notes", "block_id", "page_id", "title", "snippet"}` (`block_id` = the matched block, `page_id` its page root, `title` the page's); a PDF hit is `{"source": "pdf", "block_id", "page_id", "doc_id", "title", "page", "snippet"}` (`block_id` = `page_id` = the page carrying the PDF, `page` the 1-based PDF page). `indexing` = note pages still waiting for a rebuild batch + PDFs the background extractor hasn't reached. Owner-only |
| GET | `/pdf-search` | the PDF-only predecessor (same `pdf_fts` index; hits `{block_id, doc_id, title, page, snippet}`) — the Ctrl+F panel's library group still uses it (with `/block-search` for notes: fuzzy/regex + flags that FTS does not offer) |
| POST | `/search-reindex` | full rebuild (PDF text re-extracted in the background, every note page stamped stale for the next search), or just `doc_ids` from the body |
| GET | `/tasks` | background task progress (indexing, downloads) |

The notes index is rebuilt lazily per page: a search first refreshes every
page whose `block_fts_meta` row is missing, older than `textnorm.INDEX_VERSION`,
or no longer matches the page root's `updated_at`; the block writers that
change a child without touching the root (`POST /blocks`, `PUT /blocks/{id}`,
`DELETE /blocks/{id}`, `PUT /blocks/{id}/children` on a nested block, a
re-parenting `reorder`) call `block_index.mark_page_dirty`.
Deleting a page or detaching its PDF prunes its rows (`block_index.purge_page_data`,
which also drops the `pdf_fts` rows of papers no page carries and the deleted
blocks' chats). The `pdf_fts` schema and its shared queries (`pdf_missing`,
`search_pdf`) live in `gamma/pdf_index.py`; extraction and the background
indexer in `search.py`.

### Link previews (`links.py`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/link-preview?url=` | webpage title for the frontend's link chips (`{url, host, title}`); fetch goes through the SSRF guard, results cached in-process (TTL 24 h) |

### Browser extension (`clip.py`) — see [extension.md](extension.md)
| Method | Path | Purpose |
|---|---|---|
| POST | `/clip` | one-shot "save this page": dedup by DOI/arXiv/URL → resolve → fetch + store (`save_copy`) → page (`get_or_create_doc_page`) → folder/labels → metadata in a background thread. Body: `source_url, pdf_url, doi, arxiv_id, doc_id (pre-uploaded bytes), title, selection, folder, labels, allow_oa, save_copy`. Returns `{block_id, doc_id, title, existed, open_url, folder, labels, note?}`. **No PDF resolvable** (a plain web page, or a dead/HTML link) → a page titled from `title` (else the URL tail) with `properties.web_url = source_url` and the `selection` (if any) as its first `> quote — [title](url)` block; `doc_id` is `""` and `note` says so. Re-clipping that URL finds the page (`find_web_page`, by `web_url` on attachment-less pages), files it and appends the new selection. Only a request with nothing at all (no URL, title or selection) is a 400 |
| GET | `/library/lookup?doi=&arxiv_id=&url=` | is this page in the library (`properties.meta`, `source_url`, `web_url`, URL hash — web-clip pages by `web_url`)? 404 when not |
| GET | `/library/preview?doi=&arxiv_id=&url=` | the registry record behind an identifier (arXiv API, then doi.org): `{title, authors, year, venue, doi, arxiv_id, source}` — the popup's title for a PDF tab before anything is saved. Identifiers are also extracted from `url`; 404 when no registry answers, 400 without an identifier. Cached in memory per identifier |
| GET | `/library/folders` | `{folders, labels}` in use (folder paths include their ancestors) — the popup's pickers |
| POST | `/clip/note` | the explicit "clip into page" append: `> quote — [title](url)` as the last block of `page_id`, or of the "Web clips" page (created on first use) |

All five are session-only, never share-token readable; the clip lands in
the request's workspace — the extension names none, so its personal one.

### Metadata (`metadata.py`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/metadata/fetch` | resolve a paper or book (arXiv → DOI → ISBN via Open Library/Google Books → Crossref search → AI extraction, verified against Crossref / the book registries), cache meta + BibTeX + the slide citation on the page. Body also takes `cite_prompt`/`cite_model`; returns `meta` (with `unverified`), `bibtex`, `ppt_cite` (`""` when AI is off or that call failed), `source`, `cached`, `page_title` (the page's title after the write — always, since a concurrent lookup may have renamed it) and `title_updated` (this call replaced the automatic title) |
| POST | `/metadata/update` | save hand-edited fields incl. `publisher`/`isbn` (rebuilds BibTeX, keeps the document kind, drops the cached citation) |
| POST | `/metadata/cite` | BibTeX → PPT-style citation via AI (regenerate / fallback; the fetch already produces one) |
| GET | `/metadata/status` | library-wide health table (feeds Settings → Library): every page with a PDF attachment plus pages carrying `properties.meta` without one (`has_file: false`); per paper `meta_source`, `meta_kind`, `meta_unverified` (null for pre-flag records) |

### AI (`ai.py`) — all config is per-user GUI entries, no env API keys
| Method | Path | Purpose |
|---|---|---|
| POST | `/ai/chat` | chat; NDJSON stream of `{context}` (first line: per-page coverage — native/text, pages shown of total; `doc_id` `""` for a page without a PDF) then `{delta}`/`{action}`/`{progress}`/`{error}`; `progress` previews an edit_block/create_block call still being written (target id + markdown so far). Context is `pages` (up to 7 page ids, de-duplicated; they also become the tool scope's `context_pages`) or `page_id` (one; its PDF attachment derived server-side; `doc_id` is accepted as a compatibility input and resolves to its page), plus model id, effort, images, files, the agent scope, and the notes pointers `focus_block_id` (cursor block), `context_blocks` (attached block ids), `note_passages` (Ctrl-selected note text). See [ai.md](ai.md) |
| GET | `/ai/models` | model registry (each model carries `native_pdf`: whether its provider accepts the PDF file itself) + default prompts (feeds the model switchers and prompt editor) |
| GET | `/ai/settings` | masked provider list (key hints only) |
| POST/PUT/DELETE | `/ai/providers[/{id}]` | manage provider entries |
| POST | `/ai/providers/{id}/test` | live probe of one credential (model: the entry's `test_model`, else the request's `model` — the client sends its metadata model — else the first model); failures carry an `auth` flag for expired/rejected credentials |
| POST | `/ai/providers/{id}/usage` | ChatGPT subscription allowance windows; explicitly unavailable for generic API-key providers; an expired sign-in returns `{available: false, auth: true}` in-body |
| POST | `/ai/health` | login connection check of one entry (`{provider_id, mode}`; `""` = first entry): `mode: "ping"` is the free credential check (OAuth → usage endpoint, API key → `/v1/models`), `"test"` the tiny live completion; always answers in-body `{configured, ok, auth?, error?}` |
| POST | `/ai/model-catalog` | list models available to a credential |
| POST | `/ai/oauth/chatgpt/start`, `/complete` | ChatGPT OAuth (PKCE, pasted callback URL) |
| POST | `/ai/transcribe` | voice dictation |
| POST | `/ai/translate` | translate paragraph texts for the viewer's translated view (`{texts, lang, model, effort, stream}` → `{translations}`; with `stream: true` an NDJSON stream of `{i: [indices], text}` partials as each paragraph is written, then the same final object; in-memory per-paragraph cache) |
| GET | `/pdf-text-status` | whether a doc has extractable text |

### Chats (`chats.py`, prefix `/api/chats`)

`GET /chats/{page_id}?share=<token>` exposes only the shared page's active
saved conversation, subject to the link's audience. Shared pages show this in
a read-only AI chat window on desktop and mobile, with search and copy.
Chat mutations reject share tokens, including links that allow page editing;
archived conversation browsing remains session-only.
| Method | Path | Purpose |
|---|---|---|
| GET/PUT/DELETE | `/chats/{key:path}` | the ACTIVE conversation per bucket: page id, `home`, or `home:<folder>` (hence `:path`); GET → `{messages, title}`, PUT `{messages, title?}` (title omitted = keep) |
| POST | `/chats/folder-rename` | migrate folder buckets (active + history) on rename/move/delete (`{src, dst}`, dst `""` deletes) |
| GET | `/chat-history?bucket=` | the bucket's archived conversations, newest first (`{sessions: [{id, title, preview, count, created_at, updated_at}]}`) |
| POST | `/chat-history/archive` | "New chat": file `{bucket, messages, title}` into history and clear the active row (→ `{id}`, null when empty) |
| POST | `/chat-history/{id}/open` | make an entry the active conversation; the body's `{bucket, messages, title}` (the current one) is archived first (→ `{messages, title}`) |
| PUT/DELETE | `/chat-history/{id}` | rename (`{title}`) / delete an archived conversation |

### Import & export (`imports.py`, `export.py`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/import/logseq` | Logseq .pdf + .edn import |
| POST | `/import/markdown` | UTF-8 `.md`/`.markdown` file → note page and nested blocks (optional `folder`; a front-matter `folder:` files it below that) |
| POST | `/import/markdown-zip` | zip of Markdown notes → one page per `.md` (multipart `file`, optional `folder` prefix): Obsidian vaults (wikilinks/embeds → mentions and synced blocks, `^id` anchors and headings as link targets, `tags` → labels, `aliases` kept, comments and fold markers dropped, `.obsidian/` skipped), Notion "Markdown & CSV" exports (subpage folders → folder labels, databases → table pages, links → mentions, images uploaded), Gamma Markdown / Obsidian exports (folder/source/meta/bibtex restored) or any zipped notes. Idempotent by file digest / `notion_id`; the report says `obsidian: true` for a vault |
| POST | `/markdown-blocks` | parse markdown text into a `{content, children}` tree without storing anything (the editor's paste-as-blocks helper; same parser as `/import/markdown`, 5 MB cap) |
| POST | `/import/pdf-annotations` | import annotations embedded in the PDF (idempotent; optional `strip`) |
| POST | `/import/zotero` | Zotero library import: zip of a "Zotero RDF" export (multipart `file`; `strip`, optional `folder` prefix). Items→pages+metadata, collections→folders, tags→labels, notes→blocks; embedded annotations via the same importer. Idempotent by file hash / `zotero_key` |
| GET | `/pages/{id}/export` | page export (`?mode=readable|obsidian|notes-pdf|logseq-graph|zotero-rdf|gamma` + `highlights=&notes=&pdf=`); `obsidian` = a vault zip (`<folder>/<Title>.md`, wikilinks, `attachments/`, `.obsidian/app.json`); `notes-pdf` = the notes typeset as their own PDF (works without a paper); `gamma` = scoped backup for `/import-data?mode=merge` |
| GET | `/pages/{id}/export-pdf` | the page's own PDF with annotations written back (`?highlights=&notes=`), including native PencilKit preview/replay pictures as raster page content; `X-Native-Ink-Drawn` counts those separately from `X-Annotations-Written`. Does not mutate the stored PDF; format/fidelity limits are in [import_export.md](import_export.md) |
| GET | `/folders/export` | whole-folder export, same modes/flags (`?name=` + `mode=`); subfolders become Zotero collections or vault directories, `notes-pdf` one PDF for the whole folder |
| GET | `/folders/export-progress` | per-page progress of a running folder export (`{active, total, done, title}`) |

### Prefs (`prefs.py`)
| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/prefs/{key}` | small synced JSON KV per account: `open-tabs`, `recent-views`, `pinned-folders`, `read-pos` are stored per workspace (the request's), `appearance` / `ai-provider` account-wide (`db.USER_PREF_KEYS`); refuses the reserved `ai-settings` key |
| GET | `/page-snaps` | all recents-card cover thumbnails `{snaps: {pageId: {img, at}}}`; `?after=<iso>` returns only newer ones (the focus-pull delta) |
| PUT | `/page-snaps/{page_id}` | store a cover (JPEG data URL body `{img, at}`; per-page newest-`at` wins, count-capped server-side) |
| DELETE | `/page-snaps/{page_id}` | drop a cover (the recents card's ×) |

### Integrations and MCP (`routers/integrations.py`, `mcp_oauth.py`, `mcp_server.py`) — see [mcp.md](mcp.md)
| Method | Path | Purpose |
|---|---|---|
| GET | `/integrations/tokens` | the current workspace's assistant connections (manual tokens and OAuth grants: id, name, dates), the MCP URL and whether browser sign-in is available; session only, never a guest |
| POST | `/integrations/tokens` | mint a manual token `{name}` (shown once); at most 20 unexpired per account |
| DELETE | `/integrations/tokens/{id}` | revoke a connection |
| GET | `/integrations/oauth/request?request_id=` | the pending consent (client name, the account's workspaces) for the consent screen |
| POST | `/integrations/oauth/consent` | approve or deny a pending sign-in for one workspace |
| GET | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` | OAuth discovery for MCP clients (no `/api` prefix) |
| POST | `/oauth/register`; GET `/oauth/authorize`; POST `/oauth/token` | dynamic client registration, the authorization redirect, the PKCE code exchange (no `/api` prefix) |
| POST | `/mcp` | the Streamable HTTP MCP endpoint (bearer token or OAuth access token; no `/api` prefix, browser origins refused) |

### Publisher sessions (`routers/publisher_sessions.py`) — see [extension.md](extension.md)
| Method | Path | Purpose |
|---|---|---|
| GET | `/publisher-sessions` | the account's connected publisher hosts (metadata only) and the supported roots |
| POST | `/publisher-sessions` | store a cookie snapshot for one host (JSON, 256 KiB cap; HTTPS or localhost, personal accounts only) |
| DELETE | `/publisher-sessions/{host}` | forget a host |

### Admin (`admin.py`, prefix `/api/admin`)
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/admin/users` | list (with usage and `default_workspace`) / create accounts (+ personal workspace) |
| PUT/DELETE | `/admin/users/{name}` | password, admin flag, storage overrides / delete (+ the workspaces only they owned, listed as `deleted_workspaces`) |
| POST | `/admin/users/{name}/rename` | rename (rows only — no files move; sessions survive) |
| GET | `/admin/workspaces` | every workspace (kind, access, public role, quota, `personal` = its account or "", `default`, members, upload size), plus orphan directories — Settings → Workspaces |
| GET/POST | `/admin/backups` | list the whole-data-directory snapshots under `backups/` / take one now (`{label?, uploads?}` — databases, plus every upload with `uploads: true`); per-workspace snapshots are `/workspaces/{id}/backups` |
| GET | `/admin/backups/{name}/download` | the snapshot as a zip |
| DELETE | `/admin/backups/{name}` | delete a snapshot (restoring is `manage.py backups --restore`, server stopped — [migrations.md](migrations.md)) |
| GET/PUT | `/admin/settings` | server-wide storage defaults, plus `public_url` / `public_url_source` (the admin-confirmed public server URL, [mcp.md](mcp.md)) |
| GET | `/admin/logs?after=<seq>` | scrubbed in-memory server log |

Rails: the guest account is untouchable, no self-delete, the last admin
can't be demoted or deleted.

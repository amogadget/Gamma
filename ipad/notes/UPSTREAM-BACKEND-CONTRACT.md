# Upstream backend HTTP contract — reference for the native iPad (Swift/PDFKit) port

Scope: the HTTP contract of the **upstream** backend in this repository
(branch `integrate/tim-native-replay`, based on `tim/main` = `5f266eb`), as it affects a native iPad client.
Trees inspected: `backend/gamma/` (all of `auth.py`, `workspaces.py`, `app.py`, `storage.py`, `config.py`,
`db.py` excerpts, `ops.py`, `blocks_store.py`, `server_settings.py`, `ratelimit.py`, `pdf_meta.py`, `ink.py`),
all of `backend/gamma/routers/*.py`, `docs/dev/{api,workspaces,handwriting}.md`, `docs/research/workspaces.md`,
`frontend/src/shared/lib/utils.js`, plus the native client in `ipad/` (untracked) and the legacy backend
variants on local branches `main` / `ipad-app` / `client-app`.

**Method / honesty note.** Everything below is read from source, with `file:line` references. No request was
executed: this worktree has no virtualenv and `fastapi` is not importable (`python3 -c "import fastapi"` →
`ModuleNotFoundError`), and the task forbids modifying files. Framework-generated error bodies (FastAPI's
`{"detail": ...}` envelope) are derived from the code paths, not from a live probe. Where a claim is inferred
rather than read directly, it is marked **[inferred]**.

**Baseline caveat.** The description below is upstream `tim/main` @ `5f266eb` as it read at the time of writing.
While this document was being produced, the port work began landing *uncommitted* in the same worktree
(`backend/gamma/storage.py` and `frontend/src/shared/lib/utils.js` modified; `backend/gamma/native_ink.py`,
`frontend/src/native/`, `frontend/src/shared/lib/assetUrl.js` added), so line numbers in those two files — and
any "does not exist" statement about native routes — will drift as that work continues.

---

## 0. The headline: the native client targets a *different* backend contract

The iPad client in `ipad/` was written against the **legacy native lineage** (local branches `main`,
`ipad-app`, `client-app`), *not* against upstream `tim/main`:

| | Legacy native lineage (`main` / `ipad-app`) | Upstream `tim/main` (this worktree) |
|---|---|---|
| Identity | username only (`require_user`), per-user directories `users/<user>/` | **account + workspace**: session cookie + `?ws=` / `X-Gamma-Workspace` |
| Block ids | canonical lowercase **UUID** (`ipad/GammaIPad/Server/GammaAPI.swift:180`, legacy `ink.py:252`) | `secrets.token_urlsafe(9)` — 12-char base64url, minted by client or server (`routers/blocks.py:339`) |
| Assets | `POST/GET /api/assets`, content-addressed `<sha256-64hex>.<ext>` | **no such route**; `POST /api/upload-file` \| `/upload-image` \| `/upload-ink` → `GET /api/uploads/<sha256-24hex><ext>` |
| Ink/audio/note/highlight writes | `PUT /api/blocks/{id}/{ink,audio,note,highlight,replay-preview}` with `expected_revision` CAS | **none of these routes**; writes go through `POST /api/blocks`, `PUT /api/blocks/{id}` (properties PATCH) and the op path `POST /api/pages/{id}/ops` |
| Workspaces API | absent | `POST/GET/PUT/DELETE /api/workspaces*` (full model) |

Verified with `git grep` on the branches:

```
main:backend/gamma/routers/ink.py:119      @router.post("/assets")
main:backend/gamma/routers/ink.py:182      @router.get("/assets/{filename}")
main:backend/gamma/routers/ink.py:245      @router.put("/blocks/{block_id}/ink")
main:backend/gamma/routers/ink.py:320      @router.put("/blocks/{block_id}/replay-preview")
main:backend/gamma/routers/ink.py:420      @router.put("/blocks/{block_id}/audio")
main:backend/gamma/routers/ink.py:500      @router.put("/blocks/{block_id}/note")
main:backend/gamma/routers/native_highlights.py:57   @router.put("/blocks/{block_id}/highlight")
```

None of these exist under `backend/gamma/routers/` in this worktree, and the legacy lineage has **no workspace
concept at all** (`grep -n 'X-Gamma-Workspace\|WORKSPACE_HEADER' main -- backend/gamma/auth.py` → no matches;
`main:backend/gamma/app.py:109-126` mounts no workspaces router).

Practical consequence, confirmed empirically on the deployed server and recorded in `ipad/VALIDATION.md:81`:
`POST /api/assets` and `PUT /api/blocks/{id}/ink` answered **405** (not 404), because the SPA catch-all
(`GET /{path:path}`, `backend/gamma/app.py:157`) matches those paths for a different method. The native
client maps 405/501 to `serverUpgradeRequired` (`ipad/GammaIPad/Server/GammaAPI.swift:210`).

---

## 1. Session/identity contract

### 1.1 Cookie, middleware, session lifetime

- Cookie name: **`session`** — `SESSION_COOKIE = "session"` (`backend/gamma/auth.py:28`).
- Flags: `HttpOnly`, `SameSite=Lax`, `Max-Age = 31536000` (1 year, `SESSION_MAX_AGE`, `auth.py:29`),
  `Secure` **only when the request is HTTPS** (scheme or `X-Forwarded-Proto: https`) — `auth.py:44-50, 120-127`.
  A native client talking plain HTTP to a LAN host receives the cookie without `Secure`; over HTTPS it does.
- `session_middleware` (`auth.py:148-221`) sets `request.state.{user,is_guest,is_admin,default_ws}`.
  Server-side expiry is enforced against `SESSION_MAX_AGE`; expired rows are deleted (`auth.py:166-171`).
- Guest sessions are date-stamped: on the first request of a new UTC day the middleware deletes guest
  sessions, wipes and re-seeds the guest workspace, and issues a fresh cookie on that response
  (`auth.py:174-186, 219-220`).

### 1.2 `X-Gamma-User` tab-identity guard (the native client already sends this)

`auth.py:196-206`: if the request carries header `X-Gamma-User` (**case-insensitive lookup**, exact wire name
`X-Gamma-User`) **and** the path starts with `/api/`, and its value differs from the resolved session user
(`""` when signed out), the request is refused **before the handler runs**:

```
HTTP/1.1 409 Conflict
X-Gamma-Session-User: <current session user, "" when signed out>
{"detail": "This tab is signed in as \"<header value>\", but the browser session is now \"<user>\"|signed out. Reload the tab to continue."}
```

Exemptions: the header is not sent to `/api/login`, `/api/login-guest`, `/api/logout`, `/api/session` by the web
frontend (`frontend/src/shared/lib/utils.js:64`), and the native client skips the same four paths
(`ipad/GammaIPad/Server/GammaAPI.swift:188`). Note the guard itself only requires the header to be *present*
and mismatching; a request without the header behaves as before.

### 1.3 Anonymous / identity-only endpoints

- `GET /api/health` → `{"ok": true}`, **no auth** (registered directly on the app, `app.py:108-110`).
- `require_user(request)` → session username, else **401** (`auth.py:224-230`, raise is bare
  `HTTPException(status_code=401)` → body `{"detail":"Unauthorized"}`).
- `require_admin` → 401 then **403** `{"detail":"admin privilege required"}` (`auth.py:233-238`).
- Login throttling: 10 hits / 300 s per IP and per username → **429** with
  `{"detail":"Too many attempts. Wait a bit and try again."}` and a `Retry-After` header
  (`ratelimit.py:28-42`, used at `routers/auth.py:169-170`; guest login 20/300 s at `routers/auth.py:238`).

### 1.4 Session endpoints

| Method | Path | Body | Response | Ref |
|---|---|---|---|---|
| POST | `/api/login` | `{"username","password"}` | `{"ok": true, "username": "<name>"}` + `Set-Cookie: session=…`; 401 `{"detail":"invalid credentials"}` for bad creds or a guest account | `routers/auth.py:164-191` |
| POST | `/api/logout` | — | `{"ok": true}` + cookie delete | `routers/auth.py:194-203` |
| GET | `/api/session` | — | signed out: `{"user": null}`; signed in: `{"user", "is_guest", "is_admin", "default_workspace", "workspaces": [...]}` | `routers/auth.py:206-217` |
| POST | `/api/login-guest` | — | `{"ok": true, "username": "guest"}` + cookie | `routers/auth.py:232-250` |
| GET | `/api/accounts` | — | `{"accounts":[{"username","is_admin"}]}`, non-guest accounts; guest 403 | `routers/auth.py:220-229` |

---

## 2. Workspace identity (the part the native client does not implement yet)

Module docstring: `auth.py:1-13`; model: `backend/gamma/workspaces.py`; prose: `docs/dev/workspaces.md:98-127`.

### 2.1 How a request names its workspace

```python
WORKSPACE_HEADER = "x-gamma-workspace"                     # auth.py:30  (lowercase constant: title case is prepended, case-insensitive on the wire)

def requested_ws(carrier) -> str:                          # auth.py:243-248
    return (carrier.query_params.get("ws") or carrier.headers.get(WORKSPACE_HEADER) or "").strip()
```

- Exact wire names: query parameter **`ws`**, header **`X-Gamma-Workspace`** (matched case-insensitively via
  the lowercase constant above; the web frontend sends `X-Gamma-Workspace`, the native client would too).
- **Precedence: `?ws=` first, then the `X-Gamma-Workspace` header** — a truthiness chain, so an empty string
  falls through. Proven by test: `?ws=<A>` with header `<B>` returns data from `<A>`
  (`backend/tests/test_workspaces.py:69-71`).
- `.strip()` is applied to the winner; the value is otherwise used verbatim (no id-shape validation at this
  point — validation happens later when it becomes a filesystem path, `db.safe_ws_id`, `db.py:53-57`).
- `carrier` is a `Request` **or** a `WebSocket` — the same helper resolves the identity for the page socket
  (`routers/collab.py:92`).
- Resolution of the *chosen* id: `workspace_access(username, requested, default_ws)` →
  `ws = requested or default_ws or workspaces.ensure_personal(username)` then `role_of(ws, username)`
  (`auth.py:251-258`). `default_ws` is the session row's `users.default_workspace` (`auth.py:190`).
- `role_of` (`workspaces.py:106-124`): explicit membership role wins; otherwise a **public** shared workspace
  grants `public_role` (`viewer`/`editor`) to any signed-in **non-guest**; otherwise `None`.
  `at_least()` ranks viewer 1 < editor 2 < owner 3 (`workspaces.py:42-43, 127-128`).

### 2.2 The four helper gates

| Helper | Semantics | Ref |
|---|---|---|
| `require_user(request)` | session username only; 401 without | `auth.py:224-230` |
| `require_ws(request, write=False)` | any effective role; 401 / 403; caches `request.state.ws` + `ws_role` | `auth.py:261-275` |
| `require_ws(request, write=True)` | role must not be `viewer` | `auth.py:273-274` |
| `resolve_ws(request)` | if `?share=` present → the share's workspace (else `_share_denied`); otherwise `require_ws` | `auth.py:416-426` |
| `require_ws_writer(request)` | if `?share=` present → needs `edit` on the token (403 `"this share link is view-only"`), else `require_ws(write=True)` | `auth.py:429-441` |
| `share_scope_page(request)` | the page id a `?share=` request is confined to, else `None` | `auth.py:400-413` |
| `ws_role(request)` | the resolved role, or `None` | `auth.py:278-281` |

`require_ws` memoizes on `request.state.ws` / `request.state.ws_role`, so calling it twice in one request costs
one lookup; but `request.state.ws_role` is read **outside** the `if`, so a pre-set `request.state.ws` without a
role raises 403.

### 2.3 Exact error matrix (missing / unknown / forbidden workspace)

| Situation | Status | Body | Ref |
|---|---|---|---|
| No/stale session cookie | **401** | `{"detail":"Unauthorized"}` | `auth.py:227-229` (bare raise ⇒ FastAPI fills the status phrase) |
| `?ws=`/header names a workspace the account has **no effective role** in — this includes a **nonexistent** id | **403** | `{"detail":"you are not a member of this workspace"}` | `auth.py:271-272` |
| Explicit workspace is not a member, but **no fallback** to another library | same 403 | — | by design, `docs/dev/workspaces.md:112-113` |
| Role is `viewer` on a write helper | **403** | `{"detail":"you can only view this workspace"}` | `auth.py:273-274` |
| `?share=` unknown / not permitted, **not signed in** (or guest) | **401** | `{"detail":"Unauthorized"}` | `auth.py:391-397` |
| `?share=` unknown / not permitted, **signed in non-guest** | **403** | `{"detail":"not accessible via this share link"}` | `auth.py:391-397` |
| `?share=` view token on a write helper | **403** | `{"detail":"this share link is view-only"}` | `auth.py:439-440` |
| Share-scoped request touches another page/asset | **403** | `{"detail":"not accessible via this share link"}` | `blocks_store.py:125-134`, `routers/uploads.py:135-136,166-167`, `routers/blocks.py:188-189,209-211,285-286` |
| `X-Gamma-User` mismatch | **409** | see §1.2 | `auth.py:196-206` |
| **Management** API `/api/workspaces/{id}` with a non-member (or unknown id) | **404** | `{"detail":"workspace not found"}` — deliberately does *not* reveal existence (unlike the data helpers' 403) | `routers/workspaces.py:44-58`; test `tests/test_workspaces.py:78` |
| Admin-only management action by a non-admin | **403** | `{"detail":"only a server admin can …"}` | `routers/workspaces.py:61-63` |

### 2.4 Back-compat: an omitted workspace still works

- **Omitting `?ws=` and the header is fully supported** and lands in the account's `default_workspace`
  (`auth.py:257`; `docs/dev/workspaces.md:111`; `docs/research/workspaces.md:37-40` states this explicitly as
  the design reason the old single-library behaviour survives). This is the path the legacy iPad client
  effectively uses today.
- If the account somehow has no default (or its `pages.db` is missing), `workspaces.ensure_personal()`
  **creates** a personal workspace and records it on the `users` row on the spot (`workspaces.py:228-245`).
- Some endpoints deliberately require **no** workspace: `POST /api/login`, `/api/logout`, `/api/session`,
  `/api/accounts`, `/api/workspaces*`, `/api/admin/*`, `/api/ai/*` provider CRUD, and the prefs keys in
  `db.USER_PREF_KEYS = {"ai-settings","ai-provider","appearance"}` (`db.py:263-267`,
  `routers/prefs.py:57-72`). `GET /api/session` calls `ensure_personal` too (`routers/auth.py:216`).
- Legacy `?user=` targeting (admin only) exists on the backup endpoints: `GET /api/export`,
  `/api/export-progress`, `POST /api/import-data` accept `ws` **or** `user`
  (`routers/auth.py:34-58, 65-79, 135-146`).
- There is **no** `?user=` fallback for data reads any more — `docs/dev/api.md:19-21` records it was removed
  because it trusted any username and leaked accounts.

### 2.5 Workspace list shapes (exact)

`GET /api/session` → `workspaces` is the **array** from `workspaces.list_for_user(user)`
(`workspaces.py:131-157`, called at `routers/auth.py:217`):

```jsonc
{
  "user": "ann", "is_guest": false, "is_admin": false,
  "default_workspace": "<id>",
  "workspaces": [
    { "id": "<id>", "name": "Ann", "created_by": "ann", "created_at": "2026-…Z",
      "kind": "personal" | "shared", "access": "private" | "public",
      "public_role": "viewer" | "editor", "quota_mb": null | <int>,
      "role": "owner" | "editor" | "viewer",          // effective role, never null here
      "members": 3,                                    // COUNT of explicit members (an int here)
      "personal": true|false,                          // kind == "personal"
      "default": true|false }
  ]
}
```

Sort order (`workspaces.py:156`): personal first, then the default, then case-insensitive name.
Public workspaces appear for every signed-in non-guest even without membership; a guest sees only its own.
A workspace the caller cannot open never appears (`role` falsy rows are skipped, `workspaces.py:152-153`).

`GET /api/workspaces/mine` (`routers/workspaces.py:120-127`) → every accessible workspace with `used_bytes`,
plus account storage:

```jsonc
{ "workspaces": [ { …same fields as above…, "used_bytes": 12345 } ],
  "account": { "max_upload_mb": 50, "quota_mb": 0, "used_bytes": 999, "username": "ann" } }
```

`GET /api/workspaces/{id}` (`routers/workspaces.py:141-146`, `_payload` at `:80-89`) → the workspace row plus:

```jsonc
{ "id","name","created_by","created_at","kind","access","public_role","quota_mb",
  "role": "owner"|"editor"|"viewer"|null,   // null for an admin who is not a member
  "personal_of": "<account>" | "",          // the owning account of a personal workspace
  "default": true|false,                    // is it the CALLER's default
  "members": [ {"username","role","added_by","added_at"} ],   // ARRAY here, count in /session
  "quota": { "max_upload_mb":…, "quota_mb":…, "used_bytes":…, "workspace_bytes":…, "account":"ann"|"" } }
```

Note the deliberate asymmetry documented at `docs/dev/workspaces.md:147-149`: `members` is a **count** in
`/api/session` and `/api/workspaces/mine`, an **array** in workspace details. `personal` (bool) in the list vs
`personal_of` (username) in details.

Workspace CRUD probes (all 401-safe, 403/404 as above):

| Method | Path | Notes | Ref |
|---|---|---|---|
| POST | `/api/workspaces` | `{name, kind?, owner?, access?, public_role?, quota_mb?}`; guests 403; non-personal/other-owner/access needs admin; 400 `"too many workspaces"` past `MAX_WORKSPACES_PER_USER = 50` | `routers/workspaces.py:92-117`, `workspaces.py:48` |
| GET | `/api/workspaces/mine` | see above | `:120` |
| GET | `/api/workspaces/find-page/{page_id}` | → `{"workspace_id": "<id>"}`, 404 when none of the caller's workspaces holds it (deep links without `ws`) | `:130-138`, `workspaces.py:451-463` |
| GET/PUT/DELETE | `/api/workspaces/{id}` | PUT body `{name?, default?, kind?, access?, public_role?, quota_mb?}`, atomic; owner for rename/default, admin for kind/access/quota | `:141-177` |
| PUT/DELETE | `/api/workspaces/{id}/members/{username}` | `{role}`; last-owner and personal-workspace rails; DELETE returns `{"ok":true,"left":bool}` | `:180-204` |
| GET/POST/… | `/api/workspaces/{ws}/backups…` | per-workspace snapshots (any member lists/downloads, owner creates/deletes/restores-replace, editor merge) | `routers/ws_backups.py:37-88` |
| GET | `/api/admin/workspaces` | admin inventory incl. orphan dirs | `routers/admin.py:127` |

---

## 3. How the web frontend supplies workspace identity (grep result)

`X-Gamma-Workspace` appears in exactly these places:

| Location | What it does |
|---|---|
| `backend/gamma/auth.py:30` | `WORKSPACE_HEADER = "x-gamma-workspace"` — the only server-side definition |
| `backend/gamma/auth.py:248` | server read: `carrier.query_params.get("ws") or carrier.headers.get(WORKSPACE_HEADER)` |
| `frontend/src/shared/lib/utils.js:91` | **the fetch wrapper** injects `X-Gamma-Workspace: <currentWorkspace>` on every same-origin `/api/*` call, except `AUTH_PATHS` (`/api/login`, `/api/login-guest`, `/api/logout`, `/api/session` — `utils.js:64`) |
| `frontend/src/shared/lib/utils.js:31,35` | `setCurrentWorkspace()` / `getCurrentWorkspace()` — module-level "which library this tab works in", set once by `App.jsx:408` once the session resolves |
| `frontend/src/shared/lib/utils.js:41-44` | `withWorkspace(url)` appends **`?ws=<id>`** to in-app URLs (links, history, copied links, the socket URL) — the header cannot travel with an `<img>`, a WebSocket handshake, or a copied link |
| `frontend/src/shared/lib/utils.js:52-53` | `assetUrl()` = `withShare(withWorkspace(url))` — every render site of a bare `/api/uploads/…` URL passes through it, otherwise a non-default workspace's image 404s |
| `frontend/src/app/App.jsx:649-651` | the backup-import XHR sets `X-Gamma-Workspace` by hand (it bypasses `fetch`) |
| `frontend/src/transfers/FileChip.jsx:116-120` | the upload XHR: `withShare(withWorkspace(endpoint))` + the same header |
| `frontend/src/collaboration/usePageCollab.js:16-17` | socket URL `${API}/ws/page/{id}?client=…` then `withShare(base) === base ? withWorkspace(base) : withShare(base)` → **`?ws=` or `?share=`, never the header** |
| `frontend/src/pdf/PdfViewer.jsx:209` | `/api/pdf-info/{id}` fetched through `withWorkspace` |
| `docs/dev/workspaces.md:122-126` | states the rule: header for fetches, `?ws=`/`?share=` for browser-issued asset URLs and the socket |

So: **header on API fetches (POST/PUT/GET via `fetch`/XHR), `?ws=` on any URL the browser fetches outside the
wrapper** (images, downloads, WebSocket handshake). A native client must apply both rules itself; it currently
applies neither.

---

## 4. Route inventory (upstream, complete)

From `create_app()` — router mount order `backend/gamma/app.py:106-136`; every router prefixes its own paths.
There is **no global prefix** and **no exception handler** registered, so every `HTTPException` surfaces as
FastAPI's `{"detail": …}` envelope, and Pydantic validation failures as 422 with FastAPI's standard body.

Mounted routers (`app.py:112-136`): `auth`, `admin`, `workspaces`, `ws_backups`, `ai`, `chats`,
`chats.history_router`, `prefs`, `integrations`, `mcp_oauth`, MCP route, `metadata`, `search`, `shares`, `pdf`,
`publisher_sessions`, `uploads`, `ink`, `blocks`, `pages`, `imports`, `export`, `links`, `clip`, `collab`.
Then, **last**, the SPA catch-all `GET /{path:path}` (only when `GAMMA_STATIC_DIR` is set and exists,
`app.py:138-169`).

| Method | Path | Router file:line |
|---|---|---|
| GET | `/api/health` | `app.py:108` (no auth) |
| GET/POST/PUT/DELETE | `/api/export`, `/api/export-progress`, `/api/export-all`, `/api/import-data` | `routers/auth.py:65,72,105,135` |
| POST/GET | `/api/login`, `/api/logout`, `/api/session`, `/api/accounts`, `/api/login-guest` | `routers/auth.py:164,194,206,220,232` |
| POST/GET/PUT/DELETE | `/api/workspaces*` (8 routes) | `routers/workspaces.py:92,120,130,141,149,167,180,192` |
| GET/POST/DELETE | `/api/workspaces/{ws}/backups*` (5 routes) | `routers/ws_backups.py:37,46,58,68,82` |
| GET/PUT/DELETE | `/api/admin/{logs,settings,users,workspaces,backups…}` (13 routes) | `routers/admin.py:83-302` |
| GET/POST/PUT/DELETE | `/api/ai/*` (14 routes), `/api/pdf-text-status` | `routers/ai.py:171-1167` |
| GET/PUT/DELETE | `/api/chats/*`, `/api/chat-history/*` | `routers/chats.py:97-255` |
| POST/GET | `/api/search-reindex`, `/api/tasks`, `/api/search`, `/api/pdf-search` | `routers/search.py:106,132,142,178` |
| POST/GET/PUT/DELETE | `/api/share/{page_id}`, `/api/share-settings/{page_id}`, `/api/share/{token}` | `routers/shares.py:117,141,151,168,178` |
| POST/GET | `/api/resolve-pdf`, `/api/pdf` | `routers/pdf.py:127,287` |
| GET/POST/DELETE | `/api/publisher-sessions*` | `routers/publisher_sessions.py:20,26,48` |
| GET/POST | `/api/quota`, `/api/uploads`, `/api/upload-image`, `/api/upload-file`, `/api/pdf-info/{doc_id}`, `/api/uploads/{filename}` (GET+HEAD) | `routers/uploads.py:29,39,54,78,123,147` |
| POST | `/api/upload-ink` | `routers/ink.py:13` |
| GET/POST/PUT/DELETE | `/api/blocks*`, `/api/block-search` | `routers/blocks.py:122,181,195,206,263,280,311,337,376,394,420,453` |
| POST/DELETE | `/api/pages`, `/api/pages/by-docs`, `/api/pages/from-file`, `/api/pages/{id}/attachment` | `routers/pages.py:62,80,100,131,178` |
| POST | `/api/import/{logseq,markdown,markdown-zip,pdf-annotations,zotero}`, `/api/markdown-blocks` | `routers/imports.py:40,151,168,489,626,190` |
| GET | `/api/pages/{id}/export`, `/export-pdf`, `/api/folders/export`, `/export-progress` | `routers/export.py:686,719,785,801` |
| GET | `/api/link-preview` | `routers/links.py:46` |
| POST/GET | `/api/clip`, `/api/clip/note`, `/api/library/{lookup,preview,folders}` | `routers/clip.py:249,413,338,356,374` |
| GET/PUT/DELETE | `/api/prefs/{key}`, `/api/page-snaps`, `/api/page-snaps/{page_id}` | `routers/prefs.py:57,65,98,105,118` |
| GET/POST | `/api/metadata/{status,fetch,update,cite}` | `routers/metadata.py:684,752,933,980` |
| GET/PUT/DELETE | `/api/integrations/tokens*` | `routers/integrations.py:31,49,59` |
| POST/GET, WS | `/api/pages/{page_id}/ops`, `/api/ws/page/{page_id}` | `routers/collab.py:27,52,107` |
| MCP | `/mcp` (and OAuth routes) | `app.py:121-122`, `mcp_oauth.py` |

---

## 5. Fragment-by-fragment grep (as requested)

Searched `backend/gamma/**` for each path fragment. "Exists" means an actual route in this worktree.

| Fragment | Upstream result |
|---|---|
| `/api/assets` | **Does not exist.** Only `assets/` as an *export directory prefix* and ink SVs: `routers/export.py:125,248,363`, `markdown_export.py:243`. The legacy `/api/assets` POST/GET lives on branches `main`/`ipad-app` (`ink.py:119,182`), not here. |
| `/api/workspaces` | **Exists** — `APIRouter(prefix="/api/workspaces")`, 8 routes (`routers/workspaces.py:19,92-194`) + 5 backup routes under the same prefix (`routers/ws_backups.py:17`). |
| `/ink` | **No route contains `/ink`.** The only ink route is `POST /api/upload-ink` (`routers/ink.py:10,13`); ink *files* are served as `/api/uploads/<hash>.ink` (media type `application/json`, `storage.py:29`). Legacy `PUT /api/blocks/{id}/ink` is on `main`/`ipad-app` only. |
| `/audio` | **Does not exist** anywhere in the backend (no route, no media handler beyond `.mp3/.wav/.mp4` in `FILE_MEDIA_TYPES`, `storage.py:57-59`). Legacy `PUT /api/blocks/{id}/audio` is on `main`/`ipad-app` only. Audio has **no** block type or property in upstream. |
| `/note` | Only `POST /api/clip/note` (`routers/clip.py:413`, "clip into page"). No `PUT /api/blocks/{id}/note` upstream (legacy only). Note pages are ordinary root blocks. |
| `/highlight` | **No route.** Highlights are blocks whose `properties.highlight_id` (+ `pdf_position`, `pdf_page`, `color`, `quote`) are set; created with `POST /api/blocks` (`docs/dev/block_centric.md:54`, `frontend/src/shared/model/blockModel.js:265-275`). Legacy `PUT /api/blocks/{id}/highlight` is `main:routers/native_highlights.py:57` only. |
| `replay-preview` | **Does not exist** upstream. Legacy only (`main:routers/ink.py:320`). |
| `offline` | **No route, no server concept.** Offline is purely a client concern (`ipad/GammaIPad/Storage/GammaOfflineCache.swift`); the server has no sync/cursor endpoint beyond the op log (§7). |
| `manifest` | **No route named manifest.** The PDF "manifest" the viewer lays out from is `GET /api/pdf-info/{doc_id}` → `{doc_id, bytes, pages, dims}` (`routers/uploads.py:123-141`, `pdf_meta.py:44-101`). `ws_backup` ZIPs contain a manifest internally (`docs/dev/workspaces.md:174-176`) but that is not HTTP. |
| `prefs` | `GET/PUT /api/prefs/{key}` (`routers/prefs.py:57,65`); key shape `^[a-z0-9][a-z0-9_-]{0,63}$`, `ai-settings` refused (400 `{"detail":"invalid pref key"}`), value ≤ 64 KiB (413 `{"detail":"pref value too large"}`). Reserved per-account keys skip the workspace check (`prefs.py:61,71` + `db.py:263-267`). |
| `imports` | Routes are singular **`/api/import/...`** (`routers/imports.py:40,151,168,489,626`) plus `/api/markdown-blocks` (`:190`). There is no `/api/imports`. |
| `clip` | `POST /api/clip` (`routers/clip.py:249`), `POST /api/clip/note` (`:413`), `GET /api/library/{lookup,preview,folders}` (`:338,356,374`). All session-only, never share-readable; they land in the request's workspace (`docs/dev/api.md:212-213`). |
| `pdf` | `POST /api/resolve-pdf` (`routers/pdf.py:127`), `GET /api/pdf` proxy (`:287`), `GET /api/pdf-info/{doc_id}` (`routers/uploads.py:123`), `GET /api/pdf-search` (`routers/search.py:178`), `GET /api/pdf-text-status` (`routers/ai.py:171`), `GET /api/pages/{id}/export-pdf` (`routers/export.py:719`). |

---

## 6. Upload & asset contract (what replaces `/api/assets`)

Storage layout: `GAMMA_DATA_DIR/workspaces/<ws>` (`config.py:11-14`), uploads in `ws_uploads_dir(ws) = ws_dir(ws)/"uploads"`
(`db.py:300-315`). Names are **content hashes**: `DIGEST_CHARS = 24` hex of sha256 (`storage.py:107,135-136`),
i.e. **`<24 hex><ext>`**, not the legacy 64-hex `<sha256>.<ext>`.

| Method | Path | Auth | Request | Response | Errors | Ref |
|---|---|---|---|---|---|---|
| POST | `/api/uploads` | `require_ws(write=True)` | multipart, field **`file`** | `{"doc_id","source_url":"/api/uploads/<id>.pdf","size","already_existed"}` | 400 `"not a valid PDF (missing %PDF header)"`, 403 viewer, 413/507 quota | `routers/uploads.py:39-51` |
| POST | `/api/upload-image` | `require_ws_writer` | multipart `file` with an image content type | `{"url":"/api/uploads/<hash><ext>","size","already_existed"}` | 400 `"unsupported image type: <ct>"`; allowed types `image/png,jpeg,gif,webp,svg+xml` | `:54-75`, `storage.py:14-16` |
| POST | `/api/upload-file` | `require_ws_writer` | multipart `file` (any name; extension from the **uploaded filename**) | `{"url":"/api/uploads/<hash><ext>","name","size","already_existed"}` | 400 for a blocked executable extension (`"… files are not accepted (executable)"`) or a `.pdf` that is not a PDF | `:78-102`, `storage.py:64-102` |
| POST | `/api/upload-ink` | `require_ws_writer` | **raw JSON body** (`await request.body()`), the `gamma-ink` v1 file | `{"url":"/api/uploads/<hash>.ink","size","strokes","bbox","pdf_position","already_existed"}` | 400 `"invalid ink file: …"` | `routers/ink.py:13-34` |
| GET | `/api/pdf-info/{doc_id}` | `resolve_ws` + share scope | — | `{"doc_id","bytes","pages","dims":[[w,h],…]}` in PDF points; `Cache-Control: private, max-age=86400` when `pages>0`, else `no-store` | 400 `"invalid document id"` (non-hex), 404 `"not found"`, 403 share-scope | `routers/uploads.py:123-141`, `pdf_meta.py:44-101` |
| GET, **HEAD** | `/api/uploads/{filename}` | `resolve_ws` + share scope | — | the file; `Cache-Control: public, max-age=2592000, immutable`; inline for `.pdf/.txt/.md/.png/.jpg/.jpeg/.gif/.webp`, `Content-Disposition: attachment` + CSP sandbox for `.svg/.html`, attachment for everything else | 400 `"invalid filename"`/`"unsupported file type"`, 404 `"not found"`, 403 share-scope | `routers/uploads.py:147-184`, `storage.py:78-90` |
| GET | `/api/quota` | `require_ws` | — | `{"max_upload_mb","quota_mb","used_bytes","workspace_bytes","account"}` | 401/403 as §2.3 | `routers/uploads.py:29-36`, `server_settings.py:126-143` |
| GET | `/api/pdf` | `resolve_ws` + share scope | `?source_url=…&save=1` | the upstream PDF streamed (`X-Source-Url` header); **302 redirect** to `/api/uploads/<urlhash>.pdf` when a local copy exists (that is what makes Range requests work) | 400 with human-readable texts for blocked/paywalled/non-PDF | `routers/pdf.py:287-361` |

Notes that matter for a native client:

- `GET /api/uploads/{filename}` accepts **HEAD** (declared explicitly at `routers/uploads.py:147`) — that is how
  the viewer learns a file's size before choosing its transport. `find_upload_file` is strictly scoped to the
  resolved workspace (`storage.py:172-185`): a bare URL with no `ws` reads the **default** workspace.
- Filename validation at serve time is `[0-9a-f]+` for the stem plus a known/malformed-checked extension
  (`routers/uploads.py:149-159`); there is no length check, so legacy 64-hex names are *accepted* if the file
  exists — but the file system lookup is per workspace, so legacy assets are not there.
- Limits: default per-file cap **50 MB** (`config.py:26` → `DEFAULT_MAX_UPLOAD_MB`, `server_settings.py:24-28`),
  admin-tunable 1–2048 MB; quota `0` = unlimited; over the per-file cap → **413**
  `{"detail":"file too large (max N MB)"}`; over the applicable quota → **507**
  `{"detail":"storage quota exceeded (<used> of <quota> MB used — this file needs <n> MB more)"}`
  (`server_settings.py:145-162`; `validate_upload_mb` bounds at `:34-41`). Duplicate content by hash skips
  both checks entirely (a stored file costs no new bytes).
- **Orphan cleanup**: any upload whose stem is not some page's `doc_id` and whose `/api/uploads/<filename>` is
  not mentioned in any block `content`/`properties` is deleted — but only after a **15-minute grace period**
  (`storage.py:188-229`). A native client that uploads before referencing (asset → block) is fine; one that
  uploads and never references loses the file. This is the single most important retention rule for adding
  native asset routes ([native integration contract](../NATIVE_INTEGRATION.md)).
- Blocked extensions (never stored, 400): `.exe .com .scr .pif .bat .cmd .msi .msix .appx .dll .cpl .sys .vbs
  .vbe .jse .wsf .wsh .hta .ps1 .psm1 .reg .lnk .jar .app` (`storage.py:64-68`). Stored extension shape is
  `^\.[a-z0-9]{1,12}$` (`.` + 1–12 lowercase alphanumerics) — so `.pkdrawing` (9), `.inkjson` (7), `.m4a`,
  `.png`, `.ink` all pass (`storage.py:69-71`); a name with no/odd extension becomes `.bin`.
- Media types for unknown-but-well-formed extensions are `application/octet-stream`
  (`storage.py:82-90`), which is what a `.pkdrawing` or `.m4a` upload would be served as through
  `/api/uploads/…` (the legacy `/api/assets/{filename}` route served `audio/mp4`/`image/png` explicitly,
  `main:routers/ink.py:184-193`).

### The `gamma-ink` file (upstream's ink representation — a different format from PencilKit)

`backend/gamma/ink.py:1-40` defines the only ink codec upstream:

```json
{"format": "gamma-ink", "version": 1,
 "space": {"kind": "pdf-page", "page": 3, "width": 612, "height": 792},
 "strokes": [{"id": "k7Qm2x", "tool": "pen", "color": "#1f1f1f", "size": 1.6,
              "opacity": 1, "pen": true, "t0": 1757760000000, "ch": "xypt",
              "pts": [12040, 30512, 620, 0, 18, -3, 700, 8]}]}
```

Limits: `MAX_STROKES=5000`, `MAX_SAMPLES=500_000`, `MAX_BYTES=4 MiB`, x/y in 1/100 pt delta-encoded,
`ch` declares channels `x y [p t a z]` (`ink.py:34-36, 40-...`). An ink group is a block with
`properties.ink_url = /api/uploads/<hash>.ink`, `pdf_page`, `pdf_position`, `ink_strokes`
(`docs/dev/handwriting.md:88-99`); the client writes it as *upload then* `PUT /api/blocks/{id}` with the
properties (`frontend/src/app/App.jsx:5377-5379`). There is **no** `audio`, `ink_revision`, `audio_revision`,
`replay_asset`, `native_note` or `preview_asset` property upstream.

---

## 7. Block, tree and write-path contract (what the native client must use instead of the legacy routes)

### 7.1 Block JSON shape

`block_to_dict` (`blocks_store.py:12-24`), read from columns
`BLOCK_COLUMNS = "id, parent_id, position, content, properties, created_at, updated_at"`:

```jsonc
{ "id": "<12-char base64url>", "parent_id": "<id>|\"root\"", "position": "<fractional index string>",
  "content": "", "properties": { … arbitrary JSON … }, "created_at": "2026-…Z", "updated_at": "2026-…Z" }
```

- The tree root sentinel is the literal **`"root"`**; a page is a block whose `parent_id == "root"`.
- `GET /api/blocks/{id}/subtree` returns that node **plus `children`** (nested, position-sorted,
  `markdown_export.build_tree:36-50`) and, **for a page root only**, `"seq"` (op-log position):
  `{"block": {…, "children":[…]}, "seq": 42}` (`routers/blocks.py:263-277`).
- `POST /api/blocks` (non-root parent) and `PUT /api/blocks/{id}` return **flat** dicts without `children`
  (`routers/blocks.py:371-373, 391`).
- Positions are fractional-index strings; the client mints them, the server re-keys collisions and echoes the
  final value in the applied op (`ops.py` module docstring lines 1-32).
- Timestamps are UTC ISO with a `Z` suffix (`db.page_now()`; `CLAUDE.md` data-model invariants).

### 7.2 Reads

| Method | Path | Auth | Response | Ref |
|---|---|---|---|---|
| GET | `/api/blocks/root/children` | `resolve_ws` (+ share scope) | `{"children":[…]}`; on `root` each child also gets `"preview"` (≤240 chars of its first 5 non-highlight blocks joined ` · `; `""` when none) | `routers/blocks.py:206-260` |
| GET | `/api/blocks/{id}/children` | `resolve_ws` + `assert_block_in_page` | `{"children":[…]}`; 404 `"block not found"`; 403 for `root` under a share | `:206-228` |
| GET | `/api/blocks/{id}/subtree` | `resolve_ws` + scope | `{"block": <tree>, "seq": <int>?}`; 404 | `:263-277` |
| GET | `/api/blocks/{id}` | `resolve_ws` + scope | one flat block dict; 404 | `:311-322` |
| GET | `/api/blocks/by-doc/{doc_id}` | `resolve_ws` + scope | the page carrying that PDF; 404 `"block not found for doc_id"`, 403 for a share not owning it | `:181-192` |
| GET | `/api/blocks/{id}/backlinks` | `resolve_ws` (**refused under any share**) | `{"backlinks":[{id,content,page_root_id,page_title}]}` | `:280-308` |
| GET | `/api/block-search?q=&ids=&limit=&case=&whole=&regex=` | `require_ws` | `{"blocks":[{id,content,kind,ancestors?,page_root_id,page_title}]}`, `kind ∈ {page,link,highlight,note}`; empty `q` → recently edited | `:122-173` |

### 7.3 Writes

| Method | Path | Auth | Body | Response | Errors | Ref |
|---|---|---|---|---|---|---|
| POST | `/api/blocks` | `require_ws_writer` | `{parent_id, content?, properties?, before?, after?}` (`UBCreateRequest`, `blocks.py:35-40`) | `{id,parent_id,position,content,properties,created_at,updated_at}` | 404 `"parent block not found"`; 400 `"invalid before/after: …"`; 403 share rules (no new pages from a share) | `:337-373` |
| PUT | `/api/blocks/{id}` | `require_ws_writer` | `{content?, properties?}` — **properties is a PATCH: `null` deletes the key** | `{"ok":true,"updated_at":…,"seq":…}` | 404 `"block not found"`; 403; 413 `"content too long"` (>200 000 chars) | `:376-391`, `ops.py:244-246` |
| DELETE | `/api/blocks/{id}` | `require_ws_writer` | — | deleting a **page**: `{"ok":true,"id","removed_uploads"}` (direct write + `reload` broadcast); deleting a child: `{"ok":true,"id","removed_uploads"}` from the op path | 400 `"cannot delete root block"`; 403 `"share editors cannot delete the shared page"`; 404 | `:394-417` |
| PUT | `/api/blocks/{id}/children` | `require_ws_writer` | `{blocks:[nested tree]}` — **replaces the whole subtree** (delete + reinsert) | `{"ok":true,"count","updated_at","removed_uploads"}` | 404; 403 scope | `:420-450` |
| POST | `/api/blocks/{id}/reorder` | `require_ws_writer` | `{parent_id?, before?, after?}` | `{"ok":true,"id","position"}` (cross-page moves may also carry `position`) | 400 root/own-subtree, 404, 403 share | `:453-498` |
| POST | `/api/blocks/by-doc/{doc_id}` | `require_ws(write=True)` (**never a share**) | `{default_title, source_url?, original_filename?, folder?}` | the page block (created when absent) | — | `:195-203` |

**Share-write scoping** (relevant if the native client ever accepts a share link): with `?share=`, every touched
block must be inside `share_scope_page()`; a share editor may rename the page (content of the root) but not
change its properties, cannot create/delete/move the page itself, and cannot touch `root`
(`ops.py:179-198, 257, 275, 291`; `routers/blocks.py:328-334, 342-345, 403-408, 462-463, 480-481`).

### 7.4 Ops and collaboration (the upstream substitute for native "note/ink/audio" PUTs)

| Method | Path | Auth | Body / query | Response | Errors | Ref |
|---|---|---|---|---|---|---|
| POST | `/api/pages/{page_id}/ops` | `require_ws_writer` | `{"client": str, "ops": [Op…], "cursor"?}` where `Op` is a discriminated union `set{id,content?,base?,props?}` \| `insert{id,parent,position?,content,props}` \| `move{id,parent,position?}` \| `delete{id}` | `{"seq","at","ops":[applied ops],"removed_uploads"}` — applied ops carry re-keyed positions / merged text | 400 (no ops, unknown op, invalid position, page insert/move), 403 (page move/delete via ops, share scope, share page settings), 404, 410 n/a, 413 `"too many ops in one batch (>500)"` / `"content too long"` | `routers/collab.py:27-49`, `ops.py:40-93, 322-346` |
| GET | `/api/pages/{page_id}/ops?since=<int>` | `resolve_ws` + scope | — | `{"seq": int, "batches":[{"seq","actor","client","at","ops"}]}`; **410** `{"detail":"op log pruned — reload the page"}` | 404 `"page not found"` when the id is not a root page | `routers/collab.py:52-68` |
| WS | `/api/ws/page/{page_id}?ws=<id>|share=<token>&client=<id>` | cookie resolved **in the handler** (middleware never runs for websockets) | client→server **only** `{"t":"cursor",block,anchor,head}` | server→client `{"t":"hello",client,color,seq,peers}`, `join`, `leave`, `cursor`, `ops`, `reload` | close code **4403** when access is refused | `routers/collab.py:71-148` |

`set` with `base` is a three-way merge (`textmerge`), `props` is a patch (null deletes), re-inserting a known id
is a move+set rather than an error — i.e. retry-safe. **This is the mechanism a native offline outbox should
target** (and it is why the legacy `expected_revision` CAS has no direct upstream equivalent).

### 7.5 Pages and PDF attachment

| Method | Path | Body | Response / errors | Ref |
|---|---|---|---|---|
| POST | `/api/pages` | `{title?, folder?}` | the new root block (page) | `routers/pages.py:62` |
| POST | `/api/pages/by-docs` | `{doc_ids:[hash,…]}` (≤500) | `{"pages": {hash: {id,title}}}`, absent when no page | `:80` |
| POST | `/api/pages/from-file` | `{filename:"<hash>.md", original?, folder?}` | `{"page","created","imported"?}`; 400/404 | `:100` |
| POST | `/api/pages/{page_id}/attachment` | `{doc_id?, source_url?, original_filename?}` | updated block; 400/404, 409 `"page already has an attachment"`, 409 `"attachment belongs to another page"` (+`page_id`) | `:131` |
| DELETE | `/api/pages/{page_id}/attachment` | — | `{"ok","block","removed_uploads"}`; 404 when none | `:178` |

Page↔PDF identity: the page block carries `properties.doc_id` and `properties.source_url`
(`blocks_store.page_attachment`, used by `routers/uploads.py:110-113`, `routers/shares.py:67-81`). The stored
PDF is always `<doc_id>.pdf` inside the workspace's uploads dir (`storage.store_pdf`, `storage.py:139-154`) and
is what `GET /api/uploads/<doc_id>.pdf` serves — the same URL the native client already downloads
(`ipad/GammaIPad/Server/GammaAPI.swift:173-178`).

### 7.6 Prefs, snaps, shares (peripheral but used by a full client)

- `GET /api/prefs/{key}` → `{"key","value","updated_at"}`; `PUT` body `{"value": <any JSON>}` → `{"key","updated_at"}`
  (`routers/prefs.py:57-72`). Per-workspace keys (`open-tabs`, `recent-views`, `pinned-folders`, `read-pos`) go
  through `require_ws`; `appearance` / `ai-provider` are account-wide (`db.USER_PREF_KEYS`, `db.py:263-267`).
- `GET /api/page-snaps?after=<iso>` → `{"snaps": {pageId: {img, at}}}`; `PUT /api/page-snaps/{page_id}`
  `{img:"data:image/jpeg;base64,…", at}` → `{"page_id","at"}` (400 not a JPEG data URL, 413 >200 KiB);
  `DELETE` → `{"ok":true}` (`routers/prefs.py:98-123`).
- `POST /api/share/{page_id}` → `{"token","page_id","audience","role","users","created_by"}` (idempotent;
  root pages only, 400 `"only pages can be shared"`, 404 `"page not found"`); `GET /api/share-settings/{page_id}`
  → settings or `{"token": null, "page_id"}`; `PUT` validates `edit`+`anyone` → 400; `DELETE` → `{"ok","removed"}`
  (`routers/shares.py:117-175`).
- `GET /api/share/{token}` → `{"page_id","doc_id","username","workspace_id","audience","role","can_edit",
  "viewer","viewer_is_guest"}`; 404 `"share not found"`, 401 `"sign in to open this shared page"`,
  403 `"this page is shared with specific people only"` (`routers/shares.py:178-198`). GETs carrying `?share=`
  get `Access-Control-Allow-Origin: *` (`auth.py:67-81`).

---

## 8. Cross-check: every call the native client makes today

From `ipad/GammaIPad/Server/GammaAPI.swift` (untracked client). "Upstream" = this worktree.

| Client call site | Request | Upstream | Notes / substitute |
|---|---|---|---|
| `:86` `POST api/login` | `{username,password}` | **exists** | returns `{ok,username}`; client decodes `username` only |
| `:102` `GET api/session` | — | **exists** | client decodes `user` only; upstream additionally returns `workspaces`, `default_workspace`, `is_guest`, `is_admin` — the natural place to learn workspace identity |
| `:107` `POST api/logout` | `{}` | **exists** | — |
| `:110` `GET api/blocks/root/children` | — | **exists** | `{"children":[…]}`; client filters on non-empty `properties.docID` |
| `:116` `GET api/blocks/{id}/subtree` | — | **exists** | `{"block": …}` (+`seq` for a page) |
| `:119` `PUT api/blocks/{id}` | `{content}` | **exists** | upstream returns `{"ok",…}` not a block; client ignores the body for this call |
| `:122` `PUT api/blocks/{id}/note` | `{parent_id, content, expected_revision}` | **absent** | use `POST /api/blocks` (create) / `PUT /api/blocks/{id}` `{content}` (update), or the op path |
| `:128` `PUT api/blocks/{id}/highlight` | `{parent_id, quote, color, pdf_position}` | **absent** | `POST /api/blocks` with `properties {highlight_id, quote, color, pdf_page, pdf_position}` — note upstream expects `highlight_id` to be set (`frontend/src/shared/model/blockModel.js:265-275`) |
| `:133` `PUT api/blocks/{id}/replay-preview` | `{ink_asset, replay_asset}` | **absent** | no upstream counterpart; assets would be `/api/uploads/…` and metadata a properties PATCH |
| `:138` `PUT api/blocks/{id}/ink` | body dict | **absent** | `POST /api/upload-ink` (gamma-ink v1 JSON) then `PUT /api/blocks/{id}` `{properties:{ink_url,pdf_position,ink_strokes,pdf_page}}` |
| `:150` `PUT api/blocks/{id}/audio` | `{parent_id, expected_revision, audio_state, segments, replay_events?}` | **absent** | no audio model upstream at all |
| `:155` `POST api/assets` | multipart `file` | **absent** (405 on a deployed server) | `POST /api/upload-file` (multipart field `file`, response `{url,name,size,already_existed}`); note `.pkdrawing`/`.inkjson`/`.m4a` are accepted by the extension rule but served as `application/octet-stream` |
| `:170` `GET api/assets/{name}` | — | **absent** | `GET /api/uploads/<24hex><ext>` — **and it must carry `ws`/the header when the workspace is not the default** |
| `:175` `GET api/uploads/{doc_id}.pdf` | — | **exists** | identical for the default workspace; for any other workspace the URL needs `?ws=<id>` |
| `:188` `X-Gamma-User` header on all non-auth calls | — | **exists** | upstream enforces it (409 + `X-Gamma-Session-User`, §1.2) |
| — | no workspace header/param anywhere | — | upstream therefore resolves **the account's default workspace** for every call (valid, back-compat §2.4) |

Other incompatibilities that will bite the port:

1. **Block ids**: legacy requires canonical lowercase UUIDs (legacy `ink.py:252, 328, 427, 508`; the native
   client's `component()` only allows alphanumerics/`-_.`, `GammaAPI.swift:179-184`). Upstream ids are
   12-char base64url and are **not** UUIDs (`routers/blocks.py:339`); upstream imposes `^[A-Za-z0-9_-]{1,64}$`
   in the op path (`ops.py:52`). A UUID passes that regex, so a native client *may* keep minting UUID-shaped
   ids for new blocks, but it must not assume existing ids are UUIDs.
2. **Asset references**: legacy `/api/assets/<64-hex>.<ext>` vs upstream `/api/uploads/<24-hex><ext>`.
   `docs/legacy-native/note-replay.md:37` (and [native integration contract](../NATIVE_INTEGRATION.md)) require native assets to keep being
   understood by cleanup/export/restore; upstream orphan cleanup only recognises `/api/uploads/` references
   (`storage.py:215-222`) and the export bundlers likewise (`frontend` + `markdown_export.py:243`).
3. **Service-worker/SPA catch-all**: with `GAMMA_STATIC_DIR` set (the Docker image sets it, `Dockerfile:31`),
   `GET /api/<unknown>` returns the **SPA index.html with HTTP 200** rather than 404, and a non-GET to such a
   path returns **405** — because the catch-all `GET /{path:path}` (`app.py:157-169`) matches the path
   **[inferred from code]**. This is exactly the 405 the client saw (`ipad/VALIDATION.md:81`). A native client
   must not treat a 200 HTML body as an asset (`GammaAPI.asset` at `:167-171` returns raw bytes).
4. **HTTPS-only client**: `GammaAPI.init` requires an `https` URL (`GammaAPI.swift:64`). The cookie is
   `Secure` only over HTTPS, so this is consistent — but a self-signed/plain-HTTP LAN server cannot be used.
5. **No CORS involvement**: the native client is not a browser origin, so `_apply_share_cors` is irrelevant;
   credentials ride the cookie (`URLSessionConfiguration.ephemeral` cookie storage, `GammaAPI.swift:70-73, 94-106`).

---

## 9. Open items / not verified

- No runtime probe was possible (no venv; `import fastapi` fails) — status codes and bodies above are read from
  source. The only *observed* server behaviour available is the deployed-server evidence recorded in
  `ipad/VALIDATION.md:81` (405 for `POST /api/assets` and `PUT /api/blocks/{id}/ink`).
- The exact 405 body (FastAPI JSON `{"detail":"Method Not Allowed"}` vs Starlette's plain-text response) is
  version-dependent (`fastapi==0.136.0`, `backend/requirements.txt:1`) and was **not** verified here.
- Upstream has no ink-replay/audio/preview model, no `expected_revision` CAS, and no `/api/assets`; the port
  therefore needs *new* upstream routes (per [native integration contract](../NATIVE_INTEGRATION.md)), and their shape must integrate with
  `require_ws_writer` + `share_scope_page` + `commit_ops` + the 15-minute orphan-upload grace window.

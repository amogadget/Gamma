# iPad client on upstream `tim/main`: workspace identity

This document records how the native iPad client was moved onto the upstream
backend (workspaces, `require_ws`, `?ws=` / `X-Gamma-Workspace`) and what still
has to be verified on a Mac and on hardware. It is the companion to
`notes/UPSTREAM-BACKEND-CONTRACT.md`, which holds the upstream route/error
inventory this client was adapted against.

- Integration base: `tim/main` `5f266eb3c8199c286176d8ccdba0fa670b57f777`.
- Original native client: `2dbde2d` (per-user identity, `/api/assets`, native
  writer routes) — read-only, never modified by this work.
- The bundle identifier is unchanged: `com.gamma.pdfnotes.ipad`.

## The shape of the change

Upstream decides which library a request touches per request, from `?ws=`, else
the `X-Gamma-Workspace` header, else the account's default workspace
(`backend/gamma/auth.py:243-275`). A native client that omits the workspace is
therefore *valid* but ambiguous: every call silently lands in whichever library
the account happens to call default. For a client that keeps a durable outbox of
handwriting, audio and notes, that ambiguity is a data-placement bug, not a
convenience. So the workspace became part of the client's identity.

**One rule, applied everywhere: a workspace is chosen once, from the server's own
answer, and nothing is written or read until it is.**

| Layer | Before | Now |
|---|---|---|
| `GammaAPI` | `init(server:)` | `init(server:)` = *unbound* (login/session only); `init(server:workspace:)` or one `bind(workspace:)` call |
| Request headers | `X-Gamma-User` | `X-Gamma-User` + `X-Gamma-Workspace` on every `/api/*` call except `api/login`, `api/session`, `api/logout` |
| Cache directory | `SHA256(server + "\n" + username)` | `SHA256(server + "\n" + username + "\n" + workspace)` |
| `GammaPageCache` / `GammaMutation` / `GammaOfflineEntry` | no workspace | carry the workspace; a file claiming another library is refused, never uploaded |
| Sign-in | account/server only | account + workspace from `/api/session`, remembered per account |
| Web handoff | `pageID`, `docID`, `title`, `user` | `+ workspace`, verified against the live session and re-checked as writable |

### Why an unbound client exists at all

The workspace is only knowable *after* signing in: `POST /api/login` returns
`{ok, username}` and `GET /api/session` returns the workspaces and the default
(`backend/gamma/routers/auth.py:165-217`). A client that required a workspace at
construction could not log in. So `GammaAPI` starts unbound, and an unbound
client can reach exactly the three session endpoints:

```swift
func makeRequest(_ path: String) throws -> URLRequest {
    if Self.sessionPaths.contains(path) { return request }
    guard !workspace.isEmpty else { throw APIError.workspaceUnbound }
    ...
}
```

`bind(workspace:)` succeeds at most once, and `workspace` is `private(set)`, so no
later code path can retarget an in-flight or queued write at another library.
Switching libraries builds a new client; it never mutates an existing one.

### Choosing the workspace

`GammaWorkspace.chooseWorkspace` is the only place a library is picked:

1. Only workspaces whose role is `owner` or `editor` are candidates — every native
   save is a writer-role request (`require_ws_writer`).
2. A fresh sign-in prefers the workspace remembered for that server+account
   (`gamma.workspace.<hash>` in `UserDefaults`), then the **verified** default
   (`default_workspace`, but only when the session actually lists it), then the
   first writable one.
3. A reconnect requires the remembered workspace to still be writable. If the role
   dropped to `viewer` or the membership is gone, sign-in fails with an
   explanation and **does not** fall through to another library: the pending
   outbox belongs to the workspace it was written in.
4. An account that may write nowhere gets a clear message rather than a silent
   read-only session.

### The outbox

Every queued mutation is stamped with the workspace when it is enqueued
(`GammaWorkspace.enqueue`). `sync()` refuses to send a mutation stamped with
another workspace: it parks it as a conflict, keeps the bytes, and stops the pass.
A 403 from the workspace gate (`you are not a member of this workspace` /
`you can only view this workspace`) is a distinct error that pauses sync instead of
retrying every 15 seconds into a library that will keep refusing.

### Why the native client does not put `?ws=` on asset URLs

`docs/dev/workspaces.md` requires browser-issued image and download URLs to carry
`ws` (or the share token) because an `<img>`, `<audio>` or a WebSocket handshake
cannot attach a custom header. That rule is about transport, not about identity.

Every native fetch goes through `GammaAPI`, whose single request builder sets
`X-Gamma-Workspace`, so the native client has no header-less access path:
`GammaAPI.asset` is the only way a drawing, preview or audio asset is read, and
`/api/assets/...` strings are stored and compared bare — the same "store bare
URLs" rule the frontend follows. The only place outside `GammaAPI` that mentions
`/api/assets/` is `validUploadedAsset`, which decides whether a local file is
safely re-downloadable before deleting it and performs no request.

The Web view, by contrast, *is* a browser: it loads `?ws=` and leaves the rest to
the frontend's own fetch wrapper and `assetUrl`.

### Legacy caches (pre-workspace)

An existing cache from the original client lives at the old directory name and its
`identity.json` has no `workspace` key. It is:

- **discovered** — `GammaOfflineIdentity` decodes a missing workspace as `""`, and
  both directory schemes are recognised; the sign-in screen lists it as
  "Workspace unknown";
- **not opened offline** — without a server a client cannot prove which library the
  files belong to, so `enterOffline` refuses it with an explanation;
- **migrated only to the server-verified default workspace** —
  `GammaCache.migrateLegacyCache(rootURL:server:username:verifiedDefaultWorkspace:)`
  refuses an empty/unlisted/unsafe workspace id, refuses when the destination
  already exists (never merging two libraries), verifies the legacy identity
  belongs to this server+account, checks the destination *before* moving, performs
  one rename, and atomically re-stamps `identity.json`. A retry after process
  death validates the destination's server/account and unscoped identity plus
  page/outbox/download metadata before completing an interrupted rename. Foreign,
  missing or ambiguous identity is refused without changing bytes. Ordinary write
  failures restore the original identity and directory; rollback failure explicitly
  reports the retained directory path rather than claiming restoration.

This is deliberately the same instinct as the Web's "unscoped legacy session caches
are not restored because their owner is unknown" (`docs/dev/workspaces.md`), with
one difference that makes restoration possible here: the legacy browser cache
records no owner at all, while the legacy iPad cache's `identity.json` proves the
canonical server and authenticated username. Only the *workspace* is unrecorded, so
the cache can be listed, retained and — once a server confirms the account's
default library — attached to exactly that one. Ambiguity is surfaced, never
resolved by guessing.

## Frontend contract (owned by the frontend work stream)

The bridge is one message, and it now names a library:

```js
window.webkit.messageHandlers.gammaNative.postMessage({
  type: "openPDF", pageID, docID, title, user, workspace
})
```

- `pageID`, `docID`, `user`, `workspace`: non-empty strings, ≤200 characters,
  no `\0`/`\r`/`\n` (a newline would forge a second field).
- `title`: whitespace-collapsed, ≤120 Unicode code points.
- Every field is required — `nativePDFRequest` returns `null` if any is missing, so
  a caller can never post a handoff without a workspace.
- The native parser enforces the same field set and bounds
  (`GammaWebMessageValidator.openPDF`), so the two sides cannot drift:
  `scripts/test_native_workspace_contract.py` compares the native field list with
  the Web sender's when `frontend/src/native/nativeBridge.js` is present.

Native then treats the message as a **claim**, and verifies it against the live
session before opening anything (`GammaWebHandoffCheck`):

| Claim | Check | Failure |
|---|---|---|
| `user` | equals the session user resolved from the adopted cookies | `accountChanged` |
| `workspace` | listed by `/api/session` for that account | `workspaceUnknown` |
| `workspace` | role is `owner`/`editor` | `workspaceReadOnly` |
| `pageID`/`docID` | the fetched block is that root page with that `doc_id` | `pageIdentity` |

The Web view is loaded at `serverURL?ws=<workspace>` so the tab the message came
from is in the same library the native side will write to.

## Browser handwriting in Pencil & Audio

`properties.ink_url` identifies upstream **gamma-ink v1**, not a PencilKit
annotation. The native reader decodes the original JSON into a separate,
noninteractive vector layer below its PencilKit canvases. It never creates a
PKDrawing or PNG from these files and never writes a browser ink manifest.
Browser handwriting stays visible as **static, untimed context** during audio
replay; its `t0`/sample `t` are not recording synchronization events.

The decoder follows `backend/gamma/ink.py` and `frontend/src/ink/ink.js`: XY
hundredths-of-points and time are accumulated deltas, pressure and angles are
absolute. Pen pressure controls vector width; highlighters use constant width
and per-stroke alpha. This is a vector approximation of the browser's
perfect-freehand brush, not pixel-identical perfect-freehand smoothing. The
separate native backing layer cannot guarantee CSS-style multiplication against
the PDF backdrop; no unsupported iOS compositing filter is required.

The stored frame is pdf.js scale-one, rotation-applied top-left. The view first
undoes 0/90/180/270-degree rotation into unrotated crop-local points, then uses
`InkPageOverlay`'s public PDFKit conversion (including crop origin) to place it.
Native source coordinates and bytes are not transformed. The view cannot claim
touches; PencilKit input, finger navigation and existing PDF highlights retain
their own layers. Browser groups are labeled read-only in notes and selecting a
note navigates to its PDF page, without arming an editable native canvas.

Only local `/api/uploads/<hash>.ink` references are fetched through the existing
authenticated, workspace-bound API. Exact downloaded bytes are retained with
the source URL in the identity-scoped page snapshot for offline/cold reopen.
Refreshing notes reconciles by current block URL; old bytes cannot masquerade
as a newly referenced file. Fetch, validation and cache failures are surfaced
rather than reported as successful blank handwriting. This adds no outbox
mutation type and leaves named native snapshots/migration identity unchanged.

Focused tests: `GammaTimInkTests`, `GammaTimInkLayerTests`,
`GammaTimInkCacheTests`, and `GammaTimInkFetchTests` cover the real channel
format, rotations/crop offsets, malformed inputs, independent read-only
rendering/replay, source-byte preservation, scoped requests and partial failure.
Mixed `pdf_ink` + `ink_url` blocks fail closed as browser ink: native drawing and
caption saves are refused, and old queued native writes are retained but not
sent to those blocks. Framework tests require
the parent Mac build/test run; Linux editing alone does not verify iPad rendering.

## Backend dependency

This client calls the native routes ported from the original branch — they are not
upstream `tim/main` routes:

- `POST /api/assets`, `GET /api/assets/{filename}` (assets are `<sha256>.<ext>`:
  `pkdrawing`, `png`, `m4a`, `inkjson`)
- `PUT /api/blocks/{block_id}/{ink,audio,note,highlight,replay-preview}`

Behaviour the client relies on, all of which the original backend implemented and
the port must preserve: canonical lowercase **UUID** block ids for native
annotations; `parent_id` must be an existing Gamma PDF page; idempotent retries
return the existing block without bumping a revision; `expected_revision`
mismatches answer `409`; asset references must be local `/api/assets/...` URLs.

Two hazards worth naming, both handled on the client:

- A server without these routes answers an unknown `GET /api/...` with the SPA's
  `index.html` and **HTTP 200** (the static catch-all is registered last,
  `backend/gamma/app.py:157`). `GammaAPI.asset` rejects `text/html` and a
  `<html`/`<!doctype`/`<head` prefix and reports `serverUpgradeRequired` instead of
  caching HTML as a drawing.
- `405`/`501` can also mean "server needs
  the native routes", and pauses sync without discarding pending work.

## Verification status

The client has been compiled and tested on the iOS simulator, including clean
builds with `CODE_SIGNING_ALLOWED=NO`. See [VALIDATION.md](VALIDATION.md) for
recorded regression results, portable reproduction and remaining acceptance
boundaries. Simulator results do not establish physical-device behavior.

That build found five real defects that reading the source could not — a
whitespace-only workspace id silently degrading a client to unbound, a legacy
migration that could never succeed, and a display label compared as identity among
them. Each is now covered by a test, including a fault-injected rollback and a
migration-then-reopen test; see the cache and workspace identity test sources. The
unconditional identity writer that invited the migration bug is gone.

`python3 scripts/test_native_workspace_contract.py` — 26 checks over the Swift
sources and, when present, the Web sender and the server's own workspace-id rule.
It pins the identity invariants and the structural soundness of the sources, and
it is what runs where no Swift toolchain exists. It is not a substitute for the
Xcode suite; it is a tripwire for the invariants the suite is about.

The remaining acceptance run passed the real-backend opt-in tests, including
nondefault native outbox/upload/read isolation (see
[VALIDATION.md](VALIDATION.md)). Still open: deployment smoke, physical Pencil/microphone and
flight-mode acceptance, real device-container migration rehearsal, and live
WebKit-to-native handoff UI acceptance. Simulator tests do not establish these.

### Which acceptance gates this work stream answers

`docs/design/native-integration-acceptance.md` holds the authoritative gates for the
whole integration. This client's share of them:

| Gate | Where |
|---|---|
| Cache identity includes server + user + workspace in downloads, manifests and recording/outbox paths | `GammaCache.directoryKey`, `savePage`, `saveOfflineEntries`, `GammaWorkspace.enqueue`; recordings live under the same workspace directory |
| Legacy account-only iPad cache associated only with a verified default workspace; ambiguity retained and surfaced | `migrateLegacyCache`, `enterOffline`, the "Workspace unknown" entry |
| Web/native handoff checks origin, main frame, account, workspace, write role and page/doc identity after pending Web saves finish | `GammaWebViewController.userContentController`, `GammaWebHandoffCheck`, `GammaWorkspace.openFromWeb` |
| Returning to Web waits for acknowledged native changes and reloads scoped state | `prepareWebWorkspace` (unchanged) + the `?ws=` boot URL |
| Two workspaces cannot cross: no fetch/upload/edit in the wrong library, and switching the default does not redirect a pending mutation | explicit `X-Gamma-Workspace` on every request; the outbox stamp and sync gate |
| Owner/editor may write; viewer, removed membership and stale account guard fail without changing data | `canWrite`, `workspaceAccessDenied`, the `409` `X-Gamma-Session-User` message |
| Existing bundle identity/signing configuration retained | `project.yml` unchanged, pinned by the contract test |

Everything else in that checklist belongs to the backend, frontend or integration
work streams.

## Files

| File | Role |
|---|---|
| `GammaIPad/Server/GammaAPI.swift` | workspace-bound client, session/workspace discovery, identity headers |
| `GammaIPad/App/GammaWorkspace.swift` | workspace selection, switching, outbox stamping, sync gates, handoff |
| `GammaIPad/App/GammaWorkspaceOffline.swift` | offline entry points, per-workspace local accounts |
| `GammaIPad/Storage/GammaCache.swift` | workspace-keyed directory, snapshot/manifest stamps, outbox stamp |
| `GammaIPad/Storage/GammaOfflineCache.swift` | identity validation, discovery, legacy migration |
| `GammaIPad/Storage/GammaOfflineModels.swift` | identity (server + account + workspace), manifest entry |
| `GammaIPad/Web/GammaWebValidation.swift` | bridge payload bounds, handoff claim checks |
| `GammaIPad/Web/GammaWebWorkspace.swift` | `?ws=` boot, bridge origin/main-frame checks |
| `GammaIPadTests/GammaWorkspaceIdentityTests.swift` | the workspace-identity suite |

# Frontend source

Code is grouped by the part of Gamma it serves. Functional folders sit directly
under `src/`; there is no extra `features/` layer or requirement to route imports
through barrel files. `main.jsx` remains the Vite entry point.

| Folder | Responsibility and entry points |
| --- | --- |
| `app/` | `App.jsx` connects the application views, navigation, saves, and docks; `prefs.js` and `sessionState.js` manage browser preferences and session restoration |
| `auth/` | Login, session/share access screens (`LoginPage.jsx`) and MCP authorization (`McpConsent.jsx`) |
| `chat/` | AI conversation panel (`ChatDock.jsx`), paper mentions, chat permission settings, and the token-usage formatting (`tokenUsage.js`) shared with Settings |
| `collaboration/` | `usePageCollab.js`, the pure `collabSession.js` state machine, presence UI, `MirrorPopover.jsx` — the header's sync pill of a clone with its settings and conflicts views — and `MergeResolver.jsx`, the conflict chip on a block row ([docs/dev/mirror.md](../../docs/dev/mirror.md)) |
| `editor/` | Outliner (`BlockTree.jsx`), CodeMirror (`BlockCmEditor.jsx`), undo history, Markdown and LaTeX editing, and slash commands |
| `guide/` | First-run and contextual guides: `anchors.js` (the `data-guide` registry), `events.js` (event bus), `triggers.js` (eligibility and account-scoped progress), `useGuide.js` + `GuideOverlay.jsx` (engine, invitation and spotlight), `tours/` (one data file per tour) — [docs/dev/onboarding.md](../../docs/dev/onboarding.md) |
| `ink/` | Handwriting codec and geometry, input sampling, draft storage, and `InkLayer.jsx` |
| `library/` | Library cards and browsing controls (`FileBrowser.jsx`), the Ctrl+P page palette (`QuickOpen.jsx`), folder/page rules, title scoring, and `library.css` |
| `native/` | The iPad client's browser half: the handoff message, reading and placing the `pdf_ink` blocks the iPad writes, audio segments, Note Replay's timeline/player and its per-stroke layer (see "Native (iPad) integration" below) |
| `pdf/` | `PdfViewer.jsx`, document loading, citations, translation, and scroll alignment |
| `search/` | Workspace search (`SearchPanel.jsx`) |
| `settings/` | `SettingsDialog.jsx`, individual settings panes, shared pane controls (`SettingsKit.jsx`), navigation, integration setup, and `settings.css` |
| `sharing/` | The page Share popover (`SharePopover.jsx`): link, access, invited people, stop sharing |
| `transfers/` | Import/export dialogs (`ImportExport.jsx`), the import review (`ImportReviewDialog.jsx`, `ImportTree.jsx`, `importApi.js`, `importReview.js`), format rules, and upload/file chips (`FileChip.jsx`) |
| `shared/model/` | Block tree helpers (`blockModel.js`), block operations (`blockOps.js`), and highlight colors |
| `shared/lib/` | API transport and helpers (`utils.js`), the pure asset-URL scoping rule (`assetUrl.js`), the multipart upload (`xhrUpload.js`), search text normalization, and canvas sizing |
| `shared/ui/` | Reused widgets, menus, icons, and menu hover intent |
| `shared/illustrations/` | Decorative settings/import previews and their local image assets |
| `shared/styles/` | `app.css`: theme, base controls, and cross-application styles |

## Placement and naming

- Put code beside its main consumer. Sharing a helper between two files does not
  automatically make it a `shared/` module; library title scoring, for example,
  stays in `library/` even though chat and workspace search also use it.
- Use PascalCase for React component modules and camelCase for JavaScript
  helpers. A hook-only module can use a `use` prefix, as in `usePageCollab.js`.
- Import the owning module directly. `shared/model/blockModel.js` is the general
  page/block model, not an import adapter.
- Keep styles with their owner when already separate. `main.jsx` deliberately
  loads application, library, then settings CSS in that order to preserve the cascade.
- Keep tests in `frontend/tests/`; run `npm test`, `npm run build`, and
  `npm run e2e` from `frontend/` (the browser suite needs the backend dependencies
  — `GAMMA_E2E_PYTHON` picks the interpreter — and a Playwright browser). Three
  standalone browser checks run with `/api/**` mocked, so they need no backend and
  work while an endpoint is still being ported: `npm run e2e:native` (native ink,
  audio, the handoff payload, workspace scoping), `npm run e2e:notereplay` (static
  high-resolution ink, the replay clock, stale derivatives) and
  `npm run e2e:blankpdf` (the notebook dialog and its idempotent retry). All four
  serve `frontend/dist`, so run `npm run build` first.
- **Two engines, and the media assertions say which one ran.** Playwright's stock
  Chromium has no AAC decoder, so it can only exercise the seek-driven half of
  Note Replay; a build with proprietary codecs (Chrome for Testing) plays the real
  `.m4a` and the checks then assert that the reveal follows the audio element's
  own clock. Point the tests at it with `CHROME_PATH=/path/to/chrome` (the harness
  and all three standalone checks honour it) and set `GAMMA_E2E_REQUIRE_AAC=1` to
  make a missing decoder a failure instead of a reported skip. Mocked media must
  be served with Range/Content-Length (`nativeFixtures.mjs` `serveBytes`) — a mock
  that answers every request with a plain 200 and no length makes an MP4 load fail
  as MEDIA_ERR_SRC_NOT_SUPPORTED even in an engine that has the decoder.

## Native (iPad) integration

Upstream's own stylus drawing lives in `ink/` — that ink is *drawn here*. A
`pdf_ink` block is drawn on an iPad and only *displayed* here, and the two can
share one page, so the native half lives in `native/` under its own names
(`nativeInkBlocks` / `nativeInkPreviews` / `onNativeInkJump` next to upstream's
`inkBlocks` / `onInkJump`).

| Module | Responsibility |
| --- | --- |
| `native/nativeBridge.js` | The one web → native handoff message |
| `native/inkBlock.js` | Reading a `pdf_ink` block (strict asset refs), and placing its image on a pdf.js page (`pdf-crop-top-left-v1` affine map, rotation included) |
| `native/inkNavigation.js` | A block's bounds as a scroll target + outline rectangle, in the frame the ink is drawn in |
| `native/audioBlock.js` | A recording's finalized `.m4a` segments |
| `native/noteReplay.js` | The replay timeline (pure): segment clock, events, stroke lineage, progressive-reveal samples, `.inkjson` validation |
| `native/ReplayInkLayer.jsx` | `StaticInkPreview` (the notes picture) and the PDF's static/replay stroke layer |
| `native/NoteReplayPlayer.jsx` | The player bar and `useReplayAssets`, the per-document derivative loader |

The handoff is one message, sent only when the iPad app hosts the page
(`window.__GAMMA_IPAD__` and `window.webkit.messageHandlers.gammaNative`):

```js
nativePDFRequest({ pageID, docID, title, user, workspace })
// → { type: "openPDF", pageID, docID, workspace, user, title }
```

- Every identity field is a non-empty string ≤200 chars with no `\r`, `\n` or
  `NUL`; anything missing or malformed returns `null` and the handoff is refused.
- **`workspace` is required** — the library id every native route is scoped by
  (`/api/assets/<sha256>.<ext>` and the per-block ink/note/audio/highlight/
  replay writers), and one the iPad cannot derive on its own.
- The payload is a claim the native side verifies (main frame, origin, port,
  deploy path, then `/api/session` and the server-side page/document), never a
  grant. The web side settles its queued ops and freezes the tree first
  (`#root` `inert`, `window.__GAMMA_NATIVE_ACTIVE__`), and a refused handoff
  unfreezes it again.
- Block properties store the **bare** asset ref (`/api/assets/<sha256>.png`);
  the validators in `native/` accept only that. The workspace/share scope a
  browser-issued request needs (an `<img>`/`<audio>` src, the replay loader) is
  added at the render site by `assetUrl()` (`shared/lib/utils.js`, rule in
  `shared/lib/assetUrl.js`, which also covers `/api/uploads/`).

### Native outliner and visual acceptance

- Native ink/audio may be indented, outdented, or dragged within their containing
  PDF page. Their assets, geometry, recordings and revisions are untouched;
  native notes retain their exact-parent restriction. Duplicate and Move to page
  are disabled for both native blocks and ordinary ancestors containing them.
- `tests/e2e/nativeFixtures.mjs` uses an opaque blue PNG, not an invisible pixel.
  The real-backend native scenario and mocked Note Replay check compositor
  screenshots for colored pixels in static PDF/notes ink and the half-stroke
  mask (pixel area and painted endpoint), in addition to timeline/DOM checks.
  The mocked check writes `/tmp/gamma-static-hd-ink.png`,
  `/tmp/gamma-note-replay-half.png`, and `/tmp/gamma-note-replay-seek.png`.
- Reproduce acceptance after `npm ci --no-audit --no-fund`: `npm test && npm run
  build`, then `GAMMA_E2E_PYTHON=/path/to/python CHROME_PATH=/path/to/chrome
  GAMMA_E2E_REQUIRE_AAC=1 npm run e2e` and `CHROME_PATH=/path/to/chrome npm run
  e2e:notereplay -- --require-aac`. The latter also honors
  `GAMMA_E2E_REQUIRE_AAC=1`.

## Remaining cleanup

`app/App.jsx` still owns several kinds of state; `shared/ui/Widgets.jsx` and
`shared/lib/utils.js` still combine responsibilities. In particular, the shared
Markdown renderer understands PDF citations, so these folders are ownership
groups rather than enforced dependency layers. Split those modules when changing
their behavior, with the relevant tests, instead of adding forwarding wrappers.

See the [decomposition plan](../../docs/dev/frontend-refactor.md) for the larger
state-ownership work, and [UI design](../../docs/dev/ui-design.md) for component
details and conventions.

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
| `pdf/` | `PdfViewer.jsx`, document loading, citations, translation, and scroll alignment |
| `search/` | Workspace search (`SearchPanel.jsx`) |
| `settings/` | `SettingsDialog.jsx`, individual settings panes, shared pane controls (`SettingsKit.jsx`), navigation, integration setup, and `settings.css` |
| `sharing/` | The page Share popover (`SharePopover.jsx`): link, access, invited people, stop sharing |
| `transfers/` | Import/export dialogs (`ImportExport.jsx`), format rules, and upload/file chips (`FileChip.jsx`) |
| `shared/model/` | Block tree helpers (`blockModel.js`), block operations (`blockOps.js`), and highlight colors |
| `shared/lib/` | API transport and helpers (`utils.js`), search text normalization, and canvas sizing |
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
  and a Playwright browser).

## Remaining cleanup

`app/App.jsx` still owns several kinds of state; `shared/ui/Widgets.jsx` and
`shared/lib/utils.js` still combine responsibilities. In particular, the shared
Markdown renderer understands PDF citations, so these folders are ownership
groups rather than enforced dependency layers. Split those modules when changing
their behavior, with the relevant tests, instead of adding forwarding wrappers.

See the [decomposition plan](../../docs/dev/frontend-refactor.md) for the larger
state-ownership work, and [UI design](../../docs/dev/ui-design.md) for component
details and conventions.

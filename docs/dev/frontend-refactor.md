# App.jsx decomposition plan

Status: proposed, 2026-09-11. Asset organization is implemented separately;
the application decomposition below has not been applied.

## Goal and current constraints

`frontend/src/App.jsx` currently has 8,516 lines. It combines session checks,
library mutations, account preference synchronization, page loading and saving,
PDF state, AI provider forms, dock geometry, and most workspace markup.

The goal is a small composition root with explicit state owners and commands.
Extraction should remove coupled responsibilities, not merely move long
sections into hooks that accept every variable from App. Keep the existing
React stack, URL formats, API contracts, and stored preference keys. Follow
the [block-centric model](block_centric.md): a page owns its block tree and
may carry a PDF attachment.

## Proposed ownership

Paths below are relative to `frontend/src/`.

| Module or area | Responsibility | Existing code to extract |
|---|---|---|
| `app/App.jsx` | Compose session gate, navigation, active page, library, and workspace shell | The final route/view decision and connections between features |
| `app/useSession.js` | Identity, login/logout, conflict detection, session refresh | `checkSession`, `doLogin`, `doGuestLogin`, session event listeners |
| `app/navigation.js`, `app/useNavigation.js` | Parse/build URLs, home/page transitions, link-jump back stack | `homeUrlFor`, initial query parsing, `openBlock`, `goHome`, `pushNav`, `goBackNav` orchestration |
| `app/preferences/` | Account-scoped tabs, recents, pinned folders, appearance, and reading positions | `pushPrefSoon`, `applyServerTabs`, read-position and recents synchronization |
| `features/pages/usePageSession.js` | Active page identity, tree, load state, and metadata updates | Page fields, `loadBlocksForBlock`, the data-loading portion of `openBlock` |
| `features/editor/` (done: `src/collab.js`) | Queued writes, debounce, retries, explicit flush, unload handling — now the live session hook `usePageCollab` ([collab.md](collab.md)); App keeps only the transition effect and the remote-apply glue | `commit`, `flush`, `onRemoteOps` |
| `features/editor/` | Block editing, caret/focus, undo, and notes rendering | Existing editor files, `editTail`, notes-window markup and editor actions |
| `features/library/` | Listing derivation, selection, page/folder/label operations, and library UI | `pageBlocks` through `homeEntries`, click handlers, retagging, rename/move/delete, carousels |
| `features/workspace/` | Dock arrangement, visibility, panel sizes, drag geometry, and phone presentation | `moveWindow`, `startWindowDock`, `renderSlotGroup`, per-page layout snapshots |
| `features/pdf/` | Viewer controls, PDF/notes jumps, scroll restoration, translation, and snapshots | Existing viewer/translation files, `restorePdfScroll`, zoom and capture logic |
| `features/transfers/` | Upload/import/export operations and progress reporting | `uploadFiles`, format imports, backup transfer functions, `runExport`, transfer rows |
| `features/sharing/` | Share-link resolution/gates and owner share controls | `resolveShare`, `loadShareSettings`, invitation mutations, share popover |
| `features/settings/` | Settings panels and AI provider form/request state | Existing settings files plus provider CRUD, catalog, OAuth, and usage handlers |
| `features/chat/` | Chat attachments and page-change notifications | `addBlockToChat`, `addHighlightToChat`, image selection, existing `ChatDock` |
| `shared/ui/`, `shared/lib/` | Reusable controls, API transport, and small shared functions | Menus, icons, selected parts of `widgets.jsx` and `utils.js` |

Split the larger areas into focused files as their state owners emerge.
For example, library listing selectors, selection state, mutations, and
`LibraryView` should be separate; do not create one giant `useLibrary` hook.
Existing helpers such as `pageAttachment` and `useBlockHistory` remain the
source of truth throughout the moves.

## Logic cleanup to do with the extraction

### 1. Navigation and page state

Currently `openBlock` fetches a subtree, sets many page fields, changes the
URL, restores dock ratios and zoom, updates tabs/recents, and triggers other
page work. `goHome`, share resolution, and attachment operations manage related
state in separate places.

Separate loading a page from choosing where to navigate. Parse route inputs
in one helper, preserving `src`/`url`, `block`/`page`, share, folder, category,
and unlabelled aliases. A page session owns the loaded page and tree; display
values derive from that page, with separate draft state only for edits that
can be cancelled. Commit a loaded page as one transition rather than scattering
identity, attachment, and title resets among callers.

Use a navigation generation or abort signal so an earlier request cannot
replace a page opened later. Cancel delayed dock/scroll restoration on page
changes. Keep the existing distinction between link-jump Back history and
ordinary tab/library navigation.

### 2. Saving and undo

Keep `useBlockHistory` as the one undo stack per page. Page loads, collapse,
and edit-mode changes must retain their existing treatment; maintain caret
restoration and typing groups.

Give saves a queue keyed by account and page, with writes serialized per
page. The current pending-save slot is shared across navigation, and a failed
request can be superseded when another pending edit exists; inspect and cover
cross-page retry behavior before replacing it. Expose explicit `flush(pageId)`
and dirty-state operations. Callers such as cross-page block moves must await
the required write before reparenting or fetching replacement data. Preserve
the 500 ms debounce and immediate save on editor close.

Navigation can render the next page while the old page's queue finishes, but
must not discard the old queue. Failed saves must remain identifiable and
retryable. Share-edit saves retain scoped access; read-only shares never queue
writes. Keep unload saving best-effort and do not claim it guarantees delivery.

### 3. Dock arrangement

Layout is currently split between `layout`, collapse/visibility flags,
`pageLayoutsRef`, panel handles, `openBlock`, and drag/render functions.
Create one layout state model with pure operations: move, collapse, toggle
visibility, snapshot, and restore. Validate persisted data: known window IDs,
valid slots, arrays, and no duplicates. Keep existing storage keys and migrate
values on read where needed.

Put pointer geometry in a small DOM adapter that emits layout commands.
`pointercancel` should clear the drag preview without committing a move;
currently it shares the drop handler. Preview and drop must use the same target
calculation. Keep collapsed headers outside percentage-sized panels, preserve
window order, and restore ratios only when the target panel structure exists.
Make all retry timers cancellable on navigation and unmount.

Phone overlays should derive from the same visible-window model while retaining
the desktop arrangement for the switch back to a wider viewport. Preserve
notes in the center for pages without a PDF attachment and layout inheritance
for pages without a saved arrangement.

### 4. Preference synchronization

Centralize scheduling, cancellation, account checks, and error handling, while
keeping each preference's merge policy explicit. Tabs and recents use server
state with their existing local rules; reading positions and snapshots merge
per page. Do not force all of them through one generic merge algorithm.

Capture account identity when scheduling a write, and reject stale responses
after an account change. Move side effects out of React state-updater functions
so updater replay cannot issue duplicate writes. Put browser preference
declarations in `prefs.js`, including the home sort/kind/layout declarations
currently scattered through App, retaining legacy key migration.

### 5. Library, providers, and shared UI

Extract pure selectors for folder/label rollups, sorting, search dimming, and
visible slices. Keep one command path for operations invoked by cards, menus,
drag/drop, and keyboard shortcuts. Preserve folder refinement rules and the
ordering of folder-chat moves before folder navigation changes.

AI provider forms should own their drafts, busy/error state, catalog requests,
and OAuth lifecycle in the settings feature. App should receive the selected
provider/model and refresh commands rather than every form setter.

Split `widgets.jsx` by ownership: generic controls stay shared; transfer
dialogs, workspace docks, and chat/editor rendering belong with their feature.
Move shared highlight colors out of `pdfViewer.jsx` so the block editor need
not import the viewer for constants. Split `utils.js` into API transport and
domain helpers as actual consumers are moved; avoid another catch-all folder.

## Implementation order

1. **Establish behavioral checks.** Cover fast page switching after an edit,
   failed saves across two pages, cross-page block moves, undo/caret behavior,
   account switches with pending preference writes, and dock restore/cancel.
   Use deterministic unit tests for queues and pure layout operations; browser
   checks exercise the user flows. Keep this separate from mechanical moves.
2. **Extract leaf modules and view sections.** Move settings/provider form
   logic, library selectors, URL helpers, and reusable UI. Extract `LibraryView`,
   `NotesPane`, `WorkspaceTopbar`, and feature dialogs with narrow inputs and
   command callbacks. These are manageable initial changes with clear owners.
3. **Extract dock state and rendering.** Add the layout model, drag adapter,
   `DockSlot`, and phone shell. Implement validation/cancellation corrections
   with the corresponding checks. Keep PDF scroll restoration separate from
   dock geometry.
4. **Extract page saving, then navigation.** Establish the page/account save
   queues before moving the page lifecycle. Then introduce the page session,
   navigation commands, and generation-guarded restoration.
5. **Extract sync and longer operations.** Move account preference sync,
   transfers, sharing, metadata, and chat integration into their owners. Features
   communicate via explicit callbacks such as `onPageChanged` and
   `onTransferUpdated`, not an application-wide bag of setters.
6. **Finish the composition root and styles.** Move App into `app/`, update
   `main.jsx`, colocate feature CSS, and leave theme/base rules shared.
   Preserve stylesheet order until cascade interactions have been checked.

Each stage should build and remain usable on its own. Keep file moves and
behavior corrections distinguishable in the diff. No router library, global
state dependency, API redesign, or backend package reorganization is needed
for this work.

## Validation and documentation

- Build the frontend after each stage; use targeted behavioral tests for the
  changed owner rather than a test that only repeats its implementation.
- Exercise home folders/labels/pins, page creation, PDF and notes editing,
  sharing, import/export, tabs/Back, and phone/desktop layout as relevant.
- For save changes, verify two pages cannot overwrite each other's queued
  data, retries preserve newer edits, and stale account work cannot write.
- For layout changes, verify resize ratios, drag/reorder/cancel, collapsed
  headers, inherited/per-page layouts, and notes-only pages.
- For navigation, verify rapid A → B → C transitions leave C active, preserve
  A's edits, and never apply A/B's scroll or layout to C.
- Update `frontend/src/README.md`, `frontend/README.md`, `CLAUDE.md`, and the
  relevant `docs/dev/` topic files as each owner moves. Mark completed stages
  here so proposed paths are never mistaken for the implemented layout.

Completion means App only composes the session/view and feature boundaries;
it does not implement save queues, provider forms, folder mutations, or
pointer geometry. A few hundred lines is a useful direction, not a line-count
target that justifies hiding complexity in a replacement giant hook.

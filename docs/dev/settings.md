# Settings

Where every setting lives, and how the Settings dialog is built.

## Where settings are stored

| Layer | Storage | Examples |
|---|---|---|
| Per browser | `localStorage`, one `gamma-*` key per preference, all declared in `useAppPrefs()` ([frontend/src/app/prefs.js](../../frontend/src/app/prefs.js)) | PDF viewer behavior (incl. the handwriting input rules and the tool strip's presets, eraser and lasso choices, `gamma-ink-*`), context budgets, agent permissions, prompts, the control size (`gamma-ui-scale`, applied pre-paint by `index.html` like the theme). Theme + flip-page-colors live here too but additionally sync per account (next row, `appearance` key) — localStorage is their instant-paint cache |
| Session only | React state, nothing stored | the Ctrl+scroll text size of the notes list and the chat transcript (`useTextScale` in [Widgets.jsx](../../frontend/src/shared/ui/Widgets.jsx)) — resets on reload |
| Per account, synced | `/api/prefs/{key}` (small JSON KV, `user_prefs` in `users.db`) | per account AND workspace: open tabs (`open-tabs`), the recently-viewed queue (`recent-views`), pinned folders (`pinned-folders`; pinned pages are a page property), reading positions (`read-pos`) — they name one workspace's pages; account-wide: active AI key (`ai-provider`), appearance (`appearance`: theme + flip page colors). Server wins on load, localStorage (keyed `user@workspace`) is the instant-paint cache. The recents-card cover thumbnails are workspace data, through their own `/api/page-snaps` store (`page_snaps` in the workspace's `data.db` — over the prefs size cap) |
| Per account, server-only | AI provider entries (keys/OAuth tokens) under the reserved `ai-settings` prefs key (account-wide), managed via `/api/ai/providers*`; the browser only ever sees a masked hint | API keys, ChatGPT OAuth |
| Per workspace | `workspaces` / `workspace_members` in `users.db`, via `/api/workspaces*` ([workspaces.md](workspaces.md)) | name, kind (personal / shared), members and roles, access (private / public + the public role) and a shared workspace's own quota (admins), the account's default workspace, which workspace this tab works in (`?ws=` in the URL, `gamma-last-ws:<user>` remembers the last one) |
| Server-wide (admin) | `settings` KV in `users.db` via `GET/PUT /api/admin/settings`, plus nullable per-user override columns | default max upload size, default storage quota |

Adding a browser preference = one line in `useAppPrefs()` (with a codec if the
value needs validation) plus a control in the matching settings pane. Don't
scatter `usePersistedState` calls through App.jsx.

The last open page and viewer layout use `app/sessionState.js`, separately from
synced preferences. Its key is `gamma-session:<user>@<workspace>`. Reads wait
for workspace selection; changing scope cancels pending saves. Old unscoped
session caches are ignored because their account owner cannot be determined.

## The Settings dialog

Five everyday destinations are defined by `PREFERENCE_NAV` in
[SettingsDialog.jsx](../../frontend/src/settings/SettingsDialog.jsx):

- **Appearance**: theme choices and dark PDF pages (account-synced), control
  size and status bar (this browser).
  [SettingsAppearance.jsx](../../frontend/src/settings/SettingsAppearance.jsx): six
  theme cards (`PictureChoices`) with palette sketches and short
  descriptions, a PDF sample that follows the page tint and the dark-page
  switch, and the interface controls. Cards wrap into two columns on narrow
  screens, where the descriptions move to tooltips. The rows have no hover
  fill.
- **Reading & editing**: imported annotations, the handwriting input rules
  (stylus draws right away, fingers never draw, pressure), translation
  shortcut and language, Enter behavior and search expansion. Vertical
  scroll alignment and note badges on highlights are always on; their
  former keys `gamma-snap-vertical` and `gamma-hl-note-badge` are ignored.
- **Library**: thumbnails, folder/label display, metadata lookup, open-access
  fallback and saving external PDFs. These are browser preferences. Display
  is one live `PageCard` beside three switches (thumbnails, folders, labels);
  the two chip switches map onto the four `fileLabels` modes.
  [SettingsLibraryDisplay.jsx](../../frontend/src/settings/SettingsLibraryDisplay.jsx).
- **AI**: opens a second-level sidebar with Connections & models, Assistant,
  Advanced and Prompts. Assistant contains permissions and context presets;
  Advanced contains exact context budgets, technical limits and translation
  performance. Connections & models includes connection checks and models for
  metadata, translation and dictation.
- **Account**: the signed-in account only, including for admins. Existing
  administrator-only account editing rules still apply.

Larger management areas open their own navigation with Back to settings.
Shorter pages keep the main sidebar:

- **Manage workspaces**: workspaces and backups. A workspace's Manage action
  opens an inline detail page; rename and invite are small editor dialogs.
  Import/export, Export all and Back up all remain available. The account
  popover links to this manager beside the workspace switcher.
- **Library maintenance** (main sidebar): workspace storage, search-index rebuilding and the
  per-paper metadata/text/index health table. Also linked from the Library
  preferences page and the library operations menu.
- **Administration** (admins only): Users (accounts, each with its personal
  workspaces) and Server (shared workspaces, server-wide storage defaults,
  server backups and logs).
- **Diagnostics** (main sidebar): browser tracing and the browser session log.

Search is backed by [settingsNavigation.js](../../frontend/src/settings/settingsNavigation.js).
It searches labels and synonyms, filters out inaccessible management pages,
then opens the destination, focusing the
matching `data-setting` element. Add an entry when adding a new setting.
Legacy pane names resolve through `resolveSettingsPane`; old notes, search,
viewer and context entry points also jump to their section.

The desktop surface has a persistent search header and labeled sidebar. On
phones the Back button opens a labeled category list, replacing the old strip
of unlabeled icons. All controls remain reachable by keyboard and touch.

Most preferences apply immediately. Prompts use Save/Cancel. Credential,
account and workspace editor dialogs protect unsaved drafts on Cancel,
Escape and backdrop dismissal. `useSettingsDraft` registers dirty editors
with the settings navigation guard. Server storage defaults save together,
so saving one limit cannot discard an unsaved change to the other.

## Chat settings are global

The chat header shortcut edits the **same shared preferences** as Settings:
model, reasoning effort, single-paper context budget and tool permissions.
The Tools button and checkbox also edit the global `agentEnabled` preference;
there is no conversation-local tools override or reset on New chat.
Permissions remain scoped by chat kind (folder, PDF, notes), applying to all
chats of that kind in this browser. Read & search / Read, search & edit /
Custom presets retain access to the individual permissions. Existing custom
maps are preserved until the user explicitly picks a preset.

These browser preferences persist locally; this does not make them
account-synced. Provider selection and credentials retain their existing
account scope. Context presets change the three budgets together: Standard
is 60,000 / 6,000 / 120,000 characters, Larger doubles them, and Custom exposes
the exact values without changing them.

## Settings primitives

[SettingsKit.jsx](../../frontend/src/settings/SettingsKit.jsx) provides `PaneHead`,
`Section`, `Row`, `Toggle`, `SubDialog` and the shared controls.
Ordinary rows show a small icon, a label, a short hint and a control, with the
shared hover background. Put consequences in the visible
hint; supplementary `title` text appears on hover, without a Details toggle.
Use the existing shared controls, including `Segmented` for theme choices.
Editor dialogs accept a `draft` value for dismissal protection. See
[ui-design.md](ui-design.md) for shared control styling.

## Verification

`npm test` covers permission presets, search visibility and legacy pane aliases.
After building, `npm run e2e -- --only settings` exercises the actual UI:
preferences and reload, management navigation, prompt/connection draft guards,
shared chat settings, mobile layout and administrator account separation.
Use `--keep` to retain desktop/mobile screenshots. For concurrent development,
build into a private directory and set `GAMMA_E2E_DIST` to that directory so
another build cannot replace the assets while the suite runs.

## Storage limits

Two limits per account: max upload size per file (`max_upload_mb`, default
50) and total uploads quota (`quota_mb`, 0 = unlimited). Server-wide defaults
are admin-editable in Settings / Administration / Server; per-account overrides (NULL =
inherit) in the Users pane. They apply to the account's personal workspaces
together; a shared workspace has its own optional quota (admins, Settings →
Workspaces / Members & sharing — [workspaces.md](workspaces.md)). `GET
/api/quota` reports the limits that apply to the current workspace and its
usage — it feeds the pre-upload size check and the shared `QuotaMeter` bar
(account popover, Library maintenance, Users rows, the workspace manager).
Uploads are hard-gated (413 over per-file, 507 over quota); best-effort
caches (proxy save, AI re-download) just skip saving when full. Dedup'd
files (same hash) are always allowed.

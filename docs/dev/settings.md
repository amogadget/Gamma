# Settings

Where every setting lives, and how the Settings dialog is built.

## Where settings are stored

| Layer | Storage | Examples |
|---|---|---|
| Per browser | `localStorage`, one `gamma-*` key per preference, all declared in `useAppPrefs()` ([frontend/src/app/prefs.js](../../frontend/src/app/prefs.js)) — except `gamma-link-name`, the share view's display name for a visitor without an account, owned by `src/collaboration/linkName.js` because the fetch wrapper reads it outside React | PDF viewer behavior (incl. the handwriting input rules and the tool strip's presets, eraser and lasso choices, `gamma-ink-*`), context budgets, agent permissions, prompts, the control size (`gamma-ui-scale`, applied pre-paint by `index.html` like the theme). Theme + flip-page-colors live here too but additionally sync per account (next row, `appearance` key) — localStorage is their instant-paint cache |
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

One dialog, one sidebar in three groups, defined by `PREFERENCE_NAV`,
`AI_NAV` and `MANAGEMENT_NAV` in
[SettingsDialog.jsx](../../frontend/src/settings/SettingsDialog.jsx). Every
pane is one click from any other; nothing opens a second dialog or a
"back" link. Panes carry no explanatory subtitle: a section rule's right-hand
tag ("Your account" / "This browser") says where a setting lives, a row's
short hint what it does, and the hover `title` the rest.

Preferences:

- **Appearance**: the eight theme cards (`PictureChoices`), the dark-page
  switch with its live PDF sample, control size and the status bar.
  [SettingsAppearance.jsx](../../frontend/src/settings/SettingsAppearance.jsx).
- **Reading & editing**: imported annotations (a Keep / Remove segmented
  choice), handwriting as two `IconChoices` tiles ("Draws with": pen only /
  pen and finger — the stored preference is still `inkPenOnly`) plus the
  stylus-draws-right-away and pressure switches, translation (button and
  language; the section's action jumps to AI › Advanced for model and
  speed), the Enter key, and how search opens on the home page and on a
  page (Full panel / Find bar).
- **Library**: the live card demo with the thumbnails / folders / labels
  switches ([SettingsLibraryDisplay.jsx](../../frontend/src/settings/SettingsLibraryDisplay.jsx)),
  open-access fallback, metadata auto-fetch and saving external PDFs.
- **Account**: the signed-in account's row and storage meter.

AI:

- **Connections**: the provider list (empty state: one sentence and the Add
  button), the login connection check, the models (default chat, metadata,
  dictation, translation) and the account's token usage
  ([ai.md](ai.md) "Token usage"). The check, models and usage sections
  appear only once a provider exists.
- **Chat**: the tools master switch and, per chat kind (folder / PDF /
  notes), the tool chips (`AgentToolPicker`, the same `ToggleGroup` the chat
  header's settings popover shows for the open chat). No presets.
- **Advanced**: reasoning effort, tool limits, the context budgets (the
  section's action is the Standard / Larger / Custom preset), translation
  effort and parallel requests, and the snapshot-clearing switch.
- **Prompts**: the accordion with one Cancel / Save pair.
- **Integrations** ([SettingsIntegrations.jsx](../../frontend/src/settings/SettingsIntegrations.jsx)):
  the workspace's assistant connections, the MCP URL, the Codex setup
  command and the manual-token fallback ([mcp.md](mcp.md)) — a token's
  scope is a `Segmented` (read-only for assistants, read and write for an
  offline copy on another Gamma, [mirror.md](mirror.md)).

Manage:

- **Workspaces**: storage meter, personal and shared workspaces (each row:
  Open, a Data menu with export and import, Manage — an inline detail page;
  rename and invite are small editor dialogs), New workspace, Export all.
  The empty Shared section offers admins "New shared workspace" (a jump to
  Server). The account popover's "Workspaces…" opens this pane. Between
  Personal and Shared, **Offline copies**
  ([SettingsMirrors.jsx](../../frontend/src/settings/SettingsMirrors.jsx)):
  the account's mirrors of remote workspaces (each row: status line, Open,
  Sync now, Merges — an inline list of the decisions the sync took on its
  own with Keep / Use mine / Use theirs —, Stop) and "Mirror a remote
  workspace" (a `SubDialog`: server address, write token, name, direction)
  — [mirror.md](mirror.md).
- **Backups**: server-kept snapshots per workspace.
- **Library maintenance**: workspace storage, search-index rebuilding and
  the per-paper metadata / text / index health table.
- **Users** (admins): accounts, each with its personal workspaces and
  labelled Storage / Edit buttons.
- **Server** (admins): the dashboard (build, uptime, warnings, the update
  check), the public server URL, storage defaults (each box saves on Enter
  or blur), shared workspaces, server backups and the log with its level
  filter ([user_db.md](user_db.md)).
- **Diagnostics**: browser tracing and the browser session log.

Administrators confirm the **Public server URL** under Server: the row shows
a "confirmed" / "not confirmed" tag and, while the address is unconfirmed or
edited, one Confirm button. It is prefilled from the browser origin but saved
only on confirmation; the saved address immediately configures assistant
sign-in and the MCP host allowlist and persists in the server `settings`
table. An existing `GAMMA_PUBLIC_URL` environment override is shown
read-only.

Search is backed by [settingsNavigation.js](../../frontend/src/settings/settingsNavigation.js).
It searches labels and synonyms, filters out inaccessible management pages,
then opens the destination, focusing the
matching `data-setting` element. Add an entry when adding a new setting.
Legacy pane names resolve through `resolveSettingsPane`; old notes, search,
viewer and context entry points also jump to their section.

The desktop surface has a persistent search header and labeled sidebar. On
phones the Back button opens a labeled category list, replacing the old strip
of unlabeled icons. All controls remain reachable by keyboard and touch.

Most preferences apply immediately, the server storage defaults included
(each box saves when it commits). Prompts and the public server URL use a
draft with Cancel / Save (Confirm). Credential, account and workspace editor
dialogs protect unsaved drafts on Cancel, Escape and backdrop dismissal.
`useSettingsDraft` registers dirty editors with the settings navigation
guard.

## Chat settings are global

The chat header shortcut edits the **same shared preferences** as Settings:
model, reasoning effort, single-paper context budget and tool permissions.
The Tools button and checkbox also edit the global `agentEnabled` preference;
there is no conversation-local tools override or reset on New chat.
Permissions remain scoped by chat kind (folder, PDF, notes), applying to all
chats of that kind in this browser. Both surfaces show the same tool
chips per chat kind; there are no presets.

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
Use the existing shared controls: `PictureChoices` for illustrated choices,
`IconChoices` for a small exclusive set pictured as icon tiles (the share
popover's audience, handwriting's "Draws with"), `Segmented` for two or three
short words, `ToggleGroup` for independent chips.
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
are admin-editable in Settings → Server; per-account overrides (NULL =
inherit) in the Users pane. They apply to the account's personal workspaces
together; a shared workspace has its own optional quota (admins, Settings →
Workspaces / Members & sharing — [workspaces.md](workspaces.md)). `GET
/api/quota` reports the limits that apply to the current workspace and its
usage — it feeds the pre-upload size check and the shared `QuotaMeter` bar
(account popover, Library maintenance, Users rows, the workspace manager).
Uploads are hard-gated (413 over per-file, 507 over quota); best-effort
caches (proxy save, AI re-download) just skip saving when full. Dedup'd
files (same hash) are always allowed.

# Settings

Where every setting lives, and how the Settings dialog is built.

## Where settings are stored

| Layer | Storage | Examples |
|---|---|---|
| Per browser | `localStorage`, one `gamma-*` key per preference, all declared in `useAppPrefs()` ([frontend/src/prefs.js](../../frontend/src/prefs.js)) | PDF viewer behavior, context budgets, agent permissions, prompts, the control size (`gamma-ui-scale`, applied pre-paint by `index.html` like the theme). Theme + flip-page-colors live here too but additionally sync per account (next row, `appearance` key) — localStorage is their instant-paint cache |
| Session only | React state, nothing stored | the Ctrl+scroll text size of the notes list and the chat transcript (`useTextScale` in [widgets.jsx](../../frontend/src/widgets.jsx)) — resets on reload |
| Per account, synced | `/api/prefs/{key}` (small JSON KV, `user_prefs` in `users.db`) | per account AND workspace: open tabs (`open-tabs`), the recently-viewed queue (`recent-views`), pinned folders (`pinned-folders`; pinned pages are a page property), reading positions (`read-pos`) — they name one workspace's pages; account-wide: active AI key (`ai-provider`), appearance (`appearance`: theme + flip page colors). Server wins on load, localStorage (keyed `user@workspace`) is the instant-paint cache. The recents-card cover thumbnails are workspace data, through their own `/api/page-snaps` store (`page_snaps` in the workspace's `data.db` — over the prefs size cap) |
| Per account, server-only | AI provider entries (keys/OAuth tokens) under the reserved `ai-settings` prefs key (account-wide), managed via `/api/ai/providers*`; the browser only ever sees a masked hint | API keys, ChatGPT OAuth |
| Per workspace | `workspaces` / `workspace_members` in `users.db`, via `/api/workspaces*` ([workspaces.md](workspaces.md)) | name, kind (personal / shared), members and roles, access (private / public + the public role) and a shared workspace's own quota (admins), the account's default workspace, which workspace this tab works in (`?ws=` in the URL, `gamma-last-ws:<user>` remembers the last one) |
| Server-wide (admin) | `settings` KV in `users.db` via `GET/PUT /api/admin/settings`, plus nullable per-user override columns | default max upload size, default storage quota |

Adding a browser preference = one line in `useAppPrefs()` (with a codec if the
value needs validation) plus a control in the matching settings pane. Don't
scatter `usePersistedState` calls through App.jsx.

## The Settings dialog

Thirteen panes in four rail groups (`NAV_GROUPS` in
[frontend/src/settings.jsx](../../frontend/src/settings.jsx)):

- **Workspace** — Workspaces (every workspace I can open: my storage
  meter, the Personal and Shared lists, each row with Open, Export, Import
  and Manage — rename, members and roles, Make default, Leave, Delete —
  plus New workspace and Export all —
  [settingsWorkspace.jsx](../../frontend/src/settingsWorkspace.jsx)), Backups
  (my workspaces' server-kept snapshots: take, download, restore, delete,
  Back up all — [settingsBackups.jsx](../../frontend/src/settingsBackups.jsx));
  both hidden for guests, General (theme incl. the Sepia/Gray eye-comfort modes and
  flip page colors — both synced per account; the control size — a −/+
  `Stepper` (70–160 %) that zooms every button and toggle, see [ui-design.md](ui-design.md); paper-fetching prefs),
  Library (home-card thumbnails and folder/label chips, storage
  usage, search index, per-paper metadata health table — status
  filter incl. "Unverified AI" / "Needs attention", verified/text/index
  coverage tiles, click a title to open the paper, select-all works on the
  filtered view, and the batch fetch targets missing + unverified records)
- **Editor** — Notes (Enter behavior, note badges), Search (auto-expand
  defaults), PDF viewer (snap scrolling, embedded annotations, the
  translated view's target language + model) — the viewer is one pane of
  the editor group, not a group of its own (the app is block-centric,
  see [block_centric.md](block_centric.md))
- **AI** — Provider and models (credentials, automatic subscription usage,
  provider model catalogs, metadata and dictation model choices, the login
  connection check — `gamma-ai-login-check`, default the free credential
  ping — in [settingsAi.jsx](../../frontend/src/settingsAi.jsx)),
  Assistant (Tools: the single master switch; Tool
  configuration: one `ToggleGroup` chip row of tool permissions per chat
  kind (folder / PDF / notes; the chat header's ⚙ popover edits the same
  map for its own kind), tool rounds, agent read window; context
  budgets — the chat header's ⚙ popover edits the model, reasoning effort, the
  single-paper context budget and the per-tool permissions in place; same
  prefs),
  Prompts (the four editable prompts, as an accordion)
- **Account** — Users (admin account management / "You" for non-admins, in
  [settingsUsers.jsx](../../frontend/src/settingsUsers.jsx)), Server (admins
  only, everything about the server rather than one account: the storage
  defaults, every workspace with a Manage dialog — access, quota, members
  and ownership, kind conversion, join — and New shared workspace for any
  owner, *Server backups* of the whole data directory, and the server log,
  in [settingsServer.jsx](../../frontend/src/settingsServer.jsx) +
  [settingsWorkspacesAdmin.jsx](../../frontend/src/settingsWorkspacesAdmin.jsx)),
  Advanced (status bar, debug tracing, this browser's log)

Old pane ids keep resolving through `PANE_ALIASES`. App.jsx owns all the
state and passes it in as prop groups; the dialog only renders.

Panes are composed exclusively from the primitives in
[frontend/src/settingsKit.jsx](../../frontend/src/settingsKit.jsx) — see
[ui-design.md](ui-design.md). The visible UI per row is icon · label · one
short hint · control; the long explanation goes in the row's `title`
(hover), never on screen.

## Storage limits

Two limits per account: max upload size per file (`max_upload_mb`, default
50) and total uploads quota (`quota_mb`, 0 = unlimited). Server-wide defaults
are admin-editable in Settings → Server; per-account overrides (NULL =
inherit) in the Users pane. They apply to the account's personal workspaces
together; a shared workspace has its own optional quota (admins, Settings →
Workspaces / Members & sharing — [workspaces.md](workspaces.md)). `GET
/api/quota` reports the limits that apply to the current workspace and its
usage — it feeds the pre-upload size check and the shared `QuotaMeter` bar
(account popover, Library pane, Users rows, the Members & sharing pane).
Uploads are hard-gated (413 over per-file, 507 over quota); best-effort
caches (proxy save, AI re-download) just skip saving when full. Dedup'd
files (same hash) are always allowed.

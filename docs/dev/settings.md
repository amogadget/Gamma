# Settings

Where every setting lives, and how the Settings dialog is built.

## Where settings are stored

| Layer | Storage | Examples |
|---|---|---|
| Per browser | `localStorage`, one `gamma-*` key per preference, all declared in `useAppPrefs()` ([frontend/src/prefs.js](../../frontend/src/prefs.js)) | PDF viewer behavior, context budgets, agent permissions, prompts. Theme + flip-page-colors live here too but additionally sync per account (next row, `appearance` key) — localStorage is their instant-paint cache |
| Per account, synced | `/api/prefs/{key}` (small JSON KV in the user's `data.db`) | open tabs (`open-tabs`), the recently-viewed queue (`recent-views`), active AI key (`ai-provider`), appearance (`appearance`: theme + flip page colors) — server wins on load, localStorage is the instant-paint cache. The recents-card cover thumbnails sync too, but through their own `/api/page-snaps` store (`page_snaps` table — over the prefs size cap) |
| Per account, server-only | AI provider entries (keys/OAuth tokens) under the reserved `ai-settings` prefs key, managed via `/api/ai/providers*`; the browser only ever sees a masked hint | API keys, ChatGPT OAuth |
| Server-wide (admin) | `settings` KV in `users.db` via `GET/PUT /api/admin/settings`, plus nullable per-user override columns | default max upload size, default storage quota |

Adding a browser preference = one line in `useAppPrefs()` (with a codec if the
value needs validation) plus a control in the matching settings pane. Don't
scatter `usePersistedState` calls through App.jsx.

## The Settings dialog

Nine panes in four rail groups (`NAV_GROUPS` in
[frontend/src/settings.jsx](../../frontend/src/settings.jsx)):

- **Workspace** — General (theme incl. the Sepia/Gray eye-comfort modes and
  flip page colors — both synced per account; paper-fetching prefs),
  Library (home-card thumbnails and folder/label chips, storage
  usage/limits, search index, per-paper metadata health table — status
  filter incl. "Unverified AI" / "Needs attention", verified/text/index
  coverage tiles, click a title to open the paper, select-all works on the
  filtered view, and the batch fetch targets missing + unverified records)
- **Reading** — PDF viewer (snap scrolling, embedded annotations, translation:
  button on/off, target language, model, effort, parallel requests 1–8), Search
  (auto-expand defaults), Notes (Enter behavior, note badges)
- **AI** — Provider and models (credentials, automatic subscription usage,
  provider model catalogs, metadata and dictation model choices, the login
  connection check — `gamma-ai-login-check`, default the free credential
  ping — in
  [settingsAi.jsx](../../frontend/src/settingsAi.jsx)),
  Assistant (Tools: the master switch + folder/PDF per-chat defaults; Tool
  configuration: per-tool permissions, tool rounds, agent read window; context
  budgets — the chat header's ⚙ popover edits the model, reasoning effort and
  the single-paper context budget in place; same prefs),
  Prompts (the four editable prompts, as an accordion)
- **Account** — Users (admin account management / "You" for non-admins, in
  [settingsUsers.jsx](../../frontend/src/settingsUsers.jsx)), Advanced (status
  bar, debug tracing, session + server logs)

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
are admin-editable in Settings → Library; per-account overrides (NULL =
inherit) in the Users pane. `GET /api/quota` reports the session user's
effective limits and usage — it feeds the pre-upload size check and the
shared `QuotaMeter` bar (account popover, Library pane, Users rows).
Uploads are hard-gated (413 over per-file, 507 over quota); best-effort
caches (proxy save, AI re-download) just skip saving when full. Dedup'd
files (same hash) are always allowed.

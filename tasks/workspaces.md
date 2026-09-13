# Workspaces (accounts ≠ libraries) + versioned data migrations

Status: **implemented and verified** (2026-09-13); not committed. Developer
docs: [docs/dev/workspaces.md](../docs/dev/workspaces.md) (the model, access,
API, UI) and [docs/dev/migrations.md](../docs/dev/migrations.md) (the upgrade
runner). This file keeps the task framing, what was found, and what is left.

## The task

Separate workspaces from users: one account, several libraries (papers /
reading), and shared libraries (a lab) that several accounts belong to under
Notion-style invitations; switch between them from the user menu. Because
this changes stored data, a user-friendly, safe, regulated migration helper
that does not pile up over releases. Concise docs along the way.

## What was found first

Identity and data location were one string: every data helper took the
username (`connect_pages_db(user)`, `user_uploads_dir(user)`, `commit_ops(user,
…)`), shares were keyed by `(username, page)`, collab rooms by `(username,
page)`, and `users/<username>/` held everything — pages, chats, prefs *and*
the AI secrets. Schema upgrades were lazy `ALTER TABLE` on connect plus one
normalization pass, and one step (`drop shares.doc_id`) was parked as
"hand-run, later" because an older binary would break on the new shape — the
exact pile-up the task warns about.

## What was built

Backend: `workspaces.py` (model), `migrations.py` (runner: `PRAGMA
user_version`, snapshot into `backups/`, numbered resumable steps, refusal
of newer/too-old directories, `MIN_UPGRADABLE` for deleting old steps),
`normalize.py` (the old normalization pass, now also run on backup restore),
`db.py` at the current shape only (`users.db` gains `workspaces`,
`workspace_members`, `user_prefs`, `users.default_workspace`; `shares`
re-keyed by workspace and rid of `doc_id`), `auth.py` (`require_ws`,
`resolve_ws`, `require_ws_writer`, `ws_role`; members keep their role
through share links), `routers/workspaces.py`, every router and helper
taking a workspace id with `request.state.user` as the actor, storage
limits billed to a workspace's creator, `manage.py` (`migrate --status /
--dry-run`, `backups`, `list-workspaces`, `set-member`). Steps: 1 baseline
(the lazy columns, share backfill, file normalization), 2 workspaces
(`users/<name>/` → `workspaces/<id>/`, prefs to `users.db`, shares
re-keyed).

Frontend: the fetch wrapper adds `X-Gamma-Workspace`; `?ws=` in URLs,
copied links and the socket; `App.jsx` picks the workspace after the
session (URL → the page a deep link names → last used → personal), gates
the boot on it, keys per-account browser state `user@workspace`, sets
`readOnly` for viewers; the account menu's switcher; Settings → Members &
sharing (`settingsWorkspace.jsx`).

Tests: `test_workspaces.py` (12) and `test_migrations.py` (6) new, the rest
of the suite updated — 456 green. The migration was rehearsed on a copy of
the real `data/` directory (7 accounts, 341 MB): every account moved, 32
shares re-keyed, prefs split by scope, 33 MB snapshot, second run a no-op.
Verified in the browser (Playwright): switcher, create-and-open, invite as
viewer, viewer read-only + 403 on write, a deep link without `ws` landing in
the right workspace.

## Round two (same day)

- **Desktop aligned.** The shell's registry entries are **servers** now
  (`servers.json`, migrated from `workspaces.json` on first start; the
  storage root folder keeps its old name so nothing moves); "workspace"
  means Gamma's. The shell bar menu lists the open server's Gamma workspaces
  (read from `/api/session` through the content session's cookies, switched
  by navigating to `?ws=`) above the servers; the bar reads "server ·
  workspace". Launcher, native menu, docs and the e2e suite renamed; a new
  e2e step creates a workspace through the API and switches from the bar.
- **Server backups.** `gamma/backups.py` (the migration runner's snapshot
  code, generalised): create with or without uploads, list, zip for
  download, delete, restore (CLI, server stopped). Admin endpoints under
  `/api/admin/backups*`, a *Server backups* section in Settings → Advanced
  (`settingsBackups.jsx`), `manage.py backups --create/--delete/--restore/
  --prune`. Tests: `test_backups_api.py` + two cases in `test_migrations.py`.

## Left / ideas

- The desktop shell reads the workspace list only after navigation and when
  the menu opens; a workspace created in Gamma shows up in the bar on the
  next menu open, not live.

- Viewers still see some write affordances (upload buttons, share menu);
  the server refuses them. Hiding them behind `readOnly` is UI polish.
- Chats are workspace data, so members of a shared workspace see each
  other's AI conversations about its pages. Per-member chats would need a
  `(bucket, username)` key.
- No cross-workspace page move (export/merge does it); a "Move page to
  workspace…" action would be a server-side copy + delete.
- The extension clips into the personal workspace; a workspace picker in
  its popup would send `ws`.
- Activity/audit: `workspace_members.added_by` and the op log's `actor`
  exist; nothing shows them yet.

## Decisions log

- A workspace id is a random token, never a name: renames move no files
  (the old per-username directory made `rename-user` a stop-the-server
  operation on Windows).
- One schema version for the whole data directory, in `users.db`; the
  per-workspace files stay versionless and are normalized on restore
  instead, because backups can be older than any step.
- Refuse newer data directories rather than "best effort": an older Gamma
  that opened a migrated directory would create empty accounts next to the
  moved data.
- Snapshots copy databases only (the SQLite backup API); uploads are moved
  by `rename`, never rewritten, so a rollback is a copy-back plus the
  manifest.
- Billing follows the workspace's creator, so sharing does not multiply
  quotas; server admins can raise the creator's limit.
- Switching workspaces is a full reload: every piece of per-library state
  (tabs, recents, the live session) is torn down for free and nothing can
  leak across.

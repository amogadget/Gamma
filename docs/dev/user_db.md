# Users, workspaces, databases, and accounts

Where state lives on disk, how a request becomes a user and a workspace, and
everything account-shaped: seeding, the CLI, the admin GUI, storage limits,
the server log. Code: `gamma/db.py` (schemas/paths), `gamma/auth.py`
(middleware + workspace resolution), `gamma/workspaces.py`, `gamma/seed.py`,
`gamma/routers/admin.py`, `gamma/server_settings.py`, `gamma/logbuf.py`,
`backend/manage.py`. The workspace model itself: [workspaces.md](workspaces.md);
schema upgrades: [migrations.md](migrations.md).

## Data directory layout

All state is SQLite + files on disk under a data directory (env
`GAMMA_DATA_DIR`, defaults to the repo's `data/`):

- `users.db` — global. Its `PRAGMA user_version` is the data directory's
  schema version (`db.SCHEMA_VERSION`). Tables:
  - `users` — accounts (bcrypt), the guest/admin flags, nullable per-user
    storage-limit overrides, `default_workspace` (the personal workspace);
  - `sessions` — session tokens;
  - `workspaces` (`id`, `name`, `created_by`, `kind` personal/shared,
    `access` private/public, `public_role`, `quota_mb`) and
    `workspace_members` (`workspace_id`, `username`, `role`
    owner/editor/viewer — a personal workspace has exactly its account);
  - `shares` — page share links, one per `(workspace_id, page_id)`, with
    `created_by`, `audience` anyone/users/list, `role` view/edit and the
    comma-separated `allowed_users`;
  - `user_prefs` — small JSON values per `(username, workspace_id, key)`:
    workspace `''` for the account-wide keys (`db.USER_PREF_KEYS`:
    appearance, the active AI provider, the AI provider entries with their
    secrets), the workspace id for everything that names its pages (open
    tabs, recents, pinned folders, reading positions);
  - `settings` — admin-tunable server settings (KV).
- `workspaces/<id>/pages.db` — the core data model: the `unified_blocks`
  table. Everything is a block (self-referential `parent_id`, fractional-index
  `position` strings like `a0`, `a0V` from the `fractional-indexing` package).
  Root-level blocks (parent `'root'`) are pages; a page may CARRY a PDF
  attachment (`doc_id` / `source_url` / `original_filename`, read through
  `blocks_store.page_attachment()`). Highlights are blocks with `highlight_id` /
  `pdf_position` in their JSON `properties` column; free notes are blocks
  without. Next to it, `page_ops` — the per-page operation log (one row per
  applied batch, `seq` counting up per page, pruned to the newest 2000;
  [collab.md](collab.md)). Open it ONLY through `db.connect_pages_db(ws)`:
  WAL journal mode (readers never wait on a writer — several browsers,
  several members), a 10 s busy timeout, and the schema statements (so a
  restored backup gains `page_ops`). Backups copy it with the sqlite backup
  API, which is WAL-safe.
- `workspaces/<id>/data.db` — the workspace's derived data: AI `chats` +
  `chat_history`, `page_snaps` (the recents-card cover thumbnails, synced via
  `/api/page-snaps` — too big for the prefs KV), the viewer's per-document
  manifests `pdf_docs` (byte size, page count, page sizes —
  `gamma/pdf_meta.py`, [pdf_loading.md](pdf_loading.md)) and the two lazily
  built FTS5 search indexes: `pdf_fts`/`pdf_fts_docs` (extracted PDF text per page —
  schema + queries `gamma/pdf_index.py`, extraction `routers/search.py`) and
  `block_fts`/`block_fts_meta` (every non-root block's content keyed by its
  page root, rebuilt per page when the page changed — `gamma/block_index.py`).
  The indexes are rebuilt on demand; their rows are pruned when pages go.
  Shared by the workspace's members. Personal prefs used to live here (a
  `prefs` table); migration step 2 moved them to `users.db`.
- `workspaces/<id>/uploads/` — PDFs, images and generic file attachments
  (`/api/upload-file`), filenames are content sha256[:24] + extension (dedup).
- `backups/<time>-<label>/` — snapshots of the whole data directory's
  databases (and, on request, the uploads): the migration runner's `v<N>`
  ones (newest three kept) and the ones admins take from Settings → Server
  or `manage.py backups` ([migrations.md](migrations.md) "Backups").
- `backups/workspaces/<id>/<time>-<label>.zip` — one workspace's
  server-kept snapshots (Settings → Backups): `/api/export` zips, full
  copies, at most 20 per workspace, deleted with the workspace
  ([workspaces.md](workspaces.md) "Backups").

Workspace ids are random tokens (`workspaces.new_workspace_id`), so renaming
an account or a workspace never moves files. `db.safe_ws_id` / `safe_doc_id`
guard every path built from one.

## Schema versions

There is no lazy `ALTER TABLE` on connect any more: `db.py` always creates
the current shape, and an existing data directory is brought up to it by the
numbered steps in `gamma/migrations.py` — at every server start, with a
snapshot first, refusing a newer directory. `db.connect_users_db()` raises
`SchemaOutdated` on an old file so nothing reads it with new assumptions.
Content normalization of a workspace's files (`gamma/normalize.py`) runs in
the baseline step and on every backup restore. Rules, versions and how to
write a step: [migrations.md](migrations.md).

## Auth model

`session` cookie → middleware resolves `request.state.user` (+ `is_guest`,
`is_admin`, `default_ws`). Guest account data is wiped and re-seeded daily
(checked lazily in the middleware). Which workspace a request reads or
writes is a second decision (`require_ws` / `resolve_ws` /
`require_ws_writer` — [workspaces.md](workspaces.md)): `?ws=` or the
`X-Gamma-Workspace` header, else the account's default workspace, gated by
membership and role. Share tokens grant access to ONE page (any page — paper
or plain notes) of one workspace for the audience the sharer chose:
endpoints that support shared views resolve the workspace from the share
token (`resolve_ws` — the token wins over the visitor's own session for
choosing whose data is read) and confine reads to the page's subtree
(`share_scope_page` + `assert_block_in_page`); write endpoints require a
member with the editor or owner role (`require_ws(write=True)`), except the
block writers, which accept an `edit` share through `require_ws_writer` under
the same page scope. Keep that distinction when touching endpoints. Full
endpoint/auth table: [api.md](api.md).

## First-run seeding

The APP seeds the first admin, not launcher scripts — `seed.ensure_admin_seed()`
runs at startup and creates an "admin" account (with its personal workspace)
and a RANDOM password printed once to the console (env-overridable via
`GAMMA_ADMIN_USER` / `GAMMA_ADMIN_PASSWORD`) ONLY while zero non-guest
accounts exist. Deliberately not keyed on "no admin exists": auto-adding an
admin login to an upgraded multi-user instance would be a backdoor — those
get a startup hint to run `manage.py set-admin`. `seed.create_workspace_files`
writes a workspace's empty files (and the guest welcome page);
`workspaces.ensure_personal` gives an account its personal workspace.

## manage.py CLI

User CRUD: `create-user`, `set-password`, `set-admin`, `rename-user`,
`delete-user` (also the workspaces only that account owned), `list-users`,
`reset-guest`, `setup` (idempotent: guest account + a personal workspace for
every account + missing files). Workspaces: `list-workspaces`,
`create-workspace <name> <owner> [shared [public [viewer|editor]]]`, `set-member
<ws> <user> <owner|editor|viewer|none>`, `set-access <ws> <private|public>
[viewer|editor]`. Data directory: `migrate`
(`--status`, `--dry-run`), `backups` (list; `--create [--uploads]`,
`--delete`, `--restore`, `--prune`). Every command but
`migrate`/`backups` refuses an outdated data directory. `rename-user`
updates every row that names the account (users, sessions, shares,
memberships, prefs) — no files move.

## User management GUI

`gamma/routers/admin.py` (`/api/admin/users*`, `/api/admin/workspaces`),
frontend [SettingsUsers.jsx](../../frontend/src/settings/SettingsUsers.jsx): admins
manage accounts from Settings → Users; non-admins get the same pane as "You"
(their single row from session + `/api/quota`, since `/api/admin/*` is
admin-only). Each account row lists the account's personal workspaces
(from `/api/admin/workspaces`) with Open / Manage — the workspace dialog in
admin mode. Shared workspaces are not per account and are managed from
Settings → Server
([SettingsWorkspacesAdmin.jsx](../../frontend/src/settings/SettingsWorkspacesAdmin.jsx),
on top of `/api/admin/workspaces` + the workspace API, which admins pass
without membership — [workspaces.md](workspaces.md)). Backups are not here: every workspace's
export/import lives on its row in Settings → Workspaces and its snapshots
in Settings → Backups ([workspaces.md](workspaces.md)); admins reach any
workspace from Settings → Server (`/api/export?user=` still serves an
account's default workspace to scripts). The guest workspace can be
exported but never restored into. Rails: guest untouchable, no self-delete, the last
admin can't be demoted or deleted. Deleting an account deletes its
personal workspaces and the shared ones it alone owned (the response lists
them); shared workspaces with another owner survive.

## Storage limits

`gamma/server_settings.py`: per-account max upload size (`max_upload_mb`) and
total quota (`quota_mb`, 0 = unlimited); server-wide defaults in the users.db
`settings` KV, per-user overrides as nullable `users` columns (NULL = inherit,
explicit JSON null clears). An account's limits apply to uploads into its
PERSONAL workspaces, and its usage is their `uploads/` directories together
— nothing anyone uploads into a shared workspace counts against a person. A
shared workspace is checked against the server-wide per-file cap and its
own `workspaces.quota_mb` (NULL = unlimited; admins set it in Settings →
Workspaces or Members & sharing). `workspace_quota(ws)` resolves the pair
that applies. `check_upload_allowed(ws, n)` hard-gates `/api/uploads`, `/api/upload-image`,
`/api/upload-file` and the imports (413 over per-file, 507 over quota;
already-stored hashes always pass — dedup adds no bytes); `can_store`
soft-gates best-effort caches (proxy `save=1`, ai_context re-download).
`GET /api/quota` = the request's workspace: the limits that apply,
`used_bytes` (the account's total for a personal workspace, the workspace's
own for a shared one), `workspace_bytes` (this workspace's), and `account`
— the person whose limits these are, "" for a shared workspace;
deliberately NOT part of `/api/session` (identity only). Backup-restore imports are unmetered.
Details + UI in [settings.md](settings.md).

## Server log

`gamma/logbuf.py`, `GET /api/admin/logs?after=<seq>`: all backend logging goes
through `logbuf.log` (a `logging` logger — use it, not `print()`), which tees
to the console and a scrubbed in-memory ring buffer (2000 entries, gone on
restart) shown admin-only in Settings → Server → "Log". Secret-shaped
substrings (Bearer/sk- keys, `password=`/`token=` pairs, 40+-char urlsafe runs
— session/share tokens) are masked at insert time; the one-time seeded admin
password in `seed.py` stays a raw `print()` on purpose and must never route
through the logger. `uvicorn.access` is deliberately not captured (its lines
carry `?share=` query strings); the middleware's `[http]` line covers requests
path-only.

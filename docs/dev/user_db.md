# Users, databases, and accounts

Where state lives on disk, how a request becomes a user, and everything
account-shaped: seeding, the CLI, the admin GUI, storage limits, the server log.
Code: `gamma/db.py` (schemas/paths), `gamma/auth.py` (middleware),
`gamma/seed.py`, `gamma/routers/admin.py`, `gamma/server_settings.py`,
`gamma/logbuf.py`, `backend/manage.py`.

## Data directory layout

All state is SQLite + files on disk under a data directory (env
`GAMMA_DATA_DIR`, defaults to `backend/`):

- `users.db` — global: accounts (bcrypt, plus nullable per-user storage-limit
  override columns), session tokens, share tokens (`shares`: one per
  owner + `page_id` with `audience` anyone/users/list, `role` view/edit and
  the comma-separated `allowed_users`; the `doc_id` column is vestigial —
  never read, written as `""` while it exists, dropped by the hand-run
  `migrate --drop-share-doc-id` below; rows from before shares were keyed by
  page had NULL `page_id` and were backfilled or deleted once by the
  normalization pass), admin-tunable server settings (`settings` KV).
- `users/<username>/pages.db` — the core data model: the `unified_blocks`
  table. Everything is a block (self-referential `parent_id`, fractional-index
  `position` strings like `a0`, `a0V` from the `fractional-indexing` package).
  Root-level blocks (parent `'root'`) are pages; a page may CARRY a PDF
  attachment (`doc_id` / `source_url` / `original_filename`, read through
  `blocks_store.page_attachment()`). Highlights are blocks with `highlight_id` /
  `pdf_position` in their JSON `properties` column; free notes are blocks
  without. Next to it, `page_ops` — the per-page operation log (one row per
  applied batch, `seq` counting up per page, pruned to the newest 2000;
  [collab.md](collab.md)). Open it ONLY through `db.connect_pages_db(user)`:
  WAL journal mode (readers never wait on a writer — two browsers of one
  account, a share editor next to the owner), a 10 s busy timeout, and the
  schema statements (so a restored backup gains `page_ops`). Backups copy it
  with the sqlite backup API, which is WAL-safe.
- `users/<username>/data.db` — AI `chats` history
  + `prefs` (small JSON KV synced across browsers via `/api/prefs/{key}`, e.g.
  `open-tabs`, `recent-views`) + `page_snaps` (the recents-card cover
  thumbnails, synced via `/api/page-snaps` — too big for the prefs KV) + the
  two lazily built FTS5 search indexes: `pdf_fts`/`pdf_fts_docs` (extracted
  PDF text per page — schema + queries `gamma/pdf_index.py`, extraction
  `routers/search.py`) and `block_fts`/`block_fts_meta`
  (every non-root block's content keyed by its page root, rebuilt per page
  when the page changed — `gamma/block_index.py`). Both are derived data,
  rebuilt on demand; their rows are pruned when pages go. The reserved
  `ai-settings` prefs key holds the user's AI provider entries — the generic
  prefs endpoints refuse the key; see [ai.md](ai.md) for how those entries
  are managed and read.
- `users/<username>/uploads/` — PDFs, images and generic file attachments
  (`/api/upload-file`), filenames are content sha256[:24] + extension (dedup).

`connect_users_db()` lazily ALTERs old `users.db` files to add new columns.

## Startup normalization (`gamma/migrate.py`)

There is no migration framework; old data shapes are rewritten by ONE
idempotent pass that runs at every server start (`app._startup_maintenance`,
logging a single line only when something changed) and by hand via
`python manage.py migrate`. Every step SQL-filters (`LIKE`) for the old
shape first, so a clean data directory costs one query per step and touches
no row; `updated_at` moves only on rows actually rewritten. Steps:
`properties.sourceUrl` → `source_url`; legacy `![a](u){:width N}` image
sizes → `![a|N](u)`; `PDF Notes - <name>` titles without an `auto_title`
marker → `<name>` + marker (so the metadata worker may still rename them);
dropping the legacy per-user `annotations`/`shares` tables from `data.db`;
backfilling `shares.page_id` from the owner's `pages.db` (rows whose document
is gone are deleted). The read-side shims these replaced are gone — new code
writes only the new shape. Roadmap and the remaining schema steps:
[block_centric.md](block_centric.md).

One step is deliberately NOT in the automatic pass: `python manage.py migrate
--drop-share-doc-id` (`migrate.drop_shares_doc_id`) rebuilds the global
`shares` table without its vestigial `doc_id` column (a table rebuild, so it
works on any SQLite version; idempotent — a no-op once the column is gone).
No code reads the column any more, and `create_share` inserts it as `""`
only while `PRAGMA table_info` still lists it, so the server works either
way — but an OLDER binary would fail to INSERT into the rebuilt table
(`NOT NULL`, no default). Run it by hand only after every deployment that
touches the data directory (the Docker image on the NAS, the desktop
sidecar) has shipped code with this change; `db.py` keeps creating the old
shape for fresh installs until then.

## Auth model

`session` cookie → middleware resolves `request.state.user`. Guest account data
is wiped and re-seeded daily (checked lazily in the middleware). Share tokens
grant access to ONE page (any page — paper or plain notes) for the audience
the owner chose: endpoints that support shared views resolve the user from
the share token (`resolve_user` — the token wins over the visitor's own
session for choosing whose data is read) and confine reads to the page's
subtree (`share_scope_page` + `assert_block_in_page`); write endpoints require
the session (`require_user`), except the block writers, which accept an
`edit` share through `require_writer` under the same page scope. Keep that
distinction when touching endpoints. Full endpoint/auth table:
[api.md](api.md).

## First-run seeding

The APP seeds the first admin, not launcher scripts — `seed.ensure_admin_seed()`
runs at startup and creates an "admin" account with a RANDOM password printed
once to the console (env-overridable via `GAMMA_ADMIN_USER` /
`GAMMA_ADMIN_PASSWORD`) ONLY while zero non-guest accounts exist. Deliberately
not keyed on "no admin exists": auto-adding an admin login to an upgraded
multi-user instance would be a backdoor — those get a startup hint to run
`manage.py set-admin`. Shares the guest welcome-page seeding with the app
(`gamma/seed.py`).

## manage.py CLI

User CRUD: `create-user`, `set-password`, `set-admin`, `rename-user`,
`delete-user`, `list-users`, `reset-guest`, `setup` (idempotent: guest account
+ missing per-user DBs), `migrate` (the normalization pass above, printing
per-user counts; `--drop-share-doc-id` additionally runs the one-way shares
schema step). `rename-user` updates users/sessions/shares rows and
moves the data dir — on Windows the move needs the server stopped (open SQLite
handles lock the directory).

## User management GUI

`gamma/routers/admin.py` (`/api/admin/users*`), frontend
[settingsUsers.jsx](../../frontend/src/settingsUsers.jsx): admins manage
accounts from Settings → Users; non-admins get the same pane as "You" (their
single row from session + `/api/quota`, since `/api/admin/*` is admin-only).
Every row has backup Export/Import menus; `/api/export`,
`/api/export-progress` and `/api/import-data` take an optional `?user=` target
that only admins may point at another account (`_target_user` in
`routers/auth.py`); the guest workspace can be exported but never restored
into. Rails: guest untouchable, no self-delete, the last admin can't be demoted
or deleted. Rename moves the data dir FIRST (aborts clean on Windows file
locks) then updates users/sessions/shares rows, so sessions survive — including
a self-rename.

## Storage limits

`gamma/server_settings.py`: per-account max upload size (`max_upload_mb`) and
total quota (`quota_mb`, 0 = unlimited); server-wide defaults in the users.db
`settings` KV, per-user overrides as nullable `users` columns (NULL = inherit,
explicit JSON null clears). `check_upload_allowed` hard-gates `/api/uploads`,
`/api/upload-image` and the Logseq import (413 over per-file, 507 over quota;
already-stored hashes always pass — dedup adds no bytes); `can_store`
soft-gates best-effort caches (proxy `save=1`, ai_context re-download).
`GET /api/quota` = the session user's effective limits + usage; deliberately
NOT part of `/api/session` (identity only). Usage = uploads/ dir size;
backup-restore imports are unmetered. Details + UI in
[settings.md](settings.md).

## Server log

`gamma/logbuf.py`, `GET /api/admin/logs?after=<seq>`: all backend logging goes
through `logbuf.log` (a `logging` logger — use it, not `print()`), which tees
to the console and a scrubbed in-memory ring buffer (2000 entries, gone on
restart) shown admin-only in Settings → Advanced → "Server log". Secret-shaped
substrings (Bearer/sk- keys, `password=`/`token=` pairs, 40+-char urlsafe runs
— session/share tokens) are masked at insert time; the one-time seeded admin
password in `seed.py` stays a raw `print()` on purpose and must never route
through the logger. `uvicorn.access` is deliberately not captured (its lines
carry `?share=` query strings); the middleware's `[http]` line covers requests
path-only.

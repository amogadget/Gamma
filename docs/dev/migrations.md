# Data migrations

How the data directory moves from one Gamma release's shapes to the next,
safely and without accumulating patches. Code: `gamma/migrations.py`
(runner + numbered steps), `gamma/normalize.py` (content normalization of a
workspace's files), `db.SCHEMA_VERSION`, `manage.py migrate` / `backups`.

## The rules

1. **One version for the whole data directory**, stored as `PRAGMA
   user_version` of `users.db`. `db.SCHEMA_VERSION` is what the running code
   expects. `db.py`'s `CREATE TABLE` statements always describe the current
   shape; nothing is patched lazily on connect any more.
2. **A release that changes stored shapes ships one numbered step** in
   `migrations.STEPS` and bumps `SCHEMA_VERSION`. The step is the whole
   change — moved files, rebuilt tables, rewritten rows — written to be
   re-runnable (it checks what it is about to do). Never bump without a step,
   never add a step without bumping.
3. **The runner goes first.** `migrations.ensure_current()` is the first
   thing `app._startup_maintenance` does, before any table is opened; a data
   directory that is *ahead* of the binary (`NewerDataError`) or older than
   `MIN_UPGRADABLE` (`TooOldDataError`) stops the server with a clear message.
   `db.connect_users_db()` refuses an outdated file too (`SchemaOutdated`), so
   no code path can read old shapes with new assumptions. That refusal
   covers every `manage.py` command but `migrate`, which is why the Docker
   entrypoint runs `manage.py migrate` before `manage.py setup` — `setup`
   alone would exit on an old volume before the server ever starts.
4. **Backup, then step, then stamp.** Before the first pending step every
   SQLite file is snapshotted with the backup API into
   `backups/<time>-v<N>/` (relative paths kept, plus `manifest.json`);
   uploads are never copied — steps move directories, never rewrite files.
   Steps run in order; the version is stamped after each one, so an
   interrupted upgrade resumes at the step that did not finish. Only the
   newest `KEEP_BACKUPS` (3) snapshots are kept.
5. **Nothing piles up.** Old steps are deleted once `MIN_UPGRADABLE` is
   raised past them (a release or two later); a data directory that old must
   first run a release that still has them — the refusal says so. The
   content normalizers in `gamma/normalize.py` are the one exception: they
   also run on every backup restore (`/api/import-data`), because a backup can
   be older than any step, so they stay for as long as such backups are
   accepted.

## Versions

| version | step | what it does |
|---|---|---|
| 0 | — | every Gamma before schema versions: `users.db` with lazily added columns, `users/<username>/` per account |
| 1 | `baseline` | the pre-workspace world in its final shape: the columns that used to be added on connect, share rows keyed by page (doc-keyed rows resolved or dropped), per-user files normalized (content shapes, legacy tables, `chats.title`) |
| 2 | `workspaces` | `users/<username>/` → `workspaces/<id>/` with a `workspaces` row and an owner membership per account (`users.default_workspace`); `data.db` `prefs` → `users.db` `user_prefs` (account-wide keys under workspace `''`, page-naming keys under the new workspace); `shares` rebuilt as `(workspace_id, page_id, created_by, …)`. [workspaces.md](workspaces.md) |
| 3 | `workspace_access` | `workspaces` gains `access` (private / public), `public_role` and `quota_mb` (a shared workspace's own cap); existing rows stay private with no quota. Nothing moves |
| 4 | `workspace_kinds` | `workspaces` gains `kind`: every account's default workspace and every single-member workspace become `personal` (private, no workspace quota), the rest `shared`. Other members of a default workspace are dropped (personal workspaces have no other members) and named in the log |
| 5 | `publisher_sessions` | Adds private, encrypted publisher cookie snapshots in `users.db`, keyed by account and publisher host. Existing content and account settings are unchanged |
| 6 | `integration_tokens` | Adds the `integration_tokens` table in `users.db`: hashed assistant tokens per account and workspace ([mcp.md](mcp.md)) |
| 7 | `mcp_oauth` | Adds the `mcp_oauth` table in `users.db`: OAuth client registrations, pending authorizations and access-token audiences, all expiring |

## Backups (`gamma/backups.py`)

The runner's snapshots are one use of a general facility: a backup is
`backups/<time>-<label>/` with every SQLite file at its relative path (taken
with the SQLite backup API, so consistent while the server runs), the
`uploads/` directories when asked, and a `manifest.json` (time, label, schema
version, file list, whether uploads are included).

- **Take one**: Settings → Server → *Server backups* (admins; *Databases
  only* or *Everything*), `POST /api/admin/backups`, or `manage.py backups
  --create [--uploads] [--label x]`. The migration runner takes a
  databases-only one labelled `v<N>` and prunes its own to
  `backups.KEEP_BACKUPS`; hand-made ones are never pruned automatically.
- **See / download / delete**: the same pane, `GET /api/admin/backups`,
  `GET /api/admin/backups/{name}/download` (a zip of the directory),
  `DELETE /api/admin/backups/{name}`; `manage.py backups [--delete <name>]
  [--prune]`.
- **Restore**: `manage.py backups --restore <name>` with the server stopped
  — copies the files back over the data directory (WAL/SHM sidecars of the
  live files are dropped first) and leaves everything the snapshot lacks as
  it is; uploads come back only from a backup that carried them. Start the
  server afterwards; it migrates the restored data if the snapshot predates
  the binary. Deliberately not an HTTP endpoint: a whole-directory swap
  under a running server is not safe.

Per-workspace backups — the snapshots users keep on the server from
Settings → Backups and the `/api/export` zips — are `gamma/ws_backup.py`
([workspaces.md](workspaces.md) "Backups"), a different, smaller thing.

## Running it

- **Automatically**: at every server start (Docker, the desktop sidecar, dev).
  The startup log names the snapshot and the steps applied. On Windows an
  upgrade that moves directories needs no other process holding the files —
  which is the case at startup.
- **By hand** (server stopped): `python manage.py migrate` (`--status` to
  only report, `--dry-run` to list what would run), `python manage.py
  backups` to see, take, thin or restore snapshots.

A failed step stops the server: the version stays at the last completed
step, the message names the cause and the snapshot. Fix the cause and start
again (the step resumes), or restore the snapshot: copy its files back over
the data directory — for a directory move, `manifest.json` in the snapshot
and the `workspaces` table in the snapshot's `users.db` (after step 2) say
which directory belongs to which account.

Never run an older Gamma on an upgraded data directory: it refuses when it
knows about versions, and an older one that does not would create empty
accounts next to the moved data. Roll back by restoring the snapshot.

## Writing a step

```python
def _v3_something(conn: sqlite3.Connection) -> None:
    """One sentence on the new shape."""
    if "new_col" not in _columns(conn, "users"):      # re-runnable: check first
        conn.execute("ALTER TABLE users ADD COLUMN new_col TEXT NOT NULL DEFAULT ''")
    conn.commit()

STEPS = [..., (3, "something", _v3_something)]
SCHEMA_VERSION = 3   # gamma/db.py
```

- The step gets an open `users.db` connection; per-workspace files it opens
  itself (`closing(sqlite3.connect(...))` — leave no handle open, Windows
  locks moved directories otherwise).
- Update `USERS_SCHEMA` / `DATA_SCHEMA` / `PAGES_SCHEMA` to the new shape at
  the same time, so a fresh install and an upgraded one end up identical.
- A change to block *content* shapes (a renamed property, a syntax) goes into
  `normalize.py` as a `LIKE`-filtered idempotent rewrite, called from the
  step *and* automatically on restore.
- Test it in `tests/test_migrations.py`: build the old layout by hand in a
  temp data directory, run `ensure_current()`, assert the new shape, run it
  again (no-op), and cover the interrupted-run resume.

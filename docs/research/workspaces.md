# Workspaces and versioned data migrations

Findings from 2026-09, when Gamma separated *accounts* from *libraries* and
gave its data directory a schema version. The resulting mechanics are in
[dev/workspaces.md](../dev/workspaces.md) and
[dev/migrations.md](../dev/migrations.md); this note keeps the diagnosis and
the design reasoning, which apply to any per-user-directory application
that grows sharing.

## What was found: identity and data location were one string

Every data helper took the username: connecting to a user's database,
finding their uploads directory, committing ops. Shares and collaboration
rooms were keyed by `(username, page)`. The per-user directory held pages,
chats, preferences *and* the AI credentials side by side. Consequences:

- Renaming an account meant moving a directory, which on Windows means
  stopping the server (open SQLite handles lock the files).
- A library could not be shared, only a page: there was no object between
  "an account" and "a page" to attach membership to.
- Personal secrets and shareable content lived in the same file set, so any
  future sharing of the directory would have leaked the secrets.
- Schema changes were lazy `ALTER TABLE` statements executed on every
  connect plus one normalisation pass, with at least one step ("drop
  `shares.doc_id`") parked as *hand-run later* because an older binary would
  have broken on the new shape. That is exactly how migration debt piles up:
  every connect re-checks every historical patch, and nothing can ever be
  removed because nothing records which patches a directory has had.

## Design guidance drawn from it

**A storage location should be named by a random id, never by a
human-editable name.** With `workspaces/<id>/` a rename changes one row;
files never move. The same rule already held for uploads (content-hash
names) and pages (client-minted ids); accounts were the exception.

**Introduce the object people actually share.** A *workspace* (a library:
pages, files, chats, search indexes) sits between account and page. Every
account owns a personal one it can never leave, so the old single-library
behaviour is the default and clients that name no workspace keep working.
Membership carries a role (owner / editor / viewer), invitations are by
account (Notion's model), and page share links stay the way to admit
outsiders, so nothing has to be public.

**Decide where each kind of state lives by who may see it.** Chats and
cover snapshots name the workspace's pages, so they are workspace data and
visible to its members; appearance, the AI provider choice and credentials
follow the account. Per-account browser state that names pages (tabs,
recents, reading positions) is keyed by account *and* workspace.

**Money follows the creator.** Uploads into a shared workspace count
against its creator's quota. Otherwise sharing multiplies everyone's
allowance, and an admin who wants a lab on a bigger quota can raise one
number.

**Switch by full reload.** Every piece of per-library client state (open
tabs, recents, the live collaboration session) belongs to the library being
left. A navigation tears it all down for free and nothing can leak across;
cross-workspace views would have had to solve that state by state.

## Versioning a data directory

The migration design follows from the pile-up observed above.

- **One version for the whole directory**, stored in the central database
  (`PRAGMA user_version`), not one per file: the per-workspace files can be
  restored from backups older than any step, so they are normalised on
  restore instead of versioned.
- **The schema module always describes the current shape.** A fresh install
  and an upgraded one must be identical, and nothing may be patched lazily
  on connect. A release that changes a shape ships one numbered,
  re-runnable step and bumps the version, never one without the other.
- **Refuse rather than best-effort.** A directory newer than the binary is
  an error at startup; an older binary that silently opened a migrated
  directory would create empty accounts next to the moved data. A directory
  too old for the retained steps is also refused, with the message naming
  the release that still has them, which is what lets old steps be deleted.
- **Snapshot, then step, then stamp.** Databases are copied with SQLite's
  backup API before the first pending step; uploads are *moved* by rename,
  never rewritten, so a rollback is a copy-back plus the manifest. Stamping
  after each step makes an interrupted upgrade resume where it stopped.
- **Rehearse on real data.** The move was run on a copy of the production
  directory (seven accounts, a few hundred megabytes) before shipping; the
  second run had to be a no-op. Synthetic fixtures do not find the odd
  share row or the account with no uploads directory.

## Why not the alternatives

- *Keep the username as the key and add a `members` table:* renames still
  move files and shared content still sits next to personal secrets.
- *One workspace = one account, sharing by inviting into the account:*
  no roles, no way to leave, and credentials shared with the library.
- *Per-file schema versions:* restore semantics become "which files are at
  which version", and every step must handle every combination.
- *Keep lazy `ALTER`s but add a version check:* the check adds nothing
  unless the patches can also be removed, which needs the numbered-step
  structure anyway.

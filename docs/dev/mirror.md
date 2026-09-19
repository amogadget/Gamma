# Offline copies (mirrors)

A **mirror** is a workspace on one Gamma server that keeps a copy of a
workspace on another Gamma server and keeps the two in step: edits made in
the copy go to the original, edits made on the original arrive in the copy.
The everyday case is the desktop app: a local server that holds a copy of a
workspace on the lab's NAS, so the library opens on the train and the notes
written there land on the NAS when it is reachable again.

Code: `gamma/sync_engine.py` (the engine and the mirror registry),
`gamma/sync_tree.py` (snapshots and the diff between them),
`gamma/routers/sync.py` (the change feed and `whoami`, what a mirror reads
on the remote), `gamma/routers/mirrors.py` (the mirror API on the server
that holds the copy), `frontend/src/settings/SettingsMirrors.jsx` (Settings →
Workspaces → Offline copies), `desktop/main.js` `keepOffline` (the shell's
one-click flow). Research: [research/collaboration.md](../research/collaboration.md)
for why the model is ops plus a three-way merge and not a CRDT; the study
that led here is the upstream feature audit in `todos/`.

## The model in one paragraph

The original (the **remote**) is the authority. The copy runs on an
ordinary Gamma server (the **local**) as an ordinary personal workspace of
the person who made it, with one extra row in `users.db` (`mirrors`) and,
per page, the tree it held after the last reconciliation (`sync_pages` in
the copy's `pages.db`). A **round** asks both servers' change feeds which
pages moved since the last round and reconciles each one three ways from
that saved tree: the remote's changes are applied locally through the
normal op path (so the local server's own text merge keeps the local
keystrokes and the page's open editors see them arrive), what still differs
is pushed to the remote as an op batch under the mirror's write token, and
the remote's tree is fetched back and becomes the new base. Nothing about
the frontend changes: editing a mirror is editing a workspace.

## What travels

- **Pages and blocks**: the whole tree, root properties included (title,
  folder, labels, metadata), by block id and fractional position. Ids are
  kept, so a block is the same block on both sides forever.
- **Files**: every upload a page references (`/api/uploads/<hash>.<ext>` in
  content or properties, a page's `doc_id`), by content hash — fetched when
  missing on the copy, uploaded when missing on the original. A re-run
  never duplicates.
- **Deletions**: pages through the tombstones (`deleted_pages`), blocks
  through the diff.

Not synced: preferences (reading positions, open tabs, recents — they are
per account and per server), chats, cover snapshots, search indexes (the
copy rebuilds its own).

## The change feed (remote side)

`GET /api/sync/changes?since=&limit=` lists the pages whose root was
stamped after a cursor, each with its latest op `seq`, and the pages
deleted after it, as one time-ordered stream ([collab.md](collab.md) "The
change feed" has the cursor rules). The feed is a hint: the engine compares
each listed page's `seq` with the one it holds and fetches the tree only
when they differ. `GET /api/sync/whoami` tells the engine who its token is,
which workspace and role it has there, and whether it may write.

The local server has the same feed, read in-process, so local edits are
found the same way; the engine's own writes are tagged client `sync` and
diff to nothing on the next round.

## One round, one page (`sync_engine._sync_page`)

| the page is… | what happens |
|---|---|
| new on the remote | created here under its id, the remote tree laid in, files fetched |
| new here (two-way) | created there under its id (`POST /pages` with `id` + `properties`), the tree pushed, files uploaded |
| changed there only | the diff base → remote applied here |
| changed here only | the diff base → here pushed there, with each set's `base` text so the remote merges against anything that landed meanwhile |
| changed on both | the remote diff applied here first (merges recorded), then what still differs pushed, then the remote tree fetched back |
| deleted there, untouched here | deleted here (a local tombstone, the sync state dropped) |
| deleted there, edited here | re-created there with the local tree (`page_restored`) |
| deleted here, untouched there | deleted there |
| deleted here, edited there | re-created here from the remote (`page_restored_from_remote`) |

Inside a page the same rule holds at block level, **an edit beats a
delete**: a subtree the remote deleted stays when something in it was
edited here (the push re-inserts it there), and a subtree deleted here
comes back whole when the remote edited inside it. Same-block text edits
merge by span through `gamma/textmerge.py` on whichever server applies the
op; two edits to the same characters resolve by the remote's order.

Every decision the engine takes on its own is a row of `sync_conflicts`
(`merged`, `kept_local_edit`, `restored_remote_edit`, `page_restored`,
`page_restored_from_remote`) with the texts involved. Sync never blocks on
one: the person looks at the list in Settings and, for a merge, can put
back "mine" or "theirs" — an ordinary edit that the next round pushes.

Pull-only mirrors (a read token, or a viewer's) apply the remote's changes
and never push; local edits stay local and survive later remote changes to
other spans of the same block, since the saved base is always the remote's
tree.

## Rounds

`config.sync_interval_s()` (`GAMMA_SYNC_INTERVAL`, default 30 s, 0 = off)
drives a background loop over every mirror of the server; "Sync now"
(`POST /api/mirrors/{ws}/sync`, `?wait=1` for the answer) runs one on
demand. Rounds of one mirror never overlap. A round that cannot reach the
remote records the error on the mirror and moves no cursor; a page that
fails inside a round is reported and retried next time. The status the
Settings row shows is the mirror's `status` JSON (`last_sync`,
`last_error`, `pages_pulled`, `pages_pushed`, `files_pulled`,
`files_pushed`, `mode`, `remote_role`).

## Credentials

The mirror signs in to the remote with an **integration token** of the
`write` scope ([mcp.md](mcp.md) "Manual tokens"; `POST
/api/integrations/tokens {scope: "write"}`, made on the remote by a member
who may write there). On the HTTP API a bearer token is the account behind
it, confined to the token's workspace, never an admin and never a session
that manages tokens or accounts (`auth.py`, `require_ws`). The token is
stored Fernet-encrypted in the copy's `users.db` with the data directory's
key (`publisher_sessions.cipher`). Pushed batches land in the remote's op
log under that account with client `sync`.

## Making one

- **Desktop app**: open the remote server, open the workspace, bar menu →
  *Keep an offline copy…*. The shell mints the token on the remote with the
  page's session, starts (or makes) a local server, signs into it with the
  seeded admin credentials, creates the mirror there and moves the window
  to it ([desktop/docs/architecture.md](../../desktop/docs/architecture.md)).
- **Any Gamma**: Settings → Workspaces → Offline copies → *Mirror a remote
  workspace*: the server address and a write token made there.

Stopping a mirror (`DELETE /api/mirrors/{ws}`) keeps the workspace as an
ordinary one and drops its sync state.

## API

| method | path | what |
|---|---|---|
| GET | `/api/mirrors` | the caller's mirrors with status |
| POST | `/api/mirrors` | `{remote_url, token, name?, mode?}` → the mirror (validated against the remote's `whoami` first; a read token or a viewer's role makes it `pull`); the first fill runs in the background |
| GET | `/api/mirrors/{ws}` | one mirror |
| POST | `/api/mirrors/{ws}/sync[?wait=1]` | a round now |
| DELETE | `/api/mirrors/{ws}` | stop mirroring |
| GET | `/api/mirrors/{ws}/conflicts[?resolved=1]` | the decisions to look at |
| POST | `/api/mirrors/{ws}/conflicts/{id}` | `{choice: keep \| mine \| theirs}` |

Session-only, the mirror's owner only, never a guest.

## Testing

`backend/tests/test_mirror.py` runs the whole thing in one process: one
account's workspace is the remote, another account's mirror follows it, and
the engine's transport is a TestClient (`sync_engine.default_fetch`) so
every request is the real HTTP API with the real token. Covered: the first
fill, edits both ways, different-block and same-span merges with the
conflict rows and their resolution, edit-versus-delete both ways, pages
created and deleted on either side, files by hash, pull-only, stopping.
`test_sync_tree.py` pins the diff; `test_token_api.py` the bearer rules;
`test_sync_feed.py` the feed.

## Limits and next steps

- The op log is not replayed: a round works from trees, so a page that
  changed on both sides costs one fetch and one push, and the remote's
  per-batch authors are not carried into the copy's log (its actor is
  `mirror`).
- The change feed lists a page whose root moved; a writer that never stamps
  the root would be missed — every writer does today (ops, reloads,
  cross-page moves, imports).
- A mirror of a mirror works but doubles the delay; a workspace mirrored
  from two servers into one copy is refused (one remote per copy).
- No end-to-end browser step yet: the Playwright suite runs one server.

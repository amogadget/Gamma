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
Workspaces → Clones), `frontend/src/collaboration/MirrorPopover.jsx`
(the header's sync pill, its settings and review views),
`frontend/src/collaboration/MergeResolver.jsx` (the merge chip on a block
row), `desktop/main.js` `keepOffline` (the shell's one-click flow). Why the
model is ops plus a three-way merge and not a CRDT:
[research/collaboration.md](../research/collaboration.md).

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
  never duplicates. Every fetched tree's files are checked, not only the
  changed blocks', and each round ends with a sweep for files the copy's
  pages name but lack (`missing_uploads`), so a round cut short after a
  page landed but before its PDF did heals by itself.
- **Deletions**: pages through the tombstones (`deleted_pages`), blocks
  through the diff.

Not synced: preferences (reading positions, open tabs, recents — they are
per account and per server), chats, cover snapshots, search indexes (the
copy rebuilds its own).

### Native iPad compatibility boundary

The native client's cached library/outbox is separate from these server-to-server
mirrors. This mirror implementation transfers `/api/uploads` references, not the
native `/api/assets` originals, audio or replay derivatives. Generic mirror ops
must not bypass the native payload/revision guards: importing a new native
payload or changing reserved properties is refused rather than fabricating a
valid native copy. Cross-page relocation of native blocks (including an ordinary
parent containing native descendants) must be refused **before deleting the
source subtree**. The entire incoming batch is preflighted for unsupported native
claims before any relocation deletes an earlier ordinary block; stored native
subtrees are checked again under the source deletion's write lock. Do not treat
a mirror as a complete backup of native iPad
recordings; see [the native offline model](../../ipad/OFFLINE.md).

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
delete** (a move counts as an edit): a subtree the remote deleted stays when something in it was
edited here (the push re-inserts it there), and a subtree deleted here
comes back whole when the remote edited inside it. Same-block text edits
merge by span through `gamma/textmerge.py` on whichever server applies the
op; two edits to the same characters resolve by the remote's order.

Three more rules keep the two trees identical in the odd cases
(`tests/test_mirror_edges.py` pins each):

- **Positions.** The server re-keys a block that lands on a taken key, so
  when the remote's answer moves two siblings past each other, applying
  those moves here in order would re-key one of them and leave this side's
  keys off the remote's — and every later round would push the difference
  again. `_parked` (in `_apply_local`) moves the block that holds a
  target key to a fresh key at the end first, so every move lands where it
  says and one round settles it.
- **Cross-page moves.** A block id lives in one page. When the remote's ops
  insert a block that lives in another page here (moved there on the
  remote, or edited here after the remote moved it), `_relocated` deletes
  it from that page first and inserts it with the text it has *here*, which
  the push then sends on; the page it left is reconciled at its own turn
  (both sides deleted it there). The other way round — this copy still
  holds the block in a page the remote moved it out of — the remote refuses
  the push (`403 … outside this page`) and the page is deferred
  (`PageDeferred`: kept on the retry list, not an error) while the
  receiving page's round moves it over; the next round finds nothing left
  to push.
- **The same edit made on both sides** (or a retried batch) is one edit: an
  op whose content already is the block's text merges nothing (`ops.py`,
  `textmerge.merge`).

Every decision the engine takes on its own is a row of `sync_conflicts`
(`merged`, `kept_local_edit`, `restored_remote_edit`, `page_restored`,
`page_restored_from_remote`) with the texts involved — for a `merged` block
also `base`, the text before either side edited it, so the resolver can
show what each side changed. Sync never blocks on one: the person looks at
the list and, for a merge, can put back "mine" or "theirs" — an ordinary
edit that the next round pushes, written from the text the conflict
recorded as its `base`, so words typed into the block since the merge are
kept over the chosen version rather than lost.

Pull-only mirrors (a read token, or a viewer's, or the *Receive only*
direction) apply the remote's changes and never push; local edits stay
local and survive later remote changes to other spans of the same block,
since the saved base is always the remote's tree. Such a round still moves
the local cursor past the edits it left here, so switching the direction
back to two-way resets the local cursor (`set_cadence`): the next round
looks at every page changed here since the beginning — one tree compare
each — and pushes what differs.

## Rounds and cadence

The engine's loop (`start_loop`; `GAMMA_SYNC_INTERVAL=0` turns it off, the
tests) ticks every second and gives a round to each mirror that is due: its
own `poll_s` come round (per copy, `mirrors.poll_s`: 5 = *Live*, 30, 300,
0 = only by hand), or a local edit `DEBOUNCE_S` (1 s) ago when the copy's
`on_change` is set — `ops.commit_listeners` tells the engine about every
committed write (`request_sync`, which also wakes the loop, so the round
starts the moment the quiet second is over rather than at the next tick;
the engine's own writes, client `sync`, do not count, and a typing burst
is one round). The same listener marks the copy **dirty** (`_dirty`, in
memory): `has_local_changes(ws)` is true from a local write until a round
that started after it finishes without error, and the API reports it as
`pending_local` (two-way copies only) — the pill's "local edits not
synced yet" state (with *Sync after an edit* on, the pill spins from the
edit until a poll confirms the round is done, since a one-page round is
shorter than the poll interval). The first pass runs
`FIRST_PASS_S` (5 s) after startup, so a copy whose first fill was cut short
by a restart continues at once; "Sync now" (`POST /api/mirrors/{ws}/sync`,
`?wait=1` for the answer) runs one on demand. Rounds of one mirror never
overlap. A round that cannot reach the remote records the error on the
mirror and moves no cursor. A page that fails inside a round — whatever the
exception — is reported, kept on the mirror's `retry` list with the flags
it had, and worked again next round (the feeds' cursors have moved past
it). Nothing a round does can leave the `running` flag up: every exception
brings it down with `last_error`, and a process stopped in the middle of a
round (the desktop app quit) is caught at the next startup by
`reset_interrupted`, which clears the flag and notes `interrupted`; the
next round simply continues, a round is idempotent.

The status the Settings row and the header pill show is the mirror's
`status` JSON: `last_sync`, `last_error`, `pages_pulled`, `pages_pushed`,
`pages_deleted`, `files_pulled`, `files_pushed`, `blocks_added` /
`blocks_removed` / `blocks_changed` (the round's git-style totals), `mode`, `remote_role`,
`remote_user`, `retry`, `interrupted`, and while a round runs `running`
with `progress` (`done`, `total`, `page` — the title being worked —,
`first` for the first fill, `at`, and `file` `{name, done, total, dir}`
while a file travels, updated a few times a second from the streaming
transport), saved before every page so "21 of 79 pages" and "↓ paper.pdf
3.2 / 14 MB" move. What a round did, page by page, is the copy's `sync_log`
(`pulled`, `pushed`, `created here` / `there`, `deleted here` / `there`,
`restored here` / `there`, `replaced here` / `there`; the newest 500 rows,
`GET /api/mirrors/{ws}/log`), each row with its git-style `stats`: `add`
blocks inserted, `del` blocks removed (a delete counts its subtree), `mod`
blocks set or moved — computed from the ops the round applied or pushed
(`_stats`), or the page's size when it came or went whole (`_whole`) — and
its `changes`, what each edit did block by block for the log's diff view
(`_changes`: `{k: add | del | mod | props | move, id, text, old?}`, the
new text and, for `mod`, the old one, capped at 40 entries of 240
characters; a page that came or went whole lists its blocks). Both live in
the row's `stats` JSON; `list_log` hands `changes` out as its own key.

## What the person sees

The UI speaks git: the mirror is a **clone**, the workspace it follows is
its **origin** (the **remote**), a round **pulls** then **pushes** but the
UI only ever says **Sync** (the direction is *Two-way* or *Receive only*),
a block both sides changed is a **conflict** resolved between **local** and
**remote**, a force is **force pull** / **force push**, pausing is
**detach** / **reattach**, and dropping the link is **remove origin**. (The
code and the API keep *mirror*, *remote*, *mine* / *theirs*.)

### The header's sync pill (`MirrorPopover.jsx`)

Shown while a clone is open, in the desktop app and in a browser alike.

- An icon whose state is drawn on it, like the background-tasks button: the
  refresh glyph spinning while a round runs; a count badge when conflicts
  wait; a dot, accent for local edits not synced yet, green when up to date,
  red on a problem; an unlink glyph when detached; a cloud while the first
  fill has not run. With *Sync after an edit* on, the icon spins instead of
  showing the accent dot, until the round is confirmed done.
- No words on it: the state's sentence and the last sync time are the
  tooltip. `data-state` (`busy`, `conflicts`, `error`, `pending`, `ok`,
  `detached`, `new`) is what the browser test reads.
- The pending state is known before the server says so: the page's collab
  session raises `gamma:local-edit` when it queues ops. The pill shows the
  dot at once and polls every 2 s until a poll after a short grace reports
  `pending_local` false.
- `mirrorState(info, {busy, pending})` is the one reading of the status
  (state, icon, tone, line, tooltip, badge or dot) that the pill, the
  popover and the Settings row share.
- Polls the mirror every 20 s, every 2 s while a round runs or an edit is
  pending (the log too while open). When a poll sees the numbers move it
  raises `gamma:mirror-changed` so the page's conflict chips refresh.

Click: a popover of icons and numbers.

- The head: the clone's name with *remote · host*, a **Sync** icon button
  and the gear.
- The state line: the last round's `+3 −1 ~2`, the progress bars while a
  round runs, a *Resolve* button when conflicts wait (it opens the conflict
  cards, each resolved in place or opened on its block).
- The **Log**: a direction arrow per row and its `+3 −1 ~2` block counts.
  Clicking a row opens its changes block by block as a diff (`ChangeList`:
  added blocks tinted green with `+`, removed ones struck red with `−`, a
  changed block as a word diff of old → new with `~`, moves and property
  changes named). The arrow at the row's end opens the page.
- The gear turns the popover into the clone's **sync settings**, built from
  the settings kit's rows: *Automatic sync* (Live / 30 s / 5 min / Manual, a
  `Segmented`), the *Sync after an edit* toggle, *Direction* (*Two-way* /
  *Receive only*), then *Force pull* / *Force push* (confirmed inline; a
  receive-only clone cannot force push), *Detach* / *Reattach*, and a danger
  *Remove origin*.

### The conflict card (`MergeResolver.jsx`, `ConflictCard`)

One surface for every list: the chip on a block row, the pill's conflicts
view, Settings.

- A kind line (a merge glyph for *Auto-merged*, an arrow for a restore, the
  long story as the hint), then the versions: **Local** (this clone) and
  **Remote** (origin) side by side, and for an auto-merge the **Merged**
  text under them.
- With the row's `base` each panel is a git-style word diff (`wordDiff`, an
  LCS over word and space tokens). Local shows what local changed against
  the base, its added words in the local colour and the words it removed
  struck through; remote likewise in the remote colour. The merged text
  shows what the merge did, each added word coloured by the side that wrote
  it (dotted when both did).
- Without a base (a *diverged* block, or a row from before it was kept) the
  two texts are shown against each other and the merged text by
  attribution.
- Every version carries a radio (clicking the panel picks it too). The one
  in the block now is tagged *in the block* and preselected, and one
  **Apply** confirms: on the preselected version it marks the conflict
  resolved as it is, on another it writes that text.
- The non-textual kinds (*Kept local*, *Restored remote*, the page
  restores) show the one text involved and an *OK*.
- `useConflicts(wsId)` loads a clone's open conflicts and posts a decision;
  the pill's review view and Settings share it.

**The chip.** A block the sync merged or had to decide on carries a small
chip at its row's right end; its popover is the card. App owns which chip is
open (`mergeOpen`) and the page's conflicts in tree order (`mergeOrder`):
the card's ‹ n / N › step through them, and a decision opens the next one
down the page, so a page of conflicts is worked through in one pass. App
reads the page's conflicts (`GET /api/mirrors/{ws}/conflicts?page=`) on
open, every 15 s and on `gamma:mirror` / `gamma:mirror-changed`; a decision
is an ordinary edit the next round pushes. The lists in the pill and in
Settings jump to the block (`gamma:jump`).

### Settings → Workspaces → Clones (`SettingsMirrors.jsx`)

- One row per clone. Its avatar is its state (the same reading as the pill:
  a spinning refresh while a round runs, a check when up to date, a warning
  on a problem, an unlink glyph when detached), then the name with its tags
  (*open*, *receive only*, *detached*, *problem*, *unpushed edits*, *N
  conflicts*), *clone of X · origin host* and one short status line
  (progress and the file in flight while a round runs; *up to date 14:37 ·
  2 pages pulled* after; *local edits not pushed yet* while `pending_local`).
- Actions: Open, *Sync* (*Reattach* when detached), *Conflicts* (the same
  cards, each resolved there or opened on its block) and a "more"
  `ActionMenu`: *Force pull*, *Force push* (off on a receive-only clone),
  *Detach*, and a danger *Remove origin*. The forces and the removal are
  confirmed by the shared confirm box.
- No intro paragraph: the empty state's one sentence says what a clone is.
- *Clone a remote workspace* asks for the origin server's address, a write
  token made there, *Into* (a new workspace, or one of yours: an imported
  backup, a clone whose origin was removed, with *If a page differs*: take
  remote's or keep local), a name and the direction as two `IconChoices`
  tiles.

### The desktop switcher

On a remote server every workspace row carries a *clone* chip on hover.
Once a clone exists the chip reads *open clone* and opens it (one clone per
workspace: a second *clone* opens the existing one). On the local server the
clone's row reads *clone* and its *origin* chip opens the workspace it
follows. The shell keeps a map of clones in its registry and starts the
local servers that hold them when the app launches, so clones sync in the
background whichever server the window shows
([desktop/docs/architecture.md](../../desktop/docs/architecture.md)).

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

- **Desktop app**: open the remote server, open the switcher, the *clone*
  chip on the workspace's row. The shell mints the token on the remote with
  the page's session, starts (or makes) a local server, signs into it with
  the seeded admin credentials, creates the mirror there and moves the
  window to it ([desktop/docs/architecture.md](../../desktop/docs/architecture.md)).
- **Any Gamma**: Settings → Workspaces → Clones → *Clone a remote
  workspace*: the server address and a write token made there.

**Detach and reattach.** *Detach* (`POST /api/mirrors/{ws}/detach`) sets
the mirror's `mode` to `off`: no round runs and the workspace lists as an
ordinary one (`mirror_of` is empty), but the row keeps the token, the
cursors and every page's base. *Reattach* (`POST /api/mirrors/{ws}/relink`,
optionally a new token or address) checks the remote and switches the mode
back; the next round is a normal three-way merge of what both sides did
meanwhile. A re-link to a different remote workspace drops the bases and
adopts its pages (below). *Remove origin* (`DELETE /api/mirrors/{ws}`)
drops the link and the sync state; the workspace stays.

**Linking an existing workspace, and the adopt policy.** `POST
/api/mirrors` with `workspace_id` links a personal workspace of the caller's
instead of making a new one. Its pages that exist on both sides have no
common base, so the first round **adopts** one side's version whole
(`adopt`: `theirs`, the original's — the default — or `mine`), and every
block whose text differed becomes a `diverged` conflict holding both texts,
resolvable like a merge. The same path serves a normal mirror whose round
was cut short between a page's creation and its state. Pages one side alone
has are created on the other, as always.

**Force.** *Force pull* / *Force push* (`POST /api/mirrors/{ws}/force`
`{direction: pull | push}`) makes one side identical to the other whatever
happened: the bases and cursors are cleared, every page goes through the
adopt policy (`theirs` for pull, `mine` for push), and pages the losing side
alone has — including pages the winner deleted after a sync, whose
tombstones say nothing during a force — are deleted there (`prune`); what
the loser had is kept in `diverged` conflicts. Cheap when little differs:
a page whose trees are equal costs one read and no write, and only the
differing blocks of a page are pushed, files only when the other side lacks
the hash. Confirmed inline in the popover; a pull-only clone cannot force
push.

## API

| method | path | what |
|---|---|---|
| GET | `/api/mirrors` | the caller's mirrors with status |
| POST | `/api/mirrors` | `{remote_url, token, name?, mode?, workspace_id?, adopt?}` → the mirror (validated against the remote's `whoami` first; a read token or a viewer's role makes it `pull`; `workspace_id` links an existing workspace of the caller's under the `adopt` policy); the first fill runs in the background |
| GET | `/api/mirrors/{ws}` | one mirror, with `conflicts_open`, `pending_local` (a local write no round has pushed yet; two-way copies only), `poll_s`, `on_change`, `detached`, `interval_s` (0 = the loop is off) |
| PATCH | `/api/mirrors/{ws}` | `{poll_s?, on_change?, mode?}` — the cadence and direction |
| POST | `/api/mirrors/{ws}/sync[?wait=1]` | a round now |
| POST | `/api/mirrors/{ws}/detach` | detach (the link is kept) |
| POST | `/api/mirrors/{ws}/relink` | `{token?, remote_url?, adopt?}` — link again, a round in the background |
| POST | `/api/mirrors/{ws}/force` | `{direction: pull \| push}` — replace one side with the other, in the background |
| DELETE | `/api/mirrors/{ws}` | forget the link |
| GET | `/api/mirrors/{ws}/log?limit=` | what the last rounds did, page by page, newest first (`stats` counts, `changes` block by block, `exists`: the page is still here) |
| GET | `/api/mirrors/{ws}/conflicts[?resolved=1][&page=]` | the decisions to look at (`mine`, `theirs`, `result`, and `base` for a merge), one page's with `page` |
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
`test_sync_feed.py` the feed. `test_mirror_edges.py` is the odd cases:
typing while a round is in flight, two clones of one remote editing the
same blocks, a move against a delete, a child added inside a subtree
deleted here, a subtree deleted on both sides, the same position taken on
both sides, the title renamed on both sides, props against text, the same
edit on both sides, a round cut short after its push, resolving a conflict
after more typing, a block moved to another page while edited here, edits
made while the remote is unreachable — each ending with both sides equal. The progress reports, the interrupted-flag
reset, the retry of a page that failed, detach + re-link, linking an
existing workspace, the force in both directions, the cadence and the
sync-on-change trigger are in `test_mirror.py` too; the browser scenario
drives the popover's settings view, detach / link again and the merge chip. The
desktop's flow — the *keep offline* chip, the registry map, the
*offline copy* / *original* cross-links, one copy per workspace — is a step
of `desktop/test/e2e.js`.

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
- Every automated test runs both sides in one process (the backend suite's
  TestClient transport; the browser scenario clones a workspace of the same
  server). Two real servers are not exercised.

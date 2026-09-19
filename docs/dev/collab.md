# Real-time collaboration

Several people can edit a page together through a shared workspace or an
editable page share. Their changes and cursor positions appear live. Two
browsers signed into the same account also work. Backend: `gamma/ops.py`, `gamma/collab.py`,
`gamma/routers/collab.py`. Frontend: `src/collaboration/usePageCollab.js`, `src/shared/model/blockOps.js`,
`src/collaboration/Presence.jsx`, plus small hooks in `app/App.jsx`, `editor/BlockTree.jsx`,
`editor/BlockCmEditor.jsx` and `editor/blockHistory.js`.

Block undo/redo returns a description of the action (`describeTransition`):
note creation/deletion/move, a text edit with a short preview, a properties
or highlight edit. It is derived from the before/after trees, so a rebased
remote change is never named as ours. The status pill shows it. The
handwriting stroke history is separate ([handwriting.md](handwriting.md)).

## The model in one paragraph

A page's editor sends small **operations** on blocks. The server applies each batch in one transaction, orders
it (a per-page `seq`), logs it, and fans it out to everyone on the page over a
websocket. Edits to different blocks or property keys can coexist. When two
people type in the same block, the last content write accepted by the server
wins; the other version can be lost. Structural changes can also conflict,
such as editing a block someone else deletes. Presence helps people coordinate
but does not prevent conflicts.

SQLite is the source of truth; there is no OT or CRDT. Concurrent edits of
one block's text are reconciled by a stateless three-way merge at apply
time (`gamma/textmerge.py`, below).
Presence is temporary: standalone cursor messages and optional cursors on
operation batches are broadcast but never written to the operation log.

## Ops (`gamma/ops.py`)

| op | fields | notes |
|---|---|---|
| `set` | `id`, `content?`, `props?` | `content` is one last-writer-wins value; `props` is a PATCH (`{key: value \| null}`, null deletes), so unrelated properties never conflict |
| `insert` | `id`, `parent`, `position?`, `content`, `props` | the client mints id and position (fractional-indexing, same library both sides); a position colliding with a sibling is re-keyed and the applied op echoes the final key; re-inserting a known id (a retried batch) is a move + set |
| `move` | `id`, `parent`, `position?` | cycle-checked (400), collision-re-keyed |
| `delete` | `id` | the subtree; an unknown id is a no-op (a retry) |

Rules: every touched block and every insert parent must be inside the page
(403 otherwise, 404 unknown); the page root may only be `set` — a share
editor its content (rename) but never its properties — and is never moved,
deleted or inserted; `parent: "root"` is refused (ops never create pages). A
bad op fails the whole batch and nothing is written. Only touched rows get
`updated_at`; the page root is stamped once per batch (home-feed order and the
notes-index fingerprint). The orphan-upload sweep runs only for batches that
delete blocks or touch a block that mentions an uploaded file
(`/api/uploads/` or `/api/assets/`, `ops._mentions_upload`); the data.db purge
only when blocks were deleted.

`apply_ops(conn, page_id, ops, actor=, client=, share_scoped=, cursor=,
allow_native=)` applies and commits; `after_commit(ws, conn, result)` does the
derived-data work and publishes; `commit_ops(ws, page_id, ops, actor=)` is both
on a fresh connection — `ws` the workspace id, `actor` the account making the
change. Every server-side writer
goes through them — the single-block endpoints in `routers/blocks.py` are thin
wrappers, page attach/detach, the metadata write, the clip endpoints, the AI
tools (`edit_block`, `create_block`, `move_block`, `rename_page`, `move_page`)
and the native iPad writers (`routers/native_ink.py`, `routers/native_highlights.py`)
call them directly — so everything a page's viewers see comes from one path
and one log. Writers that rewrite a tree wholesale (`PUT /blocks/{id}/children`,
imports into an existing page, the target half of a cross-page move) log and
publish a `reload` instead; a cross-page move's source page gets a `delete`
(`record_ops`).

### Reserved native properties

A native annotation (ink, audio, a native note) is an ordinary block whose
payload belongs to the iPad endpoints (`gamma/native_ink.py`). The guards live
here, on the one write path, because every generic writer passes through it:

- a generic `set.props` may not touch the keys that describe the payload
  (including deleting them), and a generic `insert` may not create a block
  claiming one — 409 with the endpoint that owns it;
- an insert that converges on an existing native block (a retried batch, a
  client re-inserting a block it dropped) keeps the RECORDED payload instead of
  the copy the client sent (`_Batch.native_safe_props`); undoing a deletion the
  Web itself made is the other half of that rule — see below;
- a Web text edit of a native note advances `note_revision`, so an offline save
  computed against the old revision conflicts rather than overwriting it;
- `PUT /blocks/{id}/children` preserves the recorded payload per block
  (`native_ink.preserve_native_properties`) for the same reason.

The AI agent is covered by the same guards rather than by rules of its own: its
block writes call `apply_ops` too (`client="ai"`), and no agent tool even
exposes a properties argument — `edit_block`/`create_block` write content only,
`move_block` a position, `move_page` a page's `folder`. So the model can edit an
annotation's caption (and, on a native note, advances the revision the outbox
compares against like any other writer) without any path to a recorded payload
(`tests/test_native_ai_protection.py`).

`allow_native=True` — passed only by the native routers, never read from a
request — is what lets those endpoints write the reserved keys themselves. The
CAS check runs in the same transaction (`BEGIN IMMEDIATE` + `expected_revision`
against the stored revision), so a retry cannot double-advance a revision or
race a Web edit.

### Undoing a deletion (the Web's Ctrl+Z)

The guard above would otherwise make deleting an iPad annotation in the Web
irreversible: the page's undo stack restores the tree it kept
(`editor/blockHistory.js`), the editor's session diffs it
(`shared/model/blockOps.js`, `diffTrees`) and posts that diff as ops — so Ctrl+Z
after a delete is an `insert` carrying the block's FULL properties, and once the
delete has committed there is no row left to compare them against.

So a delete records what it removed. `_Batch.delete` reads the subtree rows it is
about to drop and, **for the native rows only**, attaches
`{id, parent, content, properties}` to the delete entry it logs:
`{"op": "delete", "id": X, "deleted": [...]}`. The record is built from the
database rows, never from request data (a client-supplied `deleted` field is not
read), and a delete of a block that does not exist records nothing.

A later generic insert of a block id **this page's** log records as deleted is
checked against that record instead of being refused
(`_Batch.recorded_deletion` → `native_ink.restored_native_properties`). The
lookup is exact and finished in SQL: the newest `delete` entry whose recorded
snapshot carries this id (`deleted[].id`), page-scoped. A row that merely
*mentions* the id — a note quoting it, an audio manifest's
`replay_events[].block_id`, a property value — can neither satisfy it nor hide
the real record, because the match is structural rather than textual and there
is no window: the walk is bounded by the page's own log (`KEEP_OPS` rows; a
couple of milliseconds for a full walk at that bound, and usually the first row
checked). It runs only for an insert that claims a native payload, so ordinary
inserts never read the log.

What a restore may do is narrow:

- the writer must reproduce the recorded native payload **exactly** — every key
  of the recorded kind's reserved set, compared as parsed values (so a float
  written `1e-05` by one client and `0.00001` by another is the same number). A
  queued offline save, a stale Web tree or a hand-written request therefore
  cannot turn a deletion into a new annotation, a new asset set, an escalated
  revision or an invented replay reference;
- what gets **stored** is the record: reserved payload, revisions and the
  unrelated properties it had, so an undo restores the server's last state for
  that block rather than a stale copy of it. The one thing the writer keeps is a
  caption — text on ink and audio is ordinary note text, editable on a live block
  too (the same rule as `preserve_native_properties`). A native **note**'s text
  *is* its payload, so there it must match the recorded text and the batch is
  refused otherwise; a genuinely new note belongs on `PUT /api/blocks/{id}/note`,
  which has a revision CAS of its own;
- the scope is the workspace (the `pages.db` the batch runs on), the page (the
  log it reads) and the id (the key). The same id and payload in a different
  page — or another workspace — is still a forgery and 409, as is an id no
  deletion ever recorded.

**This is the Web undoing its own deletion, not a general resurrection.** The
native write endpoints do not consult the record at all, so a queued iPad update
of a block somebody deleted on purpose stays what it is: an explicit revision
conflict (`routers/native_ink.py`, `current_revision: 0`). A stale client may
not silently bring an annotation back, and `_recorded_deletion` is deliberately
private so no route is tempted to try.

The record is provenance for the server, not history for readers: `_wire_ops`
strips the `deleted` payload from the ops `apply_ops` returns (the HTTP response
and the room fan-out) and from `ops_since` catch-up batches, so clients — and a
share viewer who joins after the deletion — see exactly the
`{"op": "delete", "id"}` they always saw. It rides in the log row itself: no new
table, nothing to migrate, and it travels in whole-workspace backups with
`pages.db`.

**Bounds and gaps — the retention is the page's log, so this is best-effort.**
The record lives and dies with the page's op log: `KEEP_OPS` rows per page,
pruned every `PRUNE_EVERY` batches, counting that page's batches only. A page
under heavy editing reaches that bound, and Ctrl+Z on a deletion that has since
been pruned is a 409 that does not restore anything — the block stays deleted and
has to come back from the iPad. A restored `pages.db` (a `mode=replace` import,
or a backup from before the deletion) has the same effect. Treat the restore as
recovery of the recent past, not as a guarantee, and do not build a
"recycle bin" expectation on it. A delete and the restore that undoes it also
have to be separate batches, since the row is written when the batch commits —
which is what the editor's undo sends (`blockHistory.js` restores the tree, so
the delete has long since committed). Write paths that do not go through ops
record nothing: `PUT /blocks/{id}/children` (bulk imports, the paste-tree path),
a root **page** delete (`routers/blocks.py` deletes the page outside ops),
`record_ops` cross-page moves (the block still exists on the target page) and the
native endpoints' own `allow_native` batches. An undo of such a delete is still
refused; `tests/test_native_undo.py` pins that limitation as well as the working
path.

## The op log

`page_ops(page_id, seq, actor, client, at, ops)` in each workspace's `pages.db`
(`db.PAGES_SCHEMA`), one row per applied batch, `seq` counting up per page
(the write lock is taken up front with `BEGIN IMMEDIATE`, so it never
collides). `actor` is the account that made the change (a share editor's own
name), `client` the tab's id, `"ai"` for an agent write or `"native"` for an
iPad annotation. Pruned to the newest `KEEP_OPS` rows
per page, checked every `PRUNE_EVERY` batches. `GET /api/pages/{id}/ops?since=`
returns the batches after a seq (410 when the log no longer reaches back: the
client reloads the tree); `GET /blocks/{id}/subtree` on a page carries the
`seq` its tree reflects.

## Rooms and the socket (`gamma/collab.py`, `routers/collab.py`)

One in-memory room per `(workspace, page_id)` — Gamma is one uvicorn process
everywhere (Docker, the desktop sidecar), so nothing is shared across
workers. `publish` schedules sends on the loop the sockets live on and is safe
from threadpool code (the sync AI chat endpoint runs the tools there); a
handler being torn down announces its leave through `publish` too, never by
awaiting inside a possibly cancelled scope.

`WS /api/ws/page/{page_id}[?ws=id&share=token&client=id]`. The HTTP
middleware does not run for websockets, so the handler resolves the session
cookie itself (`auth.session_lookup`), the workspace (`?ws=`, else the
account's default — `auth.workspace_access`) and the share grant with the
same rules as HTTP (`share_lookup` + `share_access` on the socket's
`state`): a member joins with their workspace role (viewers presence-only),
a share token admits its audience (view or edit); anything else is closed
before accept. Messages:

- server → client: `hello {client, color, seq, peers}` on join; `join {peer}`
  / `leave {client}`; `cursor {client, block, anchor, head}`; `ops {seq, at,
  actor, client, ops, cursor?}` for every applied batch (the sender's own
  included, it filters by client id; `cursor` is the writer's caret in the
  text after the batch, when the POST carried one — the server also stores
  it as the writer's presence); `reload {seq}`.
- client → server: `cursor {block, anchor, head}` only (`anchor`/`head` = -1
  when no editor is open on that block). **Writes never travel over the
  socket**: they are `POST /api/pages/{id}/ops`, so auth and scoping live in
  one place. A dropped socket does not stop HTTP saves; a closing tab attempts
  to flush queued edits with a keepalive fetch.

A peer is `{client, user, name, color, can_edit, block, anchor, head}`; colour
is an index into an 8-slot palette handed out per room (CSS `--peer-N`);
anonymous share viewers are `Anonymous`.

## The client (`src/collaboration/collabSession.js`, `src/collaboration/usePageCollab.js`, `src/shared/model/blockOps.js`)

`createCollabSession` (`collaboration/collabSession.js`) is the session as a plain state
machine over injected dependencies — the JSON call, the socket factory, the
keepalive POST, timers, and callbacks for peers/me — so the node tests drive
it with fakes. `usePageCollab` (`collaboration/usePageCollab.js`, one per open page in App.jsx)
only wires it to the browser: `utils.apiJson`, `new WebSocket(...)` on the
share- or workspace-qualified URL, the pagehide keepalive, and `peers` / `me`
as React state. The session owns:

- **the base tree**: what the server is known to hold from this tab's point of
  view. The block tree's transition effect calls
  `commit(tree)`: a load transition (the existing suppress flag, also set for
  remote applies) makes the tree the new base; any other transition is
  diffed against the base (`diffTrees`) and the ops queued. One exception:
  an empty page opens with a client-minted placeholder block
  (`seedBlockIdRef` in App.jsx) that the server has never seen, so the load
  commit leaves it out of the base — the first edit to it diffs as an
  `insert`, never as a `set` the server would 404. Positions live in
  one `Map id → key` shared with `blockOps`, so tree objects and history
  snapshots stay untouched.
- **per-page save state**: each page keeps its own queue, positions, pending
  content counts and retries. Navigating while a save is in progress does not
  retarget its queued edits or let its response change the next page's state.
  `set` ops on one block coalesce (`pushOp`); typing flushes
  after 350 ms, a structural op after 80 ms, an editor closing at once
  (`saveNowRef`), `flush()` before navigation. The POST response is the ack:
  re-keyed positions are adopted from it. Most 4xx responses reject the queue
  and reload the page. Network failures, 408 and 429 retry up to eight times;
  pending content stays protected during retries. After retry exhaustion,
  unsaved operations remain in memory for a later flush, with an error status.
- **same-block merge**: a content `set` carries `base`, the text the change
  was made from (`diffTrees` reads it off the base tree; `pushOp` keeps the
  first base of a run of keystrokes). When the server finds the block
  changed since, it applies the edit as a patch onto the current text
  (diff-match-patch with fuzzy context matching): edits to different spans
  both survive, a hunk that no longer fits is dropped and the stored text
  stands for that span. The echoed op carries the merged text and the
  batch's `cursor` is remapped into it. On the ack, a set whose stored
  text differs from what we sent lands on screen like a remote op — but
  only when no newer set of ours for that block is queued or in flight:
  that newer set's base is the text we sent, so the server patches those
  keystrokes onto its merge and the later ack brings the whole result;
  touching the base early would make the next diff repeat the change.
  The editor re-reports our caret after any external change of its text
  (a merge, a remote edit before the caret), so the others see it where it
  moved to. Writers without a `base` (imports, `PUT /blocks/{id}`) replace
  the text as before; the AI agent's `edit_block` sends the text it read
  as `base`, so a person typing in that block keeps their keystrokes.
- **reconciliation**: `inflight` counts queued-or-sent content sets per
  block. The content of a remote `set` for a block with one in flight is *deferred* and, on
  the ack, applied only if its seq is higher than the ack's (theirs is the
  newer server value), else dropped (ours is). Its property patch still
  applies immediately, so successive updates to different keys are preserved.
  Other operations apply at
  once — to the base, to the on-screen tree through `onRemoteOps` (a
  load-like transition: no history entry, nothing re-sent), and to every
  undo snapshot (`blockHistory.rebase`), so undoing your own edit never
  reverts someone else's.
- **ordered catch-up**: `seq` means the last contiguous batch processed,
  initially seeded from the tree fetch. HTTP acknowledgements and socket
  batches enter the same ordered inbox. If batch 12 arrives before 11, the
  client fetches `…/ops?since=10` before advancing. A hello with a higher
  sequence triggers the same recovery. Only one catch-up request runs at a
  time; old-page responses are ignored. A 410 or a `reload` message
  refetches the subtree with `keepUiFlags` (the open editor, its text and the
  folding survive the swap).
- **presence**: `peers` state from `hello`/`join`/`leave`/`cursor` and the
  `cursor` on an `ops` batch; every update bumps the peer's `rev`, which is
  how the editor tells a fresh caret report from one it should keep mapping.
  `sendCursor` throttled to 80 ms, fed by the editor's selection (`onCaret`),
  editor open/close and the focused row — but while a batch is queued or in
  flight the standalone message waits and the caret rides on the batch
  instead. Carets are offsets in the sender's text; sent on their own they
  reach the others up to a typing debounce before the text does, and an
  offset past the typed characters lands a few characters off in the older
  copy — and stays off once the batch maps it further along. Carried with
  the batch, the receiver syncs the text and places the caret in one render.
  After the ack a held-back caret move goes out standalone; a `hello`
  (reconnect) resends the current caret, since the server starts a joiner
  with none.

`diffTrees(base, next, pageId, pos)` emits inserts (unknown ids), moves (a
known id under another parent, or out of order — the longest increasing run
of existing keys stays, the rest are re-keyed), sets (content / property
patches), and deletes of the top-most removed subtrees last (a block that
escaped a deleted parent is moved out first). `applyOps` is idempotent and
keeps siblings sorted by key. UI-only fields (`editMode`, the `collapsed`
flag) never travel; a remote `collapsed` *property* updates the stored value
but not the viewer's own folding — folding stays personal, the stored value
is the default for the next open.

Ops on the page root (a rename, page properties) update the title / page
state in App instead of the tree.

## What the user sees (`src/collaboration/Presence.jsx`, CSS in `shared/styles/app.css`)

- the header avatar stack (initial, peer colour; faded while only viewing;
  click jumps to the person's block);
- small avatar chips before the row a person is on (in the ⋮⋮ handle
  column, fading while the row is hovered — never over the row's content or
  an embed card's controls), and a coloured left edge
  while someone has that block's editor open;
- inside an open editor, each peer's caret with a name tag and a tinted
  selection (`remoteCursorField` in `editor/BlockCmEditor.jsx`, keyed by peer: a
  peer whose `rev` changed is placed fresh from its offsets, the others keep
  mapping through every change — ours and other peers' — so a caret stays
  put while we type and shifts correctly when someone else edits before
  it). External value changes reach the editor as the minimal prefix/suffix
  replacement, tagged so they are not re-reported as local edits — the
  caret maps through instead of jumping.

## Testing

- `backend/tests/test_collab.py`: op semantics, scoping, the log and
  catch-up, the socket (TestClient `websocket_connect`; sockets need a
  context-managed client), AI-tool and cross-page fan-out. Every socket
  test opens its own page, and sequence numbers are asserted relative to
  the hello's (or the previous ack's) — never as absolute counts — so a
  step added to one test never renumbers the others.
- `frontend/tests/blockOps.test.mjs`: `node --test tests/blockOps.test.mjs`
  from `frontend/` (pure diff/apply round-trips).
- `frontend/tests/collabSession.test.mjs`: `createCollabSession` over fake
  HTTP, socket and timers — ack/socket ordering and catch-up, content versus
  property reconciliation, the merged text on an ack (landed at once, or
  held while a newer set of ours is queued), retries and their limit, rejection, navigation
  during a save, presence messages, the caret throttle, reconnect backoff,
  read-only sessions; browser behavior is covered separately below.
- End to end: `npm run e2e -- --only collab` from `frontend/`
  (`tests/e2e/scenarios/collab.mjs`, [debugging.md](debugging.md)): two
  browser contexts on one page of a shared workspace — presence stack and row
  chips, typing in one tab appears in the other, edits to different blocks
  converge, same-block typing keeps both people's text (and edits at both
  ends of one long block both survive with the carets in place), a caret after a
  mid-block edit sits where the person typed (and the other caret shifts
  along), undo after a remote edit
  keeps the remote edit, a rename reaches the other tab, an edit made offline
  lands once the network is back, a remote delete, a highlight made by the
  other person; `share.mjs` covers the invited editor on a share link.

## Limits and next steps

- Queued edits live in memory, not in durable offline storage. Keepalive
  saves on tab close are best effort and subject to browser limits; a network
  outage followed by closing the tab can lose unsaved work.
- Same-block simultaneous typing merges by span (three-way merge above);
  two people changing the *same* characters within one save window still
  resolve by server order for that span. If character-exact convergence
  ever matters, the upgrade path is CodeMirror's collab rebase on just the
  open block; not a CRDT.
- The socket needs a proxy that forwards websocket upgrades (Vite's dev proxy
  has `ws: true`; a reverse proxy in front of the NAS must pass `Upgrade`).
  uvicorn needs the `websockets` package (`requirements.txt`; the desktop
  freeze collects it).
- Rooms are per process: a multi-worker deployment would need a shared bus.
- Presence carries only the block and caret; it could also carry the PDF
  viewport (which page someone is reading).
- The op log has `actor` and `at` per batch but nothing reads them yet: an
  activity view ("who changed what") and a page version history are both
  derivable from it.

The survey behind this design (OT vs record-level LWW vs CRDT, why the old
snapshot autosave could not be patched) is in
[research/collaboration.md](../research/collaboration.md).

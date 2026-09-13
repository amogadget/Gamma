# Real-time collaboration

Several people (or one account in two browsers) can edit one page at the same
time and see who is where. This doc is the whole picture; the code comments
carry the details. Backend: `gamma/ops.py`, `gamma/collab.py`,
`gamma/routers/collab.py`. Frontend: `src/collab.js`, `src/blockOps.js`,
`src/presence.jsx`, plus small hooks in `App.jsx`, `blockTree.jsx`,
`blockCmEditor.jsx` and `blockHistory.js`.

## The model in one paragraph

A page's notes change through small typed **operations** on blocks, never by
replacing the tree. The server applies each batch in one transaction, orders
it (a per-page `seq`), logs it, and fans it out to everyone on the page over a
websocket. Concurrent edits to *different* blocks or different properties of
one block never conflict; two people typing in the *same* block resolve
last-writer-wins by server order (what Notion does), made rare by the visible
presence. Presence (who is on which block, the caret inside an open editor)
is a separate, never-persisted message type on the same socket. SQLite stays
the only source of truth; there is no CRDT.

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
delete blocks or drop an `/api/uploads/` reference; the data.db purge only
when blocks were deleted.

`apply_ops(conn, page_id, ops, actor=, client=, share_scoped=)` applies and
commits; `after_commit(user, conn, result)` does the derived-data work and
publishes; `commit_ops` is both on a fresh connection. Every server-side writer
goes through them — the single-block endpoints in `routers/blocks.py` are thin
wrappers, page attach/detach, the metadata write, the clip endpoints and the AI
tools (`edit_block`, `create_block`, `move_block`, `rename_page`, `move_page`)
call them directly — so everything a page's viewers see comes from one path
and one log. Writers that rewrite a tree wholesale (`PUT /blocks/{id}/children`,
imports into an existing page, the target half of a cross-page move) log and
publish a `reload` instead; a cross-page move's source page gets a `delete`
(`record_ops`).

## The op log

`page_ops(page_id, seq, actor, client, at, ops)` in each user's `pages.db`
(`db.PAGES_SCHEMA`), one row per applied batch, `seq` counting up per page
(the write lock is taken up front with `BEGIN IMMEDIATE`, so it never
collides). `actor` is the account that made the change (a share editor's own
name), `client` the tab's id or `"ai"`. Pruned to the newest `KEEP_OPS` rows
per page, checked every `PRUNE_EVERY` batches. `GET /api/pages/{id}/ops?since=`
returns the batches after a seq (410 when the log no longer reaches back: the
client reloads the tree); `GET /blocks/{id}/subtree` on a page carries the
`seq` its tree reflects.

## Rooms and the socket (`gamma/collab.py`, `routers/collab.py`)

One in-memory room per `(owner, page_id)` — Gamma is one uvicorn process
everywhere (Docker, the desktop sidecar), so nothing is shared across
workers. `publish` schedules sends on the loop the sockets live on and is safe
from threadpool code (the sync AI chat endpoint runs the tools there); a
handler being torn down announces its leave through `publish` too, never by
awaiting inside a possibly cancelled scope.

`WS /api/ws/page/{page_id}[?share=token&client=id]`. The HTTP middleware does
not run for websockets, so the handler resolves the session cookie itself
(`auth.session_lookup`) and the share grant with the same rules as HTTP
(`share_lookup` + `share_access` on the socket's `state`): an owner or a
signed-in account joins its own page, a share token admits its audience (view
or edit); anything else is closed before accept. Messages:

- server → client: `hello {client, color, seq, peers}` on join; `join {peer}`
  / `leave {client}`; `cursor {client, block, anchor, head}`; `ops {seq, at,
  actor, client, ops}` for every applied batch (the sender's own included, it
  filters by client id); `reload {seq}`.
- client → server: `cursor {block, anchor, head}` only (`anchor`/`head` = -1
  when no editor is open on that block). **Writes never travel over the
  socket**: they are `POST /api/pages/{id}/ops`, so auth and scoping live in
  one place, a dropped socket loses nothing, and a closing tab flushes with a
  keepalive fetch.

A peer is `{client, user, name, color, can_edit, block, anchor, head}`; colour
is an index into an 8-slot palette handed out per room (CSS `--peer-N`);
anonymous share viewers are `Anonymous`.

## The client (`src/collab.js`, `src/blockOps.js`)

`usePageCollab` — one per open page (App.jsx) — owns:

- **the base tree**: what the server is known to hold from this tab's point of
  view. The block tree's transition effect (the old autosave effect) calls
  `commit(tree)`: a load transition (the existing suppress flag, also set for
  remote applies) makes the tree the new base; any other transition is
  diffed against the base (`diffTrees`) and the ops queued. Positions live in
  one `Map id → key` shared with `blockOps`, so tree objects and history
  snapshots stay untouched.
- **the queue**: `set` ops on one block coalesce (`pushOp`); typing flushes
  after 350 ms, a structural op after 80 ms, an editor closing at once
  (`saveNowRef`), `flush()` before navigation. The POST response is the ack:
  re-keyed positions are adopted from it. 4xx → status + reload (resync rather
  than loop); network errors retry with the ops kept in front of the queue.
- **reconciliation**: `inflight` counts queued-or-sent content sets per
  block. A remote `set` for a block with one in flight is *deferred* and, on
  the ack, applied only if its seq is higher than the ack's (theirs is the
  newer server value), else dropped (ours is). Everything else applies at
  once — to the base, to the on-screen tree through `onRemoteOps` (a
  load-like transition: no history entry, nothing re-sent), and to every
  undo snapshot (`blockHistory.rebase`), so undoing your own edit never
  reverts someone else's.
- **catch-up**: `seq` is seeded from the tree fetch; a hello with a higher
  seq, or any reconnect, reads `…/ops?since=`; 410 or a `reload` message
  refetches the subtree with `keepUiFlags` (the open editor, its text and the
  folding survive the swap).
- **presence**: `peers` state from `hello`/`join`/`leave`/`cursor`;
  `sendCursor` throttled to 80 ms, fed by the editor's selection (`onCaret`),
  editor open/close and the focused row.

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

## What the user sees (`src/presence.jsx`, CSS in `app.css`)

- the header avatar stack (initial, peer colour; faded while only viewing;
  click jumps to the person's block);
- small avatar chips on the row a person is on, and a coloured left edge
  while someone has that block's editor open;
- inside an open editor, each peer's caret with a name tag and a tinted
  selection (`remoteCursorField` in `blockCmEditor.jsx`, mapped through local
  edits and replaced on new presence). External value changes reach the
  editor as the minimal prefix/suffix replacement, tagged so they are not
  re-reported as local edits — the caret maps through instead of jumping.

## Testing

- `backend/tests/test_collab.py`: op semantics, scoping, the log and
  catch-up, the socket (TestClient `websocket_connect`; sockets need a
  context-managed client), AI-tool and cross-page fan-out.
- `frontend/tests/blockOps.test.mjs`: `node --test tests/blockOps.test.mjs`
  from `frontend/` (pure diff/apply round-trips).
- End to end: two browser contexts on one page — see the `/verify` skill; the
  scenarios exercised while building this: typing in one tab appears in the
  other, chips and carets show, same-block typing converges, new block +
  indent + delete fan out, undo after a remote edit keeps the remote edit, an
  invited editor on a share link edits the owner's page under their own name.

## Limits and next steps

- Same-block simultaneous typing is last-writer-wins per block. The upgrade
  path, if it ever matters, is CodeMirror's collab rebase on just the open
  block; not a CRDT.
- The socket needs a proxy that forwards websocket upgrades (Vite's dev proxy
  has `ws: true`; a reverse proxy in front of the NAS must pass `Upgrade`).
  uvicorn needs the `websockets` package (`requirements.txt`; the desktop
  freeze collects it).
- Rooms are per process: a multi-worker deployment would need a shared bus.

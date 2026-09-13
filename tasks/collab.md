# Real-time collaborative editing (multi-user, presence, cursors)

Status: **implemented and verified** (2026-09-12); not committed. The
developer doc is [docs/dev/collab.md](../docs/dev/collab.md). This file keeps
the task framing, what was learned, and what is left.

## The task

Shared pages (Notion-style invite / general-access edit shares) and the same
account on two machines must be able to edit one page at the same time
without losing each other's work, and see who is on the page and where
(avatars per block, carets + selections inside an open editor — Notion /
Overleaf style). Clean and high-performance; no backward compatibility with
the old save protocol; tested.

## What was learned before starting

### Why the old Gamma could not collaborate

- Autosave was a snapshot protocol: 500 ms after any edit the client sent the
  WHOLE page tree to `PUT /api/blocks/{page}/children`, and the server deleted
  and reinserted every row (positions regenerated from array order, every
  row's `updated_at` stamped). Two clients on one page overwrote each other
  wholesale; positions were not stable; per-block timestamps carried nothing;
  orphan-upload cleanup and the notes-index fingerprint ran per keystroke
  burst; the payload was an untyped list.
- No concurrency token, no push channel, no presence. `pages.db` ran without
  WAL. UI state (`editMode`, `collapsed`) lived inside the block objects.
- Two machines, same account: both sessions valid; separate pages fine; the
  same page last-writer-wins on the whole page, and an image pasted on the
  losing side was deleted from disk by the orphan sweep.

### What was right and stayed

Stable client-minted block ids; SQLite as the only source of truth with every
server-side writer already per block; the undo history already a tree diff
engine; share auth per page; one uvicorn process everywhere; the block editor's
`StateField` decorations.

### How the industry does it (research, 2026-09)

Three families: central server + character OT (Google Docs, Overleaf/ShareJS,
ProseMirror/CodeMirror collab); central server + record/property
last-writer-wins (Figma, Linear, tldraw sync, Notion — block ops in
transactions, blocks never locked, "the most recent change will be
reflected"); CRDTs (AFFiNE/BlockNote on Yjs, Logseq RTC) at the cost of a
second source of truth. Presence is always a separate, never-persisted channel
(Yjs awareness, Overleaf's `updateClientPosition`, tldraw presence records,
Notion/Logseq block-level avatars). Gamma is the Notion/Linear/Figma shape.

## What was built

Backend: `gamma/db.py` `connect_pages_db` (WAL, busy timeout, schema incl.
`page_ops`); `gamma/ops.py` (op vocabulary, `apply_ops` / `after_commit` /
`commit_ops`, the log, `ops_since`, `record_ops`, `note_reload`);
`gamma/collab.py` (rooms, thread-safe `publish`); `gamma/routers/collab.py`
(`POST/GET /pages/{id}/ops`, `WS /ws/page/{id}`); `auth.session_lookup`;
every writer wired (blocks router as wrappers, pages attach/detach, metadata,
clip, AI tools, imports → reload, cross-page reorder); `websockets` added to
requirements and the desktop freeze. Tests: `backend/tests/test_collab.py`
(11), whole suite 448 green.

Frontend: `fractional-indexing` dependency; `src/blockOps.js` (+ node tests,
16); `src/collab.js` (`usePageCollab`); `src/presence.jsx`; App.jsx (the
autosave effect → `collab.commit`, remote apply, root ops → title/props state,
history rebase, presence sources, header avatar stack, `loadBlocksForBlock`
keeps UI flags); `blockCmEditor.jsx` (minimal external diff tagged as
external, remote caret field); `blockTree.jsx` (peer chips, peer edge,
`remoteCursors`); `blockHistory.rebase`; CSS; Vite proxy `ws: true`.

Verified end to end (two Chromium contexts, `/verify` flow): typing fans out
both ways, chips + carets + header avatars, same-block typing converges
(LWW), new block + indent + delete, undo after a remote edit keeps the remote
edit, an invited editor on a share link edits under their own name and sees
the owner's rename.

## Left / ideas

- Same-block simultaneous typing is LWW per block. Upgrade path: CodeMirror
  collab rebase on the open block only.
- Presence could carry the PDF viewport (which page someone reads).
- Activity view from the op log (`actor`, `at`) — "who changed what" — and a
  page version history from it.
- Rooms are per process; a multi-worker deployment would need a shared bus.
- The `/verify`-style two-browser script is not checked in (no frontend test
  runner beyond `node --test`); worth adding a Playwright smoke if the repo
  ever grows one.

## Decisions log

- Writes go over HTTP (`POST …/ops`), the socket only fans out. Auth and
  scoping stay in one code path, keepalive flushes keep working on tab close,
  a dropped socket never loses an edit.
- Same-block concurrent typing is last-writer-wins per block (Notion), with
  the Figma rule for our own unacked value (deferred remote sets decided by
  server order on the ack).
- No Yjs (second source of truth; every backend writer would have to go
  through it).
- Folding stays personal: a remote `collapsed` property updates the stored
  default, not the viewer's own flag.

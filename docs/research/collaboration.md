# Real-time collaborative editing

Survey and reasoning from 2026-09, when Gamma's whole-tree autosave was
replaced by the block-op protocol described in
[dev/collab.md](../dev/collab.md). This note keeps what is general: how the
field does it, why the old design could not be patched, and why the shape
that was chosen fits an outliner over SQLite.

## How the industry does it

Three families cover practically every shipping product.

**Central server + character-level OT.** Google Docs, Overleaf (ShareJS),
ProseMirror's and CodeMirror's `collab` modules. Every keystroke is an
operation against a document version; the server serialises them and each
client rebases its unconfirmed operations over what arrived first. Strong
for one long text; every editor surface must speak the same operation
vocabulary, and a server that loses its version counter loses the ability
to merge.

**Central server + record-level last-writer-wins.** Figma, Linear, tldraw
sync, Notion. The document is a set of records (blocks, shapes, issues) with
properties; a change is "set this property of this record", applied in a
transaction and broadcast in server order. Records are never locked; two
people changing *different* records or *different* properties never
conflict, and two people changing the *same* property resolve by server
order ("the most recent change will be reflected", in Notion's words).
Figma adds one refinement worth copying: a client that has an unacknowledged
change of its own defers a conflicting remote value and lets the server's
ordering decide when the ack arrives, so its own screen never flickers
backwards. This family needs no second data model; the database rows *are*
the document.

**CRDTs.** AFFiNE and BlockNote on Yjs, Logseq's RTC. Every replica can
merge without a server, which is what makes local-first sync possible. The
price is a second source of truth: the CRDT document has to be the thing
every writer mutates (server-side scripts, importers, AI tools included),
and the relational view becomes a projection of it. Tombstones and history
grow with the document.

**Presence is always its own channel.** In every family the "who is where"
data (Yjs awareness, Overleaf's `updateClientPosition`, tldraw's presence
records, Notion's and Logseq's per-block avatars) is a separate, ephemeral,
never-persisted message type, broadcast at a throttled rate and forgotten on
disconnect. It shares a socket with document updates but never a log.

## Why a snapshot autosave cannot be made collaborative

Gamma's original save path was the common first design: some hundreds of
milliseconds after any edit, send the whole page tree; the server deletes
and reinserts every row. Looking at it before the redesign produced a list
that generalises to any snapshot protocol:

- Two clients on one page overwrite each other wholesale, so the granularity
  of a conflict is the whole document, not the thing that was edited.
- Positions regenerated from array order are not stable, so nothing can be
  addressed across saves and no diff can be computed.
- Per-row timestamps carry nothing when every row is rewritten on every
  save; "who changed what" is unrecoverable.
- Derived work (orphan-file sweeps, search-index fingerprints) runs per
  keystroke burst because the server cannot tell what changed.
- Side effects on the losing side are destructive: an image pasted by the
  client whose snapshot lost was deleted from disk by the orphan sweep.
- UI state that lives inside the persisted objects (edit mode, folding)
  travels with the document and becomes everyone's state.

None of these is fixable by adding a version check or a merge step; the
protocol has to carry the change, not the result.

## What did not need to change

A redesign is cheaper when the model was already close. In Gamma's case:
block ids were minted by the client and stable; SQLite was the only source
of truth and every server-side writer already worked per block; the undo
history was already a tree-diff engine, so ops could be derived from the
same transitions; share authorisation was already per page; the deployment
was one process everywhere, so an in-memory room per page was enough. The
editor's decorations were a CodeMirror `StateField`, which is where remote
carets could be added without touching the editing model.

## Why the record-LWW shape fits an outliner over SQLite

The unit people edit in an outliner is the block, and blocks are already
rows. A block-op protocol (`set` / `insert` / `move` / `delete` with
fractional-index positions) therefore needs no new model: the server applies
a batch in one transaction, assigns a per-page sequence number, logs it and
fans it out. Structural edits from different people merge for free; the
only real conflict is two carets typing in one block at the same moment,
which visible presence makes rare and last-writer-wins by server order makes
harmless. If that conflict ever matters, the upgrade path is character-level
OT (CodeMirror's collab rebase) on *just the open block*, not a CRDT for the
page.

A CRDT was ruled out precisely because of the second-source-of-truth cost:
every backend writer (importers, the AI agent's tools, the clip endpoint,
metadata writes) would have had to go through the CRDT document instead of
SQL.

## Decisions worth keeping in mind

- **Writes travel over HTTP; the socket only fans out.** Authorisation and
  scoping stay in one code path, a `keepalive` fetch can still flush on tab
  close, and a dropped socket never loses an edit. A socket that also
  accepted writes would need all of that duplicated.
- **Conflict resolution is per record and per property.** Content is one
  last-writer-wins value; properties are a patch, so unrelated properties
  never fight.
- **Undo is rebased, not replayed.** Each undo snapshot is patched with the
  remote ops as they arrive, so undoing your own change never reverts
  someone else's.
- **Folding stays personal.** A remote change to a block's stored `collapsed`
  default updates the default, not the viewer's own folding; the persisted
  model and per-viewer UI state are kept apart on purpose.
- **Fractional indexing on both sides, server re-keys collisions.** The
  client can mint positions for optimistic inserts; the server's echoed key
  is authoritative.

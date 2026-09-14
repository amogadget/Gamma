// THE undo/redo history of the page: one stack, derived from the block
// tree's own state transitions — no call site declares "this is undoable",
// and the block editor keeps no history of its own (CodeMirror's `history()`
// is not installed; Ctrl+Z inside an editor reaches the same stack).
//
// Every committed change to `blocks` is classified by diffing it against the
// previous committed tree:
//   - loads (the caller flagged the transition with `loadRef`, the same flag
//     that stops the autosave) and undo/redo applications are never recorded;
//   - opening/closing editors and collapse toggles are not edits;
//   - everything else (add/delete/move/indent, property changes such as a
//     highlight colour or link, any content change — typing, checkboxes,
//     table cells, image size) pushes the previous tree.
// Consecutive content-only edits of the same block merge into one entry
// when they come quickly (TYPING_MERGE_MS while the block's editor is open —
// a run of typing undoes as one chunk, like any editor — else
// EDIT_MERGE_MS: a drag, a run of toggles).
//
// An entry is {tree, caret}: the tree kept by reference (the helpers never
// mutate in place) and, when the change came from an editor, that editor's
// selection before it. Restoring while an editor is open keeps the caret's
// block in edit mode and hands the caret back through `onCaret` so the
// editor puts the cursor where the change was; restoring with no editor open
// strips editMode so undo never pops editors open. The stack belongs to one
// page and is cleared when the page id changes.
import { useCallback, useEffect, useRef } from "react";

const MAX_ENTRIES = 200;
const TYPING_MERGE_MS = 500;
const EDIT_MERGE_MS = 1000;

// Collapsed lives in both the block and its properties; neither is an edit.
function propsEqual(a, b) {
  if (a === b) return true;
  const ka = Object.keys(a || {}).filter((k) => k !== "collapsed");
  const kb = Object.keys(b || {}).filter((k) => k !== "collapsed");
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k], vb = b[k];
    if (va === vb) continue;
    if (typeof va !== "object" || typeof vb !== "object" || va === null || vb === null) return false;
    if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
  }
  return true;
}

// null: nothing undoable changed; true: structural/property edit;
// a block id: only that block's content changed. Exported for its tests.
export function classifyTransition(prev, next) {
  if (prev === next) return null;
  if (prev.length !== next.length) return true;
  let only = null;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i], b = next[i];
    if (a === b) continue;
    if (a.id !== b.id) return true;
    if (a.content !== b.content) only = only === null ? a.id : true;
    if (!propsEqual(a.properties, b.properties)) return true;
    const sub = classifyTransition(a.children || [], b.children || []);
    if (sub === true) return true;
    if (sub) only = only === null ? sub : true;
    if (only === true) return true;
  }
  return only;
}

function editingId(list) {
  for (const b of list || []) {
    if (b.editMode) return b.id;
    const sub = editingId(b.children);
    if (sub) return sub;
  }
  return null;
}

function hasBlock(list, id) {
  for (const b of list || []) {
    if (b.id === id || hasBlock(b.children, id)) return true;
  }
  return false;
}

// editMode only on `keepId` (none when null).
function withEditMode(list, keepId) {
  return (list || []).map((b) => ({ ...b, editMode: b.id === keepId, children: withEditMode(b.children, keepId) }));
}

// Options:
//   loadRef     — ref that is true for a load transition (shared with autosave)
//   pageId      — the stack is cleared when it changes
//   enabled     — false while read-only / no page
//   caretRef    — {id, from, to} the open editor's live selection (App keeps
//                 it current from the editor's selection/change events)
//   caretBeforeRef — {id, from, to} the last editor change reported as its
//                 pre-change selection (App sets it in onChangeText)
//   onCaret({id, from, to}) — called after a restore that should land the
//                 cursor in the (kept-open) editor of that block
export function useBlockHistory(blocks, setBlocks, opts) {
  const st = useRef({ undo: [], redo: [], prev: blocks, prevCaret: null, displaced: null, intent: null, lastEdit: null });
  const optsRef = useRef({ setBlocks, ...opts });
  optsRef.current = { setBlocks, ...opts };
  const { loadRef, pageId } = opts;

  const clear = useCallback(() => {
    st.current.undo = [];
    st.current.redo = [];
    st.current.lastEdit = null;
  }, []);
  useEffect(clear, [pageId, clear]);

  // Selection of the editor open in `tree`: the live one while that editor
  // is still the open one, else what it was at the previous commit (the
  // editor has since moved to another block, e.g. Enter made a new one).
  const caretIn = (tree) => {
    const id = editingId(tree);
    if (!id) return null;
    const s = st.current;
    const live = optsRef.current.caretRef?.current;
    const c = live?.id === id ? live : s.prevCaret?.id === id ? s.prevCaret : null;
    return c ? { id, from: c.from, to: c.to } : null;
  };

  // Must run before the autosave effect consumes loadRef (effects run in
  // declaration order — call this hook right after the flag is declared).
  useEffect(() => {
    const s = st.current;
    const prev = s.prev;
    s.prev = blocks;
    const intent = s.intent;
    s.intent = null;
    const displaced = s.displaced;
    s.displaced = null;
    try {
      if (loadRef.current || prev === blocks) return;
      if (intent === "undo") { s.redo.push({ tree: prev, caret: displaced }); return; }
      if (intent === "redo") { s.undo.push({ tree: prev, caret: displaced }); return; }
      const kind = classifyTransition(prev, blocks);
      if (kind === null) {
        // The editor of the block being merged into closed: the run ends.
        if (s.lastEdit?.editing && editingId(blocks) !== s.lastEdit.id) s.lastEdit = null;
        return;
      }
      const now = Date.now();
      const editing = kind !== true && editingId(blocks) === kind;
      if (kind !== true && s.lastEdit?.id === kind
          && now - s.lastEdit.at < (editing && s.lastEdit.editing ? TYPING_MERGE_MS : EDIT_MERGE_MS)) {
        s.lastEdit.at = now;
        s.lastEdit.editing = editing;
        return;
      }
      s.lastEdit = kind === true ? null : { id: kind, at: now, editing };
      // A content change from an editor carries the selection it started from.
      const before = optsRef.current.caretBeforeRef?.current;
      const caret = kind !== true && before?.id === kind ? { ...before } : caretIn(prev);
      s.undo.push({ tree: prev, caret });
      if (s.undo.length > MAX_ENTRIES) s.undo.shift();
      s.redo = [];
    } finally {
      const live = optsRef.current.caretRef?.current;
      s.prevCaret = live ? { ...live } : null;
    }
  }, [blocks, loadRef]);

  // Stable, so a once-mounted key listener can call it. Returns whether an
  // entry was applied. `inEditor`: the keypress came from an open editor —
  // the restored block stays in edit mode with the cursor where the change
  // was; otherwise nothing opens.
  const undo = useCallback((redo = false, inEditor = false) => {
    const o = optsRef.current;
    if (!o.enabled) return false;
    const s = st.current;
    const entry = (redo ? s.redo : s.undo).pop();
    if (!entry) return false;
    s.intent = redo ? "redo" : "undo";
    s.lastEdit = null;
    // The state being displaced keeps the cursor it has right now (read
    // before the restore re-syncs the editor's document).
    s.displaced = caretIn(s.prev);
    const caret = inEditor && entry.caret && hasBlock(entry.tree, entry.caret.id) ? entry.caret : null;
    o.setBlocks(withEditMode(entry.tree, caret?.id || null));
    if (caret) o.onCaret?.(caret);
    return true;
  }, []);

  // Another client's change landed: fold it into every snapshot, so undoing
  // our own edits never reverts theirs (what a collaborative undo means).
  const rebase = useCallback((fn) => {
    const s = st.current;
    if (s.undo.length) s.undo = s.undo.map((e) => ({ ...e, tree: fn(e.tree) }));
    if (s.redo.length) s.redo = s.redo.map((e) => ({ ...e, tree: fn(e.tree) }));
  }, []);

  return { undo, clear, rebase };
}

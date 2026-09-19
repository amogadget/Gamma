// The ink files behind the page's handwriting blocks, for the document's
// life: loaded files by URL, and per-block DRAFTS — the strokes as edited
// here, ahead of (or between) uploads. A draft wins over the block's file
// until the upload replaces the block's `ink_url` with the draft's; a
// remote change of `ink_url` on a block with no unsaved strokes drops the
// draft. Plain module state with a version counter — React subscribes
// through useInkVersion (ink/InkLayer.jsx).
import { API, apiJson } from "../shared/lib/utils";

const files = new Map();     // url → ink | null (null: fetch failed)
const loading = new Map();   // url → Promise
const drafts = new Map();    // block id → {ink, dirty, url}
const listeners = new Set();
let version = 0;

function bump() {
  version += 1;
  for (const fn of listeners) fn(version);
}
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function currentVersion() { return version; }

export function loadInk(url) {
  if (!url) return Promise.resolve(null);
  if (files.has(url)) return Promise.resolve(files.get(url));
  if (loading.has(url)) return loading.get(url);
  const p = apiJson(`${API}${url.replace(/^\/api/, "")}`)
    .then((ink) => { files.set(url, ink && ink.format === "gamma-ink" ? ink : null); return files.get(url); })
    .catch(() => { files.set(url, null); return null; })
    .finally(() => { loading.delete(url); bump(); });
  loading.set(url, p);
  return p;
}

// The strokes to show for a block: its draft, else its file (fetch kicked
// off when unseen — the caller re-renders on the store's next bump).
export function inkFor(block) {
  const url = block?.properties?.ink_url || "";
  const d = drafts.get(block?.id);
  if (d) {
    if (!d.dirty && d.url !== url) { drafts.delete(block.id); }
    else return d.ink;
  }
  if (!url) return null;
  if (!files.has(url)) { loadInk(url); return null; }
  return files.get(url);
}

export function draft(id) { return drafts.get(id) || null; }
export function setDraft(id, ink) {
  const prev = drafts.get(id);
  drafts.set(id, { ink, dirty: true, url: prev?.url ?? "" });
  bump();
}
// The upload of `ink` landed at `url`. Strokes added meanwhile keep the
// draft dirty (the next flush uploads them).
export function markSaved(id, ink, url) {
  const d = drafts.get(id);
  if (!d) return;
  files.set(url, ink);
  drafts.set(id, { ...d, url, dirty: d.ink !== ink });
  bump();
}
// An acknowledged deletion still masks the old file while its block is in
// the tree. Do not cache the empty ink under the old file URL, or discard
// an edit made while the delete request was pending.
export function markDeleted(id, ink, url) {
  const d = drafts.get(id);
  if (d?.ink === ink) drafts.set(id, { ...d, dirty: false, url });
}
export function dirtyDrafts() {
  return [...drafts.entries()].filter(([, d]) => d.dirty)
    .map(([id, d]) => ({ id, ink: d.ink }));
}

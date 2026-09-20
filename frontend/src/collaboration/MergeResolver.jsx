// In-place conflict resolution for a clone (docs/dev/mirror.md): a block
// the sync merged or had to decide on carries a small chip on its row; the
// chip's popover shows the block's current text with each side's
// contribution coloured — ours (this clone's) and theirs (origin's) — and
// the three answers: keep the merge, use ours, use theirs. The list in the
// sync pill and in Settings → Workspaces jumps here; the decision is an
// ordinary edit the next round pushes.
import React from "react";
import { AlertCircleIcon, CheckIcon } from "../shared/ui/Icons";

// Word-level tokens: runs of non-space and runs of space, so a diff never
// splits a word and the coloured spans keep their spacing.
function tokens(s) {
  return (s || "").match(/\s+|[^\s]+/g) || [];
}

// For every token of `a`, whether it is part of the longest common
// subsequence with `b` (a classic DP; block texts are short).
function matched(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return new Array(n).fill(false);
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

// The result's tokens, each tagged by where it came from: "same" (in both
// versions), "mine" (ours only), "theirs" (origin's only), "both" (neither
// — a merge artefact, rare).
export function attribute(result, mine, theirs) {
  const r = tokens(result);
  const inMine = matched(r, tokens(mine));
  const inTheirs = matched(r, tokens(theirs));
  return r.map((text, i) => ({
    text,
    tag: inMine[i] && inTheirs[i] ? "same" : inMine[i] ? "mine" : inTheirs[i] ? "theirs" : "both",
  }));
}

// The sync_conflicts kinds, in git's words (ours = this clone, theirs = origin).
export const MERGE_KIND = {
  merged: { short: "Auto-merged", long: "Both sides changed this block; the two edits were merged into one text." },
  diverged: { short: "Diverged", long: "The two versions differed when the clone was attached; one was taken, the other is here." },
  kept_local_edit: { short: "Kept ours", long: "Origin deleted this, but it was edited here, so it stayed and was pushed back." },
  restored_remote_edit: { short: "Restored theirs", long: "This was deleted here, but origin edited it, so it was pulled back." },
  page_restored: { short: "Page restored on origin", long: "Origin deleted this page; it was edited here, so it was pushed back." },
  page_restored_from_remote: { short: "Page restored from origin", long: "This page was deleted here but edited on origin, so it was pulled back." },
};

// The coloured text: spans by origin, whitespace kept.
export function MergeText({ conflict }) {
  const parts = attribute(conflict.result, conflict.mine, conflict.theirs);
  return (
    <div className="mergeText">
      {parts.map((p, i) => p.tag === "same" ? <span key={i}>{p.text}</span> : <mark key={i} className={`merge-${p.tag}`}>{p.text}</mark>)}
    </div>
  );
}

// The legend under a coloured text.
export function MergeLegend() {
  return (
    <div className="mergeLegend">
      <span><mark className="merge-mine">ours</mark></span>
      <span><mark className="merge-theirs">theirs (origin)</mark></span>
    </div>
  );
}

// The chip on a block row and its popover. `onResolve(conflict, choice)`.
export function MergeChip({ conflict, onResolve }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  const kind = MERGE_KIND[conflict.kind] || { short: conflict.kind, long: "" };
  const textual = conflict.kind === "merged" || conflict.kind === "diverged";
  async function choose(choice) {
    setBusy(true);
    try { await onResolve(conflict, choice); } finally { setBusy(false); setOpen(false); }
  }
  return (
    <span className="mergeChipWrap" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className={`mergeChip ${open ? "on" : ""}`} title={`${kind.short} — click to resolve`}
        aria-label="Conflict to resolve" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <AlertCircleIcon size={12} />
      </button>
      {open ? (
        <div className="popover mergePopover" role="dialog" aria-label="Merge">
          <div className="mergeHead">
            <span className="popoverTitle">{kind.short}</span>
            <span className="popoverHint">{kind.long}</span>
          </div>
          {textual ? (
            <>
              <MergeText conflict={conflict} />
              <MergeLegend />
              {conflict.kind === "diverged" ? (
                <div className="mergeOther">
                  <span className="popoverHint">{conflict.result === conflict.mine ? "Theirs (origin):" : "Ours:"}</span>
                  <div className="mergeTextMuted">{conflict.result === conflict.mine ? conflict.theirs : conflict.mine}</div>
                </div>
              ) : null}
            </>
          ) : null}
          <div className="mergeActions">
            {textual ? <>
              <button className="uiBtn sm" disabled={busy} onClick={() => choose("mine")} title="Put this clone's text back">Use ours</button>
              <button className="uiBtn sm" disabled={busy} onClick={() => choose("theirs")} title="Take origin's text">Use theirs</button>
            </> : null}
            <button className="uiBtn sm primary" disabled={busy} onClick={() => choose("keep")} title="Mark resolved as it is">
              <CheckIcon size={13} /> {textual ? "Keep merged" : "OK"}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

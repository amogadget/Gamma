// Conflict resolution for a clone (docs/dev/mirror.md), in git's words:
// local is this clone, remote is origin. One card — ConflictCard — serves
// every surface: the chip on a block row (its popover walks the page's
// conflicts one by one), the sync pill's list and Settings → Workspaces.
// A block both sides edited shows what each side changed as a word diff
// against the text before either edit (removed words struck through, added
// words in the side's colour), and under them the text that is in the block
// now — the automatic merge, its additions coloured by who wrote them.
// Every version carries its own Use button, the current one a Keep. A
// decision is an ordinary edit the next round pushes. Rows from before the
// base was kept (and diverged blocks, which have none) show the two texts
// against each other instead.
import React from "react";
import {
  AlertCircleIcon, ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon,
  HardDriveIcon, MergeIcon, ServerIcon,
} from "../shared/ui/Icons";

// Word-level tokens: runs of non-space and runs of space, so a diff never
// splits a word and the coloured spans keep their spacing.
function tokens(s) {
  return (s || "").match(/\s+|[^\s]+/g) || [];
}

// The LCS table of two token arrays (a classic DP; block texts are short).
function lcs(A, B) {
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

// For every token of `a`, whether it is part of the longest common
// subsequence with `b`.
function matched(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return new Array(n).fill(false);
  const dp = lcs(a, b);
  const out = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

// A git-style word diff from `a` to `b`: runs tagged "same", "del" (only
// in a) and "add" (only in b), whitespace kept.
export function wordDiff(a, b) {
  const A = tokens(a), B = tokens(b);
  const n = A.length, m = B.length;
  const dp = lcs(A, B);
  const out = [];
  const push = (text, tag) => {
    const prev = out[out.length - 1];
    if (prev && prev.tag === tag) prev.text += text;
    else out.push({ text, tag });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push(A[i], "same"); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(A[i], "del"); i++; }
    else { push(B[j], "add"); j++; }
  }
  while (i < n) push(A[i++], "del");
  while (j < m) push(B[j++], "add");
  return out;
}

// The result's tokens, each tagged by where it came from: "same" (in both
// versions), "mine" (local only), "theirs" (remote only), "both" (neither
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

// One side against the other: the tokens of `text` that `other` lacks are
// tagged `tag`, the rest "same" — what this version adds.
export function onlyIn(text, other, tag) {
  const t = tokens(text);
  const m = matched(t, tokens(other));
  return t.map((s, i) => ({ text: s, tag: m[i] ? "same" : tag }));
}

// What one side changed: the diff from the base, its additions in the
// side's colour, its removals struck through.
function sideParts(base, text, tag) {
  return wordDiff(base, text).map((p) => ({ text: p.text, tag: p.tag === "add" ? tag : p.tag }));
}

// What the merge did: the diff from the base, each added word coloured by
// the side that wrote it (both, when both added it).
function mergedParts(base, mine, theirs, result) {
  const added = (text) => new Set(wordDiff(base, text).filter((p) => p.tag === "add").flatMap((p) => tokens(p.text)));
  const mineAdds = added(mine), theirsAdds = added(theirs);
  return wordDiff(base, result).flatMap((p) => p.tag !== "add" ? [p] : tokens(p.text).map((t) => ({
    text: t,
    tag: /^\s+$/.test(t) ? "same" : mineAdds.has(t) && theirsAdds.has(t) ? "both" : mineAdds.has(t) ? "mine" : theirsAdds.has(t) ? "theirs" : "both",
  })));
}

// The sync_conflicts kinds, in git's words (local = this clone, remote = origin).
export const MERGE_KIND = {
  merged: { short: "Auto-merged", long: "Both sides changed this block; the two edits were merged into one text.", Icon: MergeIcon },
  diverged: { short: "Diverged", long: "Local and remote differed when the clone was attached; one was taken, the other is here.", Icon: AlertCircleIcon },
  kept_local_edit: { short: "Kept local", long: "Remote deleted this, but it was edited here, so it stayed and was pushed back.", Icon: ArrowUpIcon },
  restored_remote_edit: { short: "Restored remote", long: "This was deleted here, but remote edited it, so it was pulled back.", Icon: ArrowDownIcon },
  page_restored: { short: "Page restored on remote", long: "Remote deleted this page; it was edited here, so it was pushed back.", Icon: ArrowUpIcon },
  page_restored_from_remote: { short: "Page restored from remote", long: "This page was deleted here but edited on remote, so it was pulled back.", Icon: ArrowDownIcon },
};

export function kindOf(conflict) {
  return MERGE_KIND[conflict.kind] || { short: conflict.kind, long: "", Icon: AlertCircleIcon };
}

// Textual conflicts hold both texts and take a choice; the others are
// decisions to acknowledge.
export function isTextual(conflict) {
  return conflict.kind === "merged" || conflict.kind === "diverged";
}

// The sides: a glyph, a word, where it lives. (The API keeps mine / theirs.)
const SIDE = {
  mine: { label: "Local", hint: "this clone", Icon: HardDriveIcon },
  theirs: { label: "Remote", hint: "origin", Icon: ServerIcon },
  result: { label: "Merged", hint: "both edits in one text", Icon: MergeIcon },
};

// Neighbouring tokens of one tag become one run, the whitespace between
// two marked tokens included — a phrase reads as a phrase, not as words.
function runs(parts) {
  const out = [];
  parts.forEach((p, i) => {
    const prev = out[out.length - 1];
    const bridge = /^\s+$/.test(p.text) && p.tag === "same" && prev && prev.tag !== "same"
      && parts[i + 1] && parts[i + 1].tag === prev.tag;
    const tag = bridge ? prev.tag : p.tag;
    if (prev && prev.tag === tag) prev.text += p.text;
    else out.push({ text: p.text, tag });
  });
  return out;
}

// Marked text: a run per tag, `mark.merge-<tag>` for everything but "same"
// (mine / theirs / both / add / del).
export function Marked({ parts }) {
  return runs(parts).map((p, i) => p.tag === "same" ? <span key={i}>{p.text}</span> : <mark key={i} className={`merge-${p.tag}`}>{p.text}</mark>);
}

// One version of the block: a header naming the side, a tag when it is the
// text in the block now, its Use / Keep button, the text with the marks.
function Version({ side, parts, current, busy, onUse, hint }) {
  const s = SIDE[side];
  const choice = side === "result" ? "keep" : side;
  const word = side === "result" ? "merged" : s.label.toLowerCase();
  return (
    <section className={`mergeVersion ${side} ${current ? "current" : ""}`} aria-label={`${s.label} (${s.hint})`}>
      <header className="mergeVersionHead">
        <span className={`mergeSide ${side}`} title={hint || s.hint}><s.Icon size={12} />{s.label}</span>
        <span className="popoverHint mergeSideHint">{hint || s.hint}</span>
        {current ? <span className="uiTag">in the block</span> : null}
        {onUse ? (
          <button type="button" className={`uiBtn sm ${current ? "primary" : ""}`} disabled={busy}
            onClick={() => onUse(current ? "keep" : choice)}
            aria-label={current ? `Keep ${word}` : `Use ${word}`}
            title={current ? "This is the text in the block now: mark it resolved" : `Put the ${word} text into the block`}>
            {current ? <><CheckIcon size={13} /> Keep</> : "Use"}
          </button>
        ) : null}
      </header>
      <div className="mergeText"><Marked parts={parts} /></div>
    </section>
  );
}

// The versions of a textual conflict. With a base (an auto-merge): local
// and remote as what each changed, the merged text as what the merge did.
// Without one (diverged, or an older row): the two texts against each
// other, the merged text by attribution.
function Versions({ conflict, busy, onUse }) {
  const c = conflict;
  const diverged = c.kind === "diverged";
  const mineCurrent = diverged && c.result === c.mine;
  const theirsCurrent = diverged && c.result !== c.mine;
  const base = !diverged && typeof c.base === "string" && c.base ? c.base : null;
  const mineParts = base ? sideParts(base, c.mine, "mine") : onlyIn(c.mine, c.theirs, "mine");
  const theirsParts = base ? sideParts(base, c.theirs, "theirs") : onlyIn(c.theirs, c.mine, "theirs");
  return (
    <div className={`mergeVersions ${diverged ? "two" : "three"}`}>
      <Version side="mine" parts={mineParts} current={mineCurrent} busy={busy} onUse={onUse} hint={base ? "changed here" : undefined} />
      <Version side="theirs" parts={theirsParts} current={theirsCurrent} busy={busy} onUse={onUse} hint={base ? "changed on origin" : undefined} />
      {diverged ? null : (
        <Version side="result" current busy={busy} onUse={onUse}
          parts={base ? mergedParts(base, c.mine, c.theirs, c.result) : attribute(c.result, c.mine, c.theirs)} />
      )}
    </div>
  );
}

// A non-textual decision: the one text involved, to acknowledge.
function Decision({ conflict }) {
  const c = conflict;
  const ours = c.kind === "kept_local_edit" || c.kind === "page_restored";
  const text = ours ? c.mine : c.theirs;
  if (!text) return null;
  return (
    <div className="mergeVersions one">
      <Version side={ours ? "mine" : "theirs"} parts={[{ text, tag: "same" }]} hint={ours ? "kept and pushed back" : "pulled back"} />
    </div>
  );
}

// The card. `onResolve(conflict, choice)` with choice keep | mine | theirs;
// `nav` {index, total, onStep(delta)} walks a page's conflicts (the row
// chip); `onOpen` jumps to the block (the lists); `showPage` names the page.
export function ConflictCard({ conflict, busy, onResolve, nav, onOpen, showPage = false }) {
  const kind = kindOf(conflict);
  const textual = isTextual(conflict);
  const many = nav && nav.total > 1;
  return (
    <div className={`mergeCard kind-${conflict.kind}`}>
      <div className="mergeHead">
        <span className="mergeKindIcon"><kind.Icon size={14} /></span>
        <span className="mergeHeadText">
          <span className="popoverTitle">
            {kind.short}
            {showPage && conflict.page_title ? <span className="mergePage" title={conflict.page_title}> · {conflict.page_title}</span> : null}
          </span>
          <span className="popoverHint">{kind.long}</span>
        </span>
        {many ? (
          <span className="mergeNav" title="The page's conflicts, one by one">
            <button type="button" className="ctlBtn" onClick={() => nav.onStep(-1)} aria-label="Previous conflict"><ChevronLeftIcon size={14} /></button>
            <span className="mergeNavCount">{nav.index} / {nav.total}</span>
            <button type="button" className="ctlBtn" onClick={() => nav.onStep(1)} aria-label="Next conflict"><ChevronRightIcon size={14} /></button>
          </span>
        ) : null}
        {onOpen ? (
          <button type="button" className="uiBtn sm iconSq" onClick={() => onOpen(conflict)} aria-label="Open the block" title="Open the page on this block">
            <ExternalLinkIcon size={13} />
          </button>
        ) : null}
      </div>
      {textual ? <Versions conflict={conflict} busy={busy} onUse={(choice) => onResolve(conflict, choice)} /> : <Decision conflict={conflict} />}
      {textual ? null : (
        <div className="mergeActions">
          <button type="button" className="uiBtn sm primary" disabled={busy} onClick={() => onResolve(conflict, "keep")} title="Mark it seen">
            <CheckIcon size={13} /> OK
          </button>
        </div>
      )}
    </div>
  );
}

// The chip on a block row and its popover. Controlled when `open` +
// `onOpenChange` are given (App walks the page's conflicts through `nav`),
// self-contained otherwise. `onResolve(conflict, choice)`.
export function MergeChip({ conflict, onResolve, open: openProp, onOpenChange, nav }) {
  const [openState, setOpenState] = React.useState(false);
  const controlled = typeof openProp === "boolean" && Boolean(onOpenChange);
  const open = controlled ? openProp : openState;
  const setOpen = controlled ? onOpenChange : setOpenState;
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open, setOpen]);
  const kind = kindOf(conflict);
  async function resolve(c, choice) {
    setBusy(true);
    try { await onResolve(c, choice); } finally { setBusy(false); }
  }
  return (
    <span className="mergeChipWrap" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className={`mergeChip ${open ? "on" : ""}`} title={`${kind.short} — click to resolve`}
        aria-label="Conflict to resolve" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <kind.Icon size={12} />
      </button>
      {open ? (
        <div className="popover mergePopover" role="dialog" aria-label="Merge">
          <ConflictCard conflict={conflict} busy={busy} onResolve={resolve} nav={nav} />
        </div>
      ) : null}
    </span>
  );
}

// Conflict resolution for a clone (docs/dev/mirror.md), in git's words:
// ours is this clone, theirs is origin. One card — ConflictCard — serves
// every surface: the chip on a block row (its popover walks the page's
// conflicts one by one), the sync pill's list and Settings → Workspaces.
// A block both sides edited shows the two versions side by side, each with
// the words the other side lacks highlighted, and under them the text that
// is in the block now (the automatic merge, coloured by who wrote what);
// every version carries its own Use button, the current one a Keep. A
// decision is an ordinary edit the next round pushes.
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

// One side against the other: the tokens of `text` that `other` lacks are
// tagged `tag`, the rest "same" — what this version adds.
export function onlyIn(text, other, tag) {
  const t = tokens(text);
  const m = matched(t, tokens(other));
  return t.map((s, i) => ({ text: s, tag: m[i] ? "same" : tag }));
}

// The sync_conflicts kinds, in git's words (ours = this clone, theirs = origin).
export const MERGE_KIND = {
  merged: { short: "Auto-merged", long: "Both sides changed this block; the two edits were merged into one text.", Icon: MergeIcon },
  diverged: { short: "Diverged", long: "The two versions differed when the clone was attached; one was taken, the other is here.", Icon: AlertCircleIcon },
  kept_local_edit: { short: "Kept ours", long: "Origin deleted this, but it was edited here, so it stayed and was pushed back.", Icon: ArrowUpIcon },
  restored_remote_edit: { short: "Restored theirs", long: "This was deleted here, but origin edited it, so it was pulled back.", Icon: ArrowDownIcon },
  page_restored: { short: "Page restored on origin", long: "Origin deleted this page; it was edited here, so it was pushed back.", Icon: ArrowUpIcon },
  page_restored_from_remote: { short: "Page restored from origin", long: "This page was deleted here but edited on origin, so it was pulled back.", Icon: ArrowDownIcon },
};

export function kindOf(conflict) {
  return MERGE_KIND[conflict.kind] || { short: conflict.kind, long: "", Icon: AlertCircleIcon };
}

// Textual conflicts hold both texts and take a choice; the others are
// decisions to acknowledge.
export function isTextual(conflict) {
  return conflict.kind === "merged" || conflict.kind === "diverged";
}

// The sides: a glyph, a word, where it lives.
const SIDE = {
  mine: { label: "Ours", hint: "this clone", Icon: HardDriveIcon },
  theirs: { label: "Theirs", hint: "origin", Icon: ServerIcon },
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

function Marked({ parts }) {
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
            title={current ? "This is the text in the block now: mark it resolved" : `Put ${word === "merged" ? "the merged text" : `${word} text`} into the block`}>
            {current ? <><CheckIcon size={13} /> Keep</> : "Use"}
          </button>
        ) : null}
      </header>
      <div className="mergeText"><Marked parts={parts} /></div>
    </section>
  );
}

// The versions of a textual conflict: ours and theirs side by side, each
// with what it adds highlighted; for a merge, the merged text under them
// with each side's words coloured. The version that is in the block now
// is marked and offers Keep instead of Use.
function Versions({ conflict, busy, onUse }) {
  const c = conflict;
  const diverged = c.kind === "diverged";
  const mineCurrent = diverged && c.result === c.mine;
  const theirsCurrent = diverged && c.result !== c.mine;
  return (
    <div className={`mergeVersions ${diverged ? "two" : "three"}`}>
      <Version side="mine" parts={onlyIn(c.mine, c.theirs, "mine")} current={mineCurrent} busy={busy} onUse={onUse} />
      <Version side="theirs" parts={onlyIn(c.theirs, c.mine, "theirs")} current={theirsCurrent} busy={busy} onUse={onUse} />
      {diverged ? null : <Version side="result" parts={attribute(c.result, c.mine, c.theirs)} current busy={busy} onUse={onUse} />}
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

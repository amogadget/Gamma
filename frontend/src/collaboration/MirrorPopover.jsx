// The sync pill in the topbar of a clone (docs/dev/mirror.md) and its
// popover, in git's words: the workspace is a clone, the workspace it
// follows on the other server is its origin (the remote), a round pulls
// then pushes. The pill is an icon whose state is drawn on it, like the
// background-tasks button: spinning while a round runs, a badge with the
// count when conflicts wait, a dot — accent for local edits not pushed yet,
// green when up to date, red on a problem — and an unlink glyph when
// detached; the words live in its tooltip and in `data-state`. The popover:
// the clone's name with its origin, a Sync button and a gear in the head,
// the state line (with the progress bars while a round runs and the
// conflicts chip when any wait), and the log — a direction arrow per row,
// its `+3 −1 ~2` block counts, and on click the row's changes block by
// block as a diff (added, removed, changed with a word diff); an arrow
// opens the page. The gear turns the popover into the clone's sync
// settings (settings-kit rows: cadence, push after an edit, direction,
// then force pull / force push, detach / reattach, remove origin). Polls
// /api/mirrors/{ws} every 20 s, every 2 s while a round runs or a local
// edit waits (the page's collab session raises `gamma:local-edit` when it
// queues ops); the log too while open.
import React from "react";
import { API, apiJson, fmtBytes } from "../shared/lib/utils";
import { Row, Segmented, Toggle } from "../settings/SettingsKit";
import { ConflictCard, Marked, useConflicts, wordDiff } from "./MergeResolver";
import {
  ActivityIcon, AlertCircleIcon, ArrowDownIcon, ArrowLeftIcon, ArrowUpDownIcon, ArrowUpIcon, CheckIcon,
  ClockIcon, CloudDownloadIcon, ExternalLinkIcon, HandIcon, HistoryIcon, LinkIcon, PenIcon, RefreshIcon,
  SettingsIcon, TrashIcon, UnlinkIcon, UploadIcon,
} from "../shared/ui/Icons";

// The server's sync_log actions, in git's words.
export const ACTION_TEXT = {
  "pulled": "pulled from remote",
  "pushed": "pushed to remote",
  "created here": "pulled from remote (new page)",
  "created there": "pushed to remote (new page)",
  "deleted here": "deleted on remote — removed here",
  "deleted there": "deleted here — removed on remote",
  "restored here": "restored from remote (edited there after it was deleted here)",
  "restored there": "restored on remote (edited here after it was deleted there)",
  "replaced here": "force-pulled: remote's version replaced this one",
  "replaced there": "force-pushed: this version replaced remote's",
};

const ACTION_ICON = {
  "pulled": ArrowDownIcon, "created here": ArrowDownIcon, "restored here": ArrowDownIcon, "replaced here": ArrowDownIcon,
  "pushed": ArrowUpIcon, "created there": ArrowUpIcon, "restored there": ArrowUpIcon, "replaced there": ArrowUpIcon,
  "deleted here": TrashIcon, "deleted there": TrashIcon,
};

export function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function n(count, word) {
  return `${count || 0} ${word}${count === 1 ? "" : "s"}`;
}

// The git-style block counts of a log row or a round: "+3 −1 ~2" ("" when
// nothing changed). `stats` is {add, del, mod}.
export function diffStat(stats) {
  if (!stats) return "";
  const parts = [];
  if (stats.add) parts.push(`+${stats.add}`);
  if (stats.del) parts.push(`−${stats.del}`);
  if (stats.mod) parts.push(`~${stats.mod}`);
  return parts.join(" ");
}

// The same, coloured like a diff stat.
export function DiffStat({ stats, title }) {
  if (!stats || !(stats.add || stats.del || stats.mod)) return null;
  return (
    <span className="mirrorDiff" title={title || "blocks added · removed · changed"}>
      {stats.add ? <span className="add">+{stats.add}</span> : null}
      {stats.del ? <span className="del">−{stats.del}</span> : null}
      {stats.mod ? <span className="mod">~{stats.mod}</span> : null}
    </span>
  );
}

// A round's block totals from its status.
export function roundBlocks(s) {
  return { add: s.blocks_added || 0, del: s.blocks_removed || 0, mod: s.blocks_changed || 0 };
}

// What the last round moved, as one sentence ("" when nothing moved).
export function roundSummary(s) {
  const parts = [];
  if (s.pages_pulled) parts.push(`${n(s.pages_pulled, "page")} pulled`);
  if (s.pages_pushed) parts.push(`${n(s.pages_pushed, "page")} pushed`);
  if (s.pages_deleted) parts.push(`${n(s.pages_deleted, "page")} removed`);
  const files = (s.files_pulled || 0) + (s.files_pushed || 0);
  if (files) parts.push(n(files, "file"));
  const blocks = diffStat(roundBlocks(s));
  if (blocks) parts.push(`${blocks} blocks`);
  return parts.join(", ");
}

export function isPullOnly(info) {
  return info?.status?.mode === "pull" || info?.mode === "pull";
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ""; }
}

// The clone's state, one reading for the pill, its popover and the
// Settings row: `state` (detached | busy | conflicts | error | new |
// pending | ok), `tone` (the colour), `Icon`, a short `text`, the longer
// `title`; `badge` (a count) or `dot` for the pill; `stats` when up to
// date; `detail` (the page being worked) while a round runs. `pending`
// adds local edits the client knows about before the server does.
export function mirrorState(info, { busy = false, pending = false } = {}) {
  const s = info?.status || {};
  const p = s.progress;
  if (info?.detached || info?.mode === "off") {
    return { state: "detached", tone: "", Icon: UnlinkIcon, text: `Detached${s.detached_at ? ` · ${clock(s.detached_at)}` : ""}`,
      title: "Detached: nothing is pulled or pushed until you reattach. Nothing is lost." };
  }
  if (s.running || busy) {
    return { state: "busy", tone: "busy", Icon: RefreshIcon,
      text: `${p?.first ? "Cloning" : "Syncing"}${p?.total ? ` ${p.done} / ${p.total}` : "…"}`,
      detail: p?.page || "", title: "A round is running" };
  }
  if (info?.conflicts_open) {
    return { state: "conflicts", tone: "warn", Icon: RefreshIcon, badge: info.conflicts_open,
      text: n(info.conflicts_open, "conflict"), title: "Blocks both sides changed wait for a decision" };
  }
  if (s.last_error) {
    const unreachable = /cannot reach|timed out|refused|unreachable/i.test(s.last_error);
    return { state: "error", tone: "error", Icon: AlertCircleIcon, dot: true,
      text: `${unreachable ? "Remote unreachable" : "Sync problem"}${s.last_attempt || s.last_sync ? ` · ${clock(s.last_attempt || s.last_sync)}` : ""}`,
      title: `${s.last_error}${unreachable ? " — your edits stay here and are pushed once the remote is reachable again." : ""}` };
  }
  if (!s.last_sync) {
    return { state: "new", tone: "", Icon: CloudDownloadIcon, text: s.interrupted ? "Interrupted · resuming" : "Not cloned yet",
      title: s.interrupted ? "The clone was interrupted; it continues in a moment." : "The clone starts in a moment." };
  }
  if (info?.pending_local || pending) {
    // with sync-after-edit on, a round follows within a second: the icon
    // spins from the edit until the round is confirmed done, so a round too
    // short for a poll to catch still reads as "syncing"
    if (info?.on_change) {
      return { state: "busy", tone: "busy", Icon: RefreshIcon, text: "Syncing your edits…", title: "A round follows every edit; your changes are on their way." };
    }
    return { state: "pending", tone: "pending", Icon: RefreshIcon, dot: true, text: "Local edits not synced yet",
      title: "Press Sync to send them, or wait for the next automatic round." };
  }
  const moved = roundSummary(s);
  return { state: "ok", tone: "ok", Icon: RefreshIcon, dot: true, text: `Up to date · ${clock(s.last_sync)}`, stats: roundBlocks(s),
    title: `Up to date since ${clock(s.last_sync)}. Last round: ${moved || "nothing had changed on either side"}.${info?.poll_s ? ` The remote is checked every ${info.poll_s} s.` : " The remote is checked only when you sync."}` };
}

// The choices the sync settings offer, shared with Settings' clone dialog.
export const CADENCE = [
  [5, "Live", ActivityIcon, "Sync every 5 seconds"],
  [30, "30 s", null, "Sync every 30 seconds"],
  [300, "5 min", null, "Sync every five minutes"],
  [0, "Manual", HandIcon, "Only when you press Sync"],
];
export const DIRECTION = [
  ["two-way", "Two-way", ArrowUpDownIcon, "Your changes go to the remote and the remote's arrive here"],
  ["pull", "Receive only", ArrowDownIcon, "The remote's changes arrive here; yours stay here until you switch back to two-way"],
];

// The progress bars of a running round: the pages, then the file in flight.
export function Progress({ progress: p }) {
  if (!p) return null;
  const f = p.file;
  return (
    <>
      {p.total ? <div className="mirrorBar"><span style={{ width: `${Math.round((100 * p.done) / p.total)}%` }} /></div> : null}
      {f ? (
        <div className="mirrorFile" title={f.dir === "up" ? "Pushing to the remote" : "Pulling from the remote"}>
          {f.dir === "up" ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
          <span className="mirrorEllipsis">{f.name}</span>
          <span className="mirrorFileBytes">{fmtBytes(f.done)}{f.total ? ` / ${fmtBytes(f.total)}` : ""}</span>
          {f.total ? <div className="mirrorBar thin"><span style={{ width: `${Math.round((100 * f.done) / f.total)}%` }} /></div> : null}
        </div>
      ) : null}
    </>
  );
}

// The state block: an icon, a short line, the bars while a round runs, the
// conflicts chip when any wait.
function StateBlock({ info, busy, pending, onConflicts }) {
  const st = mirrorState(info, { busy, pending });
  const p = info?.status?.progress;
  return (
    <div className={`mirrorState ${st.tone}`} title={st.title}>
      <st.Icon size={14} />
      <div className="mirrorStateBody">
        <div className="mirrorStateLine">
          <span>{st.text}</span>
          {st.detail ? <span className="popoverHint mirrorEllipsis" title={st.detail}>{st.detail}</span> : null}
          {st.stats ? <DiffStat stats={st.stats} title="Last round: blocks added · removed · changed" /> : null}
          {info?.conflicts_open && st.state !== "conflicts" ? (
            <button className="uiBtn sm mirrorConflictBtn" onClick={onConflicts} title="Blocks both sides changed: resolve them here, or open each on its block">
              <AlertCircleIcon size={13} /> {n(info.conflicts_open, "conflict")}
            </button>
          ) : null}
          {st.state === "conflicts" ? (
            <button className="uiBtn sm primary" onClick={onConflicts} title="Resolve them here, or open each on its block">Resolve</button>
          ) : null}
        </div>
        {st.tone === "busy" ? <Progress progress={p} /> : null}
      </div>
    </div>
  );
}

// Force pull / force push / remove origin ask once, inline: a warning line
// with Yes / No.
function Confirm({ what, busy, onYes, onNo }) {
  const text = what === "pull" ? "Force pull: make this clone identical to the remote? Where texts differ, local ones are kept as conflicts."
    : what === "push" ? "Force push: make the remote identical to this clone? Where texts differ, remote ones are kept as conflicts."
      : "Remove origin? The workspace stays; it never syncs again.";
  return (
    <div className="mirrorConfirm">
      <AlertCircleIcon size={14} />
      <span>{text}</span>
      <span className="mirrorConfirmBtns">
        <button className="uiBtn sm danger" disabled={busy} onClick={onYes}>Yes</button>
        <button className="uiBtn sm" disabled={busy} onClick={onNo}>No</button>
      </span>
    </div>
  );
}

function SettingsView({ info, wsId, onBack, reload, onOpenSettings }) {
  const [confirm, setConfirm] = React.useState(null); // "pull" | "push" | "forget" | null
  const [busy, setBusy] = React.useState(false);
  const detached = info?.detached;
  const pull = isPullOnly(info);
  async function call(path, init, body) {
    setBusy(true);
    try {
      await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}${path}`, {
        method: init, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      });
    } catch {}
    setBusy(false);
    setConfirm(null);
    if (init === "DELETE") { window.dispatchEvent(new CustomEvent("gamma:mirror-gone")); return; }
    reload();
    window.dispatchEvent(new CustomEvent("gamma:mirror"));
  }
  return (
    <>
      <div className="mirrorPopHead">
        <button className="iconBtn sm" onClick={onBack} title="Back" aria-label="Back"><ArrowLeftIcon size={14} /></button>
        <span className="popoverTitle">Sync settings</span>
      </div>
      <Row icon={ClockIcon} label="Automatic sync" hint="how often the remote is checked"
        title="A sync round every so often. Live: every 5 s. Manual: only when you press Sync.">
        <Segmented value={info?.poll_s ?? 30} onChange={(v) => call("", "PATCH", { poll_s: v })} options={CADENCE} />
      </Row>
      <Toggle icon={PenIcon} checked={Boolean(info?.on_change)} disabled={busy} onChange={(v) => call("", "PATCH", { on_change: v })}
        label="Sync after an edit" hint="a round about a second after you change something" />
      <Row icon={ArrowUpDownIcon} label="Direction"
        title="Two-way: your changes go to the remote. Receive only: the remote's changes arrive, yours stay here until you switch back.">
        <Segmented value={pull ? "pull" : "two-way"} onChange={(v) => call("", "PATCH", { mode: v })} options={DIRECTION} />
      </Row>
      <div className="popoverDivider" />
      {confirm ? (
        <Confirm what={confirm} busy={busy} onNo={() => setConfirm(null)}
          onYes={() => confirm === "forget" ? call("", "DELETE") : call("/force", "POST", { direction: confirm })} />
      ) : (
        <div className="mirrorSetActions">
          {!detached ? <>
            <button className="uiBtn sm" disabled={busy} onClick={() => setConfirm("pull")} title="Make this clone identical to the remote (only differing pages are written)">
              <CloudDownloadIcon size={13} /> Force pull
            </button>
            <button className="uiBtn sm" disabled={busy || pull} onClick={() => setConfirm("push")} title={pull ? "A receive-only clone cannot force push" : "Make the remote identical to this clone (only differing pages are written)"}>
              <UploadIcon size={13} /> Force push
            </button>
            <button className="uiBtn sm" disabled={busy} onClick={() => call("/detach", "POST")} title="Stop pulling and pushing for now; reattach later and both sides merge">
              <UnlinkIcon size={13} /> Detach
            </button>
          </> : (
            <button className="uiBtn sm primary" disabled={busy} onClick={() => call("/relink", "POST", {})} title="Follow the remote again; what both sides did meanwhile merges">
              <LinkIcon size={13} /> Reattach
            </button>
          )}
          <button className="uiBtn sm danger" disabled={busy} onClick={() => setConfirm("forget")} title="Forget the origin for good; the workspace stays as an ordinary one">
            <TrashIcon size={13} /> Remove origin
          </button>
        </div>
      )}
      <button className="popoverItem mirrorMore" onClick={onOpenSettings}><SettingsIcon size={13} /> All clones in Settings</button>
    </>
  );
}

// The conflicts, each a card resolved here or opened on its block.
function ReviewView({ wsId, onBack, jumpTo }) {
  const [items, busy, resolve] = useConflicts(wsId);
  return (
    <>
      <div className="mirrorPopHead">
        <button className="iconBtn sm" onClick={onBack} title="Back" aria-label="Back"><ArrowLeftIcon size={14} /></button>
        <span className="popoverTitle">Conflicts</span>
        {items?.length ? <span className="popoverHint">{items.length}</span> : null}
      </div>
      {items === null ? <div className="popoverHint">Loading…</div>
        : items.length ? (
          <div className="mirrorCards">
            {items.map((c) => (
              <ConflictCard key={c.id} conflict={c} busy={busy} showPage onResolve={resolve} onOpen={() => jumpTo(c.page_id, c.block_id)} />
            ))}
          </div>
        ) : <div className="mirrorState ok"><CheckIcon size={14} /><span>No conflicts — every change merged cleanly.</span></div>}
    </>
  );
}

const CHANGE_GLYPH = { add: "+", del: "−", mod: "~", move: "↕", props: "·" };
const CHANGE_TITLE = {
  add: "block added", del: "block removed", mod: "text changed", move: "block moved", props: "properties changed",
};

// A log row's changes, block by block, as a diff: added and removed blocks
// tinted, a changed block as a word diff of old → new.
export function ChangeList({ changes }) {
  return (
    <ul className="mirrorChanges">
      {changes.map((c, i) => (
        <li key={i} className={`mirrorChange ${c.k}`} title={CHANGE_TITLE[c.k] || c.k}>
          <span className="mirrorChangeGlyph">{CHANGE_GLYPH[c.k] || "·"}</span>
          <span className="mirrorChangeText">
            {c.k === "mod" ? <Marked parts={wordDiff(c.old, c.text)} /> : c.text || <i>(empty)</i>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The log: one row per page a round touched; click a row for its changes,
// the arrow opens the page.
function LogList({ log, jumpTo }) {
  const [openId, setOpenId] = React.useState(null);
  return (
    <ul className="mirrorPopLog">
      {log.map((c) => {
        const Icon = ACTION_ICON[c.action] || RefreshIcon;
        const open = openId === c.id;
        return (
          <li key={c.id} className={open ? "open" : ""}>
            <div className="mirrorPopItemRow">
              <button className="popoverItem mirrorPopItem" aria-expanded={open} onClick={() => setOpenId(open ? null : c.id)}
                title={`${ACTION_TEXT[c.action] || c.action} — click for the changes`}>
                <span className="mirrorPopItemTitle"><Icon size={12} /> {c.title || c.page_id}</span>
                <span className="mirrorPopItemMeta">{clock(c.at)}<DiffStat stats={c.stats} /></span>
              </button>
              <button className="ctlBtn mirrorPopOpen" disabled={!c.exists} onClick={() => jumpTo(c.page_id)}
                aria-label="Open the page" title={c.exists ? "Open the page" : "The page is gone"}>
                <ExternalLinkIcon size={13} />
              </button>
            </div>
            {open ? (c.changes?.length ? <ChangeList changes={c.changes} /> : <div className="popoverHint mirrorChangesNone">No block-level detail for this row.</div>) : null}
          </li>
        );
      })}
    </ul>
  );
}

const PENDING_GRACE_MS = 6000; // how long a local edit counts as pending before the server confirms it

export function MirrorPopover({ wsId, mirrorOf, open, onToggle, jumpTo, onOpenSettings }) {
  const [info, setInfo] = React.useState(null);
  const [log, setLog] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [view, setView] = React.useState("main");
  // A local edit the page's session just queued: pending until a poll
  // (after the grace) says the server pushed it.
  const [editAt, setEditAt] = React.useState(0);
  // A round that ran on its own (the loop, an edit) changes the numbers:
  // the page's merge chips (App) hear about it through "gamma:mirror-changed".
  const seenRef = React.useRef("");
  const load = React.useCallback(async () => {
    try {
      const next = await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}`);
      setInfo(next);
      if (!next.pending_local && !next.status?.running) {
        setEditAt((at) => (at && Date.now() - at >= PENDING_GRACE_MS ? 0 : at));
      }
      const mark = `${next.conflicts_open}|${next.status?.last_sync || ""}`;
      if (seenRef.current && seenRef.current !== mark) window.dispatchEvent(new CustomEvent("gamma:mirror-changed"));
      seenRef.current = mark;
    } catch {}
  }, [wsId]);
  const loadLog = React.useCallback(async () => {
    try { setLog((await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/log?limit=20`)).changes || []); } catch { setLog([]); }
  }, [wsId]);
  const running = Boolean(info?.status?.running) || busy;
  const pending = Boolean(editAt) || Boolean(info?.pending_local);
  React.useEffect(() => {
    load();
    const t = setInterval(load, running || pending ? 2000 : 20000);
    return () => clearInterval(t);
  }, [load, running, pending]);
  React.useEffect(() => { if (open) { setView("main"); load(); loadLog(); } }, [open, load, loadLog]);
  const lastSync = info?.status?.last_sync;
  React.useEffect(() => { if (open) loadLog(); }, [open, loadLog, lastSync]);
  React.useEffect(() => {
    if (!open || !running) return undefined;
    const t = setInterval(loadLog, 3000);
    return () => clearInterval(t);
  }, [open, running, loadLog]);
  // Other surfaces (Settings, the row chips) change the mirror too; the
  // page's session says when it queued a local edit.
  React.useEffect(() => {
    const h = () => { load(); if (open) loadLog(); };
    const edited = () => setEditAt(Date.now());
    window.addEventListener("gamma:mirror", h);
    window.addEventListener("gamma:local-edit", edited);
    return () => { window.removeEventListener("gamma:mirror", h); window.removeEventListener("gamma:local-edit", edited); };
  }, [load, loadLog, open]);

  async function syncNow() {
    setBusy(true);
    setInfo((prev) => prev ? { ...prev, status: { ...prev.status, running: true } } : prev);
    try {
      await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/sync?wait=1`, { method: "POST" });
    } catch {}
    setEditAt(0);
    await load();
    await loadLog();
    setBusy(false);
    window.dispatchEvent(new CustomEvent("gamma:mirror"));
  }

  const st = mirrorState(info, { busy, pending: Boolean(editAt) });
  const s = info?.status || {};
  const host = hostOf(info?.remote_url);
  const pull = isPullOnly(info);

  return (
    <span data-popover="mirror" className="popoverAnchor">
      <button
        className={`iconBtn mirrorPill ${st.tone} ${open ? "activeIcon" : ""}`}
        data-state={st.state}
        onClick={onToggle}
        title={`Clone of ${mirrorOf}${host ? ` on ${host}` : ""} — ${st.text}`}
        aria-label="Sync status"
      >
        <st.Icon size={15} />
        {st.badge ? <span className={`mirrorPillBadge ${st.tone}`}>{st.badge}</span>
          : st.dot ? <span className={`mirrorPillDot ${st.tone}`} /> : null}
      </button>
      {open ? (
        <div className="popover mirrorPopover" role="dialog" aria-label="Sync status">
          {view === "settings" ? <SettingsView info={info} wsId={wsId} onBack={() => setView("main")} reload={load} onOpenSettings={onOpenSettings} />
            : view === "review" ? <ReviewView wsId={wsId} onBack={() => setView("main")} jumpTo={jumpTo} />
            : (
              <>
                <div className="mirrorPopHead">
                  <span className="mirrorPopIcon" title={pull ? "Receive only: the remote's changes arrive here, yours stay here" : "Two-way: your changes go to the remote, the remote's arrive here"}>
                    {pull ? <ArrowDownIcon size={15} /> : <ArrowUpDownIcon size={15} />}
                  </span>
                  <span className="mirrorPopTitle">
                    <span className="popoverTitle mirrorEllipsis">{mirrorOf}</span>
                    <span className="popoverHint mirrorEllipsis" title={info?.remote_url}>remote · {host}{s.remote_user ? ` · ${s.remote_user}` : ""}</span>
                  </span>
                  <span className="mirrorPopBtns">
                    <button className={`iconBtn sm ${running ? "mirrorSpin" : ""}`} disabled={running || info?.detached} onClick={syncNow} aria-label="Sync"
                      title={running ? "A round is running" : info?.detached ? "Detached — reattach in the sync settings" : pull ? "Receive the remote's changes now" : "Sync now"}>
                      <RefreshIcon size={14} />
                    </button>
                    <button className="iconBtn sm" onClick={() => setView("settings")} title="Sync settings" aria-label="Sync settings"><SettingsIcon size={14} /></button>
                  </span>
                </div>
                <StateBlock info={info} busy={busy} pending={Boolean(editAt)} onConflicts={() => setView("review")} />
                <div className="popoverLabel"><HistoryIcon size={12} /><span>Log</span></div>
                {log === null ? <div className="popoverHint">Loading…</div>
                  : log.length ? <LogList log={log} jumpTo={jumpTo} />
                  : <div className="popoverHint">{running ? "Pages show up here as they are pulled." : s.last_sync ? "Nothing pulled or pushed yet." : "Nothing cloned yet."}</div>}
              </>
            )}
        </div>
      ) : null}
    </span>
  );
}

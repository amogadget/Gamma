// The sync pill in the topbar of a clone (docs/dev/mirror.md) and its
// popover, in git's words: the workspace is a clone, the workspace it
// follows on the other server is its origin, a round pulls then pushes.
// The pill is the shortest true thing about the clone — up to date since
// when, cloning N/M, a problem, N conflicts. The popover is built from
// icons and numbers, words only as tooltips: the state with its progress
// bars (pages, then the file in flight with its bytes), Pull & push, the
// conflicts (→ the same cards the row chips show, resolved in place or
// opened on their block), the log with a direction arrow per row, and a
// gear that turns the popover into the clone's sync settings — settings-kit
// rows for the cadence, push-after-edit and direction, then force pull /
// force push, detach / reattach, remove origin. Polls /api/mirrors/{ws}
// every 20 s, every 2 s while a round runs; the log too while open.
import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { Row, Segmented, Toggle } from "../settings/SettingsKit";
import { ConflictCard } from "./MergeResolver";
import {
  ActivityIcon, AlertCircleIcon, ArrowDownIcon, ArrowLeftIcon, ArrowUpDownIcon, ArrowUpIcon, CheckIcon,
  ClockIcon, CloudDownloadIcon, HandIcon, HistoryIcon, LinkIcon, PenIcon, RefreshIcon, SettingsIcon, TrashIcon,
  UnlinkIcon, UploadIcon,
} from "../shared/ui/Icons";

// The server's sync_log actions, in git's words.
export const ACTION_TEXT = {
  "pulled": "pulled from origin",
  "pushed": "pushed to origin",
  "created here": "pulled from origin (new page)",
  "created there": "pushed to origin (new page)",
  "deleted here": "deleted on origin — removed here",
  "deleted there": "deleted here — removed on origin",
  "restored here": "restored from origin (edited there after it was deleted here)",
  "restored there": "restored on origin (edited here after it was deleted there)",
  "replaced here": "force-pulled: origin's version replaced this one",
  "replaced there": "force-pushed: this version replaced origin's",
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

export function bytes(b) {
  if (!b && b !== 0) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
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

// The pill's text: the shortest true thing about the clone.
export function mirrorGlance(info) {
  const s = info?.status || {};
  const p = s.progress;
  if (info?.detached) return { text: "detached", tone: "" };
  if (s.running) {
    if (p && p.total) return { text: `${p.first ? "cloning" : "syncing"} ${p.done}/${p.total}`, tone: "busy" };
    return { text: "syncing…", tone: "busy" };
  }
  if (info?.conflicts_open) return { text: n(info.conflicts_open, "conflict"), tone: "warn" };
  if (s.last_error) return { text: "sync problem", tone: "warn" };
  if (!s.last_sync) return { text: "not cloned yet", tone: "" };
  return { text: `up to date ${clock(s.last_sync)}`, tone: "ok" };
}

export function isPullOnly(info) {
  return info?.status?.mode === "pull" || info?.mode === "pull";
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ""; }
}

// The choices the sync settings offer, shared with Settings' clone dialog.
export const CADENCE = [
  [5, "Live", ActivityIcon, "Check origin every 5 seconds"],
  [30, "30 s", null, "Check origin every 30 seconds"],
  [300, "5 min", null, "Check origin every five minutes"],
  [0, "Manual", HandIcon, "Only when you pull"],
];
export const DIRECTION = [
  ["two-way", "Pull & push", ArrowUpDownIcon, "Your changes go to origin, origin's arrive here"],
  ["pull", "Pull only", ArrowDownIcon, "Origin's changes arrive here; yours stay here"],
];

// The progress bars of a running round: the pages, then the file in flight.
export function Progress({ progress: p }) {
  if (!p) return null;
  const f = p.file;
  return (
    <>
      {p.total ? <div className="mirrorBar"><span style={{ width: `${Math.round((100 * p.done) / p.total)}%` }} /></div> : null}
      {f ? (
        <div className="mirrorFile" title={f.dir === "up" ? "Pushing to origin" : "Pulling from origin"}>
          {f.dir === "up" ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
          <span className="mirrorEllipsis">{f.name}</span>
          <span className="mirrorFileBytes">{bytes(f.done)}{f.total ? ` / ${bytes(f.total)}` : ""}</span>
          {f.total ? <div className="mirrorBar thin"><span style={{ width: `${Math.round((100 * f.done) / f.total)}%` }} /></div> : null}
        </div>
      ) : null}
    </>
  );
}

// The clone's state as an icon, a tone and a short line (the pill's popover
// and the Settings row agree on it). `title` is the longer story.
export function mirrorState(info, busy = false) {
  const s = info?.status || {};
  const p = s.progress;
  if (info?.detached || info?.mode === "off") {
    return { tone: "", Icon: UnlinkIcon, text: `Detached${s.detached_at ? ` · ${clock(s.detached_at)}` : ""}`,
      title: "Detached: nothing is pulled or pushed until you reattach. Nothing is lost." };
  }
  if (s.running || busy) {
    return { tone: "busy", Icon: RefreshIcon, text: `${p?.first ? "Cloning" : "Syncing"}${p?.total ? ` ${p.done} / ${p.total}` : "…"}`,
      detail: p?.page || "", title: "A round is running" };
  }
  if (s.last_error) {
    const unreachable = /cannot reach|timed out|refused|unreachable/i.test(s.last_error);
    return { tone: "warn", Icon: AlertCircleIcon,
      text: `${unreachable ? "Origin unreachable" : "Sync problem"}${s.last_attempt || s.last_sync ? ` · ${clock(s.last_attempt || s.last_sync)}` : ""}`,
      title: `${s.last_error}${unreachable ? " — your edits stay here and are pushed once origin is reachable again." : ""}` };
  }
  if (!s.last_sync) {
    return { tone: "", Icon: CloudDownloadIcon, text: s.interrupted ? "Interrupted · resuming" : "Not cloned yet",
      title: s.interrupted ? "The clone was interrupted; it continues in a moment." : "The clone starts in a moment." };
  }
  const moved = roundSummary(s);
  return { tone: "ok", Icon: CheckIcon, text: `Up to date · ${clock(s.last_sync)}`, stats: roundBlocks(s),
    title: `Last round: ${moved || "nothing had changed on either side"}.${info?.poll_s ? ` Origin is checked every ${info.poll_s} s.` : " Origin is checked only when you pull."}` };
}

// The state block: an icon, a short line, the bars while a round runs.
function StateBlock({ info, busy }) {
  const st = mirrorState(info, busy);
  const p = info?.status?.progress;
  return (
    <div className={`mirrorState ${st.tone}`} title={st.title}>
      <st.Icon size={14} />
      <div className="mirrorStateBody">
        <div className="mirrorStateLine">
          <span>{st.text}</span>
          {st.detail ? <span className="popoverHint mirrorEllipsis" title={st.detail}>{st.detail}</span> : null}
          {st.stats ? <DiffStat stats={st.stats} title="Last round: blocks added · removed · changed" /> : null}
        </div>
        {st.tone === "busy" ? <Progress progress={p} /> : null}
      </div>
    </div>
  );
}

// Force pull / force push / remove origin ask once, inline: a warning line
// with Yes / No.
function Confirm({ what, busy, onYes, onNo }) {
  const text = what === "pull" ? "Force pull: make this clone identical to origin? Where texts differ, yours are kept as conflicts."
    : what === "push" ? "Force push: make origin identical to this clone? Where texts differ, origin's are kept as conflicts."
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
      <Row icon={ClockIcon} label="Check origin" hint="a pull, then a push"
        title="How often origin is checked for changes. Live: every 5 s. Manual: only when you pull.">
        <Segmented value={info?.poll_s ?? 30} onChange={(v) => call("", "PATCH", { poll_s: v })} options={CADENCE} />
      </Row>
      <Toggle icon={PenIcon} checked={Boolean(info?.on_change)} disabled={busy} onChange={(v) => call("", "PATCH", { on_change: v })}
        label="Push after an edit" hint="a round a few seconds after you change something" />
      <Row icon={ArrowUpDownIcon} label="Direction"
        title="Pull & push: your changes go to origin. Pull only: origin's changes arrive, yours stay here.">
        <Segmented value={pull ? "pull" : "two-way"} onChange={(v) => call("", "PATCH", { mode: v })} options={DIRECTION} />
      </Row>
      <div className="popoverDivider" />
      {confirm ? (
        <Confirm what={confirm} busy={busy} onNo={() => setConfirm(null)}
          onYes={() => confirm === "forget" ? call("", "DELETE") : call("/force", "POST", { direction: confirm })} />
      ) : (
        <div className="mirrorSetActions">
          {!detached ? <>
            <button className="uiBtn sm" disabled={busy} onClick={() => setConfirm("pull")} title="Make this clone identical to origin (only differing pages are written)">
              <CloudDownloadIcon size={13} /> Force pull
            </button>
            <button className="uiBtn sm" disabled={busy || pull} onClick={() => setConfirm("push")} title={pull ? "A pull-only clone cannot force push" : "Make origin identical to this clone (only differing pages are written)"}>
              <UploadIcon size={13} /> Force push
            </button>
            <button className="uiBtn sm" disabled={busy} onClick={() => call("/detach", "POST")} title="Stop pulling and pushing for now; reattach later and both sides merge">
              <UnlinkIcon size={13} /> Detach
            </button>
          </> : (
            <button className="uiBtn sm primary" disabled={busy} onClick={() => call("/relink", "POST", {})} title="Follow origin again; what both sides did meanwhile merges">
              <LinkIcon size={13} /> Reattach
            </button>
          )}
          <button className="uiBtn sm danger" disabled={busy} onClick={() => setConfirm("forget")} title="Forget origin for good; the workspace stays as an ordinary one">
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
  const [items, setItems] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/conflicts`).then((d) => setItems(d.conflicts || [])).catch(() => setItems([]));
  }, [wsId]);
  async function resolve(c, choice) {
    setBusy(true);
    try {
      await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/conflicts/${c.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }),
      });
      setItems((prev) => (prev || []).filter((x) => x.id !== c.id));
    } catch {}
    setBusy(false);
    window.dispatchEvent(new CustomEvent("gamma:mirror"));
  }
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

export function MirrorPopover({ wsId, mirrorOf, open, onToggle, jumpTo, onOpenSettings }) {
  const [info, setInfo] = React.useState(null);
  const [log, setLog] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [view, setView] = React.useState("main");
  // A round that ran on its own (the loop, an edit) changes the numbers:
  // the page's merge chips (App) hear about it through "gamma:mirror-changed".
  const seenRef = React.useRef("");
  const load = React.useCallback(async () => {
    try {
      const next = await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}`);
      setInfo(next);
      const mark = `${next.conflicts_open}|${next.status?.last_sync || ""}`;
      if (seenRef.current && seenRef.current !== mark) window.dispatchEvent(new CustomEvent("gamma:mirror-changed"));
      seenRef.current = mark;
    } catch {}
  }, [wsId]);
  const loadLog = React.useCallback(async () => {
    try { setLog((await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/log?limit=20`)).changes || []); } catch { setLog([]); }
  }, [wsId]);
  const running = Boolean(info?.status?.running) || busy;
  React.useEffect(() => {
    load();
    const t = setInterval(load, running ? 2000 : 20000);
    return () => clearInterval(t);
  }, [load, running]);
  React.useEffect(() => { if (open) { setView("main"); load(); loadLog(); } }, [open, load, loadLog]);
  const lastSync = info?.status?.last_sync;
  React.useEffect(() => { if (open) loadLog(); }, [open, loadLog, lastSync]);
  React.useEffect(() => {
    if (!open || !running) return undefined;
    const t = setInterval(loadLog, 3000);
    return () => clearInterval(t);
  }, [open, running, loadLog]);
  // Other surfaces (Settings, the row chips) change the mirror too.
  React.useEffect(() => {
    const h = () => { load(); if (open) loadLog(); };
    window.addEventListener("gamma:mirror", h);
    return () => window.removeEventListener("gamma:mirror", h);
  }, [load, loadLog, open]);

  async function syncNow() {
    setBusy(true);
    setInfo((prev) => prev ? { ...prev, status: { ...prev.status, running: true } } : prev);
    try {
      await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/sync?wait=1`, { method: "POST" });
    } catch {}
    await load();
    await loadLog();
    setBusy(false);
    window.dispatchEvent(new CustomEvent("gamma:mirror"));
  }

  const glance = mirrorGlance(info);
  const s = info?.status || {};
  const host = hostOf(info?.remote_url);
  const pull = isPullOnly(info);
  const PillIcon = glance.tone === "warn" ? AlertCircleIcon : info?.detached ? UnlinkIcon : RefreshIcon;

  return (
    <span data-popover="mirror" className="popoverAnchor">
      <button
        className={`iconBtn mirrorPill ${glance.tone} ${open ? "activeIcon" : ""}`}
        onClick={onToggle}
        title={`Clone of ${mirrorOf}${host ? ` on ${host}` : ""} — ${glance.text}`}
        aria-label="Sync status"
      >
        <PillIcon size={15} />
        <span className="mirrorPillText">{glance.text}</span>
      </button>
      {open ? (
        <div className="popover mirrorPopover" role="dialog" aria-label="Sync status">
          {view === "settings" ? <SettingsView info={info} wsId={wsId} onBack={() => setView("main")} reload={load} onOpenSettings={onOpenSettings} />
            : view === "review" ? <ReviewView wsId={wsId} onBack={() => setView("main")} jumpTo={jumpTo} />
            : (
              <>
                <div className="mirrorPopHead">
                  <span className="mirrorPopIcon" title={pull ? "Pull only: origin's changes arrive here, yours stay here" : "Pull & push: your changes go to origin, origin's arrive here"}>
                    {pull ? <ArrowDownIcon size={15} /> : <ArrowUpDownIcon size={15} />}
                  </span>
                  <span className="mirrorPopTitle">
                    <span className="popoverTitle mirrorEllipsis">{mirrorOf}</span>
                    <span className="popoverHint mirrorEllipsis" title={info?.remote_url}>origin · {host}{s.remote_user ? ` · ${s.remote_user}` : ""}</span>
                  </span>
                  <button className="iconBtn sm" onClick={() => setView("settings")} title="Sync settings" aria-label="Sync settings"><SettingsIcon size={14} /></button>
                </div>
                <StateBlock info={info} busy={busy} />
                <div className="mirrorPopActions">
                  <button className="uiBtn sm" disabled={running || info?.detached} onClick={syncNow}
                    title={running ? "A round is running" : info?.detached ? "Detached — reattach in the sync settings" : pull ? "Pull origin's changes now" : "Pull origin's changes, then push yours"}>
                    <RefreshIcon size={13} /> {pull ? "Pull" : "Pull & push"}
                  </button>
                  {info?.conflicts_open ? (
                    <button className="uiBtn sm primary" onClick={() => setView("review")} title="Blocks both sides changed: resolve them here, or open each on its block">
                      <AlertCircleIcon size={13} /> {n(info.conflicts_open, "conflict")}
                    </button>
                  ) : null}
                </div>
                <div className="popoverLabel"><HistoryIcon size={12} /><span>Log</span></div>
                {log === null ? <div className="popoverHint">Loading…</div>
                  : log.length ? (
                    <ul className="mirrorPopLog">
                      {log.map((c) => {
                        const Icon = ACTION_ICON[c.action] || RefreshIcon;
                        return (
                          <li key={c.id}>
                            <button className="popoverItem mirrorPopItem" disabled={!c.exists} onClick={() => c.exists && jumpTo(c.page_id)}
                              title={`${ACTION_TEXT[c.action] || c.action}${c.exists ? "" : " (the page is gone)"}`}>
                              <span className="mirrorPopItemTitle"><Icon size={12} /> {c.title || c.page_id}</span>
                              <span className="mirrorPopItemMeta">{clock(c.at)}<DiffStat stats={c.stats} /></span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : <div className="popoverHint">{running ? "Pages show up here as they are pulled." : s.last_sync ? "Nothing pulled or pushed yet." : "Nothing cloned yet."}</div>}
              </>
            )}
        </div>
      ) : null}
    </span>
  );
}

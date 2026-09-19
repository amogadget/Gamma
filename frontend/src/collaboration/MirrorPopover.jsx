// The sync pill in the topbar of an offline copy (docs/dev/mirror.md): a
// glance at the mirror's state — up to date since when, copying N of M
// pages, a problem, merges to review — and, on click, a popover that says
// in plain words what the copy is doing right now, what the last round
// did, Sync now, Review merges (→ Settings → Workspaces) and the recent
// changes page by page (click one to open it). Reads /api/mirrors/{ws}
// every 20 s while the workspace is open, every 2 s while a round runs, and
// the log while the popover is open.
import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { AlertCircleIcon, CheckIcon, RefreshIcon, SettingsIcon } from "../shared/ui/Icons";

const ACTION_TEXT = {
  "pulled": "updated from the original",
  "pushed": "sent to the original",
  "created here": "arrived from the original",
  "created there": "sent to the original (new page)",
  "deleted here": "removed here (deleted on the original)",
  "deleted there": "deleted on the original (removed here)",
  "restored here": "came back from the original",
  "restored there": "put back on the original",
};

function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function n(count, word) {
  return `${count || 0} ${word}${count === 1 ? "" : "s"}`;
}

// What the last round moved, as one sentence ("" when nothing moved).
export function roundSummary(s) {
  const parts = [];
  if (s.pages_pulled) parts.push(`${n(s.pages_pulled, "page")} arrived`);
  if (s.pages_pushed) parts.push(`${n(s.pages_pushed, "page")} sent`);
  if (s.pages_deleted) parts.push(`${n(s.pages_deleted, "page")} removed`);
  const files = (s.files_pulled || 0) + (s.files_pushed || 0);
  if (files) parts.push(n(files, "file"));
  return parts.join(", ");
}

// The pill's text: the shortest true thing about the copy.
export function mirrorGlance(info) {
  const s = info?.status || {};
  const p = s.progress;
  if (s.running) {
    if (p && p.total) return { text: `${p.first ? "copying" : "syncing"} ${p.done}/${p.total}`, tone: "busy" };
    return { text: "syncing…", tone: "busy" };
  }
  if (info?.conflicts_open) return { text: `${info.conflicts_open} to review`, tone: "warn" };
  if (s.last_error) return { text: "sync problem", tone: "warn" };
  if (!s.last_sync) return { text: "not copied yet", tone: "" };
  return { text: `up to date ${clock(s.last_sync)}`, tone: "ok" };
}

// The popover's state block: a headline and one line of explanation.
function StateLine({ s, busy, intervalS }) {
  const p = s.progress;
  if (s.running || busy) {
    const what = p?.first ? "Making the first copy" : "Syncing";
    return (
      <div className="mirrorPopState busy">
        <RefreshIcon size={14} />
        <div className="mirrorPopStateText">
          <div>{what}{p?.total ? ` · ${p.done} of ${n(p.total, "page")}` : "…"}</div>
          {p?.total ? (
            <div className="mirrorPopBar" aria-hidden="true"><span style={{ width: `${Math.round((100 * p.done) / p.total)}%` }} /></div>
          ) : null}
          <div className="popoverHint">
            {p?.page ? `Now: ${p.page}` : p?.first ? "Pages and their files come over one by one; you can start reading as they arrive." : "Checking both sides for changes…"}
          </div>
        </div>
      </div>
    );
  }
  if (s.last_error) {
    const unreachable = /cannot reach|timed out|refused|unreachable/i.test(s.last_error);
    return (
      <div className="mirrorPopState warn">
        <AlertCircleIcon size={14} />
        <div className="mirrorPopStateText">
          <div>{unreachable ? "The original can't be reached" : "The last sync hit a problem"}{s.last_attempt || s.last_sync ? ` · ${clock(s.last_attempt || s.last_sync)}` : ""}</div>
          <div className="popoverHint">
            {unreachable ? "Your edits stay here and go over once it is reachable again. " : ""}
            {s.last_error}
          </div>
        </div>
      </div>
    );
  }
  if (!s.last_sync) {
    return (
      <div className="mirrorPopState">
        <RefreshIcon size={14} />
        <div className="mirrorPopStateText">
          <div>{s.interrupted ? "The first copy was interrupted" : "Not copied yet"}</div>
          <div className="popoverHint">{s.interrupted ? "It continues in a moment, or press Sync now." : "The first copy starts in a moment."}</div>
        </div>
      </div>
    );
  }
  const moved = roundSummary(s);
  return (
    <div className="mirrorPopState ok">
      <CheckIcon size={14} />
      <div className="mirrorPopStateText">
        <div>Up to date · checked {clock(s.last_sync)}</div>
        <div className="popoverHint">
          {s.interrupted ? "The last round was interrupted; it continues at the next check. " : ""}
          {moved ? `Last round: ${moved}.` : "Last round: nothing had changed on either side."}
          {intervalS ? ` Checks again every ${intervalS} s.` : ""}
        </div>
      </div>
    </div>
  );
}

export function MirrorPopover({ wsId, mirrorOf, open, onToggle, openPage, onOpenSettings }) {
  const [info, setInfo] = React.useState(null);
  const [log, setLog] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    try { setInfo(await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}`)); } catch {}
  }, [wsId]);
  const loadLog = React.useCallback(async () => {
    try { setLog((await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/log?limit=20`)).changes || []); } catch { setLog([]); }
  }, [wsId]);
  const running = Boolean(info?.status?.running) || busy;
  // A running round is watched closely (the numbers move); idle, a glance every 20 s is enough.
  React.useEffect(() => {
    load();
    const t = setInterval(load, running ? 2000 : 20000);
    return () => clearInterval(t);
  }, [load, running]);
  React.useEffect(() => { if (open) { load(); loadLog(); } }, [open, load, loadLog]);
  // The list grows while a round runs, and changes once it ends.
  const lastSync = info?.status?.last_sync;
  React.useEffect(() => { if (open) loadLog(); }, [open, loadLog, lastSync]);
  React.useEffect(() => {
    if (!open || !running) return undefined;
    const t = setInterval(loadLog, 3000);
    return () => clearInterval(t);
  }, [open, running, loadLog]);

  async function syncNow() {
    setBusy(true);
    setInfo((prev) => prev ? { ...prev, status: { ...prev.status, running: true } } : prev);
    try {
      await apiJson(`${API}/mirrors/${encodeURIComponent(wsId)}/sync?wait=1`, { method: "POST" });
    } catch {}
    await load();
    await loadLog();
    setBusy(false);
  }

  const glance = mirrorGlance(info);
  const s = info?.status || {};
  let host = info?.remote_url || "";
  try { host = new URL(info.remote_url).host; } catch {}
  const pull = s.mode === "pull" || info?.mode === "pull";

  return (
    <span data-popover="mirror" className="popoverAnchor">
      <button
        className={`iconBtn mirrorPill ${glance.tone} ${open ? "activeIcon" : ""}`}
        onClick={onToggle}
        title={`Offline copy of ${mirrorOf}${host ? ` on ${host}` : ""} — ${glance.text}`}
        aria-label="Sync status"
      >
        {glance.tone === "warn" ? <AlertCircleIcon size={15} /> : <RefreshIcon size={15} />}
        <span className="mirrorPillText">{glance.text}</span>
      </button>
      {open ? (
        <div className="popover mirrorPopover" role="dialog" aria-label="Sync status">
          <div className="mirrorPopHead">
            <span className="popoverTitle">Offline copy of {mirrorOf}</span>
            <span className="popoverHint">
              {pull ? "Follows the original" : "Kept in step with the original"}{host ? ` on ${host}` : ""}
              {s.remote_user ? `, signed in there as ${s.remote_user}` : ""}.
              {pull ? " Read-only: edits made here stay here." : " Edits made here go to the original; edits made there arrive here."}
            </span>
          </div>
          <StateLine s={s} busy={busy} intervalS={info?.interval_s} />
          <div className="mirrorPopActions">
            <button className="uiBtn sm" disabled={running} onClick={syncNow} title={running ? "A round is running" : "Check both sides now instead of waiting for the next round"}>
              <RefreshIcon size={13} /> Sync now
            </button>
            <button className={`uiBtn sm ${info?.conflicts_open ? "primary" : ""}`} onClick={onOpenSettings}
              title={info?.conflicts_open ? "Both sides changed the same block; the merged result waits for you to keep or replace"
                : "Settings → Workspaces → Offline copies: merges, direction, stop mirroring"}>
              {info?.conflicts_open ? <><AlertCircleIcon size={13} /> Review {n(info.conflicts_open, "merge")}</> : <><SettingsIcon size={13} /> Settings</>}
            </button>
          </div>
          <div className="popoverLabel">Recent changes</div>
          {log === null ? <div className="popoverHint">Loading…</div>
            : log.length ? (
              <ul className="mirrorPopLog">
                {log.map((c) => (
                  <li key={c.id}>
                    <button className="popoverItem mirrorPopItem" disabled={!c.exists} onClick={() => c.exists && openPage(c.page_id)}
                      title={c.exists ? "Open this page" : "This page is gone"}>
                      <span className="mirrorPopItemTitle">{c.title || c.page_id}</span>
                      <span className="mirrorPopItemMeta">{ACTION_TEXT[c.action] || c.action} · {clock(c.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <div className="popoverHint">{running ? "Pages show up here as they are copied." : s.last_sync ? "Nothing has changed on either side since the copy was made." : "Nothing copied yet."}</div>}
        </div>
      ) : null}
    </span>
  );
}

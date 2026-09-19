// Settings → Workspaces → Offline copies: the mirrors of this account —
// local workspaces that follow a workspace on another Gamma server
// (docs/dev/mirror.md, GUI for /api/mirrors*). A row per mirror with its
// sync status, Open, Sync now, the conflicts it decided on its own (an
// inline list with Keep / Use mine / Use theirs), and Stop. "Mirror a
// remote workspace" asks for the server address and a write token made
// there (Settings → Integrations on that server).
import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { Section, Row, SubDialog, Field, Segmented, Empty } from "./SettingsKit";
import { AlertCircleIcon, CheckIcon, CloudDownloadIcon, HardDriveIcon, PlusIcon, RefreshIcon } from "../shared/ui/Icons";
import { roundSummary } from "../collaboration/MirrorPopover";

const KIND_TEXT = {
  merged: "Both sides changed this block; the two edits were merged.",
  kept_local_edit: "The other side deleted this, but it was edited here, so it stayed (and went back over).",
  restored_remote_edit: "This was deleted here, but the other side edited it, so it came back.",
  page_restored: "The other side deleted this page; it was edited here, so it came back there.",
  page_restored_from_remote: "This page was deleted here but edited on the other side, so it came back.",
};

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString();
}

// The account's mirrors (null while loading). `enabled` false (a guest, or
// signed out) reads nothing: the endpoint would refuse.
export function useMirrors(enabled = true) {
  const [mirrors, setMirrors] = React.useState(null);
  const refresh = React.useCallback(() => {
    if (!enabled) { setMirrors([]); return; }
    apiJson(`${API}/mirrors`).then((d) => setMirrors(d.mirrors || [])).catch(() => setMirrors([]));
  }, [enabled]);
  React.useEffect(() => { refresh(); }, [refresh]);
  return [mirrors, refresh];
}

export function mirrorStatusLine(m) {
  const s = m.status || {};
  const dir = s.mode === "pull" || m.mode === "pull" ? "read-only copy" : "both ways";
  const p = s.progress;
  if (s.running) return `${dir} · ${p?.total ? `${p.first ? "copying" : "syncing"} ${p.done} of ${p.total} pages…` : "syncing…"}`;
  if (s.last_error) return `${dir} · problem: ${s.last_error}`;
  if (!s.last_sync) return `${dir} · ${s.interrupted ? "the first copy was interrupted, it continues at the next round" : "not copied yet"}`;
  const moved = roundSummary(s);
  return `${dir} · up to date ${when(s.last_sync)} · last round: ${moved || "nothing had changed"}`;
}

export function MirrorDialog({ busy, error, onSubmit, onClose }) {
  const [url, setUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const [name, setName] = React.useState("");
  const [mode, setMode] = React.useState("two-way");
  const ok = url.trim() && token.trim();
  return (
    <SubDialog title="Mirror a remote workspace" onClose={onClose} draft={url || token}>
      <div className="settingsForm">
      <p className="settingDesc">
        Keeps a copy of a workspace from another Gamma server here, so it opens without a connection.
        Edits made here go back when the server is reachable; edits made there arrive here.
      </p>
      <Field label="Server address" hint="the other Gamma, e.g. https://nas.local:8000">
        <input className="aiKeyInput" value={url} autoFocus placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Token" hint="made on that server: Settings → Integrations → Manual setup, with the “Read and write” scope, for the workspace to copy">
        <input className="aiKeyInput" type="password" value={token} placeholder="gamma_…" onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field label="Name here" hint="optional — defaults to the remote workspace's name">
        <input className="aiKeyInput" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Direction">
        <Segmented value={mode} onChange={setMode} options={[["two-way", "Both ways"], ["pull", "Read-only copy"]]} />
      </Field>
      {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
      <div className="reportModalBtns">
        <button className="uiBtn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="uiBtn primary" disabled={!ok || busy}
          onClick={() => onSubmit({ remote_url: url.trim(), token: token.trim(), name: name.trim(), mode })}>
          {busy ? "Connecting…" : "Start mirroring"}
        </button>
      </div>
      </div>
    </SubDialog>
  );
}

function ConflictRow({ c, busy, onResolve }) {
  const textual = c.kind === "merged";
  return (
    <div className="mirrorConflict">
      <div className="mirrorConflictHead">
        <AlertCircleIcon size={14} />
        <span className="aiProvName">{c.page_title || c.page_id}</span>
        <span className="settingDesc">{when(c.at)}</span>
      </div>
      <p className="settingDesc">{KIND_TEXT[c.kind] || c.kind}</p>
      {textual ? (
        <div className="mirrorConflictTexts">
          <div><span className="uiTag">mine</span><pre>{c.mine}</pre></div>
          <div><span className="uiTag">theirs</span><pre>{c.theirs}</pre></div>
          <div><span className="uiTag">result</span><pre>{c.result}</pre></div>
        </div>
      ) : null}
      <div className="aiProvActions">
        {textual ? <>
          <button className="uiBtn sm" disabled={busy} onClick={() => onResolve(c, "mine")}>Use mine</button>
          <button className="uiBtn sm" disabled={busy} onClick={() => onResolve(c, "theirs")}>Use theirs</button>
        </> : null}
        <button className="uiBtn sm" disabled={busy} onClick={() => onResolve(c, "keep")}><CheckIcon size={13} /> {textual ? "Keep the merge" : "OK"}</button>
      </div>
    </div>
  );
}

export function MirrorConflicts({ mirror, onClose, setStatus }) {
  const [items, setItems] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const ws = mirror.workspace_id;
  const load = React.useCallback(() => {
    apiJson(`${API}/mirrors/${encodeURIComponent(ws)}/conflicts`).then((d) => setItems(d.conflicts || [])).catch(() => setItems([]));
  }, [ws]);
  React.useEffect(() => { load(); }, [load]);
  async function resolve(c, choice) {
    setBusy(true);
    try {
      await apiJson(`${API}/mirrors/${encodeURIComponent(ws)}/conflicts/${c.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }),
      });
      setItems((prev) => (prev || []).filter((x) => x.id !== c.id));
    } catch (err) {
      setStatus?.(`Could not resolve: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title={`Merges to look at · ${mirror.name}`} action={<button className="uiBtn sm" onClick={onClose}>Back</button>}>
      {items === null ? <Empty icon={HardDriveIcon}>Loading…</Empty>
        : items.length ? items.map((c) => <ConflictRow key={c.id} c={c} busy={busy} onResolve={resolve} />)
        : <Empty icon={CheckIcon}>Nothing to decide — every change merged cleanly.</Empty>}
    </Section>
  );
}

export function MirrorsSection({ mirrors, refresh, workspaces, currentId, switchWorkspace, closeSettings, confirm, setStatus }) {
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [conflictsOf, setConflictsOf] = React.useState(null);
  const byWs = Object.fromEntries((workspaces || []).map((w) => [w.id, w]));

  async function submit(body) {
    setBusy(true);
    setCreateError("");
    try {
      await apiJson(`${API}/mirrors`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setCreating(false);
      setStatus?.("Mirroring started — the first copy runs in the background.");
      refresh();
      setTimeout(refresh, 4000);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function syncNow(m) {
    setBusy(true);
    try {
      const d = await apiJson(`${API}/mirrors/${encodeURIComponent(m.workspace_id)}/sync?wait=1`, { method: "POST" });
      const s = d.status || {};
      setStatus?.(s.last_error ? `Sync problem: ${s.last_error}`
        : `Up to date — ${roundSummary(s) || "nothing had changed on either side"}.`);
    } catch (err) {
      setStatus?.(`Sync failed: ${err.message}`);
    } finally {
      setBusy(false);
      refresh();
    }
  }
  function stop(m) {
    const name = m.name || byWs[m.workspace_id]?.name || "this copy";
    confirm({
      title: "Stop mirroring",
      message: `“${name}” stays as an ordinary workspace of yours; it just stops following ${m.remote_name}.`,
      confirmLabel: "Stop mirroring", danger: true,
      onConfirm: async () => {
        try {
          await apiJson(`${API}/mirrors/${encodeURIComponent(m.workspace_id)}`, { method: "DELETE" });
        } catch (err) {
          setStatus?.(`Could not stop: ${err.message}`);
        }
        refresh();
      },
    });
  }

  if (conflictsOf) {
    return <MirrorConflicts mirror={conflictsOf} setStatus={setStatus} onClose={() => { setConflictsOf(null); refresh(); }} />;
  }

  function row(m) {
    const current = m.workspace_id === currentId;
    const w = byWs[m.workspace_id];
    const s = m.status || {};
    let host = m.remote_url;
    try { host = new URL(m.remote_url).host; } catch {}
    return (
      <div key={m.workspace_id} className="aiProvRow">
        <span className={`aiProvAvatar ${current ? "active" : ""}`}>
          {current ? <CheckIcon size={15} /> : <HardDriveIcon size={15} />}
        </span>
        <span className="aiProvMeta">
          <span className="aiProvName">
            {m.name || w?.name}
            {current ? <span className="uiTag">open</span> : null}
            {s.last_error ? <span className="uiTag">problem</span> : null}
            {m.conflicts_open ? <span className="uiTag">{m.conflicts_open} to review</span> : null}
          </span>
          <span className="aiProvDesc" title={m.remote_url}>
            copy of {m.remote_name} on {host}
          </span>
          <span className="aiProvDesc">{mirrorStatusLine(m)}</span>
        </span>
        <span className="aiProvActions">
          {!current ? <button className="uiBtn sm" onClick={() => { closeSettings?.(); switchWorkspace(m.workspace_id); }}>Open</button> : null}
          <button className="uiBtn sm" disabled={busy || s.running} onClick={() => syncNow(m)} title="Run a sync round now">
            <RefreshIcon size={13} /> Sync now
          </button>
          <button className={`uiBtn sm ${m.conflicts_open ? "primary" : ""}`} disabled={busy} onClick={() => setConflictsOf({ ...m, name: m.name || w?.name })}
            title="When both sides changed the same thing, the sync decided on its own; the decisions wait here for you to check">
            Merges{m.conflicts_open ? ` (${m.conflicts_open})` : ""}
          </button>
          <button className="uiBtn sm" disabled={busy} onClick={() => stop(m)}>Stop</button>
        </span>
      </div>
    );
  }

  return (
    <>
      <Section
        title="Offline copies"
        action={(
          <button className="uiBtn sm" disabled={busy} onClick={() => { setCreateError(""); setCreating(true); }}>
            <PlusIcon size={13} /> Mirror a remote workspace
          </button>
        )}
      >
        {mirrors?.length ? (
          <p className="settingDesc mirrorIntro">
            A copy of a workspace on another Gamma, kept in step: edits made here go to the original when it is reachable,
            edits made there arrive here — every {""}
            30 seconds and on <b>Sync now</b>. When both sides changed the same block, the two edits are merged and the
            result waits under <b>Merges</b> for you to keep, or replace with your version or theirs. The sync pill in the
            header shows the same state while the copy is open.
          </p>
        ) : null}
        {mirrors === null ? <Empty icon={CloudDownloadIcon}>Loading…</Empty>
          : mirrors.length ? mirrors.map(row)
          : <Empty icon={CloudDownloadIcon}>
              <span>No offline copies yet.</span>
              <span className="settingDesc">A copy of a workspace on another Gamma server, kept in step both ways, that opens without a connection.</span>
            </Empty>}
      </Section>
      {creating ? <MirrorDialog busy={busy} error={createError} onSubmit={submit} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

// Settings → Workspaces → Clones: the mirrors of this account — local
// workspaces that follow a workspace on another Gamma server, in git's
// words a clone and its origin (docs/dev/mirror.md, GUI for /api/mirrors*).
// A row per clone, its avatar the clone's state (syncing, up to date, a
// problem, detached): Open, Pull & push (Reattach when detached), the
// conflicts, and a "more" menu with force pull / force push, detach and
// remove origin. The conflicts view lists the same cards as the row chips,
// each resolved here or opened on its block. "Clone a remote workspace"
// asks for the server address and a write token made there (Settings →
// Integrations on that server), into a new workspace or an existing one.
import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { Section, SubDialog, Field, IconChoices, Segmented, Empty } from "./SettingsKit";
import { ActionMenu, MenuSelect } from "../shared/ui/Menus";
import {
  AlertCircleIcon, ArrowDownIcon, ArrowUpDownIcon, CheckIcon, CloudDownloadIcon, HardDriveIcon, LinkIcon, MoreIcon,
  PlusIcon, RefreshIcon, TrashIcon, UnlinkIcon, UploadIcon,
} from "../shared/ui/Icons";
import { bytes, clock, hostOf, isPullOnly, mirrorState, roundSummary } from "../collaboration/MirrorPopover";
import { ConflictCard } from "../collaboration/MergeResolver";

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

// The row's status line: the state in a few words, the file in flight
// while a round runs, the last round's totals when up to date.
export function mirrorStatusLine(m) {
  const s = m.status || {};
  const p = s.progress;
  const st = mirrorState(m);
  if (m.detached || m.mode === "off") return `detached${s.detached_at ? ` ${clock(s.detached_at)}` : ""} · reattach to merge what both sides did meanwhile`;
  if (st.tone === "busy") {
    const file = p?.file ? ` · ${p.file.dir === "up" ? "pushing" : "pulling"} ${p.file.name} ${bytes(p.file.done)}${p.file.total ? ` / ${bytes(p.file.total)}` : ""}` : "";
    return `${p?.total ? `${p.first ? "cloning" : "syncing"} ${p.done} of ${p.total} pages…` : "syncing…"}${file}`;
  }
  if (s.last_error) return `problem: ${s.last_error}`;
  if (!s.last_sync) return s.interrupted ? "interrupted · continues at the next round" : "not cloned yet";
  if (m.pending_local) return `local edits not pushed yet · up to date ${clock(s.last_sync)}`;
  return `up to date ${clock(s.last_sync)} · ${roundSummary(s) || "nothing had changed"}`;
}

const DIRECTION_TILES = [
  { value: "two-way", label: "Two-way", hint: "your edits go to the remote too", Icon: ArrowUpDownIcon },
  { value: "pull", label: "Receive only", hint: "the remote's edits arrive here", Icon: ArrowDownIcon },
];

export function MirrorDialog({ busy, error, onSubmit, onClose, candidates = [] }) {
  const [url, setUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const [name, setName] = React.useState("");
  const [mode, setMode] = React.useState("two-way");
  const [into, setInto] = React.useState("");
  const [adopt, setAdopt] = React.useState("theirs");
  const ok = url.trim() && token.trim();
  return (
    <SubDialog title="Clone a remote workspace" onClose={onClose} draft={url || token}>
      <div className="settingsForm">
      <Field label="Origin server" hint="the other Gamma, e.g. https://nas.local:8000">
        <input className="aiKeyInput" value={url} autoFocus placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Token" hint="made on that server: Settings → Integrations → Manual setup, with the “Read and write” scope, for the workspace to clone">
        <input className="aiKeyInput" type="password" value={token} placeholder="gamma_…" onChange={(e) => setToken(e.target.value)} />
      </Field>
      {candidates.length ? (
        <Field label="Into" hint="a new workspace, or one of yours that already holds a copy (an imported backup, a clone whose origin was removed)">
          <MenuSelect block value={into} onChange={setInto}
            options={[["", "A new workspace"], ...candidates.map((w) => [w.id, w.name])]} />
        </Field>
      ) : null}
      {into ? (
        <Field label="If a page differs" hint="both versions are kept; the other waits under Conflicts">
          <Segmented value={adopt} onChange={setAdopt} options={[["theirs", "Take remote's"], ["mine", "Keep local"]]} />
        </Field>
      ) : (
        <Field label="Name here" hint="optional — defaults to the origin workspace's name">
          <input className="aiKeyInput" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
      <Field label="Direction">
        <IconChoices label="Direction" value={mode} onChange={setMode} options={DIRECTION_TILES} />
      </Field>
      {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
      <div className="reportModalBtns">
        <button className="uiBtn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="uiBtn primary" disabled={!ok || busy}
          onClick={() => onSubmit({ remote_url: url.trim(), token: token.trim(), name: name.trim(), mode, workspace_id: into, adopt })}>
          {busy ? "Connecting…" : "Clone"}
        </button>
      </div>
      </div>
    </SubDialog>
  );
}

export function MirrorConflicts({ mirror, onClose, setStatus, closeSettings }) {
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
      window.dispatchEvent(new CustomEvent("gamma:mirror"));
    }
  }
  function open(c) {
    closeSettings?.();
    window.dispatchEvent(new CustomEvent("gamma:jump", { detail: { page: c.page_id, block: c.block_id } }));
  }
  return (
    <Section title={`Conflicts · ${mirror.name}`} action={<button className="uiBtn sm" onClick={onClose}>Back</button>}>
      {items === null ? <Empty icon={HardDriveIcon}>Loading…</Empty>
        : items.length ? <div className="mirrorCards">{items.map((c) => <ConflictCard key={c.id} conflict={c} busy={busy} showPage onResolve={resolve} onOpen={open} />)}</div>
        : <Empty icon={CheckIcon}>No conflicts — every change merged cleanly.</Empty>}
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
      setStatus?.("Cloning in the background.");
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
  async function call(m, path, init, ok, gone = false) {
    setBusy(true);
    try {
      await apiJson(`${API}/mirrors/${encodeURIComponent(m.workspace_id)}${path}`, init);
      if (ok) setStatus?.(ok);
    } catch (err) {
      setStatus?.(`Could not do that: ${err.message}`);
    } finally {
      setBusy(false);
      refresh();
      // the page's pill and merge chips follow; a forgotten link is told apart (nothing to reload)
      if (!gone) window.dispatchEvent(new CustomEvent("gamma:mirror"));
    }
  }
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  function nameOf(m) {
    return m.name || byWs[m.workspace_id]?.name || "this clone";
  }
  function force(m, direction) {
    confirm({
      title: direction === "pull" ? "Force pull" : "Force push",
      message: direction === "pull"
        ? `Make “${nameOf(m)}” identical to ${m.remote_name} on ${hostOf(m.remote_url)}? Only differing pages are written; where texts differ, yours are kept as conflicts.`
        : `Make ${m.remote_name} on ${hostOf(m.remote_url)} identical to “${nameOf(m)}”? Only differing pages are written; where texts differ, origin's are kept as conflicts.`,
      confirmLabel: direction === "pull" ? "Force pull" : "Force push", danger: true,
      onConfirm: () => call(m, "/force", json({ direction }), `${direction === "pull" ? "Force pull" : "Force push"} running in the background.`),
    });
  }
  function forget(m) {
    confirm({
      title: "Remove origin",
      message: `“${nameOf(m)}” stays as an ordinary workspace of yours; it never pulls from or pushes to ${m.remote_name} again.`,
      confirmLabel: "Remove origin", danger: true,
      onConfirm: async () => {
        if (m.workspace_id === currentId) window.dispatchEvent(new CustomEvent("gamma:mirror-gone"));
        await call(m, "", { method: "DELETE" }, undefined, true);
      },
    });
  }

  if (conflictsOf) {
    return <MirrorConflicts mirror={conflictsOf} setStatus={setStatus} closeSettings={closeSettings} onClose={() => { setConflictsOf(null); refresh(); }} />;
  }

  function row(m) {
    const current = m.workspace_id === currentId;
    const s = m.status || {};
    const detached = m.detached || m.mode === "off";
    const pullOnly = isPullOnly(m);
    const st = mirrorState(m);
    const more = detached ? [
      { icon: LinkIcon, label: "Reattach", title: "Follow origin again; what both sides did meanwhile merges",
        onClick: () => call(m, "/relink", json({}), "Reattached — syncing in the background.") },
    ] : [
      { icon: CloudDownloadIcon, label: "Force pull", title: "Make this clone identical to origin", onClick: () => force(m, "pull") },
      { icon: UploadIcon, label: "Force push", title: pullOnly ? "A receive-only clone cannot force push" : "Make the remote identical to this clone",
        disabled: pullOnly, onClick: () => force(m, "push") },
      { icon: UnlinkIcon, label: "Detach", title: "Stop pulling and pushing for now; origin is kept, so reattaching merges what both sides did meanwhile",
        onClick: () => call(m, "/detach", { method: "POST" }, "Detached — reattach whenever you like.") },
    ];
    more.push({ icon: TrashIcon, label: "Remove origin", danger: true, title: "Remove origin for good; the workspace stays as an ordinary one", onClick: () => forget(m) });
    return (
      <div key={m.workspace_id} className="aiProvRow">
        <span className={`aiProvAvatar mirrorAvatar ${st.tone} ${current ? "active" : ""}`} title={st.title}>
          <st.Icon size={15} />
        </span>
        <span className="aiProvMeta">
          <span className="aiProvName">
            {nameOf(m)}
            {current ? <span className="uiTag">open</span> : null}
            {pullOnly ? <span className="uiTag" title="The remote's changes arrive here; yours stay here until you switch to two-way">receive only</span> : null}
            {detached ? <span className="uiTag">detached</span> : null}
            {!detached && s.last_error ? <span className="uiTag warn">problem</span> : null}
            {!detached && !s.last_error && m.pending_local ? <span className="uiTag pending" title="Local edits the next round pushes">unpushed edits</span> : null}
            {m.conflicts_open ? <span className="uiTag warn">{m.conflicts_open} conflict{m.conflicts_open === 1 ? "" : "s"}</span> : null}
          </span>
          <span className="aiProvDesc" title={m.remote_url}>
            clone of {m.remote_name} · origin {hostOf(m.remote_url)}
          </span>
          <span className="aiProvDesc">{mirrorStatusLine(m)}</span>
        </span>
        <span className="aiProvActions">
          {!current ? <button className="uiBtn sm" onClick={() => { closeSettings?.(); switchWorkspace(m.workspace_id); }}>Open</button> : null}
          {detached ? (
            <button className="uiBtn sm primary" disabled={busy} title="Follow origin again; what both sides did meanwhile merges"
              onClick={() => call(m, "/relink", json({}), "Reattached — syncing in the background.")}>
              <LinkIcon size={13} /> Reattach
            </button>
          ) : (
            <button className="uiBtn sm" disabled={busy || s.running} onClick={() => syncNow(m)}
              title={pullOnly ? "Receive the remote's changes now" : "Sync now"}>
              <RefreshIcon size={13} /> Sync
            </button>
          )}
          <button className={`uiBtn sm ${m.conflicts_open ? "primary" : ""}`} disabled={busy} onClick={() => setConflictsOf({ ...m, name: nameOf(m) })}
            title="Blocks both sides changed: the sync merged them or took one side; they wait here for you to resolve">
            <AlertCircleIcon size={13} /> Conflicts{m.conflicts_open ? ` (${m.conflicts_open})` : ""}
          </button>
          <ActionMenu label="More" icon={MoreIcon} iconOnly disabled={busy} items={more} />
        </span>
      </div>
    );
  }

  return (
    <>
      <Section
        title="Clones"
        action={(
          <button className="uiBtn sm" disabled={busy} onClick={() => { setCreateError(""); setCreating(true); }}>
            <PlusIcon size={13} /> Clone a remote workspace
          </button>
        )}
      >
        {mirrors === null ? <Empty icon={CloudDownloadIcon}>Loading…</Empty>
          : mirrors.length ? mirrors.map(row)
          : <Empty icon={CloudDownloadIcon}>
              <span>No clones yet.</span>
              <span className="settingDesc">A clone follows a workspace on another Gamma server, pulling and pushing changes, and opens without a connection.</span>
            </Empty>}
      </Section>
      {creating ? (
        <MirrorDialog busy={busy} error={createError} onSubmit={submit} onClose={() => setCreating(false)}
          candidates={(workspaces || []).filter((w) => w.personal && !w.mirror_of && !(mirrors || []).some((m) => m.workspace_id === w.id))} />
      ) : null}
    </>
  );
}

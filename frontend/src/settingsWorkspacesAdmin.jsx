// Settings → Workspaces (admins): every workspace on the server — shared
// ones with their access, owners, members and size; personal ones per
// account — with a Manage dialog per workspace (rename, access, quota,
// members and ownership, kind conversion, delete, join) and New workspace
// (a shared one, for any owner, private or public). GUI for GET
// /api/admin/workspaces + /api/workspaces* (docs/dev/workspaces.md); the
// building blocks are settingsWorkspace.jsx's.
import React from "react";
import { API, apiJson, fmtBytes } from "./utils";
import { MenuSelect } from "./menus";
import { PaneHead, Section, SubDialog, Field, Empty, UnitInput, AccountPicker } from "./settingsKit";
import {
  AccessRows, InviteDialog, MembersList, StorageRow, useAccounts, useWorkspace,
  ACCESS_OPTIONS, PUBLIC_ROLE_OPTIONS,
} from "./settingsWorkspace";
import { GlobeIcon, PenIcon, PlusIcon, ShieldIcon, Trash2Icon, UserIcon, UsersIcon } from "./icons";

export function WorkspacesAdmin({ value }) {
  const { me, workspaces: mine, switchWorkspace, refreshSession, setStatus, confirm, closeSettings } = value;
  const [listing, setListing] = React.useState(null); // {workspaces, orphans}
  const [error, setError] = React.useState("");
  const [manage, setManage] = React.useState(null);   // workspace id
  const [creating, setCreating] = React.useState(false);
  const accounts = useAccounts();

  const refresh = React.useCallback(() => {
    apiJson(`${API}/admin/workspaces`).then(setListing).catch((err) => setError(err.message));
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  const rows = listing?.workspaces || [];
  const shared = rows.filter((w) => !w.personal);
  const personal = rows.filter((w) => w.personal);
  const openable = new Set((mine || []).map((w) => w.id));

  function row(w) {
    const owners = w.members.filter((m) => m.role === "owner").map((m) => m.username);
    const isPublic = w.access === "public";
    return (
      <div key={w.id} className="aiProvRow">
        <span className={`aiProvAvatar ${isPublic ? "active" : ""}`}>
          {w.personal ? <UserIcon size={15} /> : isPublic ? <GlobeIcon size={15} /> : <UsersIcon size={15} />}
        </span>
        <span className="aiProvMeta">
          <span className="aiProvName">
            {w.name}
            {w.personal ? <span className="uiTag">{w.personal === me ? "you" : w.personal}</span> : null}
            {w.personal && w.default ? <span className="uiTag">default</span> : null}
            {isPublic ? <span className="uiTag">public · everyone {w.public_role === "editor" ? "edits" : "views"}</span> : null}
          </span>
          <span className="aiProvDesc">
            {w.personal
              ? `${w.personal}'s personal library`
              : `${owners.length ? `owner ${owners.join(", ")}` : "no owner"} · ${w.members.length} member${w.members.length === 1 ? "" : "s"}`}
            {` · ${fmtBytes(w.used_bytes)}`}
            {!w.personal && w.quota_mb ? ` of ${w.quota_mb} MB` : ""}
          </span>
        </span>
        <span className="aiProvActions">
          {openable.has(w.id) ? (
            <button className="uiBtn sm" onClick={() => { closeSettings?.(); switchWorkspace(w.id); }}>Open</button>
          ) : null}
          <button className="uiBtn sm" onClick={() => setManage(w.id)} title={`Manage ${w.name}`}>
            <PenIcon size={13} /> Manage
          </button>
        </span>
      </div>
    );
  }

  return (
    <>
      <PaneHead icon={GlobeIcon} title="Workspaces">
        Every library on this server: shared workspaces (admin-made, members and roles) and each account's personal ones. Admins manage any of them without being members; opening one still takes membership or public access.
      </PaneHead>
      {!listing && !error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
      {error ? <Empty icon={UsersIcon}>Workspaces unavailable — {error}</Empty> : null}
      {listing ? (
        <>
          <Section
            title="Shared workspaces"
            action={(
              <button className="uiBtn sm" onClick={() => setCreating(true)}>
                <PlusIcon size={13} /> New workspace
              </button>
            )}
          >
            {shared.length ? shared.map(row) : <Empty icon={UsersIcon}>No shared workspaces yet.</Empty>}
          </Section>
          <Section title="Personal workspaces">
            {[...personal].sort((a, b) => a.personal.localeCompare(b.personal) || (b.default - a.default) || a.name.localeCompare(b.name)).map(row)}
          </Section>
          {listing.orphans?.length ? (
            <div className="settingsPaneHint">
              Directories under workspaces/ that no workspace names (inspect or delete by hand): {listing.orphans.join(", ")}
            </div>
          ) : null}
        </>
      ) : null}

      {manage ? (
        <ManageDialog
          wsId={manage} me={me} accounts={accounts} confirm={confirm} setStatus={setStatus}
          canOpen={openable.has(manage)}
          onOpen={() => { closeSettings?.(); switchWorkspace(manage); }}
          onClose={() => { setManage(null); refresh(); refreshSession?.(); }}
        />
      ) : null}
      {creating ? (
        <NewWorkspaceDialog
          me={me} accounts={accounts} setStatus={setStatus}
          onCreated={() => { setCreating(false); refresh(); refreshSession?.(); }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}

// One workspace, everything an admin can do to it. Reuses the Members &
// sharing pane's pieces on top of useWorkspace(wsId).
function ManageDialog({ wsId, me, accounts, confirm, setStatus, canOpen, onOpen, onClose }) {
  const ws = useWorkspace(wsId);
  const [name, setName] = React.useState(null); // the name being edited, null = not editing
  const [inviting, setInviting] = React.useState(false);
  const info = ws.info;
  const isPersonal = info?.kind === "personal";
  const isMember = (info?.members || []).some((m) => m.username === me);

  function convert(kind) {
    const toShared = kind === "shared";
    confirm({
      title: toShared ? "Convert to shared workspace" : "Convert to personal workspace",
      message: toShared
        ? `Make "${info?.name}" a shared workspace? ${info?.personal_of} stays its owner and can invite people; it stops counting against their storage. If it is their default, another personal workspace becomes the default.`
        : `Make "${info?.name}" ${info?.members?.[0]?.username}'s personal workspace? It becomes private, its own quota is cleared, and it counts against their storage.`,
      confirmLabel: "Convert",
      onConfirm: async () => {
        const d = await ws.update({ kind });
        if (d) setStatus(`${d.name} is now a ${d.kind} workspace.`);
      },
    });
  }

  async function saveName() {
    const d = await ws.update({ name: name.trim() });
    if (d) { setName(null); setStatus(`Renamed to ${d.name}.`); }
  }

  async function invite(username, role) {
    const d = await ws.setRole(username, role);
    if (d) { setInviting(false); setStatus(`${username} is now ${role} of ${d.name}.`); }
  }

  function remove(username) {
    confirm({
      title: username === me ? "Leave workspace" : "Remove member",
      message: `Remove ${username} from "${info?.name}"?`,
      confirmLabel: "Remove", danger: true,
      onConfirm: async () => {
        const d = await ws.removeMember(username);
        if (d) ws.setInfo((prev) => ({ ...prev, members: (prev?.members || []).filter((m) => m.username !== username) }));
      },
    });
  }

  function destroy() {
    confirm({
      title: "Delete workspace",
      message: `Delete "${info?.name}" with ALL its pages, PDFs and chats, for every member? This can't be undone.`,
      confirmLabel: "Delete", danger: true,
      onConfirm: async () => {
        const d = await ws.destroy();
        if (d) { setStatus(d.warning || `Deleted ${info?.name}.`); onClose(); }
      },
    });
  }

  const title = info?.name || "Workspace";
  return (
    <SubDialog title={title} onClose={onClose}>
      <div className="settingsForm">
        {!info && !ws.error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
        {info ? (
          <>
            <Field label="Name" hint={isPersonal ? `${info.personal_of}'s personal workspace${info.default ? " (their default)" : ""}` : "a shared library"}>
              {name === null ? (
                <span className="aiProvPwForm">
                  <input className="aiKeyInput" type="text" value={info.name} readOnly />
                  <button className="uiBtn sm iconSq" title="Rename" aria-label="Rename" onClick={() => setName(info.name)}>
                    <PenIcon size={13} />
                  </button>
                </span>
              ) : (
                <span className="aiProvPwForm">
                  <input
                    className="aiKeyInput" type="text" autoFocus value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) saveName(); if (e.key === "Escape") setName(null); }}
                  />
                  <button className="uiBtn sm primary" disabled={ws.busy || !name.trim()} onClick={saveName}>Save</button>
                  <button className="uiBtn sm" onClick={() => setName(null)}>Cancel</button>
                </span>
              )}
            </Field>
            <StorageRow quota={info.quota} me={me} />
            <AccessRows info={info} canEdit onUpdate={async (patch) => {
              const d = await ws.update(patch);
              if (d && patch.access) setStatus(d.access === "public" ? `${d.name} is open to everyone.` : `${d.name} is private.`);
            }} />
            {!isPersonal ? (
              <>
                <div className="setSection">
                  <span className="setSectionLabel">Members</span>
                  <span className="setSectionRule" />
                  <button className="uiBtn sm" disabled={ws.busy} onClick={() => { ws.setError(""); setInviting(true); }}>
                    <PlusIcon size={13} /> Add
                  </button>
                </div>
                <MembersList info={info} me={me} canManage busy={ws.busy} onSetRole={ws.setRole} onRemove={remove} />
                <div className="settingsPaneHint">
                  Naming someone Owner hands the workspace on; the role menu is how ownership moves.
                  {info.members?.length === 1 ? " With a single member it can also become that person's personal workspace." : ""}
                </div>
              </>
            ) : (
              <div className="settingsPaneHint">
                A personal workspace has no other members. Convert it to a shared workspace to let people in.
              </div>
            )}
          </>
        ) : null}
        {ws.error && !inviting ? <div className="settingsPaneHint aiKeysError">{ws.error}</div> : null}
        <div className="reportModalBtns">
          {info ? (
            <button className="uiBtn danger" disabled={ws.busy} onClick={destroy}
              title={isPersonal ? "Delete this personal workspace (an account's last one cannot go)" : "Delete the workspace for every member"}>
              <Trash2Icon size={13} /> Delete…
            </button>
          ) : null}
          {info && isPersonal ? (
            <button className="uiBtn" disabled={ws.busy} onClick={() => convert("shared")} title="Let people in: the owner stays owner, it stops counting against them">
              <UsersIcon size={13} /> Make shared
            </button>
          ) : null}
          {info && !isPersonal && info.members?.length === 1 ? (
            <button className="uiBtn" disabled={ws.busy} onClick={() => convert("personal")} title="Hand it to its single member as a personal workspace">
              <UserIcon size={13} /> Make personal
            </button>
          ) : null}
          {info && !isMember && !isPersonal ? (
            <button
              className="uiBtn" disabled={ws.busy}
              title={info.access === "public" ? "Add yourself as an owner (everyone can already open it)" : "Add yourself as an owner so you can open it"}
              onClick={async () => { const d = await ws.setRole(me, "owner"); if (d) setStatus(`You now own ${d.name}.`); }}
            >
              <ShieldIcon size={13} /> Join as owner
            </button>
          ) : null}
          {canOpen || isMember ? <button className="uiBtn" onClick={onOpen}>Open</button> : null}
          <button className="uiBtn primary" onClick={onClose}>Done</button>
        </div>
      </div>
      {inviting ? (
        <InviteDialog
          name={title} accounts={accounts} exclude={(info?.members || []).map((m) => m.username)}
          busy={ws.busy} error={ws.error} onSubmit={invite} onClose={() => { setInviting(false); ws.setError(""); }}
        />
      ) : null}
    </SubDialog>
  );
}

// New shared workspace: a name, an owner picked from the directory (you, by
// default), private or public with its public role, and an optional quota.
function NewWorkspaceDialog({ me, accounts, setStatus, onCreated, onClose }) {
  const [form, setForm] = React.useState({ name: "", owner: me, access: "private", public_role: "viewer", quota_mb: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    const name = form.name.trim();
    if (!name) { setError("Give the workspace a name."); return; }
    if (!form.owner) { setError("Pick an owner."); return; }
    const quota = form.quota_mb.trim() === "" ? 0 : Number.parseInt(form.quota_mb, 10);
    if (!Number.isFinite(quota) || quota < 0) { setError("The quota must be a whole number of MB, or blank."); return; }
    setBusy(true);
    setError("");
    try {
      const d = await apiJson(`${API}/workspaces`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind: "shared", owner: form.owner, access: form.access, public_role: form.public_role, quota_mb: quota }),
      });
      setStatus(`Created ${d.name} for ${form.owner}${d.access === "public" ? ", open to everyone" : ""}.`);
      onCreated(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SubDialog title="New shared workspace" onClose={onClose}>
      <div className="settingsForm">
        <Field label="Name" hint="a lab, a course, a reading room — personal workspaces are made from Members & sharing">
          <input
            className="aiKeyInput" type="text" autoFocus value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
        </Field>
        <Field label="Owner" hint="who manages it — you unless you pick someone">
          <AccountPicker accounts={accounts} value={form.owner} onChange={(owner) => set({ owner })} compact />
        </Field>
        <Field label="Access" hint={form.access === "public" ? "every account on this server can open it" : "members only, by invitation"}>
          <MenuSelect value={form.access} label="Access" options={ACCESS_OPTIONS} block onChange={(access) => set({ access })} />
        </Field>
        {form.access === "public" ? (
          <Field label="Public role">
            <MenuSelect value={form.public_role} label="Public role" options={PUBLIC_ROLE_OPTIONS} block onChange={(public_role) => set({ public_role })} />
          </Field>
        ) : null}
        <Field label="Workspace quota" hint="total uploads · blank = unlimited">
          <UnitInput unit="MB" min={0} placeholder="unlimited" value={form.quota_mb} onChange={(quota_mb) => set({ quota_mb })} />
        </Field>
        {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
        <div className="reportModalBtns">
          <button className="uiBtn" onClick={onClose}>Cancel</button>
          <button className="uiBtn primary" disabled={busy || !form.name.trim() || !form.owner} onClick={submit}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </SubDialog>
  );
}

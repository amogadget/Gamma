// Settings → Server → Workspaces (admins): every workspace on the server —
// shared ones with their access, owners, members and size; personal ones
// per account — each with Manage (the shared workspace dialog from
// settingsWorkspace.jsx, in admin mode: access, quota, ownership, kind
// conversion, join) and New workspace (a shared one, for any owner, private
// or public). GUI for GET /api/admin/workspaces + /api/workspaces*
// (docs/dev/workspaces.md).
import React from "react";
import { API, apiJson, fmtBytes } from "./utils";
import { MenuSelect } from "./menus";
import { Section, SubDialog, Field, Empty, UnitInput, AccountPicker } from "./settingsKit";
import { ManageWorkspaceDialog, useAccounts, ACCESS_OPTIONS, PUBLIC_ROLE_OPTIONS } from "./settingsWorkspace";
import { GlobeIcon, PenIcon, PlusIcon, UserIcon, UsersIcon } from "./icons";

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
        <ManageWorkspaceDialog
          wsId={manage} me={me} admin accounts={accounts} confirm={confirm} setStatus={setStatus}
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

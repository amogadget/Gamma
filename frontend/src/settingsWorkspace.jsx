// Settings → Members & sharing: the library this tab works in. A personal
// workspace (just you; several per account, all under your quota): rename,
// storage, make it your default, back it up or restore one, delete it. A
// shared workspace (admin-made): the same plus the member list with role
// menus, Invite (picked from the account directory), leave, and — for
// admins — the Access rows (private / public, the public role, the
// workspace's own quota). Then the list of all your workspaces and New
// workspace (a personal one). GUI for /api/workspaces* (docs/dev/workspaces.md).
//
// The pieces that also build the admin's Workspaces pane
// (settingsWorkspacesAdmin.jsx) are exported from here: useAccounts,
// useWorkspace (one workspace's state + every call on it), AccessRows,
// MembersList, InviteDialog, and the role tables.
import React from "react";
import { API, apiJson, fmtBytes } from "./utils";
import { ActionMenu, MenuSelect } from "./menus";
import { PaneHead, Section, Row, SubDialog, Field, Empty, QuotaMeter, UnitInput, AccountPicker } from "./settingsKit";
import {
  CheckIcon, DatabaseIcon, ExportIcon, GlobeIcon, HardDriveIcon, ImportIcon, LogOutIcon, PenIcon,
  PlusIcon, ShieldIcon, Trash2Icon, UserIcon, UsersIcon,
} from "./icons";

// Workspace roles as the UI words them (docs/dev/workspaces.md); the account
// menu's switcher in App.jsx reads the same table.
export const ROLE_OPTIONS = [["owner", "Owner"], ["editor", "Can edit"], ["viewer", "View only"]];
export const ROLE_LABEL = { owner: "owner", editor: "can edit", viewer: "view only" };
// One line under a switcher entry / workspace row: what kind it is and, for
// a shared one, your role.
export function workspaceMeta(w) {
  if (w.personal) return w.default ? "personal · default" : "personal";
  return `${w.access === "public" ? "public · " : ""}${ROLE_LABEL[w.role] || w.role}`;
}
export const ACCESS_OPTIONS = [["private", "Private", UsersIcon], ["public", "Public", GlobeIcon]];
export const PUBLIC_ROLE_OPTIONS = [["viewer", "Everyone can view"], ["editor", "Everyone can edit"]];

// The account directory (GET /api/accounts) for the pickers: null while
// loading, [] when it cannot be read (the guest).
export function useAccounts() {
  const [accounts, setAccounts] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    apiJson(`${API}/accounts`).then((d) => { if (live) setAccounts(d.accounts || []); }).catch(() => { if (live) setAccounts([]); });
    return () => { live = false; };
  }, []);
  return accounts;
}

// One workspace as the Settings dialogs see it: GET /api/workspaces/{id}
// (members + quota), plus every call on it. Every mutation returns the
// server's fresh payload (or null after setError) and folds it into `info`.
export function useWorkspace(wsId) {
  const [info, setInfo] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!wsId) return;
    setInfo(null);
    setError("");
    apiJson(`${API}/workspaces/${encodeURIComponent(wsId)}`).then(setInfo).catch((err) => setError(err.message));
  }, [wsId]);

  async function call(path, method, body) {
    setBusy(true);
    setError("");
    try {
      const d = await apiJson(`${API}/workspaces/${encodeURIComponent(wsId)}${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (d && d.id) setInfo((prev) => ({ ...prev, ...d }));
      return d;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  return {
    info, setInfo, error, setError, busy,
    update: (patch) => call("", "PUT", patch),                // {name} | {access, public_role} | {quota_mb}
    setRole: (username, role) => call(`/members/${encodeURIComponent(username)}`, "PUT", { role }),
    removeMember: (username) => call(`/members/${encodeURIComponent(username)}`, "DELETE"),
    destroy: () => call("", "DELETE"),
  };
}

// The admin-only settings of a shared workspace: who may open it and its
// own upload cap. `canEdit` false renders them read-only (an owner sees
// what the admin decided).
export function AccessRows({ info, canEdit, onUpdate }) {
  if (!info || info.kind === "personal") return null;
  const isPublic = info.access === "public";
  return (
    <>
      <Row
        icon={isPublic ? GlobeIcon : UsersIcon} label="Access"
        hint={isPublic ? "every account on this server can open it" : "members only, by invitation"}
        title="Private: only invited members can open the workspace. Public: every signed-in account on this server can open it with the role below; invited members keep their own role. Set by server admins."
      >
        {canEdit ? (
          <MenuSelect
            value={info.access} label="Access" options={ACCESS_OPTIONS}
            onChange={(access) => { if (access !== info.access) onUpdate({ access, public_role: info.public_role }); }}
          />
        ) : <span className="settingDesc">{isPublic ? "Public" : "Private"}</span>}
      </Row>
      {isPublic ? (
        <Row icon={UserIcon} label="Public role" hint="what everyone gets"
          title="The role every signed-in account holds in this workspace unless they are invited with another.">
          {canEdit ? (
            <MenuSelect
              value={info.public_role} label="Public role" options={PUBLIC_ROLE_OPTIONS}
              onChange={(public_role) => { if (public_role !== info.public_role) onUpdate({ access: "public", public_role }); }}
            />
          ) : <span className="settingDesc">{PUBLIC_ROLE_OPTIONS.find(([r]) => r === info.public_role)?.[1]}</span>}
        </Row>
      ) : null}
      {canEdit && info.quota != null ? (
        <Row icon={HardDriveIcon} label="Workspace quota" hint="total uploads · blank or 0 = unlimited"
          title="A shared workspace's own storage cap. It counts against nobody's personal quota; the per-file limit is the server default.">
          <UnitInput
            unit="MB" min={0} placeholder="unlimited" value={info.quota_mb ?? ""}
            onCommit={(raw) => {
              const n = raw.trim() === "" ? 0 : Number.parseInt(raw, 10);
              if (!Number.isFinite(n) || n < 0) return;
              if ((n || null) !== (info.quota_mb ?? null)) onUpdate({ quota_mb: n });
            }}
          />
        </Row>
      ) : null}
    </>
  );
}

// The storage that applies to uploads into the workspace (GET quota): a
// personal workspace shows its account's meter (all of that account's
// personal workspaces together), a shared one its own.
export function StorageRow({ quota, me }) {
  if (!quota) return null;
  const who = quota.account
    ? `${fmtBytes(quota.workspace_bytes)} here · counts against ${quota.account === me ? "your" : `${quota.account}'s`} storage`
    : quota.quota_mb ? `this workspace's own quota · ${quota.quota_mb} MB` : "this workspace's own quota · unlimited";
  return (
    <Row icon={DatabaseIcon} label="Storage" hint={who}
      title="Uploads into a personal workspace count against its account's quota, together with the account's other personal workspaces; a shared workspace has its own optional quota set by an admin.">
      {quota.account
        ? <QuotaMeter usedBytes={quota.used_bytes} quotaMb={quota.quota_mb} />
        : <span className="settingDesc">{fmtBytes(quota.workspace_bytes)}</span>}
    </Row>
  );
}

// The explicit members, each with a role menu (owners) and a remove/leave
// button. `me` marks "you"; the last owner and a personal workspace's
// owner cannot go.
export function MembersList({ info, me, canManage, busy, onSetRole, onRemove }) {
  const members = info?.members || [];
  const owners = members.filter((m) => m.role === "owner").length;
  return members.map((m) => {
    const self = m.username === me;
    const stuck = m.role === "owner" && owners <= 1;
    return (
      <div key={m.username} className="aiProvRow">
        <span className={`aiProvAvatar ${m.role === "owner" ? "active" : ""}`}>
          {m.role === "owner" ? <ShieldIcon size={15} /> : <UserIcon size={15} />}
        </span>
        <span className="aiProvMeta">
          <span className="aiProvName">
            {m.username}
            {self ? <span className="uiTag">you</span> : null}
          </span>
          <span className="aiProvDesc">
            {ROLE_OPTIONS.find(([r]) => r === m.role)?.[1] || m.role}
            {m.added_by && m.added_by !== m.username ? ` · invited by ${m.added_by}` : ""}
          </span>
        </span>
        <span className="aiProvActions">
          {canManage ? (
            <MenuSelect
              value={m.role} label="Role" options={ROLE_OPTIONS}
              onChange={(r) => { if (r !== m.role) onSetRole(m.username, r); }}
            />
          ) : null}
          {(canManage || self) && !stuck ? (
            <button
              className="uiBtn sm iconSq" disabled={busy}
              title={self ? "Leave this workspace" : `Remove ${m.username}`}
              aria-label={self ? "Leave" : "Remove"}
              onClick={() => onRemove(m.username)}
            >
              {self ? <LogOutIcon size={13} /> : <Trash2Icon size={13} />}
            </button>
          ) : null}
        </span>
      </div>
    );
  });
}

// Invite: pick an account from the directory, choose a role.
export function InviteDialog({ name, accounts, exclude, busy, error, onSubmit, onClose }) {
  const [username, setUsername] = React.useState("");
  const [role, setRole] = React.useState("editor");
  return (
    <SubDialog title={`Invite to ${name}`} onClose={onClose}>
      <div className="settingsForm">
        <Field label="Account" hint="anyone with an account on this server">
          <AccountPicker accounts={accounts} exclude={exclude} value={username} onChange={setUsername} autoFocus />
        </Field>
        <Field label="Role" hint="owners manage members; editors write; viewers read">
          <MenuSelect value={role} label="Role" options={ROLE_OPTIONS} block onChange={setRole} />
        </Field>
        {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
        <div className="reportModalBtns">
          <button className="uiBtn" onClick={onClose}>Cancel</button>
          <button className="uiBtn primary" disabled={busy || !username} onClick={() => onSubmit(username, role)}>Invite</button>
        </div>
      </div>
    </SubDialog>
  );
}

// A one-field dialog: rename, or name a new workspace.
export function NameDialog({ title, label, hint, initial, submitLabel, busy, error, onSubmit, onClose }) {
  const [name, setName] = React.useState(initial || "");
  return (
    <SubDialog title={title} onClose={onClose}>
      <div className="settingsForm">
        <Field label={label} hint={hint}>
          <input
            className="aiKeyInput" type="text" autoFocus value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSubmit(name.trim()); }}
          />
        </Field>
        {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
        <div className="reportModalBtns">
          <button className="uiBtn" onClick={onClose}>Cancel</button>
          <button className="uiBtn primary" disabled={busy || !name.trim()} onClick={() => onSubmit(name.trim())}>{submitLabel}</button>
        </div>
      </div>
    </SubDialog>
  );
}

export function WorkspaceSettings({ value }) {
  const { workspace, workspaces, me, isAdmin, switchWorkspace, refreshSession,
          exportUserData, importUserData, setStatus, confirm, closeSettings } = value;
  const wsId = workspace?.id;
  const ws = useWorkspace(wsId);
  const accounts = useAccounts();
  const [dialog, setDialog] = React.useState(null); // "rename" | "invite" | "create"
  const [createError, setCreateError] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const info = ws.info;
  const isPersonal = (info?.kind || (workspace?.personal ? "personal" : "shared")) === "personal";
  const isDefault = info ? info.default : !!workspace?.default;
  const role = info?.role || workspace?.role;
  const owner = role === "owner" || isAdmin;
  const explicitMember = (info?.members || []).some((m) => m.username === me);
  const personalCount = workspaces.filter((w) => w.personal).length;
  const home = () => workspaces.find((w) => w.default && w.id !== wsId)?.id || workspaces.find((w) => w.personal && w.id !== wsId)?.id;
  const closeDialog = () => { setDialog(null); ws.setError(""); setCreateError(""); };

  async function saveRename(name) {
    const d = await ws.update({ name });
    if (!d) return;
    closeDialog();
    setStatus(`Renamed to ${d.name}.`);
    refreshSession?.(); // the switcher and the account card show the new name
  }

  async function makeDefault() {
    const d = await ws.update({ default: true });
    if (!d) return;
    setStatus(`${d.name} is now your default workspace.`);
    refreshSession?.();
  }

  async function submitInvite(username, invitedRole) {
    const d = await ws.setRole(username, invitedRole);
    if (!d) return;
    closeDialog();
    setStatus(`${username} can now ${invitedRole === "viewer" ? "view" : invitedRole === "editor" ? "edit" : "manage"} ${d.name}.`);
  }

  async function updateAccess(patch) {
    const d = await ws.update(patch);
    if (!d) return;
    if (patch.access) setStatus(d.access === "public" ? `${d.name} is now open to everyone on this server.` : `${d.name} is private again.`);
    else if ("quota_mb" in patch) setStatus(d.quota_mb ? `Workspace quota set to ${d.quota_mb} MB.` : "Workspace quota removed.");
    refreshSession?.();
  }

  function removeMember(username) {
    const leaving = username === me;
    confirm({
      title: leaving ? "Leave workspace" : "Remove member",
      message: leaving
        ? `Leave "${info?.name}"? You will need a new invitation to come back.`
        : `Remove ${username} from "${info?.name}"? They keep nothing from it.`,
      confirmLabel: leaving ? "Leave" : "Remove",
      danger: true,
      onConfirm: async () => {
        const d = await ws.removeMember(username);
        if (!d) return;
        if (leaving) {
          closeSettings?.();
          switchWorkspace(home());
          return;
        }
        ws.setInfo((prev) => ({ ...prev, members: (prev?.members || []).filter((m) => m.username !== username) }));
        setStatus(`Removed ${username}.`);
      },
    });
  }

  function deleteWorkspace() {
    confirm({
      title: "Delete workspace",
      message: isPersonal
        ? `Delete "${info?.name}" with ALL its pages, PDFs and chats? This can't be undone.`
        : `Delete "${info?.name}" with ALL its pages, PDFs and chats, for every member? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        const d = await ws.destroy();
        if (!d) return;
        closeSettings?.();
        switchWorkspace(home());
      },
    });
  }

  async function submitCreate(name) {
    setCreating(true);
    setCreateError("");
    try {
      const d = await apiJson(`${API}/workspaces`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      closeDialog();
      closeSettings?.();
      switchWorkspace(d.id); // open it right away
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  if (!workspace) return <Empty icon={UsersIcon}>No workspace open.</Empty>;
  const name = info?.name || workspace.name;
  const isPublic = (info?.access || workspace.access) === "public";

  return (
    <>
      <PaneHead icon={isPersonal ? UserIcon : isPublic ? GlobeIcon : UsersIcon} title={name}>
        {isPersonal
          ? `${isDefault ? "Your default workspace" : "One of your personal workspaces"} — just you. Share a page with a link, or ask an admin for a shared workspace to work with others.`
          : `${isPublic ? "A public workspace — open to everyone on this server" : "A shared workspace"} · you ${role === "owner" ? "own it" : role === "editor" ? "can edit" : "can view"}.`}
      </PaneHead>

      <Section
        title="This workspace"
        action={owner ? (
          <button className="uiBtn sm" disabled={ws.busy} onClick={() => { ws.setError(""); setDialog("rename"); }}>
            <PenIcon size={13} /> Rename
          </button>
        ) : null}
      >
        <StorageRow quota={info?.quota} me={me} />
        <AccessRows info={info} canEdit={isAdmin} onUpdate={updateAccess} />
        <div className="reportModalBtns settingsAlignStart">
          <ActionMenu
            label="Export" icon={ExportIcon}
            items={[
              { icon: ExportIcon, label: "Everything (.zip)", title: "Download a zip backup: this workspace's databases + every uploaded PDF",
                onClick: () => { closeSettings?.(); exportUserData(true); } },
              { icon: DatabaseIcon, label: "Database only (.zip)", title: "A small zip with just the databases — no uploaded PDFs",
                onClick: () => { closeSettings?.(); exportUserData(false); } },
            ]}
          />
          {role !== "viewer" ? (
            <ActionMenu
              label="Import" icon={ImportIcon}
              items={[
                ...(owner ? [{ icon: ImportIcon, label: "Restore (replace)…", title: "Replace this workspace's pages and chats with a backup zip",
                               onClick: () => { closeSettings?.(); importUserData("replace"); } }] : []),
                { icon: PlusIcon, label: "Merge into this workspace…", title: "Add the backup's pages that are not here yet; nothing existing changes",
                  onClick: () => { closeSettings?.(); importUserData("merge"); } },
              ]}
            />
          ) : null}
          {isPersonal && !isDefault && role === "owner" ? (
            <button className="uiBtn" disabled={ws.busy} onClick={makeDefault}
              title="Requests that name no workspace (the browser extension, plain links) land in your default workspace">
              <CheckIcon size={13} /> Make default
            </button>
          ) : null}
          {owner && (!isPersonal || personalCount > 1) ? (
            <button className="uiBtn danger" disabled={ws.busy} onClick={deleteWorkspace}>
              <Trash2Icon size={13} /> Delete workspace…
            </button>
          ) : null}
        </div>
      </Section>

      {!isPersonal ? (
        <Section
          title="Members"
          action={owner ? (
            <button className="uiBtn sm" disabled={ws.busy} onClick={() => { ws.setError(""); setDialog("invite"); }}>
              <PlusIcon size={13} /> Invite
            </button>
          ) : null}
        >
          {!info && !ws.error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
          <MembersList info={info} me={me} canManage={owner} busy={ws.busy} onSetRole={ws.setRole} onRemove={removeMember} />
          {info && isPublic && !explicitMember ? (
            <div className="settingsPaneHint">You are here because the workspace is public — everyone on this server is.</div>
          ) : null}
        </Section>
      ) : null}

      <Section
        title="Your workspaces"
        action={(
          <button className="uiBtn sm" disabled={creating} onClick={() => { setCreateError(""); setDialog("create"); }}>
            <PlusIcon size={13} /> New workspace
          </button>
        )}
      >
        {workspaces.map((w) => (
          <div key={w.id} className="aiProvRow">
            <span className={`aiProvAvatar ${w.id === wsId ? "active" : ""}`}>
              {w.id === wsId ? <CheckIcon size={15} /> : w.personal ? <UserIcon size={15} /> : w.access === "public" ? <GlobeIcon size={15} /> : <UsersIcon size={15} />}
            </span>
            <span className="aiProvMeta">
              <span className="aiProvName">
                {w.name}
                {w.personal ? <span className="uiTag">personal</span> : <span className="uiTag">{w.access === "public" ? "public" : "shared"}</span>}
                {w.default ? <span className="uiTag">default</span> : null}
              </span>
              <span className="aiProvDesc">
                {w.personal ? "just you" : `${ROLE_LABEL[w.role] || w.role} · ${w.members} member${w.members === 1 ? "" : "s"}`}
              </span>
            </span>
            <span className="aiProvActions">
              {w.id !== wsId ? (
                <button className="uiBtn sm" onClick={() => { closeSettings?.(); switchWorkspace(w.id); }}>Open</button>
              ) : null}
            </span>
          </div>
        ))}
      </Section>

      {ws.error && !dialog ? <div className="settingsPaneHint aiKeysError">{ws.error}</div> : null}

      {dialog === "rename" ? (
        <NameDialog title="Rename workspace" label="Name" initial={name} submitLabel="Save"
          busy={ws.busy} error={ws.error} onSubmit={saveRename} onClose={closeDialog} />
      ) : null}
      {dialog === "invite" ? (
        <InviteDialog
          name={name} accounts={accounts} exclude={(info?.members || []).map((m) => m.username)}
          busy={ws.busy} error={ws.error} onSubmit={submitInvite} onClose={closeDialog}
        />
      ) : null}
      {dialog === "create" ? (
        <NameDialog title="New personal workspace" label="Name"
          hint={`a separate library of your own — work, life, play${isAdmin ? "; shared workspaces are made in Settings → Workspaces" : "; ask an admin for a shared one"}`}
          submitLabel="Create and open" busy={creating} error={createError} onSubmit={submitCreate} onClose={closeDialog} />
      ) : null}
    </>
  );
}

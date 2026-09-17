// Settings → Workspaces: every library you can open, in one place. Personal
// workspaces (just you; several per account, all under your quota) and the
// shared ones you belong to (admin-made), each row with Open, Export,
// Import and Manage — a dialog with rename, storage, members and roles
// (shared), Make default (personal), Leave, Delete. Plus your account's
// storage meter, New workspace (a personal one) and Export all. GUI for
// /api/workspaces* (docs/dev/workspaces.md).
//
// The dialog (ManageWorkspaceDialog) is shared with the admin's Server pane
// (settingsWorkspacesAdmin.jsx), which adds access, quota, ownership, kind
// conversion and join-as-owner in `admin` mode. Also exported from here:
// useAccounts, useWorkspace (one workspace's state + every call on it),
// AccessRows, StorageRow, MembersList, InviteDialog, NameDialog, the role
// tables and workspaceMeta (the switcher's one-line description).
import React from "react";
import { API, apiJson, fmtBytes } from "../shared/lib/utils";
import { ActionMenu, MenuSelect } from "../shared/ui/Menus";
import { PaneHead, Section, Row, SubDialog, Field, Empty, QuotaMeter, UnitInput, AccountPicker } from "./SettingsKit";
import {
  CheckIcon, DatabaseIcon, ExportIcon, GlobeIcon, HardDriveIcon, ImportIcon, LogOutIcon, PenIcon,
  PlusIcon, ShieldIcon, Trash2Icon, UserIcon, UsersIcon,
} from "../shared/ui/Icons";

// Workspace roles as the UI words them (docs/dev/workspaces.md); the account
// menu's switcher in App.jsx reads the same table.
export const ROLE_OPTIONS = [["owner", "Owner"], ["editor", "Can edit"], ["viewer", "View only"]];
export const ROLE_LABEL = { owner: "owner", editor: "can edit", viewer: "view only" };
const ROLE_TEXT = { owner: "own it", editor: "can edit", viewer: "can view" };
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
// (members + quota), plus every call on it. After a successful mutation the
// workspace is READ AGAIN from the server (not patched from the response),
// so the dialog always shows what is stored. Calls return the response, or
// null after setError.
export function useWorkspace(wsId) {
  const [info, setInfo] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!wsId) return null;
    try {
      const d = await apiJson(`${API}/workspaces/${encodeURIComponent(wsId)}`);
      setInfo(d);
      return d;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [wsId]);

  React.useEffect(() => {
    setInfo(null);
    setError("");
    reload();
  }, [reload]);

  async function call(path, method, body, { refresh = true } = {}) {
    setBusy(true);
    setError("");
    try {
      const d = await apiJson(`${API}/workspaces/${encodeURIComponent(wsId)}${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (refresh) await reload();
      return d;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  return {
    info, error, setError, busy, reload,
    update: (patch) => call("", "PUT", patch),                // {name} | {default} | {kind} | {access, public_role} | {quota_mb}
    setRole: (username, role) => call(`/members/${encodeURIComponent(username)}`, "PUT", { role }),
    removeMember: (username) => call(`/members/${encodeURIComponent(username)}`, "DELETE"),
    destroy: () => call("", "DELETE", null, { refresh: false }),
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

// The explicit members, each with a role menu and a remove button
// (owners). `me` marks "you"; the last owner cannot go; leaving yourself
// is an action row of the dialog, not a button on your own row.
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
          {canManage && !self && !stuck ? (
            <button
              className="uiBtn sm iconSq" disabled={busy}
              title={`Remove ${m.username}`} aria-label="Remove"
              onClick={() => onRemove(m.username)}
            >
              <Trash2Icon size={13} />
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
    <SubDialog title={`Invite to ${name}`} onClose={onClose} draft={{ username, role }}>
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
    <SubDialog title={title} onClose={onClose} draft={name}>
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

// One workspace, everything its owner (or, with `admin`, a server admin)
// can do to it, in the settings-row grammar: General (name, storage),
// Access (shared; admins edit, owners read), Members (shared), Actions
// (default, kind, join, leave, delete — each a labelled row with a hint).
// `canOpen` / `onOpen` wire the Open button; `onLeft` fires after the
// caller leaves or deletes it (the pane switches away if it was the open
// one). `personalCount` hides Delete on an account's last personal workspace.
function WorkspacePage({ title, onClose, children }) {
  return <>
    <button className="uiBtn sm settingsInlineLink" onClick={onClose}>Back to workspaces</button>
    <PaneHead icon={UsersIcon} title={title}>Workspace settings</PaneHead>
    {children}
  </>;
}

export function ManageWorkspaceDialog({ wsId, me, admin, accounts, confirm, setStatus, canOpen, onOpen, onClose, onLeft, personalCount, inline = false }) {
  const ws = useWorkspace(wsId);
  const [renaming, setRenaming] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const info = ws.info;
  const isPersonal = info?.kind === "personal";
  const mine = isPersonal && info?.personal_of === me;
  const isOwner = info?.role === "owner";
  const manages = isOwner || admin;
  const explicitMember = (info?.members || []).some((m) => m.username === me);
  const soleOwner = (info?.members || []).filter((m) => m.role === "owner").length <= 1 && isOwner;

  const done = (msg) => { if (msg) setStatus(msg); };

  async function saveName(name) {
    const d = await ws.update({ name });
    if (d) { setRenaming(false); done(`Renamed to ${d.name}.`); }
  }

  async function invite(username, role) {
    const d = await ws.setRole(username, role);
    if (d) { setInviting(false); done(`${username} can now ${role === "viewer" ? "view" : role === "editor" ? "edit" : "manage"} ${d.name}.`); }
  }

  function remove(username) {
    const leaving = username === me;
    confirm({
      title: leaving ? "Leave workspace" : "Remove member",
      message: leaving
        ? `Leave "${info?.name}"? You will need a new invitation to come back.`
        : `Remove ${username} from "${info?.name}"? They keep nothing from it.`,
      confirmLabel: leaving ? "Leave" : "Remove", danger: true,
      onConfirm: async () => {
        const d = await ws.removeMember(username);
        if (!d) return;
        if (leaving) { onClose(); onLeft?.(wsId); return; }
        done(`Removed ${username}.`);
      },
    });
  }

  function destroy() {
    confirm({
      title: "Delete workspace",
      message: `Delete "${info?.name}" with ALL its pages, PDFs, chats and backups${isPersonal ? "" : ", for every member"}? This can't be undone.`,
      confirmLabel: "Delete", danger: true,
      onConfirm: async () => {
        const d = await ws.destroy();
        if (d) { done(d.warning || `Deleted ${info?.name}.`); onClose(); onLeft?.(wsId); }
      },
    });
  }

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
        if (d) done(`${d.name} is now a ${d.kind} workspace.`);
      },
    });
  }

  const title = info?.name || "Workspace";
  const subtitle = !info ? "" : isPersonal
    ? (mine ? `Your personal workspace${info.default ? " · your default" : ""}` : `${info.personal_of}'s personal workspace${info.default ? " · their default" : ""}`)
    : `${info.access === "public" ? "Public" : "Shared"} workspace · ${info.role ? `you ${ROLE_TEXT[info.role]}` : "you manage it as an admin"}`;
  const canDelete = manages && (!isPersonal || personalCount == null || personalCount > 1);

  const Surface = inline ? WorkspacePage : SubDialog;
  return (
    <Surface title={title} onClose={onClose}>
      <div className="settingsForm">
        {subtitle ? <div className="settingsPaneHint">{subtitle}</div> : null}
        {!info && !ws.error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
        {info ? (
          <>
            <Section title="General">
              <Row icon={PenIcon} label="Name" hint={info.name}>
                {manages ? <button className="uiBtn sm" disabled={ws.busy} onClick={() => setRenaming(true)}>Rename</button> : null}
              </Row>
              <StorageRow quota={info.quota} me={me} />
            </Section>
            {!isPersonal ? (
              <Section title="Access">
                <AccessRows info={info} canEdit={!!admin} onUpdate={async (patch) => {
                  const d = await ws.update(patch);
                  if (d && patch.access) done(d.access === "public" ? `${d.name} is open to everyone on this server.` : `${d.name} is private.`);
                  else if (d && "quota_mb" in patch) done(d.quota_mb ? `Workspace quota set to ${d.quota_mb} MB.` : "Workspace quota removed.");
                }} />
                {!admin ? <div className="settingsPaneHint">Access and the workspace's quota are set by a server admin.</div> : null}
              </Section>
            ) : null}
            {!isPersonal ? (
              <Section
                title="Members"
                action={manages ? (
                  <button className="uiBtn sm" disabled={ws.busy} onClick={() => { ws.setError(""); setInviting(true); }}>
                    <PlusIcon size={13} /> Invite
                  </button>
                ) : null}
              >
                <MembersList info={info} me={me} canManage={manages} busy={ws.busy} onSetRole={ws.setRole} onRemove={remove} />
                {info.access === "public" && !explicitMember ? (
                  <div className="settingsPaneHint">You are in because the workspace is public — everyone on this server is.</div>
                ) : manages ? (
                  <div className="settingsPaneHint">Naming someone Owner hands the workspace on; the role menu is how ownership moves.</div>
                ) : null}
              </Section>
            ) : null}
            <Section title="Actions">
              {mine && !info.default ? (
                <Row icon={CheckIcon} label="Default workspace" hint="where the extension and plain links land"
                  title="Requests that name no workspace — the browser extension's clips, older clients, a link without a workspace — land in your default workspace.">
                  <button className="uiBtn sm" disabled={ws.busy} onClick={async () => { const d = await ws.update({ default: true }); if (d) done(`${d.name} is now your default workspace.`); }}>
                    Make default
                  </button>
                </Row>
              ) : null}
              {isPersonal && !admin ? (
                <Row icon={UsersIcon} label="Sharing" hint="a personal workspace is just you"
                  title="Share a page with a link, or ask a server admin for a shared workspace to work with others.">
                  <span className="settingDesc">page links only</span>
                </Row>
              ) : null}
              {admin && isPersonal ? (
                <Row icon={UsersIcon} label="Convert to shared" hint="let people in; the owner stays owner, it stops counting against them">
                  <button className="uiBtn sm" disabled={ws.busy} onClick={() => convert("shared")}>Make shared</button>
                </Row>
              ) : null}
              {admin && !isPersonal && info.members?.length === 1 ? (
                <Row icon={UserIcon} label="Convert to personal" hint={`hand it to ${info.members[0].username} as a personal workspace`}>
                  <button className="uiBtn sm" disabled={ws.busy} onClick={() => convert("personal")}>Make personal</button>
                </Row>
              ) : null}
              {admin && !isPersonal && !explicitMember ? (
                <Row icon={ShieldIcon} label="Join as owner" hint={info.access === "public" ? "everyone can already open it; this adds you as an owner" : "add yourself so you can open it"}>
                  <button className="uiBtn sm" disabled={ws.busy} onClick={async () => { const d = await ws.setRole(me, "owner"); if (d) done(`You now own ${d.name}.`); }}>
                    Join
                  </button>
                </Row>
              ) : null}
              {!isPersonal && explicitMember && !soleOwner ? (
                <Row icon={LogOutIcon} label="Leave" hint="you will need a new invitation to come back">
                  <button className="uiBtn sm" disabled={ws.busy} onClick={() => remove(me)}>Leave</button>
                </Row>
              ) : null}
              {canDelete ? (
                <Row icon={Trash2Icon} label="Delete workspace" hint={isPersonal ? "everything in it, and its backups" : "everything in it, for every member"}>
                  <button className="uiBtn sm danger" disabled={ws.busy} onClick={destroy}>Delete…</button>
                </Row>
              ) : null}
            </Section>
          </>
        ) : null}
        {ws.error && !inviting && !renaming ? <div className="settingsPaneHint aiKeysError">{ws.error}</div> : null}
        <div className="reportModalBtns">
          {canOpen || explicitMember ? <button className="uiBtn" onClick={onOpen}>Open</button> : null}
          <button className="uiBtn primary" onClick={onClose}>Done</button>
        </div>
      </div>
      {renaming ? (
        <NameDialog title="Rename workspace" label="Name" initial={info?.name} submitLabel="Save"
          busy={ws.busy} error={ws.error} onSubmit={saveName} onClose={() => { setRenaming(false); ws.setError(""); }} />
      ) : null}
      {inviting ? (
        <InviteDialog
          name={title} accounts={accounts} exclude={(info?.members || []).map((m) => m.username)}
          busy={ws.busy} error={ws.error} onSubmit={invite} onClose={() => { setInviting(false); ws.setError(""); }}
        />
      ) : null}
    </Surface>
  );
}

// The Export / Import menus every workspace row carries. Export downloads
// an /api/export zip of that workspace; Import restores or merges one into
// it (owners restore, editors merge).
export function WorkspaceDataMenus({ w, exportWorkspace, importWorkspace, closeSettings }) {
  const run = (fn) => { closeSettings?.(); fn(); }; // progress shows in the status pill, the confirm wants the screen
  return (
    <>
      <ActionMenu
        label="Export" icon={ExportIcon}
        items={[
          { icon: ExportIcon, label: "Everything (.zip)", title: `A zip of ${w.name}: its databases + every uploaded PDF`,
            onClick: () => run(() => exportWorkspace(w.id, true)) },
          { icon: DatabaseIcon, label: "Database only (.zip)", title: "A small zip with just the databases — no uploaded PDFs",
            onClick: () => run(() => exportWorkspace(w.id, false)) },
        ]}
      />
      {w.role !== "viewer" ? (
        <ActionMenu
          label="Import" icon={ImportIcon}
          items={[
            ...(w.role === "owner" ? [{ icon: ImportIcon, label: "Restore (replace)…", title: `Replace ${w.name}'s pages and chats with a backup zip`,
                                        onClick: () => run(() => importWorkspace(w.id, "replace")) }] : []),
            { icon: PlusIcon, label: "Merge into it…", title: "Add the backup's pages that are not there yet; nothing existing changes",
              onClick: () => run(() => importWorkspace(w.id, "merge")) },
          ]}
        />
      ) : null}
    </>
  );
}

export function WorkspacesSettings({ value }) {
  const { workspace, me, isAdmin, switchWorkspace, refreshSession,
          exportWorkspace, exportAll, importWorkspace, setStatus, confirm, closeSettings } = value;
  const [data, setData] = React.useState(null);  // GET /api/workspaces/mine: {workspaces, account}
  const [error, setError] = React.useState("");
  const [manage, setManage] = React.useState(null); // workspace id
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const accounts = useAccounts();
  const currentId = workspace?.id;

  const refresh = React.useCallback(() => {
    apiJson(`${API}/workspaces/mine`).then(setData).catch((err) => setError(err.message));
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  const all = data?.workspaces || [];
  const personal = all.filter((w) => w.personal);
  const shared = all.filter((w) => !w.personal);

  async function submitCreate(name) {
    setBusy(true);
    setCreateError("");
    try {
      const d = await apiJson(`${API}/workspaces`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      setCreating(false);
      closeSettings?.();
      switchWorkspace(d.id); // open it right away
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // After leaving or deleting the open workspace there is nothing to stay
  // in: go to the default one. Otherwise just refresh the lists.
  function left(id) {
    if (id === currentId) {
      closeSettings?.();
      switchWorkspace(all.find((w) => w.default && w.id !== id)?.id || all.find((w) => w.personal && w.id !== id)?.id);
      return;
    }
    refresh();
    refreshSession?.();
  }

  function row(w) {
    const current = w.id === currentId;
    const isPublic = w.access === "public";
    return (
      <div key={w.id} className="aiProvRow">
        <span className={`aiProvAvatar ${current ? "active" : ""}`}>
          {current ? <CheckIcon size={15} /> : w.personal ? <UserIcon size={15} /> : isPublic ? <GlobeIcon size={15} /> : <UsersIcon size={15} />}
        </span>
        <span className="aiProvMeta">
          <span className="aiProvName">
            {w.name}
            {w.default ? <span className="uiTag">default</span> : null}
            {isPublic ? <span className="uiTag">public</span> : null}
            {current ? <span className="uiTag">open</span> : null}
          </span>
          <span className="aiProvDesc">
            {w.personal ? "just you" : `${ROLE_LABEL[w.role] || w.role} · ${w.members} member${w.members === 1 ? "" : "s"}`}
            {` · ${fmtBytes(w.used_bytes)}`}
          </span>
        </span>
        <span className="aiProvActions">
          {!current ? <button className="uiBtn sm" onClick={() => { closeSettings?.(); switchWorkspace(w.id); }}>Open</button> : null}
          <WorkspaceDataMenus w={w} exportWorkspace={exportWorkspace} importWorkspace={importWorkspace} closeSettings={closeSettings} />
          <button className="uiBtn sm" onClick={() => setManage(w.id)} title={`Manage ${w.name}`}>
            <PenIcon size={13} /> Manage
          </button>
        </span>
      </div>
    );
  }

  if (manage) return (
    <ManageWorkspaceDialog inline
      wsId={manage} me={me} admin={isAdmin} accounts={accounts} confirm={confirm} setStatus={setStatus}
      canOpen={manage !== currentId} personalCount={personal.length}
      onOpen={() => { closeSettings?.(); switchWorkspace(manage); }}
      onClose={() => { setManage(null); refresh(); refreshSession?.(); }}
      onLeft={left}
    />
  );

  return (
    <>
      <PaneHead icon={UsersIcon} title="Workspaces">
        Your libraries. Personal workspaces are just you and share your storage; shared ones are made by an admin and have members.
      </PaneHead>
      {!data && !error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
      {error ? <Empty icon={UsersIcon}>Workspaces unavailable — {error}</Empty> : null}
      {data ? (
        <>
          <Section title="Storage">
            <Row icon={DatabaseIcon} label="Your storage" hint={`all your personal workspaces together${data.account.max_upload_mb ? ` · max ${data.account.max_upload_mb} MB per file` : ""}`}
              title="Uploads into your personal workspaces count against your account's quota. Shared workspaces carry their own.">
              <QuotaMeter usedBytes={data.account.used_bytes} quotaMb={data.account.quota_mb} />
            </Row>
          </Section>
          <Section
            title="Personal"
            action={(
              <span className="aiProvActions">
                <ActionMenu
                  label="Export all" icon={ExportIcon} disabled={!personal.length}
                  items={[
                    { icon: ExportIcon, label: "Everything (.zip)", title: "One zip holding an export of each personal workspace, PDFs included",
                      onClick: () => { closeSettings?.(); exportAll(true); } },
                    { icon: DatabaseIcon, label: "Databases only (.zip)", title: "One zip holding a database-only export of each personal workspace",
                      onClick: () => { closeSettings?.(); exportAll(false); } },
                  ]}
                />
                <button className="uiBtn sm" disabled={busy} onClick={() => { setCreateError(""); setCreating(true); }}>
                  <PlusIcon size={13} /> New workspace
                </button>
              </span>
            )}
          >
            {personal.map(row)}
          </Section>
          <Section title="Shared">
            {shared.length ? shared.map(row) : (
              <Empty icon={UsersIcon}>
                {isAdmin ? "No shared workspaces yet — make one in Settings → Server." : "No shared workspaces yet — an admin makes them."}
              </Empty>
            )}
          </Section>
        </>
      ) : null}

      {creating ? (
        <NameDialog title="New personal workspace" label="Name"
          hint={`a separate library of your own — work, life, play${isAdmin ? "; shared workspaces are made in Settings → Server" : "; ask an admin for a shared one"}`}
          submitLabel="Create and open" busy={busy} error={createError} onSubmit={submitCreate} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}

// Settings → Workspace: the library this tab works in — rename it, invite
// people and set their roles, leave or delete it, back it up or restore
// one — plus creating another workspace and switching. GUI for
// /api/workspaces* (docs/dev/workspaces.md). Owner-only actions are shown
// to owners (and server admins); everyone else sees the member list.
import React from "react";
import { API, apiJson } from "./utils";
import { ActionMenu, MenuSelect } from "./menus";
import { PaneHead, Section, SubDialog, Field, Empty, QuotaMeter } from "./settingsKit";
import {
  CheckIcon, DatabaseIcon, ExportIcon, ImportIcon, LogOutIcon, PenIcon, PlusIcon,
  ShieldIcon, Trash2Icon, UserIcon, UsersIcon,
} from "./icons";

const ROLE_OPTIONS = [["owner", "Owner"], ["editor", "Can edit"], ["viewer", "View only"]];
const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS);

export function WorkspaceSettings({ value }) {
  const { workspace, workspaces, me, isAdmin, quotaInfo, switchWorkspace, refreshSession,
          exportUserData, importUserData, setStatus, confirm, closeSettings } = value;
  const [info, setInfo] = React.useState(null); // GET /api/workspaces/{id}: members + quota
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [rename, setRename] = React.useState(null);   // the name being edited
  const [invite, setInvite] = React.useState(null);   // {username, role}
  const [create, setCreate] = React.useState(null);   // {name}
  const wsId = workspace?.id;

  React.useEffect(() => {
    if (!wsId) return;
    setInfo(null);
    apiJson(`${API}/workspaces/${encodeURIComponent(wsId)}`).then(setInfo).catch((err) => setError(err.message));
  }, [wsId]);

  const role = info?.role || workspace?.role;
  const owner = role === "owner" || isAdmin;

  async function call(path, method, body) {
    setBusy(true);
    setError("");
    try {
      return await apiJson(`${API}/workspaces${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveRename() {
    const d = await call(`/${encodeURIComponent(wsId)}`, "PUT", { name: rename });
    if (!d) return;
    setInfo((prev) => ({ ...prev, ...d }));
    setRename(null);
    setStatus(`Renamed to ${d.name}.`);
    refreshSession?.(); // the switcher and the account card show the new name
  }

  async function submitInvite() {
    const name = (invite?.username || "").trim();
    if (!name) { setError("Enter a username."); return; }
    const d = await call(`/${encodeURIComponent(wsId)}/members/${encodeURIComponent(name)}`, "PUT", { role: invite.role });
    if (!d) return;
    setInfo((prev) => ({ ...prev, ...d }));
    setInvite(null);
    setStatus(`${name} can now ${invite.role === "viewer" ? "view" : invite.role === "editor" ? "edit" : "manage"} ${d.name}.`);
  }

  async function setRole(username, newRole) {
    const d = await call(`/${encodeURIComponent(wsId)}/members/${encodeURIComponent(username)}`, "PUT", { role: newRole });
    if (d) setInfo((prev) => ({ ...prev, ...d }));
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
        const d = await call(`/${encodeURIComponent(wsId)}/members/${encodeURIComponent(username)}`, "DELETE");
        if (!d) return;
        if (leaving) {
          closeSettings?.();
          switchWorkspace(workspaces.find((w) => w.personal)?.id);
          return;
        }
        setInfo((prev) => ({ ...prev, members: (prev?.members || []).filter((m) => m.username !== username) }));
        setStatus(`Removed ${username}.`);
      },
    });
  }

  function deleteWorkspace() {
    confirm({
      title: "Delete workspace",
      message: `Delete "${info?.name}" with ALL its pages, PDFs and chats, for every member? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        const d = await call(`/${encodeURIComponent(wsId)}`, "DELETE");
        if (!d) return;
        closeSettings?.();
        switchWorkspace(workspaces.find((w) => w.personal)?.id);
      },
    });
  }

  async function submitCreate() {
    const name = (create?.name || "").trim();
    if (!name) { setError("Give the workspace a name."); return; }
    const d = await call("", "POST", { name });
    if (!d) return;
    setCreate(null);
    closeSettings?.();
    switchWorkspace(d.id); // open it right away
  }

  function memberRow(m) {
    const self = m.username === me;
    const lastOwner = m.role === "owner" && (info?.members || []).filter((x) => x.role === "owner").length <= 1;
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
            {ROLE_LABEL[m.role] || m.role}
            {m.added_by && m.added_by !== m.username ? ` · invited by ${m.added_by}` : ""}
          </span>
        </span>
        <span className="aiProvActions">
          {owner ? (
            <MenuSelect
              value={m.role} label="Role" options={ROLE_OPTIONS}
              onChange={(r) => { if (r !== m.role) setRole(m.username, r); }}
            />
          ) : null}
          {(owner || self) && !(lastOwner && self) && !(self && info?.personal) ? (
            <button
              className="uiBtn sm iconSq" disabled={busy}
              title={self ? "Leave this workspace" : `Remove ${m.username}`}
              aria-label={self ? "Leave" : "Remove"}
              onClick={() => removeMember(m.username)}
            >
              {self ? <LogOutIcon size={13} /> : <Trash2Icon size={13} />}
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  if (!workspace) return <Empty icon={UsersIcon}>No workspace open.</Empty>;
  const name = info?.name || workspace.name;

  return (
    <>
      <PaneHead icon={UsersIcon} title={name}>
        {info?.personal
          ? "Your personal workspace. Invite people to share it, or create a separate one for a group."
          : `A shared workspace · you ${role === "owner" ? "own it" : role === "editor" ? "can edit" : "can view"}.`}
      </PaneHead>

      <Section
        title="This workspace"
        action={owner ? (
          <button className="uiBtn sm" disabled={busy} onClick={() => { setError(""); setRename(name); }}>
            <PenIcon size={13} /> Rename
          </button>
        ) : null}
      >
        {info?.quota ? (
          <div className="settingRow setRow" title="Uploads into this workspace count against its billing account's storage quota">
            <span className="setIcon"><DatabaseIcon size={15} /></span>
            <span className="settingText">
              <span className="settingLabel">Storage</span>
              <span className="settingDesc">
                billed to {info.quota.billed_to || "—"}
                {info.quota.quota_mb ? ` · quota ${info.quota.quota_mb} MB` : " · unlimited"}
              </span>
              <QuotaMeter usedBytes={info.quota.used_bytes} quotaMb={info.quota.quota_mb} />
            </span>
          </div>
        ) : null}
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
          {owner && !info?.personal ? (
            <button className="uiBtn danger" disabled={busy} onClick={deleteWorkspace}>
              <Trash2Icon size={13} /> Delete workspace…
            </button>
          ) : null}
        </div>
      </Section>

      <Section
        title="Members"
        action={owner ? (
          <button className="uiBtn sm" disabled={busy} onClick={() => { setError(""); setInvite({ username: "", role: "editor" }); }}>
            <PlusIcon size={13} /> Invite
          </button>
        ) : null}
      >
        {!info && !error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
        {(info?.members || []).map(memberRow)}
      </Section>

      <Section
        title="Your workspaces"
        action={(
          <button className="uiBtn sm" disabled={busy} onClick={() => { setError(""); setCreate({ name: "" }); }}>
            <PlusIcon size={13} /> New workspace
          </button>
        )}
      >
        {workspaces.map((w) => (
          <div key={w.id} className="aiProvRow">
            <span className={`aiProvAvatar ${w.id === wsId ? "active" : ""}`}>
              {w.id === wsId ? <CheckIcon size={15} /> : <UsersIcon size={15} />}
            </span>
            <span className="aiProvMeta">
              <span className="aiProvName">
                {w.name}
                {w.personal ? <span className="uiTag">personal</span> : null}
              </span>
              <span className="aiProvDesc">
                {w.personal ? "" : `${ROLE_LABEL[w.role] || w.role} · `}{w.members} member{w.members === 1 ? "" : "s"}
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

      {error && !rename && !invite && !create ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}

      {rename !== null ? (
        <SubDialog title="Rename workspace" onClose={() => setRename(null)}>
          <div className="settingsForm">
            <Field label="Name">
              <input
                className="aiKeyInput" type="text" autoFocus value={rename}
                onChange={(e) => setRename(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveRename(); }}
              />
            </Field>
            {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
            <div className="reportModalBtns">
              <button className="uiBtn" onClick={() => setRename(null)}>Cancel</button>
              <button className="uiBtn primary" disabled={busy} onClick={saveRename}>Save</button>
            </div>
          </div>
        </SubDialog>
      ) : null}

      {invite ? (
        <SubDialog title={`Invite to ${name}`} onClose={() => setInvite(null)}>
          <div className="settingsForm">
            <Field label="Username" hint="an account on this server">
              <input
                className="aiKeyInput" type="text" spellCheck={false} autoFocus
                value={invite.username}
                onChange={(e) => setInvite((f) => ({ ...f, username: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") submitInvite(); }}
              />
            </Field>
            <Field label="Role" hint="owners manage members; editors write; viewers read">
              <MenuSelect value={invite.role} label="Role" options={ROLE_OPTIONS} block
                onChange={(r) => setInvite((f) => ({ ...f, role: r }))} />
            </Field>
            {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
            <div className="reportModalBtns">
              <button className="uiBtn" onClick={() => setInvite(null)}>Cancel</button>
              <button className="uiBtn primary" disabled={busy} onClick={submitInvite}>Invite</button>
            </div>
          </div>
        </SubDialog>
      ) : null}

      {create ? (
        <SubDialog title="New workspace" onClose={() => setCreate(null)}>
          <div className="settingsForm">
            <Field label="Name" hint="a separate library — e.g. a lab, a course, a reading pile">
              <input
                className="aiKeyInput" type="text" autoFocus value={create.name}
                onChange={(e) => setCreate({ name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); }}
              />
            </Field>
            {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
            <div className="reportModalBtns">
              <button className="uiBtn" onClick={() => setCreate(null)}>Cancel</button>
              <button className="uiBtn primary" disabled={busy} onClick={submitCreate}>Create and open</button>
            </div>
          </div>
        </SubDialog>
      ) : null}
    </>
  );
}

// Settings → Users: the GUI for /api/admin/users*. Two separate editors per
// account — credentials (rename/password/privilege) and storage limits —
// and, nested under each account row, its personal workspaces (from
// /api/admin/workspaces) with Open / Manage (the workspace dialog from
// settingsWorkspace.jsx in admin mode). Shared workspaces are not per
// account, so they stay in Settings → Server.
//
// Non-admins get this pane too, as "You": a single read-only row for
// themselves. /api/admin/* is admin-only, so their row is built from the
// session + /api/quota instead of the accounts listing, and there is no
// editor. Backups of anyone's workspaces live in Settings → Backups (and,
// for admins, Settings → Server), not here.
import React from "react";
import { API, apiJson, fmtBytes } from "./utils";
import { PaneHead, SubDialog, Field, UnitInput, Empty, QuotaMeter, PasswordInput } from "./settingsKit";
import { ManageWorkspaceDialog, useAccounts } from "./settingsWorkspace";
import { BookIcon, HardDriveIcon, PenIcon, PlusIcon, ShieldIcon, Trash2Icon, UserIcon, UsersIcon } from "./icons";

export function UsersSettings({ value, selfOnly = false }) {
  const { setStatus, confirm, onSelfRenamed, refreshQuota, isAdmin, me, isGuest, quotaInfo,
    workspaces: mine, switchWorkspace, refreshSession, closeSettings } = value;
  const [info, setInfo] = React.useState(null); // {users, me}
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [edit, setEdit] = React.useState(null); // {original, username, password, is_admin, max_upload_mb, quota_mb}
  const [addForm, setAddForm] = React.useState(null); // {username, password, is_admin}
  const [wsRows, setWsRows] = React.useState(null); // /api/admin/workspaces, personal ones only
  const [manage, setManage] = React.useState(null); // workspace id being managed
  const listWorkspaces = isAdmin && !selfOnly;

  const [defaults, setDefaults] = React.useState(null); // {max_upload_mb, quota_mb} server-wide
  React.useEffect(() => {
    if (!isAdmin) {
      refreshQuota?.(); // the self row's storage meter comes from /api/quota
      return;
    }
    apiJson(`${API}/admin/users`).then((d) => setInfo(d)).catch((err) => setError(err.message));
    apiJson(`${API}/admin/settings`).then(setDefaults).catch(() => {});
  }, [isAdmin]);
  const refreshWorkspaces = React.useCallback(() => {
    if (!listWorkspaces) return;
    apiJson(`${API}/admin/workspaces`)
      .then((d) => setWsRows((d.workspaces || []).filter((w) => w.personal)))
      .catch(() => setWsRows([]));
  }, [listWorkspaces]);
  React.useEffect(() => { refreshWorkspaces(); }, [refreshWorkspaces]);
  const openable = new Set((mine || []).map((w) => w.id));
  // An account's personal workspaces, its default first. The admin listing
  // keys them by username, so account changes re-fetch (usersCall below).
  const personalOf = (username) => (wsRows || [])
    .filter((w) => w.personal === username)
    .sort((a, b) => (b.default - a.default) || a.name.localeCompare(b.name));

  const myName = isAdmin ? info?.me : me;
  // /api/quota reports effective limits (overrides already resolved), which is
  // exactly what the self row shows — no "blank = inherit" distinction to make.
  const rows = isAdmin ? (info?.users || []) : [{
    username: me,
    is_guest: isGuest,
    is_admin: false,
    created_at: null,
    used_bytes: quotaInfo?.used_bytes,
    max_upload_mb: quotaInfo?.max_upload_mb ?? null,
    quota_mb: quotaInfo?.quota_mb ?? null,
  }];
  const lastAdmin = (u) => u.is_admin && (info?.users || []).filter((x) => x.is_admin && !x.is_guest).length <= 1;

  // Mutation responses carry the fresh users list but omit used_bytes (the
  // server only stats every account's disk on the GET listing) — carry the
  // last known usage forward. Returns the response, or null after setError.
  async function usersCall(path, method, body) {
    setBusy(true);
    setError("");
    try {
      const d = await apiJson(`${API}/admin/users${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      setInfo((prev) => {
        const usage = new Map((prev?.users || []).map((u) => [u.username, u.used_bytes]));
        if (d.renamed) usage.set(d.renamed.to, usage.get(d.renamed.from));
        return {
          ...prev,
          users: d.users.map((u) => (u.used_bytes == null ? { ...u, used_bytes: usage.get(u.username) ?? 0 } : u)),
          me: d.renamed?.from === prev?.me ? d.renamed.to : prev?.me,
        };
      });
      refreshWorkspaces(); // created / renamed / deleted accounts change the nested rows
      return d;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Two separate editors per account: credentials (rename/password/privilege)
  // and storage limits — each its own button and dialog.
  // edit = {kind: "account", original, username, password, is_admin}
  //      | {kind: "storage", original, max_upload_mb, quota_mb}
  function openAccount(u) {
    setError("");
    setAddForm(null);
    setEdit({ kind: "account", original: u, username: u.username, password: "", is_admin: !!u.is_admin });
  }

  function openStorage(u) {
    setError("");
    setAddForm(null);
    setEdit({ kind: "storage", original: u, max_upload_mb: u.max_upload_mb ?? "", quota_mb: u.quota_mb ?? "" });
  }

  // "" = inherit the server default (sent as explicit null), digits = override
  function parseLimit(s) {
    const t = String(s ?? "").trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : NaN;
  }

  async function saveAccount() {
    const u = edit.original;
    const payload = {};
    if (edit.password) payload.password = edit.password;
    if (edit.is_admin !== !!u.is_admin) payload.is_admin = edit.is_admin;
    const newName = (edit.username || "").trim();
    const renaming = newName && newName !== u.username;
    if (!Object.keys(payload).length && !renaming) { setEdit(null); return; }
    if (Object.keys(payload).length) {
      if (!await usersCall(`/${encodeURIComponent(u.username)}`, "PUT", payload)) return;
    }
    if (renaming) {
      const d = await usersCall(`/${encodeURIComponent(u.username)}/rename`, "POST", { new_username: newName });
      if (!d) return;
      if (d.renamed) setStatus(`Renamed ${d.renamed.from} → ${d.renamed.to}. Sessions keep working.`);
      // Renamed yourself? Re-read the session so the whole app re-keys
      // (avatar, per-user prefs, synced tabs all follow the new name).
      if (d.renamed?.from === myName) onSelfRenamed?.();
    } else {
      setStatus(`Updated ${u.username}.`);
    }
    setEdit(null);
  }

  async function saveStorage() {
    const u = edit.original;
    const maxMb = parseLimit(edit.max_upload_mb);
    const quotaMb = parseLimit(edit.quota_mb);
    if (Number.isNaN(maxMb) || Number.isNaN(quotaMb)) {
      setError("Storage limits must be whole numbers of MB, or blank for the server default.");
      return;
    }
    const payload = {};
    if (maxMb !== (u.max_upload_mb ?? null)) payload.max_upload_mb = maxMb;
    if (quotaMb !== (u.quota_mb ?? null)) payload.quota_mb = quotaMb;
    if (Object.keys(payload).length) {
      if (!await usersCall(`/${encodeURIComponent(u.username)}`, "PUT", payload)) return;
      setStatus(`Storage limits updated for ${u.username}.`);
      if (u.username === myName) refreshQuota?.();
    }
    setEdit(null);
  }

  function deleteAccount(u) {
    confirm({
      title: "Delete user",
      message: `Delete "${u.username}" and ALL their data (notes, PDFs, settings)? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        const d = await usersCall(`/${encodeURIComponent(u.username)}`, "DELETE");
        if (!d) return;
        setStatus(d.warning || `Deleted ${u.username}.`);
        setEdit(null);
      },
    });
  }

  async function submitAdd() {
    const f = addForm;
    if (!f?.username.trim() || !f?.password) { setError("Username and password are required."); return; }
    const d = await usersCall("", "POST",
      { username: f.username.trim(), password: f.password, is_admin: !!f.is_admin });
    if (!d) return;
    setStatus(`Created ${f.username.trim()}.`);
    setAddForm(null);
  }

  const closeEdit = () => { setEdit(null); setError(""); };

  function accountDialog() {
    const u = edit.original;
    return (
      <SubDialog title={`Edit ${u.username}`} onClose={closeEdit} draft={edit}>
        <div className="settingsForm">
          <Field label="Username" hint="renaming keeps sessions and share links working">
            <input
              className="aiKeyInput" type="text" spellCheck={false}
              value={edit.username}
              onChange={(e) => setEdit((f) => ({ ...f, username: e.target.value }))}
            />
          </Field>
          <Field label="New password" hint="blank keeps the current one">
            <PasswordInput
              autoComplete="new-password"
              value={edit.password}
              onChange={(e) => setEdit((f) => ({ ...f, password: e.target.value }))}
            />
          </Field>
          <label className="uiCheckRow" title={lastAdmin(u) ? "The last admin can't be demoted" : ""}>
            <input
              type="checkbox" checked={edit.is_admin} disabled={lastAdmin(u)}
              onChange={(e) => setEdit((f) => ({ ...f, is_admin: e.target.checked }))}
            />
            <ShieldIcon size={13} /> Admin privilege
          </label>
          {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
          <div className="reportModalBtns">
            {u.username !== myName ? (
              <button className="uiBtn danger" disabled={busy} onClick={() => deleteAccount(u)}>
                <Trash2Icon size={13} /> Delete…
              </button>
            ) : null}
            <button className="uiBtn" onClick={closeEdit}>Cancel</button>
            <button className="uiBtn primary" disabled={busy} onClick={saveAccount}>Save</button>
          </div>
        </div>
      </SubDialog>
    );
  }

  function storageDialog() {
    const u = edit.original;
    // effective quota = this account's override, else the server default
    const effQuota = u.quota_mb ?? defaults?.quota_mb;
    const defUpload = defaults ? `server default (${defaults.max_upload_mb})` : "server default";
    const defQuota = defaults
      ? `server default (${defaults.quota_mb || "unlimited"})`
      : "server default";
    return (
      <SubDialog title={`Storage limits — ${u.username}`} onClose={closeEdit} draft={edit}>
        <div className="settingsForm">
          <QuotaMeter usedBytes={u.used_bytes} quotaMb={effQuota} />
          <Field label="Max upload size" hint="largest single PDF or image · blank inherits">
            <UnitInput
              unit="MB" min={1} placeholder={defUpload}
              value={edit.max_upload_mb}
              onChange={(max_upload_mb) => setEdit((f) => ({ ...f, max_upload_mb }))}
            />
          </Field>
          <Field label="Storage quota" hint="total for all uploads · blank inherits · 0 = unlimited">
            <UnitInput
              unit="MB" min={0} placeholder={defQuota}
              value={edit.quota_mb}
              onChange={(quota_mb) => setEdit((f) => ({ ...f, quota_mb }))}
            />
          </Field>
          {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
          <div className="reportModalBtns">
            <button className="uiBtn" onClick={closeEdit}>Cancel</button>
            <button className="uiBtn primary" disabled={busy} onClick={saveStorage}>Save</button>
          </div>
        </div>
      </SubDialog>
    );
  }

  function userRow(u) {
    const wsList = listWorkspaces ? personalOf(u.username) : [];
    return (
      <div key={u.username} className="aiProvRow">
        <span className={`aiProvAvatar ${u.is_admin ? "active" : ""}`}>
          {u.is_admin ? <ShieldIcon size={15} /> : <UserIcon size={15} />}
        </span>
        <span className="aiProvMeta">
          <span className="aiProvName">
            {u.username}
            {u.username === myName ? <span className="uiTag">you</span> : null}
            {u.is_admin ? <span className="uiTag admin">admin</span> : null}
            {u.is_guest ? <span className="uiTag">guest</span> : null}
          </span>
          <span className="aiProvDesc">
            {u.is_guest
              ? "shared demo workspace, resets daily"
              : u.created_at // absent on the self row: non-admins can't list accounts
                ? `since ${new Date(u.created_at).toLocaleDateString()}`
                : "signed in"}
            {u.max_upload_mb != null ? ` · max file ${u.max_upload_mb} MB` : ""}
            {u.quota_mb != null ? (u.quota_mb ? ` · quota ${u.quota_mb} MB` : " · unlimited") : ""}
          </span>
          <QuotaMeter usedBytes={u.used_bytes} quotaMb={u.quota_mb ?? defaults?.quota_mb} />
        </span>
        <span className="aiProvActions">
          {isAdmin ? (
            <>
              <button
                className="uiBtn sm iconSq" disabled={busy}
                title={`Storage limits for ${u.username}`}
                aria-label="Storage limits"
                onClick={() => openStorage(u)}
              >
                <HardDriveIcon size={13} />
              </button>
              {!u.is_guest ? (
                <button
                  className="uiBtn sm iconSq" disabled={busy}
                  title={`Rename ${u.username}, set a password, or grant admin`}
                  aria-label="Edit account"
                  onClick={() => openAccount(u)}
                >
                  <PenIcon size={13} />
                </button>
              ) : null}
            </>
          ) : null}
        </span>
        {wsList.length ? (
          <div className="aiProvSub">
            {wsList.map((w) => (
              <div key={w.id} className="aiProvSubRow">
                <span className="aiProvSubIcon"><BookIcon size={13} /></span>
                <span className="aiProvSubMeta">
                  <span className="aiProvSubName">
                    {w.name}
                    {w.default ? <span className="uiTag">default</span> : null}
                  </span>
                  <span className="aiProvDesc">personal workspace · {fmtBytes(w.used_bytes)}</span>
                </span>
                <span className="aiProvActions">
                  {openable.has(w.id) ? (
                    <button className="uiBtn sm" onClick={() => { closeSettings?.(); switchWorkspace?.(w.id); }}>Open</button>
                  ) : null}
                  <button className="uiBtn sm" onClick={() => setManage(w.id)} title={`Manage ${w.name}`}>
                    <PenIcon size={13} /> Manage
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {isAdmin && !selfOnly ? (
        <PaneHead icon={UsersIcon} title="Users">
          Accounts on this server, each with its personal workspaces. The last admin can never be demoted or deleted.
        </PaneHead>
      ) : (
        <PaneHead icon={UserIcon} title="Account">
          Your profile and storage limits. Account changes are managed by an administrator.
        </PaneHead>
      )}
      {isAdmin && !info && !error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
      {(selfOnly ? rows.filter((row) => row.username === me) : rows).map(userRow)}
      {edit?.kind === "account" ? accountDialog() : null}
      {edit?.kind === "storage" ? storageDialog() : null}
      {manage ? (
        <PersonalWorkspaceDialog
          wsId={manage} me={myName} admin confirm={confirm} setStatus={setStatus}
          canOpen={openable.has(manage)}
          onOpen={() => { closeSettings?.(); switchWorkspace?.(manage); }}
          onClose={() => { setManage(null); refreshWorkspaces(); refreshSession?.(); }}
        />
      ) : null}
      {!isAdmin || selfOnly ? null : addForm ? (
        <SubDialog title="Add user" draft={addForm} onClose={() => { setAddForm(null); setError(""); }}>
          <div className="settingsForm">
          <Field label="Username" hint="letters, digits, _ . -">
            <input
              className="aiKeyInput" type="text" spellCheck={false} autoFocus
              value={addForm.username}
              onChange={(e) => setAddForm((f) => ({ ...f, username: e.target.value }))}
            />
          </Field>
          <Field label="Password">
            <PasswordInput
              autoComplete="new-password"
              value={addForm.password}
              onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }}
            />
          </Field>
          <label className="uiCheckRow">
            <input
              type="checkbox" checked={!!addForm.is_admin}
              onChange={(e) => setAddForm((f) => ({ ...f, is_admin: e.target.checked }))}
            />
            <ShieldIcon size={13} /> Grant the admin privilege
          </label>
          {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
          <div className="reportModalBtns">
            <button className="uiBtn" onClick={() => { setAddForm(null); setError(""); }}>Cancel</button>
            <button className="uiBtn primary" disabled={busy} onClick={submitAdd}>
              {busy ? "Creating…" : "Create user"}
            </button>
          </div>
          </div>
        </SubDialog>
      ) : info ? (
        <div className="reportModalBtns settingsAlignStart">
          <button className="uiBtn" onClick={() => { setError(""); setEdit(null); setAddForm({ username: "", password: "", is_admin: false }); }}>
            + Add user
          </button>
        </div>
      ) : null}
      {error && !edit && !addForm ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
    </>
  );
}

// The workspace dialog with the account directory it needs for ownership
// changes — fetched only while a dialog is open (the directory is admin
// territory; the self-only Account pane never asks for it).
function PersonalWorkspaceDialog(props) {
  const accounts = useAccounts();
  return <ManageWorkspaceDialog {...props} accounts={accounts} />;
}

// Share this page — the dialog behind the page header's link button. Built
// like the workspace Manage dialog (settings/SettingsWorkspace.jsx): sections
// of settings rows, a people list, an invite sub-dialog, actions last, every
// control from the shared set. State is the server's share settings
// (docs/dev/api.md "Shares"): every change saves at once, the link itself
// only changes on Reset or Stop.
import React from "react";
import { MenuSelect } from "../shared/ui/Menus";
import { AccountPicker, Empty, Field, Row, Section, SubDialog } from "../settings/SettingsKit";
import { useAccounts } from "../settings/SettingsWorkspace";
import {
  AlertCircleIcon, CheckIcon, GlobeIcon, LinkIcon, PenIcon, PlusIcon, RefreshIcon, ShieldIcon,
  Trash2Icon, UserIcon, UsersIcon,
} from "../shared/ui/Icons";

export const AUDIENCE_OPTIONS = [
  ["anyone", "Anyone with the link", GlobeIcon],
  ["users", "Signed-in users", UsersIcon],
  ["list", "Only people invited", ShieldIcon],
];
export const SHARE_ROLE_OPTIONS = [["view", "Can view"], ["edit", "Can edit"]];

const AUDIENCE_ICON = { anyone: GlobeIcon, users: UsersIcon, list: ShieldIcon };

function audienceHint(settings) {
  if (settings.audience === "anyone") return "no account needed";
  if (settings.audience === "users") return "any account on this server";
  return "nobody beyond the people below";
}

function roleHint(settings) {
  if (settings.audience === "anyone") {
    return settings.role === "edit" ? "whoever holds the link can edit" : "whoever holds the link can read";
  }
  return settings.role === "edit" ? "every signed-in account can edit" : "every signed-in account can read";
}

// Invite: an account from the directory plus its own role, additive to
// general access (the same shape as the workspace invite).
function ShareInviteDialog({ exclude, busy, error, onSubmit, onClose }) {
  const accounts = useAccounts();
  const [username, setUsername] = React.useState("");
  const [role, setRole] = React.useState("view");
  return (
    <SubDialog title="Invite to this page" onClose={onClose} draft={{ username, role }}>
      <div className="settingsForm">
        <Field label="Account" hint="anyone with an account on this server">
          <AccountPicker accounts={accounts} exclude={exclude} value={username} onChange={setUsername} autoFocus />
        </Field>
        <Field label="Access" hint="their own, whatever general access says">
          <MenuSelect value={role} label="Access" options={SHARE_ROLE_OPTIONS} block onChange={setRole} />
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

// One person on the page: the owner (you) or an invited account.
function PersonRow({ name, self, sub, icon: Icon, active, children }) {
  return (
    <div className="aiProvRow">
      <span className={`aiProvAvatar ${active ? "active" : ""}`}><Icon size={15} /></span>
      <span className="aiProvMeta">
        <span className="aiProvName">
          {name}
          {self ? <span className="uiTag">you</span> : null}
        </span>
        <span className="aiProvDesc">{sub}</span>
      </span>
      <span className="aiProvActions">{children}</span>
    </div>
  );
}

// Props: settings (null while loading; {token: null} when unshared), error
// (the last failed save, e.g. an unknown username), me / meIsGuest (the
// owner's account), shareUrl, copied / onCopy, and one callback per action.
// `citation` is the page's citation section (App owns it), shown when the
// page has metadata.
export function ShareDialog({
  settings, error, me, meIsGuest, shareUrl, copied, onCopy,
  onCreate, onUpdate, onInvite, onSetRole, onRemove, onReset, onStop, onClose, citation,
}) {
  const [inviting, setInviting] = React.useState(false);
  const users = settings?.users || [];
  const shared = !!settings?.token;
  const AudienceIcon = shared ? AUDIENCE_ICON[settings.audience] || GlobeIcon : LinkIcon;
  const openEdit = shared && settings.audience === "anyone" && settings.role === "edit";

  async function invite(name, role) {
    const ok = await onInvite(name, role);
    if (ok !== false) setInviting(false);
  }

  return (
    <SubDialog title="Share this page" onClose={onClose} className="shareDialog" closeButton>
      <div className="settingsForm">
        {settings === null ? <Empty icon={LinkIcon}>Loading…</Empty> : null}
        {settings && !shared ? (
          <Section title="Link">
            <Row icon={LinkIcon} label="Share link" hint="not shared yet"
              title="A link lets people open this page — read-only or editable, for anyone or only for accounts you name.">
              <button type="button" className="uiBtn sm primary" onClick={onCreate}>
                <LinkIcon size={13} />Create link
              </button>
            </Row>
          </Section>
        ) : null}
        {shared ? (
          <>
            <Section title="Link">
              <Row icon={LinkIcon} label="Share link" hint={shareUrl} title={shareUrl}>
                <button type="button" className={`uiBtn sm ${copied ? "on" : ""}`} onClick={onCopy} title={shareUrl}>
                  {copied ? <CheckIcon size={13} /> : <LinkIcon size={13} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              </Row>
            </Section>
            <Section title="General access">
              <Row icon={AudienceIcon} label="Who can open the link" hint={audienceHint(settings)}
                title="Anyone: the link alone opens the page. Signed-in users: any account on this server. Only people invited: nobody beyond the list below. Invited people keep their own access either way.">
                <MenuSelect
                  label="Who can open the link" value={settings.audience} options={AUDIENCE_OPTIONS}
                  onChange={(audience) => {
                    if (audience === settings.audience) return;
                    // Opening a link up to everyone never silently makes it editable.
                    onUpdate(audience === "anyone" ? { audience, role: "view" } : { audience });
                  }}
                />
              </Row>
              {settings.audience !== "list" ? (
                <Row icon={PenIcon} label="What they can do" hint={roleHint(settings)}
                  title="Editing is confined to this page: its notes and highlights, never other pages or the page's settings.">
                  <MenuSelect
                    label="What they can do" value={settings.role} options={SHARE_ROLE_OPTIONS}
                    onChange={(role) => { if (role !== settings.role) onUpdate({ role }); }}
                  />
                </Row>
              ) : null}
              {openEdit ? (
                <div className="settingsPaneHint shareWarn">
                  <AlertCircleIcon size={13} />
                  <span>Whoever holds the link can edit this page without signing in. Their changes are recorded under a name they choose. Reset the link if it gets around.</span>
                </div>
              ) : null}
            </Section>
            <Section
              title="People"
              action={
                <button type="button" className="uiBtn sm" onClick={() => setInviting(true)}>
                  <PlusIcon size={13} /> Invite
                </button>
              }
            >
              <PersonRow name={me} self sub="Owner · full access" icon={meIsGuest ? UserIcon : ShieldIcon} active />
              {users.map((u) => (
                <PersonRow key={u.name} name={u.name} sub="Invited · signs in to open" icon={UserIcon}>
                  <MenuSelect
                    label={`What ${u.name} may do`} value={u.role} options={SHARE_ROLE_OPTIONS}
                    onChange={(role) => { if (role !== u.role) onSetRole(u.name, role); }}
                  />
                  <button
                    type="button" className="uiBtn sm iconSq"
                    title={`Remove ${u.name}`} aria-label={`Remove ${u.name}`}
                    onClick={() => onRemove(u.name)}
                  >
                    <Trash2Icon size={13} />
                  </button>
                </PersonRow>
              ))}
              {error && !inviting ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
              {!users.length ? (
                <div className="settingsPaneHint">Invited people open the link with their own account and access, whatever general access says.</div>
              ) : null}
            </Section>
          </>
        ) : null}
        {settings ? citation : null}
        {shared ? (
          <Section title="Actions">
            <Row icon={RefreshIcon} label="Reset link" hint="a new address; the old one stops opening"
              title="Same settings and people, new link — for a link that got further than intended.">
              <button type="button" className="uiBtn sm" onClick={onReset}>Reset link</button>
            </Row>
            <Row icon={Trash2Icon} label="Stop sharing" hint="the link stops working"
              title="Sharing again later makes a new link with default settings.">
              <button type="button" className="uiBtn sm danger" onClick={onStop}>Stop sharing</button>
            </Row>
          </Section>
        ) : null}
      </div>
      {inviting ? (
        <ShareInviteDialog
          exclude={[me, ...users.map((u) => u.name)]}
          error={error}
          onSubmit={invite}
          onClose={() => setInviting(false)}
        />
      ) : null}
    </SubDialog>
  );
}

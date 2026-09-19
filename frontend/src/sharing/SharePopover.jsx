// Share this page — the popover under the page header's link button, like
// the account menu: it hangs off its button (App wraps it in a
// `data-popover="share"` anchor, so the topbar's outside-click / Escape
// rules close it) and is built from the settings kit like the workspace
// Manage dialog: Link (Copy link, Stop sharing), Access, People, Citation.
// State is the server's share settings (docs/dev/api.md "Shares"): every
// change saves at once; the link itself only changes on Stop.
//
// Access is pictured, not described: three tiles say who may open the link
// (Anyone / Signed in / Invited only, the same glyphs the read-only view's
// badge uses) and one View / Edit toggle says what they may do; the one-line
// summary under them is the only prose. Invited people carry their own
// View / Edit toggle on top, whatever the tiles say.
import React from "react";
import { MenuSelect } from "../shared/ui/Menus";
import { AccountPicker, Empty, PictureChoices, Row, Section, Segmented } from "../settings/SettingsKit";
import { useAccounts } from "../settings/SettingsWorkspace";
import {
  AlertCircleIcon, CheckIcon, CopyIcon, EyeIcon, GlobeIcon, LinkIcon, PenIcon, PlusIcon,
  ShieldIcon, Trash2Icon, UserIcon, UsersIcon,
} from "../shared/ui/Icons";

const SHARE_ROLE_OPTIONS = [["view", "Can view"], ["edit", "Can edit"]];
const ROLE_SEGMENTS = [
  ["view", "View", EyeIcon, "Can read the page"],
  ["edit", "Edit", PenIcon, "Can edit this page's notes and highlights — never other pages or the page's settings"],
];

const AUDIENCE_TILES = [
  { value: "anyone", label: "Anyone", hint: "with the link", Icon: GlobeIcon },
  { value: "users", label: "Signed in", hint: "any account here", Icon: UsersIcon },
  { value: "list", label: "Invited only", hint: "the people below", Icon: ShieldIcon },
];

// The one sentence that says what the tiles + toggle add up to.
function accessSummary(settings, invited) {
  const who = settings.audience === "anyone" ? "Anyone with the link"
    : settings.audience === "users" ? "Anyone signed in"
      : null;
  if (!who) return invited ? "Only the people below can open it." : "Nobody can open it until you invite someone.";
  const verb = settings.role === "edit" ? "edit" : "read";
  return `${who} can ${verb} this page${invited ? "; invited people keep their own access" : ""}.`;
}

// Invite, inline under the people list (a popover can't host a modal): an
// account from the directory plus its own role, additive to general access.
function ShareInviteForm({ exclude, error, onSubmit, onCancel }) {
  const accounts = useAccounts();
  const [username, setUsername] = React.useState("");
  const [role, setRole] = React.useState("view");
  return (
    <div className="shareInvite">
      <AccountPicker accounts={accounts} exclude={exclude} value={username} onChange={setUsername} autoFocus compact />
      <div className="shareInviteRow">
        <MenuSelect value={role} label="Access" options={SHARE_ROLE_OPTIONS} onChange={setRole} />
        <span className="shareInviteBtns">
          <button type="button" className="uiBtn sm" onClick={onCancel}>Cancel</button>
          <button type="button" className="uiBtn sm primary" disabled={!username} onClick={() => onSubmit(username, role)}>Invite</button>
        </span>
      </div>
      {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
    </div>
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

// A copyable text box: the rendered text (or a scrolling <pre>) with the
// copy button pinned top-right — the same for the slide citation and BibTeX.
export function CopyBox({ children, copied, onCopy, title, label }) {
  return (
    <div className="copyBox">
      <div className="copyBoxBody">{children}</div>
      <button type="button" className={`uiBtn sm iconSq copyBoxBtn ${copied ? "on" : ""}`} onClick={onCopy} title={title} aria-label={label}>
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
    </div>
  );
}

// Props: settings (null while loading; {token: null} when unshared), error
// (the last failed save, e.g. an unknown username), me / meIsGuest (the
// owner's account), shareUrl, copied / onCopy, and one callback per action.
// `citation` is the page's citation section (App owns it), shown when the
// page has metadata.
export function SharePopover({
  settings, error, me, meIsGuest, shareUrl, copied, onCopy,
  onCreate, onUpdate, onInvite, onSetRole, onRemove, onStop, onClose, citation,
}) {
  const [inviting, setInviting] = React.useState(false);
  const users = settings?.users || [];
  const shared = !!settings?.token;
  const openEdit = shared && settings.audience === "anyone" && settings.role === "edit";

  async function invite(name, role) {
    const ok = await onInvite(name, role);
    if (ok !== false) setInviting(false);
  }

  return (
    <div className="popover sharePopover" role="dialog" aria-label="Share this page">
      <div className="sharePopoverHead">
        <span className="popoverTitle">Share this page</span>
        <button type="button" className="uiClose" onClick={onClose} aria-label="Close" title="Close">×</button>
      </div>
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
                <span className="shareLinkBtns">
                  <button type="button" className={`uiBtn sm ${copied ? "on" : ""}`} onClick={onCopy} title={shareUrl}>
                    {copied ? <CheckIcon size={13} /> : <LinkIcon size={13} />}
                    {copied ? "Copied" : "Copy link"}
                  </button>
                  <button type="button" className="uiBtn sm iconSq danger" onClick={onStop}
                    aria-label="Stop sharing"
                    title="Stop sharing — the link stops working; sharing again later makes a new link with default settings.">
                    <Trash2Icon size={13} />
                  </button>
                </span>
              </Row>
            </Section>
            <Section
              title="Access"
              action={settings.audience !== "list" ? (
                <Segmented
                  value={settings.role} options={ROLE_SEGMENTS}
                  onChange={(role) => { if (role !== settings.role) onUpdate({ role }); }}
                />
              ) : null}
            >
              <PictureChoices
                label="Who can open the link" value={settings.audience}
                options={AUDIENCE_TILES.map(({ value, label, hint, Icon }) => ({
                  value, label, hint,
                  preview: <span className="shareTileIcon" aria-hidden="true"><Icon size={18} /></span>,
                }))}
                onChange={(audience) => {
                  if (audience === settings.audience) return;
                  // Opening a link up to everyone never silently makes it editable.
                  onUpdate(audience === "anyone" ? { audience, role: "view" } : { audience });
                }}
              />
              <div className={`settingsPaneHint shareSummary ${openEdit ? "shareWarn" : ""}`}>
                {openEdit ? <AlertCircleIcon size={13} /> : null}
                <span>
                  {accessSummary(settings, users.length > 0)}
                  {openEdit ? " No sign-in needed; edits are recorded under a name they choose." : ""}
                </span>
              </div>
            </Section>
            <Section
              title="People"
              action={
                <button type="button" className={`uiBtn sm ${inviting ? "on" : ""}`} onClick={() => setInviting((v) => !v)}>
                  <PlusIcon size={13} /> Invite
                </button>
              }
            >
              <PersonRow name={me} self sub="Owner" icon={meIsGuest ? UserIcon : ShieldIcon} active />
              {users.map((u) => (
                <PersonRow key={u.name} name={u.name} sub="Invited" icon={UserIcon}>
                  <Segmented
                    value={u.role} options={ROLE_SEGMENTS}
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
              {inviting ? (
                <ShareInviteForm
                  exclude={[me, ...users.map((u) => u.name)]}
                  error={error}
                  onSubmit={invite}
                  onCancel={() => setInviting(false)}
                />
              ) : error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
            </Section>
          </>
        ) : null}
        {settings ? citation : null}
      </div>
    </div>
  );
}

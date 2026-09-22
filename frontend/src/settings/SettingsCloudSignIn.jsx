// Sign in with Gamma Cloud (backend gamma/cloud_auth.py, docs/dev/cloud_accounts.md):
// - CloudSignInSettings — Settings → Server → Sign-in (admins): the account
//   server's address, the client this server is, and what happens to a cloud
//   identity this server has not seen (refuse / claim / provision).
// - CloudIdentityRow — Settings → Account: the signed-in account's own link
//   to its cloud account (link = a round trip through the account server,
//   unlink = one call; refused for an account that has no password).
import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { Row, Segmented, PasswordInput, useSettingsDraft } from "./SettingsKit";
import { CloudIcon, KeyIcon, UserIcon } from "../shared/ui/Icons";

const POLICIES = [
  ["refuse", "Refuse", null, "Only accounts already linked to a cloud account can sign in"],
  ["claim", "Claim", null, "A cloud account whose handle equals an unlinked username here signs in as it"],
  ["provision", "Provision", null, "Any verified cloud account gets an account here, named after its handle"],
];

export function CloudSignInSettings({ setStatus }) {
  const [saved, setSaved] = React.useState(null); // the `cloud` object of /api/admin/settings
  const [draft, setDraft] = React.useState({ issuer: "", client_id: "", secret: "", policy: "refuse" });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const fromSaved = (c) => ({ issuer: c.issuer || "", client_id: c.client_id === "gamma-desktop" ? "" : (c.client_id || ""),
    secret: "", policy: c.policy || "refuse" });
  React.useEffect(() => {
    let active = true;
    apiJson(`${API}/admin/settings`).then((v) => {
      if (active) { setSaved(v.cloud); setDraft(fromSaved(v.cloud)); }
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const managed = saved?.source === "environment";
  const dirty = !!saved && !managed && JSON.stringify(draft) !== JSON.stringify(fromSaved(saved));
  const discard = () => { setDraft(fromSaved(saved)); setError(""); };
  useSettingsDraft("cloud-sign-in", dirty, discard);
  async function save() {
    if (!saved || managed || busy) return;
    setBusy(true); setError("");
    try {
      const body = { cloud_issuer: draft.issuer.trim(), cloud_client_id: draft.client_id.trim(), cloud_policy: draft.policy };
      if (draft.secret) body.cloud_client_secret = draft.secret;
      const value = await apiJson(`${API}/admin/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      setSaved(value.cloud); setDraft(fromSaved(value.cloud));
      setStatus(value.cloud.enabled ? "Cloud sign-in saved. The login page now offers it." : "Cloud sign-in turned off.");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
  const disabled = !saved || managed || busy;
  return <>
    <Row icon={CloudIcon} label="Account server"
      hint={managed ? "Set by the server's environment" : "The Gamma Cloud address people sign in through; empty turns it off"}
      title="Sign in with Gamma Cloud: this server becomes an OpenID Connect client of the account server. Its login page gets a second button.">
      <span className="setRowControls">
        {saved ? <span className={`uiTag ${saved.enabled ? "ok" : ""}`}>{saved.enabled ? "on" : "off"}</span> : null}
        <input className="aiKeyInput" type="url" aria-label="Account server" value={draft.issuer} spellCheck={false}
          disabled={disabled} placeholder="https://account.gammapdf.com" onChange={(e) => set("issuer")(e.target.value)} />
      </span>
    </Row>
    <Row icon={KeyIcon} label="Client"
      hint="Empty = the desktop app's public client; a hosted server gets its own id and secret"
      title="A local Gamma is the account server's built-in public client (PKCE only). A server the account server provisioned was given a confidential client id and secret.">
      <span className="setRowControls">
        <input className="aiKeyInput" type="text" aria-label="Client id" value={draft.client_id} spellCheck={false}
          disabled={disabled} placeholder="gamma-desktop" onChange={(e) => set("client_id")(e.target.value)} />
        <PasswordInput aria-label="Client secret" value={draft.secret} disabled={disabled}
          placeholder={saved?.has_secret ? "secret set — type to replace" : "no secret"} onChange={(e) => set("secret")(e.target.value)} />
      </span>
    </Row>
    <Row icon={UserIcon} label="Unknown cloud accounts"
      hint="What a cloud account that is not linked to an account here may do"
      title="Refuse: only linked accounts. Claim: a cloud handle equal to an unlinked username here takes it over — for a server whose accounts were created under cloud handles. Provision: every verified cloud account gets an account — the free share host.">
      <span className="setRowControls">
        <Segmented value={draft.policy} onChange={disabled ? () => {} : set("policy")} options={POLICIES} />
        {dirty ? <button className="uiBtn sm primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save sign-in"}</button> : null}
      </span>
    </Row>
    {error ? <p className="settingsPaneHint aiKeysError" role="alert">{error}</p> : null}
  </>;
}

export function CloudIdentityRow({ setStatus, confirm }) {
  const [state, setState] = React.useState(null); // {identity, enabled}
  const [error, setError] = React.useState("");
  const load = React.useCallback(() => {
    apiJson(`${API}/auth/cloud/status`).then(setState).catch((err) => setError(err.message));
  }, []);
  React.useEffect(() => { load(); }, [load]);
  if (!state || !state.enabled) return null;
  const id = state.identity;
  const here = window.location.pathname + window.location.search;
  const link = () => { window.location.assign(`${API}/auth/cloud/start?link=1&next=${encodeURIComponent(here)}`); };
  async function doUnlink() {
    try {
      await apiJson(`${API}/auth/cloud/unlink`, { method: "POST" });
      setStatus?.("Gamma Cloud account unlinked.");
      load();
    } catch (err) { setError(err.message); }
  }
  function unlink() {
    if (!confirm) { doUnlink(); return; }
    confirm({ title: "Unlink Gamma Cloud", message: `This account will no longer sign in as "${id.handle}". You can link it again any time.`,
      confirmLabel: "Unlink", onConfirm: doUnlink });
  }
  return <>
    <Row icon={CloudIcon} label="Gamma Cloud"
      hint={id ? `${id.handle}${id.email ? ` · ${id.email}` : ""}${id.plan ? ` · ${id.plan} plan` : ""}` : "Sign in here with your Gamma Cloud account"}
      title={id ? `Linked ${id.linked_at ? id.linked_at.slice(0, 10) : ""}. Signing in with this cloud account opens this account.`
        : "Link your Gamma Cloud account: you are sent to the account server and back, then either login opens this account."}>
      <span className="setRowControls">
        {id ? <span className="uiTag ok">linked</span> : null}
        {id ? <button className="uiBtn sm" onClick={unlink}>Unlink</button>
            : <button className="uiBtn sm primary" onClick={link}>Link Gamma Cloud account</button>}
      </span>
    </Row>
    {error ? <p className="settingsPaneHint aiKeysError" role="alert">{error}</p> : null}
  </>;
}

import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { Row, useSettingsDraft } from "./SettingsKit";
import { LinkIcon } from "../shared/ui/Icons";

export function PublicUrlSettings({ setStatus }) {
  const [saved, setSaved] = React.useState(null);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const suggested = window.location.origin;
  const initial = (value) => value.public_url || suggested;
  React.useEffect(() => {
    let active = true;
    apiJson(`${API}/admin/settings`).then((value) => {
      if (active) { setSaved(value); setDraft(initial(value)); }
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const managed = saved?.public_url_source === "environment";
  const dirty = !!saved && !managed && draft !== initial(saved);
  const discard = () => { setDraft(initial(saved)); setError(""); };
  useSettingsDraft("public-server-url", dirty, discard);
  async function save() {
    if (!saved || managed || busy) return;
    setBusy(true); setError("");
    try {
      const value = await apiJson(`${API}/admin/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_url: draft.trim() }),
      });
      setSaved(value); setDraft(initial(value));
      setStatus(value.public_url ? "Public server URL saved. Assistant connections now use this address." : "Public server URL cleared.");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <>
    <Row icon={LinkIcon} label="Public server URL"
      hint="Confirm the address assistants use to reach Gamma. Use HTTPS for a remote server; localhost can use HTTP.">
      <input className="aiKeyInput" type="url" aria-label="Public server URL" value={draft} spellCheck={false}
        disabled={!saved || managed || busy} placeholder="https://gamma.example.com"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }} />
    </Row>
    {saved ? <>
      <p className="setNotice">{managed
        ? "This address is managed by the server's environment configuration."
        : saved.public_url
          ? "Changes apply immediately. Changing the address requires assistants to connect again."
          : "Suggested from your browser address. Confirm it once to enable assistant sign-in; no restart is needed."}</p>
      {!managed ? <div className="reportModalBtns">
        <button className="uiBtn sm" disabled={!dirty || busy} onClick={discard}>Cancel address changes</button>
        <button className="uiBtn sm primary" disabled={busy || (!dirty && !!saved.public_url) || (!saved.public_url && !draft.trim())}
          onClick={save}>{busy ? "Saving..." : saved.public_url ? "Save address" : "Confirm address"}</button>
      </div> : null}
    </> : !error ? <p className="setNotice">Loading server address...</p> : null}
    {error ? <p className="settingsPaneHint aiKeysError" role="alert">{error}</p> : null}
  </>;
}

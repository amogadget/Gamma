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
  const confirmed = !!saved?.public_url;
  const needsAction = !!saved && !managed && (dirty || !confirmed) && !!draft.trim();
  return <>
    <Row icon={LinkIcon} label="Public server URL"
      hint={managed ? "Set by the server's environment" : "The address assistants use to reach Gamma; HTTPS unless localhost"}
      title="Assistant sign-in (MCP OAuth) needs to know the address this server is reached at. Confirm it once; no restart. Changing it later makes assistants connect again.">
      <span className="setRowControls">
        {saved && !managed ? (
          <span className={`uiTag ${confirmed && !dirty ? "ok" : ""}`}>{confirmed && !dirty ? "confirmed" : "not confirmed"}</span>
        ) : null}
        <input className="aiKeyInput" type="url" aria-label="Public server URL" value={draft} spellCheck={false}
          disabled={!saved || managed || busy} placeholder="https://gamma.example.com"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }} />
        {needsAction ? (
          <button className="uiBtn sm primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Confirm"}</button>
        ) : null}
      </span>
    </Row>
    {error ? <p className="settingsPaneHint aiKeysError" role="alert">{error}</p> : null}
  </>;
}

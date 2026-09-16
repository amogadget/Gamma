import React from "react";
import { API, apiJson, copyText } from "./utils";
import { PaneHead, Section, Row } from "./settingsKit";
import { LinkIcon } from "./icons";

export function IntegrationSettings({ workspaceId }) {
  const [data, setData] = React.useState(null);
  const [name, setName] = React.useState("Codex");
  const [secret, setSecret] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const endpoint = `${API}/integrations/tokens?ws=${encodeURIComponent(workspaceId)}`;
  React.useEffect(() => {
    let active = true;
    apiJson(endpoint).then((value) => { if (active) setData(value); })
      .catch((err) => { if (active) setMessage(err.message); });
    return () => { active = false; };
  }, [endpoint]);
  const refresh = async () => setData(await apiJson(endpoint));
  const create = async () => {
    setBusy(true); setMessage("");
    try {
      const value = await apiJson(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }) });
      setSecret(value);
      await refresh();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };
  const revoke = async (id) => {
    setBusy(true); setMessage("");
    try {
      await apiJson(`${API}/integrations/tokens/${id}?ws=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
      if (secret?.id === id) setSecret(null);
      await refresh();
      setMessage("Connection revoked.");
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };
  const copy = async (text) => {
    try { setMessage(await copyText(text) ? "Copied." : "Could not copy. Select the text and copy it manually."); }
    catch { setMessage("Could not copy. Select the text and copy it manually."); }
  };
  const config = data ? `[mcp_servers.gamma]\nurl = ${JSON.stringify(data.mcp_url)}\nbearer_token_env_var = "GAMMA_TOKEN"` : "";
  return <>
    <PaneHead icon={LinkIcon} title="External assistants">
      Let Codex and other assistants read this workspace's pages, notes, highlights, and PDF text.
      Retrieved content is sent to the assistant's provider. Connections cannot edit your library.
    </PaneHead>
    <Section title="New connection">
      <Row label="Connection name" hint="Read-only access to the current workspace. Expires after 90 days.">
        <div className="integrationCreateControls">
          <input className="aiKeyInput" aria-label="Connection name" value={name} maxLength={80}
            onChange={(event) => setName(event.target.value)} />
          <button className="uiBtn" disabled={busy || !data || !name.trim() || !!secret} onClick={create}>Create token</button>
        </div>
      </Row>
      {secret ? <div className="integrationDetails">
        <p>Copy this token now. Gamma will not show it again. Keep it private.</p>
        <textarea className="aiKeyInput" aria-label="New integration token" readOnly rows={2} value={secret.token} />
        <div className="integrationActions">
          <button className="uiBtn" onClick={() => copy(secret.token)}>Copy token</button>
          <button className="uiBtn" onClick={() => setSecret(null)}>Done</button>
        </div>
      </div> : null}
    </Section>
    <Section title="Connect Codex">
      {data ? <div className="integrationDetails">
        <p>Set the <code>GAMMA_TOKEN</code> environment variable to your token before starting Codex.
          Add this connection to <code>~/.codex/config.toml</code>, then restart Codex.</p>
        <textarea className="aiKeyInput" aria-label="Codex MCP configuration" readOnly rows={4} value={config} />
        <button className="uiBtn" onClick={() => copy(config)}>Copy configuration</button>
        <p>Gamma must be running. For a remote server, its administrator must allow the server's hostname for MCP.</p>
      </div> : null}
    </Section>
    <Section title="Your connections in this workspace">
      {!data ? <p>Loading connections…</p> : data.tokens.length ? data.tokens.map((item) =>
        <Row key={item.id} label={item.name}
          hint={`${item.expires_at * 1000 <= Date.now() ? "Expired" : "Expires"} ${new Date(item.expires_at * 1000).toLocaleDateString()}`}>
          <button className="uiBtn" disabled={busy} onClick={() => revoke(item.id)}>Revoke</button>
        </Row>) : <p>No connections yet.</p>}
    </Section>
    {message ? <p role="status">{message}</p> : null}
  </>;
}

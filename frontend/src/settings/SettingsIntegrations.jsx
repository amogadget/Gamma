import React from "react";
import { API, apiJson, copyText } from "../shared/lib/utils";
import { PaneHead, Section, Row, Segmented, Step } from "./SettingsKit";
import { LinkIcon } from "../shared/ui/Icons";
import { codexSetupCommand } from "./codexSetup";

function CopyField({ label, value, action, rows = 2 }) {
  const [status, setStatus] = React.useState("");
  React.useEffect(() => setStatus(""), [value]);
  const copy = async () => {
    try { setStatus(await copyText(value) ? "Copied. You can paste it now." : "Select the text above and copy it manually."); }
    catch { setStatus("Select the text above and copy it manually."); }
  };
  return <div className="integrationDetails">
    <textarea className="aiKeyInput" aria-label={label} readOnly rows={rows} value={value}
      onFocus={(event) => event.target.select()} />
    <div className="integrationActions">
      <button className="uiBtn" onClick={copy}>{action}</button>
      <span className="settingDesc" role="status">{status}</span>
    </div>
  </div>;
}

export function IntegrationSettings({ workspaceId }) {
  const [data, setData] = React.useState(null);
  const [name, setName] = React.useState("Codex");
  const [scope, setScope] = React.useState("read");
  const [secret, setSecret] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [method, setMethod] = React.useState("settings");
  const [platform, setPlatform] = React.useState(() => /Windows/i.test(navigator.userAgent) ? "windows" : "unix");
  const [loadError, setLoadError] = React.useState("");
  const endpoint = `${API}/integrations/tokens`;
  const loadVersion = React.useRef(0);
  const refresh = React.useCallback(async (notice = "") => {
    const version = ++loadVersion.current;
    setMessage(notice);
    try {
      const value = await apiJson(endpoint);
      // A focus refresh started before a revocation must not restore its row.
      if (version !== loadVersion.current) return;
      setData(value); setLoadError("");
    } catch (err) {
      if (version === loadVersion.current) setLoadError(err.message);
    }
  }, [endpoint]);
  React.useEffect(() => {
    setData(null); setSecret(null); setMessage(""); setLoadError("");
    const load = () => refresh();
    load();
    window.addEventListener("focus", load);
    const visible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      ++loadVersion.current;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const create = async () => {
    setBusy(true); setMessage("");
    try {
      const value = await apiJson(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scope }) });
      setSecret(value);
      await refresh();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };
  const revoke = async ({ id, name: connectionName }) => {
    setBusy(true); setMessage("");
    try {
      await apiJson(`${API}/integrations/tokens/${id}`, { method: "DELETE" });
      if (secret?.id === id) setSecret(null);
      // DELETE succeeded even if reloading the remaining connections fails.
      setData((value) => value ? { ...value, tokens: value.tokens.filter((item) => item.id !== id) } : value);
      await refresh(`Access revoked for the selected “${connectionName}” connection.`);
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };
  const config = data ? `[mcp_servers.gamma]\nurl = ${JSON.stringify(data.mcp_url)}\nbearer_token_env_var = "GAMMA_TOKEN"` : "";
  const setup = data ? codexSetupCommand(data.mcp_url, platform) : "";
  return <>
    <PaneHead icon={LinkIcon} title="Integrations">Read-only access for Codex or any MCP assistant.</PaneHead>
    {loadError ? <div className="integrationDetails" role="alert">
      <p>Could not load your connections. {loadError}</p>
      <button className="uiBtn" onClick={() => refresh()}>Try again</button>
    </div> : null}
    <Section title="Connect an assistant">
      {data ? <div className="integrationDetails">
        {data.oauth_available ? <>
          <div role="group" aria-label="Connection method">
            <Segmented value={method} onChange={setMethod} options={[["settings", "Any assistant"], ["terminal", "Codex CLI"]]} />
          </div>
          <Step n={1} title={method === "settings" ? "Add Gamma to your assistant" : "Install and connect Gamma PDF"}
            hint={method === "settings" ? "In your assistant's settings, add an MCP server with this URL." : "Run this command on the computer where you use Codex. It installs the plugin and opens Gamma sign-in."}>
            {method === "settings"
              ? <CopyField key="url" label="Gamma MCP server URL" value={data.mcp_url} action="Copy server URL" />
              : <>
                <div role="group" aria-label="Terminal platform">
                  <Segmented value={platform} onChange={setPlatform} options={[["windows", "Windows PowerShell"], ["unix", "macOS / Linux"]]} />
                </div>
                <CopyField key="commands" label="Codex setup command" value={setup} action="Copy setup command" rows={4} />
                <p className="settingDesc">Requires the <a href="https://learn.chatgpt.com/docs/cli" target="_blank" rel="noreferrer">Codex CLI</a>.
                  Downloads the setup script and plugin from <a href="https://github.com/tim4431/Gamma/releases/latest" target="_blank" rel="noreferrer">Gamma's latest release</a>.</p>
              </>}
          </Step>
          <Step n={2} title="Sign in and choose a workspace"
            hint="Follow your assistant's sign-in prompt. Approve read-only access in Gamma. No token to create or paste." />
          <Step n={3} title="Start a new chat"
            hint={method === "terminal" ? 'Mention @Gamma PDF and ask about a paper, or say “Let me choose a paper”.' : 'Try asking: “Use Gamma to find my notes about…”'} />
        </> : <>
          <p>Browser sign-in is not available for this Gamma address yet.</p>
          <p>An administrator can enable it by confirming the public server URL in Settings → Server.</p>
          <details><summary>Server setup details</summary><p>{data.oauth_error}</p></details>
        </>}
      </div> : !loadError ? <p role="status">Loading connection settings…</p> : null}
    </Section>
    <Section title="Workspace access" action={<button className="uiBtn sm" onClick={() => refresh()}>Refresh connections</button>}>
      {data ? data.tokens.length ? data.tokens.map((item) =>
        <Row key={item.id} label={item.name}
          hint={`${item.expires_at * 1000 <= Date.now() ? "Expired" : `${item.scope === "write" ? "Read and write" : "Read-only"} · Expires`} ${new Date(item.expires_at * 1000).toLocaleDateString()}`}>
          <button className="uiBtn" disabled={busy} onClick={() => revoke(item)}>Disconnect</button>
        </Row>) : <div className="integrationDetails"><p>No assistants have access to this workspace yet.</p>
          </div> : null}
    </Section>
    {message ? <p role="status">{message}</p> : null}
    <details className="integrationAdvanced">
      <summary>Manual setup (advanced)</summary>
      <div className="integrationDetails"><p>Use a token if your assistant does not support browser sign-in.</p></div>
      <Section title="Create a token">
      <Row label="Connection name" hint="Access to the current workspace. Expires after 90 days.">
        <div className="integrationCreateControls">
          <input className="aiKeyInput" aria-label="Connection name" value={name} maxLength={80}
            onChange={(event) => setName(event.target.value)} />
          <button className="uiBtn" disabled={busy || !data || !name.trim() || !!secret} onClick={create}>Create token</button>
        </div>
      </Row>
      <Row label="Scope" hint={scope === "write"
        ? "Read and write: what an offline copy on another Gamma (Settings → Workspaces → Offline copies there) signs in with. Assistants only need read."
        : "Read-only: assistants. Choose “Read and write” for an offline copy of this workspace on another Gamma."}>
        <Segmented value={scope} onChange={setScope} options={[["read", "Read-only"], ["write", "Read and write"]]} />
      </Row>
      {secret ? <div className="integrationDetails">
        <p>Copy this token now. Gamma will not show it again. Keep it private.</p>
        <CopyField label="New integration token" value={secret.token} action="Copy token" />
        <div className="integrationActions">
          <button className="uiBtn" onClick={() => setSecret(null)}>Done</button>
        </div>
      </div> : null}
    </Section>
    <Section title="Add the token to Codex">
      {data ? <div className="integrationDetails">
        <p>Set the <code>GAMMA_TOKEN</code> environment variable to your token before starting Codex.
          Add this connection to <code>~/.codex/config.toml</code>, then restart Codex.</p>
        <CopyField label="Codex MCP configuration" value={config} action="Copy configuration" rows={4} />
        <p>Gamma must be running. For a remote server, its administrator must allow the server's hostname for MCP.</p>
      </div> : null}
    </Section>
    </details>
  </>;
}

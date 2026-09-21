import React from "react";
import { API, apiJson, copyText } from "../shared/lib/utils";
import { PaneHead, Section, Row, Segmented, Step } from "./SettingsKit";
import { LinkIcon, KeyIcon, CopyIcon, CheckIcon, RefreshIcon, UnlinkIcon } from "../shared/ui/Icons";
import { codexSetupCommand, claudeConnectCommand, claudePluginInstallCommands } from "./assistantSetup";

const COPIED = "Copied. You can paste it now.";
const COPY_MANUALLY = "Select the text above and copy it manually.";

// A read-only code box with the copy button in its corner. A successful copy
// swaps the icon for a check; the status text is visible only when the
// clipboard was refused (the check already says the rest, but the sentence
// stays in the DOM for assistive tech).
function CopyField({ label, value, action, rows = 2 }) {
  const [status, setStatus] = React.useState("");
  React.useEffect(() => setStatus(""), [value]);
  React.useEffect(() => {
    if (status !== COPIED) return undefined;
    const timer = setTimeout(() => setStatus(""), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  const copy = async () => {
    try { setStatus(await copyText(value) ? COPIED : COPY_MANUALLY); }
    catch { setStatus(COPY_MANUALLY); }
  };
  const copied = status === COPIED;
  return <div className="integrationDetails">
    <div className="integrationCode">
      <textarea className="aiKeyInput" aria-label={label} readOnly rows={rows} value={value}
        onFocus={(event) => event.target.select()} />
      <button type="button" className={`uiBtn sm iconSq integrationCopy${copied ? " on" : ""}`} aria-label={action} title={action} onClick={copy}>
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
    </div>
    <span className={`settingDesc integrationCopyStatus${copied ? " ok" : ""}`} role="status">{status}</span>
  </div>;
}

const dateOf = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// One connected assistant: how it signed in, what it may do, when it was
// connected and when its access lapses. OAuth connections are minted with an
// " (OAuth)" suffix on the client's name (mcp_oauth_provider.py).
function ConnectionRow({ item, busy, onRevoke }) {
  const oauth = /\s\(OAuth\)$/.test(item.name);
  const name = oauth ? item.name.replace(/\s\(OAuth\)$/, "") : item.name;
  const daysLeft = Math.ceil((item.expires_at * 1000 - Date.now()) / 86400000);
  const expiry = daysLeft <= 0 ? `Expired ${dateOf(item.expires_at)}`
    : `Expires ${dateOf(item.expires_at)} (${daysLeft === 1 ? "1 day" : `${daysLeft} days`} left)`;
  const connected = item.created_at ? `Connected ${new Date(item.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : null;
  const parts = [oauth ? "Browser sign-in" : "Token", item.scope === "write" ? "Read and write" : "Read-only", connected, expiry].filter(Boolean);
  return <Row icon={oauth ? LinkIcon : KeyIcon} label={name}
    hint={<>{parts.join(" · ")}{daysLeft <= 0 ? <span className="uiTag warn">Expired</span> : null}</>}>
    <button type="button" className="uiBtn sm iconSq danger" disabled={busy} aria-label="Disconnect"
      title={`Disconnect ${name}: the assistant loses access to this workspace`} onClick={() => onRevoke(item)}>
      <UnlinkIcon size={13} />
    </button>
  </Row>;
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
  const isClaude = method === "claude";
  return <>
    <PaneHead icon={LinkIcon} title="Integrations">Read-only access for Codex, Claude Code, or any MCP assistant.</PaneHead>
    {loadError ? <div className="integrationDetails" role="alert">
      <p>Could not load your connections. {loadError}</p>
      <button className="uiBtn" onClick={() => refresh()}>Try again</button>
    </div> : null}
    <Section title="Connect an assistant">
      {data ? <div className="integrationDetails">
        {data.oauth_available ? <>
          <div role="group" aria-label="Connection method">
            <Segmented value={method} onChange={setMethod} options={[["settings", "Any assistant"], ["terminal", "Codex CLI"], ["claude", "Claude Code"]]} />
          </div>
          <Step n={1} title={method === "settings" ? "Add Gamma to your assistant" : isClaude ? "Connect Claude Code to Gamma" : "Install and connect Gamma PDF"}
            hint={method === "settings" ? "In your assistant's settings, add an MCP server with this URL." : isClaude
              ? "Run this command in a terminal on the computer where you use Claude Code. If Gamma is already connected at this address, continue to sign-in."
              : "Run this command on the computer where you use Codex. It installs the plugin and opens Gamma sign-in."}>
            {method === "settings"
              ? <CopyField key="url" label="Gamma MCP server URL" value={data.mcp_url} action="Copy server URL" />
              : <>
                <div role="group" aria-label="Terminal platform">
                  <Segmented value={platform} onChange={setPlatform} options={[["windows", "Windows PowerShell"], ["unix", "macOS / Linux"]]} />
                </div>
                {isClaude ? <>
                  <CopyField key="claude-connect" label="Claude Code connection command" value={claudeConnectCommand(data.mcp_url, platform)} action="Copy connection command" />
                  <p className="settingDesc">Requires <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">Claude Code</a> and a running Gamma server.</p>
                </> : <>
                  <CopyField key="commands" label="Codex setup command" value={setup} action="Copy setup command" rows={4} />
                  <p className="settingDesc">Requires the <a href="https://learn.chatgpt.com/docs/cli" target="_blank" rel="noreferrer">Codex CLI</a>.
                    Downloads the setup script and plugin from <a href="https://github.com/tim4431/Gamma/releases/latest" target="_blank" rel="noreferrer">Gamma's latest release</a>.</p>
                </>}
              </>}
          </Step>
          <Step n={2} title="Sign in and choose a workspace"
            hint={isClaude ? "Start Claude Code, run /mcp, select gamma, and authenticate. Sign in to Gamma in your browser and approve a workspace."
              : "Follow your assistant's sign-in prompt. Approve read-only access in Gamma. No token to create or paste."} />
          {isClaude ? <>
            <Step n={3} title="Ask about your papers"
              hint="Start a new session and paste a Gamma page or share link with your question, or mention a paper by name. With the Gamma plugin installed, /gamma:gamma starts the workflow.">
              <p className="settingDesc">The MCP connection above is all Claude Code needs to read your library. The plugin (optional) adds the /gamma:gamma workflow and the Gamma identity.</p>
              <details>
                <summary>Install the plugin (once)</summary>
                <p>Download the Claude Code plugin ZIP from <a href="https://github.com/tim4431/Gamma/releases/latest" target="_blank" rel="noreferrer">Gamma's latest release</a> and extract it into a permanent folder.
                  Open a terminal in the folder containing <code>gamma-marketplace</code> and run:</p>
                <CopyField label="Claude Code plugin install commands" value={claudePluginInstallCommands} action="Copy plugin install commands" rows={3} />
                <p className="settingDesc">Choose the asset named <code>gamma-claude-code-plugin</code> followed by the version and <code>.zip</code>.
                  Requires a release that includes the Claude Code plugin. Keep the extracted folder after installing.</p>
              </details>
            </Step>
            <details className="integrationAdvanced">
              <summary>Changed the server address?</summary>
              <p>Open Gamma at its new address, then copy these commands to replace the connection. Your plugin stays installed.
                Restart Claude Code and sign in again through <code>/mcp</code>.</p>
              <CopyField label="Claude Code change server commands" value={claudeConnectCommand(data.mcp_url, platform, { replace: true })} action="Copy change server commands" rows={3} />
              <p className="settingDesc">If Gamma runs on the same computer, localhost keeps working when your LAN IP changes.
                For a remote server, use a stable HTTPS hostname and confirm it in Gamma's Settings → Server.</p>
            </details>
          </> : <Step n={3} title="Start a new chat"
            hint={method === "terminal" ? 'Copy the Gamma page URL from your browser and paste it with your question. A share link works too.' : 'Try asking: “Use Gamma to find my notes about…”'} />}
        </> : <>
          <p>Browser sign-in is not available for this Gamma address yet.</p>
          <p>An administrator can enable it by confirming the public server URL in Settings → Server.</p>
          <details><summary>Server setup details</summary><p>{data.oauth_error}</p></details>
        </>}
      </div> : !loadError ? <p role="status">Loading connection settings…</p> : null}
    </Section>
    <Section title="Workspace access" action={
      <button type="button" className="uiBtn sm iconSq" aria-label="Refresh connections" title="Refresh connections" onClick={() => refresh()}>
        <RefreshIcon size={13} />
      </button>}>
      {data ? data.tokens.length ? data.tokens.map((item) => <ConnectionRow key={item.id} item={item} busy={busy} onRevoke={revoke} />)
        : <div className="integrationDetails"><p>No assistants have access to this workspace yet.</p></div> : null}
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
        ? "Read and write: what an offline copy on another Gamma (Settings → Workspaces → Clones there) signs in with. Assistants only need read."
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

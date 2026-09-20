import React from "react";
import { MenuSelect } from "../shared/ui/Menus";
import { API, apiJson, setExpectedUser } from "../shared/lib/utils";
import { AuthLoading, LoginPage, SessionConflictPage } from "./LoginPage";

// A standalone sign-in gate: no workspace/session restoration runs while the
// user is reviewing a request. Keep the request URL through account changes.
export function McpAuthorization({ requestId }) {
  const [user, setUser] = React.useState(null);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [conflict, setConflict] = React.useState("");
  const acceptSession = (data) => {
    const next = data.user || false;
    setExpectedUser(next);
    setUser(next);
    if (next) {
      try { localStorage.setItem("gamma-active-user", next); } catch {}
    }
  };
  React.useEffect(() => {
    let active = true;
    apiJson(`${API}/session`).then((data) => { if (active) acceptSession(data); })
      .catch(() => { if (active) setUser(false); });
    return () => { active = false; setExpectedUser(null); };
  }, []);
  React.useEffect(() => {
    if (!user) return;
    let active = true;
    const check = (who) => {
      if (!active) return;
      if (!who) { setExpectedUser(null); setUser(false); setPassword(""); }
      else if (who !== user) setConflict(who);
    };
    const mismatch = (event) => check(event.detail?.user || "");
    const storage = (event) => { if (event.key === "gamma-active-user" && event.newValue !== null) check(event.newValue); };
    const focus = () => apiJson(`${API}/session`).then((data) => check(data.user)).catch(() => {});
    window.addEventListener("gamma-user-mismatch", mismatch);
    window.addEventListener("gamma-auth-expired", mismatch);
    window.addEventListener("storage", storage);
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      window.removeEventListener("gamma-user-mismatch", mismatch);
      window.removeEventListener("gamma-auth-expired", mismatch);
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", focus);
    };
  }, [user]);
  const login = async (event) => {
    event.preventDefault(); setError("");
    try {
      await apiJson(`${API}/login`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }) });
      acceptSession(await apiJson(`${API}/session`));
      setPassword("");
    } catch (err) { setError(err.message || "Login failed"); }
  };
  if (user === null) return <AuthLoading />;
  if (!user) return <LoginPage username={username} password={password} error={error}
    onUsernameChange={setUsername} onPasswordChange={setPassword} onSubmit={login}
    subtitle="Sign in to connect your assistant" />;
  if (conflict) return <SessionConflictPage tabUser={user} activeUser={conflict} onReload={() => window.location.reload()} />;
  return <McpConsent key={`${requestId}:${user}`} requestId={requestId} />;
}

export default function McpConsent({ requestId }) {
  const [details, setDetails] = React.useState(null);
  const [workspace, setWorkspace] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    apiJson(`${API}/integrations/oauth/request?request_id=${encodeURIComponent(requestId)}`)
      .then((data) => {
        if (!active) return;
        setDetails(data);
        setWorkspace(data.default_workspace || data.workspaces[0]?.id || "");
      }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [requestId]);
  const decide = async (approve) => {
    setBusy(true); setError("");
    try {
      const result = await apiJson(`${API}/integrations/oauth/consent`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, csrf: details.csrf, workspace_id: workspace, approve }),
      });
      window.location.assign(result.redirect_url);
    } catch (err) { setError(err.message); setBusy(false); }
  };
  const switchAccount = async () => {
    setBusy(true); setError("");
    try {
      await apiJson(`${API}/logout`, { method: "POST" });
      window.location.reload();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return <div className="app mcpConsentPage"><div className="loginPage"><div className="loginCard mcpConsent">
    <div className="loginTitle">Gamma</div>
    <h1 className="loginSubtitle">Connect your workspace</h1>
    {details ? <>
      <p><strong>{details.client_name}</strong> wants to connect to Gamma.</p>
      <p className="loginConflictHint">Signed in as <strong>{details.username}</strong>.</p>
      <label>Workspace</label>
      <MenuSelect label="Workspace" block value={workspace} onChange={setWorkspace}
        options={details.workspaces.map((item) => [item.id, item.name])} />
      <div className="mcpPermissions">
        <strong>Read-only access</strong>
        <ul><li>Read pages, notes, highlights, and PDF text.</li>
          <li>Cannot edit or delete your library.</li></ul>
        <p className="loginConflictHint">Content the assistant reads is shared with its provider.</p>
      </div>
      <p className="loginConflictHint">Access lasts 90 days. Disconnect anytime in
        Settings → AI → Integrations.</p>
      <details className="mcpConnectionDetails"><summary>Connection details</summary>
        <p className="loginConflictHint">The assistant provided its name. Only approve if you started this connection.</p>
        <p className="loginConflictHint mcpCallback">Returns to: {details.redirect_uri}</p>
      </details>
      <div className="mcpConsentActions">
      <button className="loginBtn" disabled={busy || !workspace} onClick={() => decide(true)}>
        {busy ? "Connecting…" : "Allow read-only access"}
      </button>
      <button className="loginGuestBtn" disabled={busy} onClick={() => decide(false)}>Cancel</button>
      </div>
    </> : !error ? <p>Loading connection request…</p> : null}
    {error ? <p className="loginError" role="alert">{error}</p> : null}
    <button className="loginGuestBtn" disabled={busy} onClick={switchAccount}>Use another account</button>
  </div></div></div>;
}

import React from "react";
import { PasswordInput } from "../settings/SettingsKit";

function AuthShell({ children }) {
  return (
    <div className="app">
      <div className="loginPage">
        <div className="loginCard">
          <div className="loginTitle">Gamma</div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function AuthLoading() {
  return <AuthShell><p className="loginLoading">Loading...</p></AuthShell>;
}

export function WorkspaceUnavailablePage() {
  return (
    <AuthShell>
      <p className="loginSubtitle">This workspace is unavailable</p>
      <p className="loginConflictText">
        It may have been deleted, or your account may no longer have access.
        Ask a workspace owner to invite you if you need access.
      </p>
      <button type="button" className="loginBtn" onClick={() => window.location.assign("/")}>
        Open my workspaces
      </button>
    </AuthShell>
  );
}

// Shown when another tab of the same browser signed into a different account:
// the session cookie is browser-wide, so this tab's identity changed under it.
// The tab is frozen (its API calls are refused with 409 by the backend) until
// the user reloads into the account that now owns the session.
export function SessionConflictPage({ tabUser, activeUser, onReload }) {
  return (
    <AuthShell>
      <p className="loginSubtitle">Signed in elsewhere</p>
      <p className="loginConflictText">
        This tab was open as <b>{tabUser}</b>, but this browser is now signed in
        as <b>{activeUser}</b> (from another tab). This tab has been paused so the
        two accounts&apos; data can&apos;t mix.
      </p>
      <button type="button" className="loginBtn" onClick={onReload}>
        Continue as {activeUser}
      </button>
      <p className="loginConflictHint">
        To use both accounts at the same time, open one of them in a private
        window or a separate browser profile.
      </p>
    </AuthShell>
  );
}

// The cloud sign-in callback sends a refused sign-in back here as
// `?cloud_error=`: shown once, then dropped from the address bar.
function takeCloudError() {
  try {
    const url = new URL(window.location.href);
    const message = url.searchParams.get("cloud_error");
    if (!message) return "";
    url.searchParams.delete("cloud_error");
    window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    return message;
  } catch { return ""; }
}

export function LoginPage({
  username,
  password,
  error,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
  onGuestLogin,
  cloudLogin,
  subtitle,
}) {
  const [cloudError] = React.useState(takeCloudError);
  const next = window.location.pathname + window.location.search;
  return (
    <AuthShell>
      <p className="loginSubtitle">{subtitle || "Annotate PDFs, Share Your Thinking"}</p>
      {cloudLogin?.enabled ? (
        <a className="loginBtn loginCloudBtn" href={`/api/auth/cloud/start?next=${encodeURIComponent(next)}`}
          title={`Sign in through ${cloudLogin.issuer}`}>
          Sign in with Gamma Cloud
        </a>
      ) : null}
      {cloudError ? <div className="loginError" role="alert">{cloudError}</div> : null}
      <form onSubmit={onSubmit}>
        <input
          type="text"
          value={username}
          onChange={(event) => onUsernameChange(event.target.value)}
          placeholder="Username"
          className="loginInput"
          autoFocus
        />
        <PasswordInput
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="Password"
          className="loginInput"
          autoComplete="current-password"
        />
        {error ? <div className="loginError">{error}</div> : null}
        <button type="submit" className="loginBtn" disabled={!username.trim() || !password.trim()}>
          Log in
        </button>
        {onGuestLogin ? (
          <button type="button" className="loginGuestBtn" onClick={onGuestLogin}>
            Continue as guest
          </button>
        ) : null}
      </form>
    </AuthShell>
  );
}

// A share link this visitor can't open: unknown/turned off, or shared with
// specific people that don't include the signed-in account.
export function ShareBlockedPage({ reason, viewer, onSwitchAccount }) {
  const missing = reason !== "forbidden";
  return (
    <AuthShell>
      <p className="loginSubtitle">{missing ? "This link doesn't work" : "Not shared with you"}</p>
      <p className="loginConflictText">
        {missing
          ? "The share link doesn't exist or its owner turned sharing off."
          : `This page is shared with specific people only${viewer ? `, and ${viewer} isn't one of them` : ""}. Ask the owner to add your username.`}
      </p>
      {!missing && onSwitchAccount ? (
        <button type="button" className="loginBtn" onClick={onSwitchAccount}>Sign in as someone else</button>
      ) : null}
    </AuthShell>
  );
}

import React from "react";

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

export function LoginPage({
  username,
  password,
  error,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
  onGuestLogin,
}) {
  return (
    <AuthShell>
      <p className="loginSubtitle">Annotate PDFs, Share Your Thinking</p>
      <form onSubmit={onSubmit}>
        <input
          type="text"
          value={username}
          onChange={(event) => onUsernameChange(event.target.value)}
          placeholder="Username"
          className="loginInput"
          autoFocus
        />
        <input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="Password"
          className="loginInput"
        />
        {error ? <div className="loginError">{error}</div> : null}
        <button type="submit" className="loginBtn" disabled={!username.trim() || !password.trim()}>
          Log in
        </button>
        <button type="button" className="loginGuestBtn" onClick={onGuestLogin}>
          Continue as guest
        </button>
      </form>
    </AuthShell>
  );
}

const releaseBase = "https://github.com/tim4431/Gamma/releases/latest/download";

function shellQuote(value, platform) {
  // These are shell literals, not JavaScript/JSON strings. Server URLs may be
  // supplied by a self-hosted deployment and must never become shell syntax.
  return platform === "windows"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function codexSetupCommand(serverUrl, platform) {
  const quote = (value) => shellQuote(value, platform);
  if (platform === "windows") {
    return `& ([scriptblock]::Create((Invoke-RestMethod ${quote(releaseBase + "/install-gamma-codex.ps1")}))) -ServerUrl ${quote(serverUrl)}`;
  }
  // Download completely before executing, and leave stdin attached to the
  // terminal so Codex can open its interactive browser authorization flow.
  // The subshell keeps the cleanup trap local to setup, including failed downloads.
  return `(gamma_setup=$(mktemp) && trap 'rm -f "$gamma_setup"' 0 && curl -fsSL ${quote(releaseBase + "/install-gamma-codex.sh")} -o "$gamma_setup" && sh "$gamma_setup" ${quote(serverUrl)})`;
}

export function claudeConnectCommand(serverUrl, platform, { replace = false } = {}) {
  const add = `claude mcp add --transport http --scope user gamma ${shellQuote(serverUrl, platform)}`;
  return replace ? `claude mcp remove gamma --scope user\n${add}` : add;
}

// Run from the parent of the extracted gamma-marketplace directory on either OS.
export const claudePluginInstallCommands = "claude plugin marketplace add ./gamma-marketplace\nclaude plugin install gamma@gamma-local --scope user";

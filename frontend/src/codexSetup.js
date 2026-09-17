const releaseBase = "https://github.com/tim4431/Gamma/releases/latest/download";

export function codexSetupCommand(serverUrl, platform) {
  // These are shell literals, not JavaScript/JSON strings. Server URLs may be
  // supplied by a self-hosted deployment and must never become shell syntax.
  const quote = platform === "windows"
    ? (value) => "'" + value.replaceAll("'", "''") + "'"
    : (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  if (platform === "windows") {
    return `& ([scriptblock]::Create((Invoke-RestMethod ${quote(releaseBase + "/install-gamma-codex.ps1")}))) -ServerUrl ${quote(serverUrl)}`;
  }
  // Download completely before executing, and leave stdin attached to the
  // terminal so Codex can open its interactive browser authorization flow.
  // The subshell keeps the cleanup trap local to setup, including failed downloads.
  return `(gamma_setup=$(mktemp) && trap 'rm -f "$gamma_setup"' 0 && curl -fsSL ${quote(releaseBase + "/install-gamma-codex.sh")} -o "$gamma_setup" && sh "$gamma_setup" ${quote(serverUrl)})`;
}

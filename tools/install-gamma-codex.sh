#!/bin/sh
set -eu

gamma_server=${1:?Pass the Gamma MCP URL from External assistants.}
for gamma_tool in codex curl unzip; do
    command -v "$gamma_tool" >/dev/null 2>&1 || { printf 'Install %s first. Codex CLI: https://learn.chatgpt.com/docs/cli\n' "$gamma_tool" >&2; exit 1; }
done
case "$gamma_server" in
    *'@'*|*'?'*|*'#'*|*' '*|*'
'*) printf 'Use the Gamma MCP URL without credentials, query parameters, or whitespace.\n' >&2; exit 1 ;;
esac
case "$gamma_server" in
    https://*/mcp|http://localhost/mcp|http://localhost:*/mcp|http://127.0.0.1/mcp|http://127.0.0.1:*/mcp|http://\[::1\]/mcp|http://\[::1\]:*/mcp) ;;
    *) printf 'Use HTTPS, or HTTP localhost, ending in /mcp.\n' >&2; exit 1 ;;
esac

# These are replaced by the release packager; never resolve "latest" twice.
gamma_download='__GAMMA_ARCHIVE_URL__'
gamma_digest='__GAMMA_ARCHIVE_SHA256__'
gamma_root="${XDG_DATA_HOME:-$HOME/.local/share}/gamma/codex-plugin"
mkdir -p "$gamma_root"
gamma_install=$(mktemp -d "$gamma_root/install.XXXXXXXX")
gamma_marketplace="$gamma_root/gamma-marketplace"
gamma_cleanup() {
    if [ -d "$gamma_install/previous" ] && [ ! -e "$gamma_marketplace" ]; then
        # Leave the backup intact if restoration fails.
        mv "$gamma_install/previous" "$gamma_marketplace" || return 1
    fi
    rm -rf "$gamma_install"
}
trap gamma_cleanup 0
trap 'exit 1' HUP INT TERM
printf 'Downloading the Gamma PDF plugin...\n'
curl --fail --silent --show-error --location "$gamma_download" -o "$gamma_install/gamma-marketplace.zip"
if command -v sha256sum >/dev/null 2>&1; then
    gamma_actual=$(sha256sum "$gamma_install/gamma-marketplace.zip" | cut -d ' ' -f 1)
else
    gamma_actual=$(shasum -a 256 "$gamma_install/gamma-marketplace.zip" | cut -d ' ' -f 1)
fi
[ "$gamma_actual" = "$gamma_digest" ] || { printf 'The Gamma plugin download is incomplete or changed. Run setup again.\n' >&2; exit 1; }
unzip -q "$gamma_install/gamma-marketplace.zip" -d "$gamma_install"
gamma_staged="$gamma_install/gamma-marketplace"
[ -f "$gamma_staged/.agents/plugins/marketplace.json" ] || { printf 'The Gamma package is missing its marketplace catalog.\n' >&2; exit 1; }
# Replace the whole package, retaining the old source until the move succeeds.
if [ -e "$gamma_marketplace" ]; then
    mv "$gamma_marketplace" "$gamma_install/previous"
fi
mv "$gamma_staged" "$gamma_marketplace"
gamma_cleanup
trap - 0 HUP INT TERM
codex plugin marketplace add "$gamma_marketplace"
codex plugin add gamma@gamma-local
printf 'Connecting Gamma. Approve the workspace in your browser.\n'
codex mcp add gamma --url "$gamma_server" || { printf 'Gamma PDF is installed. Retry sign-in with: codex mcp login gamma\n' >&2; exit 1; }
printf 'Gamma PDF is installed. Start a new chat and mention @Gamma PDF.\n'

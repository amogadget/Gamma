# Gamma PDF for Codex

Search and read your Gamma pages, notes, highlights and PDF text from Codex.

## Connect your library

Open Gamma in your browser and go to **Settings → AI → External assistants**.
Copy the MCP server URL into your assistant's MCP settings, or copy the Codex
CLI setup commands. Sign in with Gamma and approve the workspace you want to
share, then start a new chat. No manual token or environment variable is needed.
Keep Gamma reachable. Self-hosted servers use HTTPS; localhost supports HTTP.
See [the guide](docs/dev/mcp.md) for server configuration and manual-token setup.

For the combined installer, choose **Codex CLI** in that settings panel and copy
the command for Windows PowerShell or macOS/Linux. It installs the released plugin
and connects this server. Requires the Codex CLI and a Gamma release containing
the setup scripts; no Gamma desktop app is required.

## Install the optional workflow

{install_intro}

```text
codex plugin marketplace add {install_source}
```

Open the desktop Plugins Directory, select **Gamma PDF**, and install the plugin.
Start a new chat. Installing the workflow alone does not connect your library.
Mention Gamma PDF with @ and ask "Let me choose a paper". An MCP Apps-capable
client shows a searchable picker; other clients receive a text list. The picker
requires the updated Gamma backend and stays in the authorized workspace.
This package contains no credentials and does not publish a public directory listing.

## Publish this marketplace on GitHub

Commit the contents of this directory as the root of your marketplace repository,
including `.agents/` and `plugins/gamma/.codex-plugin/`. Once pushed, users can
add it with `codex plugin marketplace add OWNER/REPO`. To release an update,
replace the package contents and push; users refresh their marketplace and
reinstall the plugin, then start a new chat.

See [the integration guide](docs/dev/mcp.md) and [privacy policy](PRIVACY.md).

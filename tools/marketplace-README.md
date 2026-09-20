# Gamma PDF for Codex and Claude Code

Search and read your Gamma pages, notes, highlights and PDF text from either assistant.

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

### Claude Code

```text
claude plugin marketplace add {install_source}
claude plugin install gamma@gamma-local --scope user
claude mcp add --transport http --scope user gamma <your-gamma-address>/mcp
```

Use the actual MCP URL from Gamma's settings. Start Claude Code, open `/mcp`,
select `gamma`, and authenticate in your browser to approve a workspace.
Start a new session and invoke `/gamma:gamma`, or ask about your Gamma library.
To update later, run `claude plugin marketplace update gamma-local` followed by
`claude plugin update gamma@gamma-local`, then start a new session.
For an extracted marketplace, replace its contents with the newer release first.

### Codex

```text
codex plugin marketplace add {install_source}
```

Keep the extracted directory in a permanent location before registering it.
Codex continues reading its marketplace catalog after installation; deleting or
moving the source can break plugin discovery even when the plugin is cached.

Open the desktop Plugins Directory, select **Gamma PDF**, and install the plugin.
Start a new chat. Installing the workflow alone does not connect your library.
Paste a Gamma page or share link with your question. In Gamma, use **Copy for
assistant** in the page menu to include your reading position, or in a note or
highlight menu to include that passage. The assistant reads it through your
authorized workspace connection.
This package contains no credentials and does not publish a public directory listing.

## Publish this marketplace on GitHub

Commit the contents of this directory as the root of your marketplace repository,
including `.agents/`, `.claude-plugin/`, and both hidden manifest directories in
`plugins/gamma/`. Once pushed, users can add it with
`codex plugin marketplace add OWNER/REPO` or
`claude plugin marketplace add OWNER/REPO`. To release an update,
replace the package contents and push; users refresh their marketplace and
reinstall the plugin, then start a new chat.

See [the integration guide](docs/dev/mcp.md) and [privacy policy](PRIVACY.md).

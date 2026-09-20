# Gamma PDF for Codex and Claude Code

This plugin supplies the Gamma workflow and display identity. Configure the
Gamma MCP connection separately: every Gamma installation has its own address
and workspace authorization. The plugin contains no credentials or hardcoded
server address.

## Claude Code

From a Gamma checkout, build a marketplace into a permanent directory:

```text
python tools/package_plugins.py --output <permanent-directory>/gamma-marketplace --archive
claude plugin marketplace add <permanent-directory>/gamma-marketplace
claude plugin install gamma@gamma-local --scope user
claude mcp add --transport http --scope user gamma <your-gamma-address>/mcp
```

Alternatively, download `gamma-claude-code-plugin-X.Y.Z.zip` from a Gamma release,
extract it into a permanent location, and add the extracted `gamma-marketplace`
directory with the same marketplace command. Replace the MCP URL with the one
shown in Gamma's **Settings → Integrations**. Use HTTPS for remote servers;
HTTP localhost is supported.

Start Claude Code, open `/mcp`, select `gamma`, and authenticate. Sign in to Gamma
in the browser and approve read-only access to your chosen workspace. Start a new
session and run `/gamma:gamma`, or ask Claude to find your Gamma notes. If tools
are missing, inspect `/mcp` or `claude mcp get gamma` before retrying sign-in.
Copy the Gamma page URL from your browser and paste it with your question.
A share link works too.

To update an extracted marketplace, replace its contents with the newer release.
Then run `claude plugin marketplace update gamma-local`
and `claude plugin update gamma@gamma-local`, then start a new session. For local
development, load this directory directly with `claude --plugin-dir ./plugins/gamma`
from the repository root; the MCP connection still needs separate setup.

The plugin layout follows the [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference);
connection setup follows the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## Codex

For the combined installer, open **Settings → AI → Integrations → Codex
CLI**, select your operating system, and copy the setup command. It downloads
the plugin from Gamma's latest release, installs it, and connects this server.
Requires an installed Codex CLI and a release containing the setup scripts.
Approve a workspace in your browser, then start a new chat. Gamma's desktop app
is not required. To connect manually or install a development package:

1. Update/start Gamma and open **Settings → AI → Integrations** in the
   workspace you want Codex to read.
2. Copy the server URL into your assistant's MCP settings and sign in with Gamma.
   For Codex CLI, copy the setup commands shown in Gamma, or:

   ```text
   codex mcp add gamma --url <your-gamma-address>/mcp
   ```

   If sign-in is interrupted, retry with `codex mcp login gamma`.
   Approve read-only access to the workspace in your browser. No manual token
   or environment variable is needed. HTTPS is required for remote servers;
   HTTP localhost is supported. Manual tokens remain available for other clients.

3. Add the marketplace repository or extracted directory with
   `codex plugin marketplace add <owner/repo-or-directory>`.
   Install **Gamma PDF** using the desktop plugin browser or `/plugins` in the
   CLI. Start a new conversation. Select Gamma from the available plugin/skill
   picker, or invoke `$gamma` in the CLI.

The IDE extension can use the direct MCP connection without the plugin.

Paste a Gamma page or share link with your question. The assistant uses
`read_gamma_link` to resolve and read it. Copy the page URL directly from your
browser's address bar, or use an existing block or share link.
Both assistants use the same workflow. Follow-up questions keep the last supplied
page as context until you send a different reference.

Gamma must be running and reachable from the machine running the MCP client.
The packaged workflow uses the configured tools; installing it alone does not
establish a connection. Public directory publication is a separate review process.

If setup reports successful login but the assistant has no Gamma tools, inspect
`codex mcp get gamma` in your terminal. A server disabled by managed requirements
needs administrator approval in Codex's managed policy; reinstalling or repeating
OAuth cannot enable it. If the server is enabled, restart the Codex app and start
a new task, then inspect MCP startup errors if tools are still missing. An OAuth
entry in Gamma confirms a grant of access, not that Codex loaded its MCP tools.

For remote hosts, HTTPS, troubleshooting, token management, and release
instructions, see [the integration guide](../../docs/dev/mcp.md).

To build a distributable marketplace from a Gamma source checkout:

```text
python tools/package_plugins.py --output tmp/gamma-marketplace --archive
```

The output includes installation instructions, the hidden marketplace catalog,
plugin files for both clients, and a ZIP. Publish the generated directory as the root of your
marketplace repository, including hidden files. Gamma's normal release workflow
also publishes a versioned plugin ZIP and Windows/macOS/Linux setup scripts.
The `Assistant plugin package` workflow tests them and builds preview artifacts.

## Shared implementation

Both manifests live in this directory and point to `skills/`. Edit
`skills/gamma/SKILL.md` once to change the workflow for both clients. Codex's
display metadata stays in `.codex-plugin/plugin.json` and `agents/openai.yaml`;
Claude Code reads `.claude-plugin/plugin.json`. The builder checks shared
manifest metadata for drift and copies an explicit allowlist of distributable files.
There are no symlinks or cross-plugin references that could break in a client cache.

`tools/package_plugins.py` creates both marketplace catalogs around this one plugin.
`tools/package_codex_plugin.py` remains a compatibility entry point.
`tools/release_plugins.py` versions both manifests together and produces both
downloads from identical package bytes, preserving existing Codex asset names and
setup scripts. Connection, authentication, and read tools remain in the shared
Gamma MCP backend; per-user addresses and credentials never enter the package.

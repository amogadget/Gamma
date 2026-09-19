# Gamma PDF for Codex

This plugin supplies the Gamma workflow and display identity. Configure the
Gamma MCP connection separately: every Gamma installation has its own address
and workspace authorization. The plugin contains no credentials or hardcoded
server address.

For the combined installer, open **Settings → AI → External assistants → Codex
CLI**, select your operating system, and copy the setup command. It downloads
the plugin from Gamma's latest release, installs it, and connects this server.
Requires an installed Codex CLI and a release containing the setup scripts.
Approve a workspace in your browser, then start a new chat. Gamma's desktop app
is not required. To connect manually or install a development package:

1. Update/start Gamma and open **Settings → AI → External assistants** in the
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

To select a paper, mention **Gamma PDF** with `@` in a new desktop chat and ask
**"Let me choose a paper"**. Search by title, select a result, and click
**Use this paper**. Ask questions about it in the same conversation. The picker
uses the existing authorized workspace; it does not change workspaces. It needs
an updated Gamma server and an MCP Apps-capable client. Clients without UI get
a text list to choose from. This does not add papers to the native `@` menu.

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
python tools/package_codex_plugin.py --output tmp/gamma-marketplace --archive
```

The output includes installation instructions, the hidden marketplace catalog,
plugin files, and a ZIP. Publish the generated directory as the root of your
marketplace repository, including hidden files. Gamma's normal release workflow
also publishes a versioned plugin ZIP and Windows/macOS/Linux setup scripts.
The `Codex plugin package` workflow tests them and builds preview artifacts.

# Gamma PDF for Codex

This plugin supplies the Gamma workflow and display identity. Configure the
Gamma MCP connection separately: every Gamma installation has its own address
and private workspace token. The plugin contains no credentials or hardcoded
server address.

1. Update/start Gamma and open **Settings → AI → External assistants** in the
   workspace you want Codex to read.
2. Create a token, copy it once, and set `GAMMA_TOKEN` in the environment that
   launches Codex. Use the configuration shown in Gamma, or:

   ```text
   codex mcp add gamma --url <your-gamma-address>/mcp --bearer-token-env-var GAMMA_TOKEN
   ```

3. Package this plugin from the repository root:

   ```text
   python tools/package_codex_plugin.py --output tmp/gamma-marketplace
   codex plugin marketplace add ./tmp/gamma-marketplace
   ```

4. Install **Gamma PDF** using the desktop plugin browser or `/plugins` in the
   CLI. Start a new conversation. Select Gamma from the available plugin/skill
   picker, or invoke `$gamma` in the CLI.

The IDE extension can use the direct MCP connection without the plugin.
Gamma must be running and reachable from the machine running the MCP client.
The packaged workflow uses the configured tools; installing it alone does not
establish a connection. Public directory publication and OAuth are not included.

For remote hosts, HTTPS, troubleshooting, token management, and release
instructions, see [the integration guide](../../docs/dev/mcp.md).

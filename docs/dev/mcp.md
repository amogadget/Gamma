# Gamma MCP and Codex

Gamma exposes a read-only Streamable HTTP MCP endpoint at `/mcp`, on the same
server as the app. Gamma's chat and MCP adapter share `gamma/ai_tools.py`:
tool definitions, executors, page/folder scope checks, and dispatch permissions.
The chat calls these functions directly. Gamma is not an MCP client for external
servers, and connecting Codex does not invoke Gamma's AI provider.

## Connect

Install the updated `backend/requirements.txt` and restart Gamma. Startup
migrates the data directory to schema 6, with the existing migration snapshot
mechanism. Desktop builds bundle the dependency.

In the desired workspace, open **Settings → AI → External assistants**. Create
a named connection and copy its token; it is shown once. Guests cannot create
connections. Set `GAMMA_TOKEN` in the environment of the process launching
Codex. For a temporary PowerShell session, avoid storing the token in history:

```powershell
$gammaSecret = Read-Host 'Gamma token' -AsSecureString
$env:GAMMA_TOKEN = [System.Net.NetworkCredential]::new('', $gammaSecret).Password
codex mcp add gamma --url http://127.0.0.1:8000/mcp --bearer-token-env-var GAMMA_TOKEN
codex
```

Replace the example address/port with the one shown in Gamma; desktop workspace
ports can differ. A desktop Codex process must also inherit `GAMMA_TOKEN`;
restarting a process launched elsewhere may not inherit a terminal's variables.
Never put the token in prompts, screenshots, source control, or plugin packages.
The settings panel also provides the equivalent `config.toml` snippet.

Ask Codex to find a page, search a topic, or summarize notes. Tools available:

| Tool | Content |
| --- | --- |
| `list_pages` | Page IDs/titles, folders, labels, attachment metadata |
| `search_library` | Full-text note and PDF matches, with source locations |
| `read_page` | Notes, highlights, properties, and windowed PDF text |
| `read_block` | One block/subtree or a page's nested note outline |

Results include an absolute page URL or URL template carrying the workspace ID.
PDF page numbers are physical 1-based page numbers. Existing read budgets and
indexing/incomplete-result notices still apply. The initial release reads text;
it does not provide rendered PDF figures or handwriting recognition.

## Self-hosted and remote connections

The default MCP Host allowlist accepts localhost and loopback addresses. Set
`GAMMA_MCP_ALLOWED_HOSTS` to comma-separated additional host authorities before
starting Gamma, for example `gamma.example.com,nas.local:8000`. Use HTTPS for
connections crossing untrusted networks. Preserve the external Host header at
the proxy and configure its trusted forwarding so generated links use HTTPS.
For a reverse-proxy path prefix, configure the ASGI root path accordingly.

Browser-origin requests to `/mcp` are rejected. This endpoint targets native
MCP clients; it does not enable cross-origin browser access. The official Python
MCP SDK handles protocol negotiation, request validation, and the stateless JSON
transport. Request bodies are limited to 64 KiB. The backend lifespan owns the
SDK manager; it must run when embedding Gamma's ASGI app.

## Permissions and credentials

- Integration tokens grant reading access to exactly one workspace. Tool arguments,
  `?ws=`, and `X-Gamma-Workspace` cannot select another workspace.
- Only token SHA-256 hashes are stored in `users.db`. Tokens contain 256 random bits.
- Tokens expire after 90 days by default (API range: 1–365 days); accounts may
  have at most 20 unexpired tokens. Revoke a connection in the same settings panel.
- Each request checks the account still exists and can access the workspace.
  Removing access, expiration, or revocation denies subsequent requests. A request
  already running may finish. Public workspace access follows Gamma's existing rules.
- Account/workspace deletion removes the associated tokens. Account rename preserves
  them; password changes through the admin API revoke them along with sessions.
- MCP always disables writes and external web tools. The allowlist is enforced on
  every dispatch, independent of which tools the client was offered. Deprecated chat
  aliases are not accepted by the MCP transport.
- Token management requires a normal Gamma session and never accepts an integration
  token. A browser session alone cannot authenticate to `/mcp`.

Management API (session authenticated; current workspace selected as usual):

```text
GET    /api/integrations/tokens
POST   /api/integrations/tokens       {"name":"Codex","expires_in_days":90}
DELETE /api/integrations/tokens/{id}
```

## Codex plugin and distribution

`plugins/gamma` is a skills-based Codex plugin. Its workflow uses the separately
configured Gamma MCP server; this keeps per-installation addresses and credentials
out of a distributable package. A direct MCP connection also works without the
plugin, including in the Codex IDE extension.

From a Gamma checkout:

```text
python tools/package_codex_plugin.py --output tmp/gamma-marketplace
codex plugin marketplace add ./tmp/gamma-marketplace
```

Install Gamma PDF through the desktop plugin browser or CLI `/plugins`, then
start a new conversation. To distribute it, publish the generated directory as
a Git repository or release archive. Users add that directory or Git marketplace
source, install the plugin, and configure their own Gamma connection. Package
updates into a new directory; the builder never overwrites an existing one.

This does not publish a public directory listing. Public MCP submissions currently
require a stable public HTTPS endpoint and review. OAuth and a hosted service are
outside this local/self-hosted first release.

Official references: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[plugin packaging](https://developers.openai.com/plugins/build/plugins), and
[public submission](https://developers.openai.com/plugins/deploy/submission).

## Troubleshooting

- **401:** token missing, expired, revoked, or account no longer has access. Confirm
  the Codex process inherited the variable; create a new token if needed.
- **421:** server hostname is not in `GAMMA_MCP_ALLOWED_HOSTS`.
- **503:** the ASGI lifespan is not running.
- **Connection refused:** Gamma is stopped, the desktop port changed, or the MCP
  client is running on a different machine where localhost means that machine.
- **No tool in the picker:** verify the direct MCP connection first. Plugin/skill
  picker behavior varies by Codex surface; installing the workflow alone does not
  connect a server. Use `/mcp` in the CLI to inspect configured servers.

## Validation

`backend/tests/test_mcp.py` exercises the SDK endpoint, real tool reads, input
validation, workspace isolation, permissions, expiration, and revocation.
`test_migrations.py` covers schema upgrades. The settings browser suite exercises
token creation, one-time display, and revocation in the actual UI.

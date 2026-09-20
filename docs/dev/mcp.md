# Gamma MCP, Codex, and Claude Code

Gamma exposes a read-only Streamable HTTP MCP endpoint at `/mcp`, on the same
server as the app. Gamma's chat and MCP adapter share `gamma/ai_tools.py`:
tool definitions, executors, page/folder scope checks, and dispatch permissions.
The chat calls these functions directly. Gamma is not an MCP client for external
servers, and connecting Codex does not invoke Gamma's AI provider.

| File | Owns |
|---|---|
| `gamma/mcp_server.py` | the `/mcp` transport (official Python MCP SDK), the four library read tools plus link reading |
| `gamma/mcp_oauth.py` | discovery, dynamic registration, PKCE authorization and token exchange, the consent API (`/api/integrations/oauth/*`), `public_base` |
| `gamma/mcp_links.py` | local page/block/share link resolution within the connected workspace |
| `gamma/integrations.py` | integration tokens (`integration_tokens` table, hashes only) and their resolution |
| `gamma/server_settings.py` | the admin-confirmed public URL and the MCP host allowlist |
| `gamma/routers/integrations.py` | the session-only token management API |
| `users.db` tables `integration_tokens`, `mcp_oauth` | migrations 6 and 7 ([migrations.md](migrations.md)) |
| `frontend/src/settings/SettingsIntegrations.jsx`, `frontend/src/auth/McpConsent.jsx` | the Integrations pane, the consent screen |
| `plugins/gamma/`, `tools/package_plugins.py`, `tools/release_plugins.py`, `.github/workflows/codex-plugin.yml` | the shared Codex / Claude Code plugin and its packaging |

## Connect

Open Gamma in your browser and go to **Settings → Integrations**.
Copy its server URL into your assistant's MCP settings and choose its sign-in
option. Select **Codex CLI** in the panel for commands using your actual URL:

```text
codex mcp add gamma --url https://gamma.example.com/mcp
```

Codex opens the browser. If sign-in is interrupted, run `codex mcp login gamma`
to retry. Sign in with your Gamma account, choose the workspace,
and approve read-only access. Start a new Codex chat. There is no token to copy
and no environment variable to set. This works with local browser-based Gamma
and self-hosted servers; the Gamma desktop app is not required. Local installations
may use `http://127.0.0.1:8000/mcp` (substitute your actual port).

A `gamma` entry configured with `bearer_token_env_var` or an Authorization
header must be removed (`codex mcp remove gamma`) and added again with just the
URL before signing in. Installing the optional plugin does not install this
per-user connection. A browser cannot directly edit Codex's configuration on
your computer.

### Claude Code

Open **Settings → Integrations → Claude Code**. The connection command uses this
Gamma server's MCP URL, with quoting for the selected terminal platform:

```text
claude mcp add --transport http --scope user gamma https://gamma.example.com/mcp
```

The same tab explains where the plugin appears (`/plugin`), how to invoke it
(`/gamma:gamma`), and how to install it from an extracted release. Expand
**Changed the server address?** for commands that replace the user-scoped MCP
connection without reinstalling the plugin. Confirm a changed remote public URL
in **Settings → Server** first, then reopen the setup tab and sign in again.
Frontend command generation lives in `frontend/src/settings/assistantSetup.js`;
both clients share shell-literal quoting, with `codexSetup.js` retained as an alias.

Start Claude Code and open `/mcp`. Select `gamma` and authenticate in your browser;
sign in to Gamma and approve the workspace. Start a new session. Check `/mcp` or
`claude mcp get gamma` if tools are unavailable. Each assistant maintains its own
connection and authorization; an existing Codex login does not connect Claude Code.
See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

For the optional Gamma workflow, extract `gamma-claude-code-plugin-X.Y.Z.zip`
from a Gamma release into a permanent directory, then run:

```text
claude plugin marketplace add <permanent-directory>/gamma-marketplace
claude plugin install gamma@gamma-local --scope user
```

Start a new session and use `/gamma:gamma`, or ask about your Gamma library.
The plugin uses the separately configured connection. To update after refreshing
your extracted package or published marketplace, run
`claude plugin marketplace update gamma-local` and
`claude plugin update gamma@gamma-local`. Restart the session.

For local development from this checkout, use `claude --plugin-dir ./plugins/gamma`.
This loads the shared workflow without creating a marketplace; connect MCP separately.
See the [plugin README](../../plugins/gamma/README.md) for both clients' setup.

### Manual tokens (advanced)

For clients without OAuth, expand **Manual setup (advanced)** in the same panel,
create a named token, and copy it once. Guests cannot create connections. Set `GAMMA_TOKEN` in the environment
of the process launching Codex. For a temporary PowerShell session:

```powershell
$gammaSecret = Read-Host 'Gamma token' -AsSecureString
$env:GAMMA_TOKEN = [System.Net.NetworkCredential]::new('', $gammaSecret).Password
codex mcp add gamma --url http://127.0.0.1:8000/mcp --bearer-token-env-var GAMMA_TOKEN
codex
```

Replace the address/port with the one shown in Gamma. A desktop Codex process
must inherit the variable; restarting an app launched elsewhere may not inherit
a terminal's variables. Never put tokens in prompts, screenshots, source control,
or plugin packages. The panel also provides a manual `config.toml` snippet.

Ask Codex to find a page, search a topic, or summarize notes. Tools available:

| Tool | Content |
| --- | --- |
| `list_pages` | Page IDs/titles, folders, labels, attachment metadata |
| `search_library` | Full-text note and PDF matches, with source locations |
| `read_page` | Notes, highlights, properties, and windowed PDF text |
| `read_block` | One block/subtree or a page's nested note outline |
| `read_gamma_link` | Resolve and read a page, block, or share URL, including PDF page context |

### Send a page to either assistant

Paste a Gamma page, block, or share URL with your question. `read_gamma_link`
validates the server and workspace, resolves the reference locally, and reads the
page through the same dispatcher as the other read tools. A block link also reads
that block; `pdf_page` starts the PDF excerpt at that physical page. A URL's
optional `quote` is returned as selected context, not treated as an instruction.
The response includes stable IDs and a canonical URL for subsequent reads.

Copy the page URL directly from the browser's address bar, or use an existing
block or share link. The assistant keeps that reference as context until another
is supplied; it does not track the user's active tab or PDF scroll position.

Links never grant extra MCP access. Share tokens resolve only inside the already
authorized workspace, including restricted shares whose workspace the user can
already read. Revoked, unknown, mismatched, or cross-workspace references fail
without disclosing the target. URLs are never fetched; foreign origins are
rejected. Localhost, 127.0.0.1 and ::1 are equivalent only at the same scheme and
port. A new server address requires the corresponding connection and link.

`read_page`, `read_block`, `list_pages`, and `search_library` remain available for
follow-up reading and requests naming a page or topic without a URL.

## Self-hosted and remote connections

Open Gamma at its public HTTPS address, then sign in as an administrator and
open **Settings → Server → Public server URL**. The field
suggests the browser's origin. Check it and click **Confirm address** once.
Gamma stores the address in `users.db` and immediately uses it for OAuth,
MCP links, and the MCP hostname allowlist. No environment variables or restart
are needed. Merely opening the settings page does not trust an address.

Serve Gamma at an origin root, such as `https://gamma.example.com`, and preserve
the external Host header at the reverse proxy. The saved HTTPS address works
even when the proxy connects to Gamma over HTTP. Changing the address requires
assistants to reconnect; the previous hostname is removed from the allowlist
unless separately allowed. Clearing the field restores request-based discovery.

`GAMMA_PUBLIC_URL` overrides the saved address and makes the field read-only. Its hostname is
automatically allowed too. `GAMMA_MCP_ALLOWED_HOSTS` adds other allowed host
authorities, for example `nas.local:8000` for manual tokens. Localhost and
loopback remain allowed by default. Browser sign-in over HTTP is restricted to
localhost/loopback; HTTP LAN and path-prefixed deployments can use manual tokens.

OAuth handles sign-in, not network reachability. A remote assistant still needs
to reach Gamma's server. A public listing cannot access a user's localhost by itself.

Browser-origin requests to `/mcp` are rejected. This endpoint targets native
MCP clients; it does not enable cross-origin browser access. The official Python
MCP SDK handles protocol negotiation, request validation, and the stateless JSON
transport. Request bodies are limited to 64 KiB. The backend lifespan owns the
SDK manager; it must run when embedding Gamma's ASGI app.

## Browser sign-in protocol

Gamma provides OAuth authorization-server discovery, protected-resource discovery,
dynamic public-client registration, and authorization-code exchange with S256
PKCE. The SDK validates client identity, redirect matching, and PKCE. Gamma adds:

- resource binding and an explicit workspace approval screen;
- session-bound consent, rate and body limits;
- persistent expiring records and atomic single-use codes.

Only `gamma:read` is supported. Callback URLs must be HTTPS or HTTP loopback.

```text
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server
POST /oauth/register
GET  /oauth/authorize
POST /oauth/token
```

Both authorization and token requests must include `resource=<exact MCP URL>`.
Clients use `token_endpoint_auth_method=none`. Dynamic client registrations expire
after 90 days; sign-in requests expire after 10 minutes and authorization codes
after two minutes. Access tokens last 90 days. Refresh tokens are not issued;
sign in again after expiration or revocation. OAuth connections appear alongside
manual tokens in **Integrations**, where users can revoke them.

## Permissions and credentials

- Integration tokens grant access to exactly one workspace: `read` (the default; the MCP endpoint and the HTTP API's reads) or `write` (a mirror's push credential, [mirror.md](mirror.md); refused to viewers). On the HTTP API a manual token is a bearer credential — the account behind it, confined to its workspace, never an admin ([api.md](api.md) "Integrations"). Tool arguments,
  `?ws=`, and `X-Gamma-Workspace` cannot select another workspace.
- Only token SHA-256 hashes are stored in `users.db`. Tokens contain 256 random bits.
- Tokens expire after 90 days by default (API range: 1–365 days); accounts may
  have at most 20 unexpired tokens. Revoke a connection in the same settings panel.
- Each request checks the account still exists and can access the workspace.
  Removing access, expiration, or revocation denies subsequent requests. A request
  already running may finish. Public workspace access follows Gamma's existing rules.
- Account/workspace deletion removes the associated tokens. Account rename preserves
  them; password changes through the admin API or `manage.py set-password`
  revoke them along with sessions.
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

### Install from a Gamma release

Open **Settings → Integrations → Codex CLI** in browser or self-hosted
Gamma (the same walkthrough ships in `plugins/gamma/README.md`). Select **Windows PowerShell** or **macOS / Linux**, copy the setup command,
and run it on the computer where you use Codex. The Codex CLI must already be
installed. Setup installs **Gamma PDF**, adds this server's MCP URL, and opens
browser sign-in. Approve a workspace and start a new chat. No Gamma desktop app
is needed.

The command downloads a script from Gamma's latest GitHub release. Each script
pins a versioned ZIP URL and its SHA-256 digest, preventing mixed-version downloads.
Sources stay under `%LOCALAPPDATA%/Gamma/codex-plugin` on Windows or
`${XDG_DATA_HOME:-~/.local/share}/gamma/codex-plugin` on macOS/Linux. Repeating
setup updates the same local marketplace; keep that source directory.
Download or plugin-install failures stop before changing the MCP connection.
`codex mcp add` starts OAuth itself, so setup does not start a second login.
If sign-in is interrupted, resume with `codex mcp login gamma`.

If `gamma-local` is already registered from another directory, keep using it or
remove that marketplace registration in Codex before switching to release setup.
Setup does not remove existing marketplaces or plugins.

### Build and publish

`plugins/gamma` is one skills-based plugin for Codex and Claude Code. Its workflow
uses the separately configured Gamma MCP server; this keeps per-installation addresses and credentials
out of a distributable package. A direct MCP connection also works without the
plugin, including in the Codex IDE extension.

Both native manifests point to the same `skills/gamma/SKILL.md`. Keep client UI
metadata in its own manifest or `agents/openai.yaml`; keep library behavior in
the shared skill and server. The builder rejects mismatched shared manifest
metadata, and releases stamp both versions together. It copies only allowlisted
files and writes each client's catalog around the same plugin directory, without
symlinks or references outside the installed plugin. No second MCP backend is needed.

From a Gamma checkout, build into a directory you will keep. Codex registers
the source path and continues reading its catalog after installation; deleting
it breaks marketplace discovery even when the plugin remains cached. For
example, in Windows PowerShell:

```powershell
python tools/package_plugins.py --output "$env:LOCALAPPDATA/Gamma/codex-plugin/gamma-marketplace" --archive
codex plugin marketplace add "$env:LOCALAPPDATA/Gamma/codex-plugin/gamma-marketplace"
```

On macOS/Linux, use a persistent directory such as
`~/.local/share/gamma/codex-plugin/gamma-marketplace`. Reserve `tmp/` output for
package previews, not a registered marketplace source.

Install Gamma PDF through the desktop plugin browser or CLI `/plugins`, then
start a new conversation. To distribute it, publish the generated directory as
a Git repository or release archive. Users add that directory or Git marketplace
source, install the plugin, and configure their own Gamma connection. Package
updates into a new directory; the builder never overwrites an existing one.

The builder also writes a root README with installation and publication steps,
copies the privacy policy, and optionally creates a ZIP containing the hidden
catalog and plugin manifest. To put your destination marketplace repository in
the generated instructions, pass `--github-repo OWNER/REPO`. This only formats
the instructions; it does not create a repository or push files.

For GitHub distribution, commit the **contents of the generated directory** at
the root of a separate marketplace repository. Include `.agents/`,
`.claude-plugin/`, `plugins/gamma/.codex-plugin/`, and
`plugins/gamma/.claude-plugin/`. After publication, users run the command for their client:

```text
codex plugin marketplace add OWNER/REPO
claude plugin marketplace add OWNER/REPO
```

They then install Gamma PDF from that marketplace in the plugin browser and
connect their own library. The main Gamma repository itself is not a marketplace
root. The `Assistant plugin package` workflow checks both catalogs, shared files,
release versions, checksums, and the Codex installers on
Windows, macOS, and Linux and uploads preview assets.

The existing `desktop.yml` Gamma release workflow also builds the plugin with
the computed release version and publishes these assets on the same `vX.Y.Z` release:

- `gamma-codex-plugin-X.Y.Z.zip`
- `install-gamma-codex.ps1` and `install-gamma-codex.sh`
- `gamma-codex-SHA256SUMS.txt`
- `gamma-claude-code-plugin-X.Y.Z.zip`
- `gamma-claude-code-SHA256SUMS.txt`

Both ZIPs contain identical bytes; separate names make the client downloads easy
to find while keeping one build. The Codex installers retain their published names
and behavior. The old `package_codex_plugin.py` entry point still builds the shared
package; `release_codex_plugin.py` still emits only the original Codex asset names.

Build-only runs keep them as CI artifacts. Keeping them on the existing
release preserves the desktop updater's latest-release convention. Preview the
assets locally with:

```text
python tools/release_plugins.py --output tmp/gamma-plugin-release --version 1.2.3
```

The packager sets the version only in the exported manifests; it does not tag
or publish. Nothing here submits a public directory listing, which needs a
stable public HTTPS endpoint and a review.

Official references: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[plugin packaging](https://developers.openai.com/plugins/build/plugins), and
[public submission](https://developers.openai.com/plugins/deploy/submission).

## Troubleshooting

- **Marketplace root does not contain a supported manifest:** run
  `codex plugin marketplace list` and check whether the registered source still
  contains `.agents/plugins/marketplace.json`. If a temporary source was deleted,
  rebuild into a persistent directory, run `codex plugin marketplace remove gamma-local`,
  then `codex plugin marketplace add <persistent-directory>` and
  `codex plugin add gamma@gamma-local`. Restart Codex and use a new chat.
- **MCP disabled by requirements:** `codex mcp list` reports the applicable
  managed policy. Ask the workspace administrator to permit the Gamma MCP
  connection; reinstalling the plugin or signing in again cannot override policy.
- **401:** sign in again if OAuth access expired or was revoked. For a manual token,
  confirm the Codex process inherited the variable. Account/workspace access must
  still exist. OAuth tokens are bound to the exact server URL used when signing in.
- **421:** the request's host is neither loopback nor the confirmed public
  server URL (Settings → Server); confirm the address first.
- **503:** the ASGI lifespan is not running.
- **Connection refused:** Gamma is stopped, the desktop port changed, or the MCP
  client is running on a different machine where localhost means that machine.
- **No tool in the picker:** verify the direct MCP connection first. Plugin/skill
  picker behavior varies by Codex surface; installing the workflow alone does not
  connect a server. Use `/mcp` in the CLI to inspect configured servers.

## Validation

`backend/tests/test_mcp.py` exercises the SDK endpoint, real tool reads, input
validation, workspace isolation, permissions, expiration, and revocation.
`test_mcp_oauth.py` covers discovery, approval, PKCE, resource/client/redirect
binding, expiration, replay prevention, revocation, and streamed body limits.
`test_integration_lifecycle.py` covers manual and OAuth tokens across account
rename, password changes through the admin API and CLI, workspace deletion,
and account deletion through the admin API and `manage.py delete-user`.
`test_migrations.py` covers
schema upgrades. Browser scenarios cover sign-in, approval, cancellation, and MCP
reads as well as manual-token creation and revocation.

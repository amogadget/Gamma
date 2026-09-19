# Gamma MCP and Codex

Gamma exposes a read-only Streamable HTTP MCP endpoint at `/mcp`, on the same
server as the app. Gamma's chat and MCP adapter share `gamma/ai_tools.py`:
tool definitions, executors, page/folder scope checks, and dispatch permissions.
The chat calls these functions directly. Gamma is not an MCP client for external
servers, and connecting Codex does not invoke Gamma's AI provider.

| File | Owns |
|---|---|
| `gamma/mcp_server.py` | the `/mcp` transport (official Python MCP SDK), the four read tools plus the two picker tools |
| `gamma/mcp_oauth.py` | discovery, dynamic registration, PKCE authorization and token exchange, the consent API (`/api/integrations/oauth/*`), `public_base` |
| `gamma/mcp_picker.py` + `mcp_paper_picker.html` | the sandboxed MCP-Apps paper picker and its text fallback |
| `gamma/integrations.py` | integration tokens (`integration_tokens` table, hashes only) and their resolution |
| `gamma/server_settings.py` | the admin-confirmed public URL and the MCP host allowlist |
| `gamma/routers/integrations.py` | the session-only token management API |
| `users.db` tables `integration_tokens`, `mcp_oauth` | migrations 6 and 7 ([migrations.md](migrations.md)) |
| `frontend/src/settings/SettingsIntegrations.jsx`, `frontend/src/auth/McpConsent.jsx` | the External assistants pane, the consent screen |
| `plugins/gamma/`, `tools/*codex*`, `.github/workflows/codex-plugin.yml` | the Codex plugin and its packaging |

## Connect

Open Gamma in your browser and go to **Settings → AI → External assistants**.
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
| `show_paper_picker` | Interactive title search and paper selection, with a text fallback |
| `search_paper_choices` | Picker pagination/search through the host bridge (app visibility) |

### Choose a paper inside ChatGPT

Install the Gamma PDF plugin, keep its MCP connection enabled, and start a new
chat. Mention the plugin with `@` and ask **"Let me choose a paper"**. The
`show_paper_picker` tool opens a searchable list in clients that render MCP Apps.
Select a paper, optionally type a question, then click **Use this paper** or
**Ask about this paper**. This sends a short message containing the title and
Gamma URL (with exact page/workspace IDs), plus your question if provided.
The picker collapses after sending; **Choose another paper** reopens it.
The assistant reads the selected page through `read_page`. If you already know
the title, simply ask **"Use Gamma to explain [paper title]"** to skip the picker.

The picker searches titles (including notes pages), shows 20 results at a time,
and stays inside the connection's authorized workspace. Choosing a paper does
not change Gamma's current workspace or grant additional access. Duplicate
titles are distinguished by page ID. This is an in-conversation picker, not
individual-paper autocomplete in ChatGPT's native `@` menu.

The server supplies `ui://gamma/paper-picker-v1.html` as an authenticated MCP
resource with MIME type `text/html;profile=mcp-app`. It is a self-contained,
sandboxed component with no external scripts or network access. Search uses
host-proxied `tools/call`; selection uses `ui/message` with a content-block array.
Gamma's existing icon is bundled with the plugin, MCP metadata, and picker;
whether the tool card displays the supplied icon depends on the host.
Tokens are never embedded
in the HTML. The UI is served by Gamma, so updating the skills-only plugin does
not replace the server's picker code.

If the client does not render MCP Apps, the tool also returns text choices with
titles and page links. Choose one in a reply. The assistant is
instructed not to duplicate the list beneath a working picker.
If the host rejects the selection message, the
picker shows a copyable reference. A connected MCP server by itself does not
guarantee UI support; check your client's support when no picker appears.

Implementation references: [OpenAI MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui)
and [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview).

Results include an absolute page URL or URL template carrying the workspace ID.
PDF page numbers are physical 1-based page numbers. Existing read budgets and
indexing/incomplete-result notices still apply. The tools read text only: no
rendered PDF figures, no handwriting recognition.

## Self-hosted and remote connections

Open Gamma at its public HTTPS address, then sign in as an administrator and
open **Settings → Administration → Server → Public server URL**. The field
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
manual tokens in **External assistants**, where users can revoke them.

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

### Install from a Gamma release

Open **Settings → AI → External assistants → Codex CLI** in browser or self-hosted
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

`plugins/gamma` is a skills-based Codex plugin. Its workflow uses the separately
configured Gamma MCP server; this keeps per-installation addresses and credentials
out of a distributable package. A direct MCP connection also works without the
plugin, including in the Codex IDE extension.

From a Gamma checkout, build into a directory you will keep. Codex registers
the source path and continues reading its catalog after installation; deleting
it breaks marketplace discovery even when the plugin remains cached. For
example, in Windows PowerShell:

```powershell
python tools/package_codex_plugin.py --output "$env:LOCALAPPDATA/Gamma/codex-plugin/gamma-marketplace" --archive
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
the root of a separate marketplace repository. Include `.agents/` and
`plugins/gamma/.codex-plugin/`. After publication, users run:

```text
codex plugin marketplace add OWNER/REPO
```

They then install Gamma PDF from that marketplace in the plugin browser and
connect their own library. The main Gamma repository itself is not a marketplace
root. The `Codex plugin package` workflow checks the package and installers on
Windows, macOS, and Linux and uploads preview assets.

The existing `desktop.yml` Gamma release workflow also builds the plugin with
the computed release version and publishes these assets on the same `vX.Y.Z` release:

- `gamma-codex-plugin-X.Y.Z.zip`
- `install-gamma-codex.ps1` and `install-gamma-codex.sh`
- `gamma-codex-SHA256SUMS.txt`

Build-only runs keep them as CI artifacts. Keeping them on the existing
release preserves the desktop updater's latest-release convention. Preview the
assets locally with:

```text
python tools/release_codex_plugin.py --output tmp/gamma-plugin-release --version 1.2.3
```

The packager sets the version only in the exported manifest; it does not tag
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
  server URL (Settings → Administration → Server); confirm the address first.
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
binding, expiration, replay prevention, and revocation. `test_migrations.py` covers
schema upgrades. Browser scenarios cover sign-in, approval, cancellation, and MCP
reads as well as manual-token creation and revocation.

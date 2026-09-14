# Workspaces

Accounts and libraries are separate things. A **workspace** is a library:
its own pages, PDFs, chats and search indexes. An account belongs to one or
more workspaces under a role, and switches between them from the account
menu. Code: `gamma/workspaces.py` (model), `gamma/auth.py` (request →
workspace), `gamma/routers/workspaces.py` (API), `frontend/src/settingsWorkspace.jsx`
(the Settings pane), the switcher in `App.jsx`.

## Model

- Every account gets a **personal workspace** when it is created
  (`users.default_workspace`). It is where a request lands when it names no
  workspace (the browser extension, older clients), and the one the account
  can never leave or delete — it goes with the account.
- Any non-guest account can **create** more workspaces and **invite** other
  accounts (Notion-style). Page share links stay the way to let outsiders
  (people without an account) in ([api.md](api.md) "Share permissions").
- **Roles** (`workspace_members.role`): `owner` manages members, renames,
  deletes, restores backups; `editor` reads and writes; `viewer` reads. A
  workspace always keeps at least one owner. Naming another member owner is
  how ownership is handed on.
- **Access** (`workspaces.access`): `private` — members only, by invitation
  (the default, and the only choice for a personal workspace); `public` —
  every signed-in non-guest account on the server can open it at the
  workspace's `public_role` (viewer or editor), with no join step. Public
  access is not a membership: `role_of` answers the explicit membership
  first, else the public role; the switcher lists public workspaces for
  everyone; there is nothing to "leave". Invited members keep their own role
  on top (an invited viewer stays a viewer in an everyone-edits workspace).
  Only server admins set access.
- **Server admins** pass every check of the workspace API for every
  workspace without being members — inspect, rename, set access and quota,
  manage members and ownership, delete, create a workspace for any owner
  (Settings → Workspaces, or `manage.py`). Reading a workspace's pages still
  takes membership or public access: an admin opens a private workspace only
  after adding themselves ("Join as owner").
- **Storage** ([user_db.md](user_db.md)): only an account's *personal*
  workspace counts against its quota — uploading into a shared workspace
  costs nobody's allowance. A shared workspace has its own optional cap,
  `workspaces.quota_mb` (NULL = unlimited), set by admins; its per-file limit
  is the server default. `GET /api/quota` reports the limits and usage that
  apply to the request's workspace (`account` names the person for a
  personal one, "" for a shared one).
- The guest account has a personal workspace like anyone (wiped daily), can
  neither create workspaces nor be invited, and sees no public workspace.

On disk (`GAMMA_DATA_DIR`): `users.db` holds the `workspaces` (`id`,
`name`, `created_by`, `access`, `public_role`, `quota_mb`),
`workspace_members`, `shares` (keyed by `(workspace_id, page_id)`) and
`user_prefs` tables next to accounts and sessions; `workspaces/<id>/` holds
each workspace's `pages.db`, `data.db` and `uploads/`. Ids are random
tokens, so renaming a workspace or an account never moves files. Full
layout: [user_db.md](user_db.md).

## Which workspace a request means

`gamma/auth.py`:

| helper | returns | for |
|---|---|---|
| `require_user` | the session username | identity-only endpoints (session, AI keys, admin) |
| `require_ws(request, write=)` | the session's workspace id — `?ws=`, else the `X-Gamma-Workspace` header, else the account's default; 403 when not a member (nor admitted by public access), or a viewer with `write=True` | every session-only data endpoint |
| `resolve_ws` | a `?share=` token's workspace, else `require_ws` | read endpoints that also serve share views |
| `require_ws_writer` | an edit share's workspace, else `require_ws(write=True)` | the block writers that accept share editors |
| `ws_role` | the session's role in the resolved workspace | e.g. the AI chat, to withhold mutating tools from viewers |

The returned id is what every data helper takes (`connect_pages_db`,
`ws_uploads_dir`, `commit_ops`, …); `request.state.user` stays the actor
written into the op log. The websocket handshake resolves the same way
(`?ws=` on the socket URL, since a handshake carries no custom headers).

The middleware also puts the account's default workspace on
`request.state.default_ws` (one query, already made for the session).
Membership itself is checked lazily and cached per request.

## Shares inside workspaces

A share names a page in a workspace. Anyone the link admits reads (or, with
an edit share, writes inside) that page. Members of the page's workspace keep
their workspace role on top: editors and owners edit through the link too,
viewers stay viewers, and an explicit invite on the share can only add
(`auth.share_access`). Any editor or owner of the workspace manages the
page's share (create, settings, stop); `shares.created_by` records who
minted it.

## API

`/api/workspaces` (`routers/workspaces.py`, all session-only; "owner" below
always includes server admins, member or not). The list of my workspaces is
part of `GET /session` (`workspaces: [{id, name, role, access, public_role,
personal, members, created_by, created_at}]`), there is no separate list
endpoint.

| Method | Path | Purpose |
|---|---|---|
| POST | `/workspaces` `{name, owner?, access?, public_role?, quota_mb?}` | create; the caller becomes owner (guests 403). `owner` (another account), `access`, `public_role`, `quota_mb` are admin-only |
| GET | `/workspaces/{id}` | the workspace with `role` (the caller's; null for an admin outsider), `personal_of` (whose personal workspace, "" if shared), `members: [{username, role, added_by, added_at}]` and `quota` (any member; admins) |
| PUT | `/workspaces/{id}` `{name?, access?, public_role?, quota_mb?}` | rename (owner); access / public role / the workspace's own quota (admin; `quota_mb` 0 or null = unlimited, refused on a personal workspace; a personal workspace cannot go public) |
| DELETE | `/workspaces/{id}` | delete with everything in it (owner; a personal workspace is refused) |
| PUT | `/workspaces/{id}/members/{user}` `{role}` | invite or change a role — incl. naming a new owner (owner; no guests, the last owner cannot be demoted) |
| DELETE | `/workspaces/{id}/members/{user}` | remove a member (owner) or leave (yourself; not the last owner, not your personal workspace, and not a public workspace you are no explicit member of) |
| GET | `/workspaces/find-page/{page_id}` | which of my workspaces holds this page — a deep link without `ws` |

`GET /api/accounts` (`routers/auth.py`) is the account directory the invite
and owner pickers show: every non-guest account, `[{username, is_admin}]`;
any signed-in non-guest account may read it.

Admin: `GET /api/admin/workspaces` lists every workspace (`access`,
`public_role`, `quota_mb`, `personal` = the account it belongs to or "",
`used_bytes`, `members`) plus directories under `workspaces/` that no row
names — the source of Settings → Workspaces. Backups (`/api/export`,
`/api/import-data`) take `?ws=` — any member exports, merge needs an editor,
replace an owner — and, for admins, `?user=` for an account's personal
workspace ([api.md](api.md)). `manage.py` has `list-workspaces`,
`create-workspace`, `set-member` and `set-access`.

## Frontend

- `GET /api/session` returns the account's workspaces (memberships plus
  every public one, each with `access`); `App.jsx` `chooseWorkspace` picks one: the URL's `?ws=` when the account belongs to
  it, else — for a `?page=`/`?block=` link without `ws` — the workspace that
  holds the page (`find-page`), else the last one used in this browser
  (`gamma-last-ws:<user>`), else the personal one. `applyWorkspace` then sets
  it on the fetch wrapper (`utils.setCurrentWorkspace` → the
  `X-Gamma-Workspace` header on every API call), writes `ws` into the URL, and
  makes the tree read-only for a viewer. Nothing is fetched before that
  (`wsReady` gates the deep-link boot and the data effects).
- In-app URLs, copied block links and the page websocket carry `ws`
  (`utils.withWorkspace`); share URLs never do.
- Per-account browser state that names pages (open tabs, recents, pinned and
  extra folders, reading positions, page layouts, the restored session) is
  keyed `user@workspace` in localStorage and stored per account and
  workspace on the server (`user_prefs`); appearance and the AI provider
  choice follow the account everywhere (`db.USER_PREF_KEYS`).
- Switching (account menu → a workspace, or Settings → Members & sharing →
  Open) is a navigation to `/?ws=<id>`: tabs, recents, the open page and the
  live session all belong to the library being left, so the tab reloads.
- Settings → Members & sharing (`settingsWorkspace.jsx`): rename, storage,
  the Access rows (private / public + the public role, and a shared
  workspace's own quota — editable by admins, read-only for owners),
  export/import of this workspace, the member list with role menus (owners),
  Invite (an `AccountPicker` over `/api/accounts` — search box + account
  rows — plus the role), leave, delete, the list of all my workspaces with
  Open, and New workspace (creates and opens). Hidden for guests. The module
  also exports the pieces the admin pane is built from: `useAccounts`,
  `useWorkspace(wsId)` (one workspace's state + every call on it),
  `AccessRows`, `StorageRow`, `MembersList`, `InviteDialog`, `NameDialog`.
- Settings → Workspaces (`settingsWorkspacesAdmin.jsx`, admins only): every
  workspace on the server in two lists (shared: access tag, owners, member
  count, size and quota; personal: per account), each with Open (when the
  admin can) and Manage — a dialog with rename, the Access rows, the member
  list with role menus (naming someone Owner hands the workspace on), Add
  (the same invite picker), Delete, and "Join as owner" for a private
  workspace the admin is not in. New workspace takes a name, an owner picked
  from the directory (the admin by default), private / public with the
  public role, and a quota. The share popover's invite box is the same
  `AccountPicker` (one account per Invite).

## Decisions

- Chats and cover snapshots are workspace data (they name the workspace's
  pages) and are shared by its members; personal prefs and AI credentials
  are not.
- One workspace per tab, chosen once per load; no cross-workspace views. A
  page moves between workspaces through export/merge, not drag and drop.
- Public means "everyone with an account on this server", decided by an
  admin, with no join step — a lab's reading room. There is still no
  "anyone with the link can join" and nothing for people without an
  account; share links cover that per page.
- Only personal workspaces count against a person's quota. Sharing is not
  billed to whoever happened to create the workspace; a shared workspace
  that needs a cap gets its own (`quota_mb`), set by an admin.

The reasoning behind these (what the old username-keyed layout cost, the
alternatives that were rejected) is in
[research/workspaces.md](../research/workspaces.md).

## Limits and next steps

- Viewers still see some write affordances (upload buttons, the share menu);
  the server refuses the writes. Hiding them behind `readOnly` is UI polish.
- Everyone on the server can read the account directory (`/api/accounts`)
  once signed in — the pickers need it. A server that wants accounts hidden
  from each other would gate it behind a server setting.
- Chats are workspace data, so members of a shared workspace see each
  other's AI conversations about its pages. Per-member chats would need a
  `(bucket, username)` key.
- No cross-workspace page move (export/merge does it); a "Move page to
  workspace…" action would be a server-side copy + delete.
- The extension clips into the personal workspace; a workspace picker in its
  popup would send `ws`.
- Activity/audit: `workspace_members.added_by` and the op log's `actor`
  exist; nothing shows them yet.
- The desktop shell reads the workspace list only after navigation and when
  its menu opens, so a workspace created in Gamma appears in the shell bar on
  the next menu open, not live.

# Workspaces

Accounts and libraries are separate things. A **workspace** is a library:
its own pages, PDFs, chats and search indexes. An account has one or more
personal workspaces of its own, belongs to shared ones under a role, and
switches between them from the account menu. Code: `gamma/workspaces.py` (model), `gamma/auth.py` (request →
workspace), `gamma/routers/workspaces.py` (API), `frontend/src/settingsWorkspace.jsx`
(the Settings pane), the switcher in `App.jsx`.

## Model

Two kinds of workspace (`workspaces.kind`):

- **Personal** — one account's own library. Every account gets one when it
  is created and any non-guest account can create more (work, life, play).
  The account is its single member and owner; nothing else joins it — page
  share links stay the way to let others in per page ([api.md](api.md)
  "Share permissions"). One of them is the account's **default**
  (`users.default_workspace`): where a request lands when it names no
  workspace (the browser extension, older clients), and the fallback when
  another workspace is left or deleted. The first one created is the
  default, any other personal one can be made default, and the last
  personal workspace cannot be deleted — deleting the default moves the
  default to the oldest other one.
- **Shared** — created by server admins, for any owner. **Roles**
  (`workspace_members.role`): `owner` manages members, renames, deletes,
  restores backups; `editor` reads and writes; `viewer` reads. A workspace
  always keeps at least one owner; naming another member owner is how
  ownership is handed on. **Access** (`workspaces.access`): `private` —
  members only, by invitation; `public` — every signed-in non-guest account
  on the server can open it at the workspace's `public_role` (viewer or
  editor), with no join step. Public access is not a membership: `role_of`
  answers the explicit membership first, else the public role; the switcher
  lists public workspaces for everyone; there is nothing to "leave". Invited
  members keep their own role on top (an invited viewer stays a viewer in an
  everyone-edits workspace). Only server admins set access.
- **Conversion** (admins): personal → shared keeps the owner as owner,
  stops metering it against them and, if it was their default, moves the
  default to another personal workspace (refused for their last one).
  Shared → personal needs exactly one member, who becomes its account;
  access resets to private and the workspace quota is cleared.
- **Server admins** pass every check of the workspace API for every
  workspace without being members — inspect, rename, set access, quota and
  kind, manage members and ownership, delete, create a shared workspace for
  any owner (Settings → Workspaces, or `manage.py`). Reading a workspace's
  pages still takes membership or public access: an admin opens a private
  shared workspace only after adding themselves ("Join as owner"), and a
  personal workspace not at all.
- **Storage** ([user_db.md](user_db.md)): an account's quota covers its
  personal workspaces together — uploading into a shared workspace costs
  nobody's allowance, and nothing a user can create escapes their quota. A
  shared workspace has its own optional cap, `workspaces.quota_mb` (NULL =
  unlimited), set by admins; its per-file limit is the server default. `GET
  /api/quota` reports the limits and usage that apply to the request's
  workspace (`account` names the person for a personal one, "" for a shared
  one; `used_bytes` is the account's total, `workspace_bytes` this one's).
- The guest account has a personal workspace like anyone (wiped daily), can
  neither create workspaces nor be invited, and sees no public workspace.

On disk (`GAMMA_DATA_DIR`): `users.db` holds the `workspaces` (`id`,
`name`, `created_by`, `kind`, `access`, `public_role`, `quota_mb`),
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
part of `GET /session` (`workspaces: [{id, name, kind, role, access,
public_role, personal, default, members, created_by, created_at}]`), there
is no separate list endpoint.

| Method | Path | Purpose |
|---|---|---|
| POST | `/workspaces` `{name, kind?, owner?, access?, public_role?, quota_mb?}` | create a personal workspace of the caller's (guests 403). `kind: "shared"`, `owner` (another account), `access`, `public_role`, `quota_mb` are admin-only |
| GET | `/workspaces/{id}` | the workspace with `kind`, `role` (the caller's; null for an admin outsider), `personal_of` (whose personal workspace, "" if shared), `default` (the caller's default?), `members: [{username, role, added_by, added_at}]` and `quota` (any member; admins) |
| PUT | `/workspaces/{id}` `{name?, default?, kind?, access?, public_role?, quota_mb?}` | rename (owner); `default: true` makes a personal workspace the caller's default (its owner); kind / access / public role / the workspace's own quota (admin; `quota_mb` 0 or null = unlimited; access and quota are refused on a personal workspace) |
| DELETE | `/workspaces/{id}` | delete with everything in it (owner; an account's last personal workspace is refused, deleting the default moves the default) |
| PUT | `/workspaces/{id}/members/{user}` `{role}` | invite or change a role — incl. naming a new owner (owner of a shared workspace; no guests, the last owner cannot be demoted; a personal workspace refuses) |
| DELETE | `/workspaces/{id}/members/{user}` | remove a member (owner) or leave (yourself; not the last owner, not a personal workspace, and not a public workspace you are no explicit member of) |
| GET | `/workspaces/find-page/{page_id}` | which of my workspaces holds this page — a deep link without `ws` |

`GET /api/workspaces/mine` is what Settings → Workspaces and Backups read:
the session list plus each workspace's upload size and the account's
storage (limits + the usage of all its personal workspaces).
`GET /api/accounts` (`routers/auth.py`) is the account directory the invite
and owner pickers show: every non-guest account, `[{username, is_admin}]`;
any signed-in non-guest account may read it.

## Backups

One zip format, `gamma-backup-1` (`gamma/ws_backup.py`): consistent copies
of `pages.db` and `data.db`, every file under `uploads/` unless databases-
only was asked, and a `manifest.json`. Three things produce or consume it:

- **Export / Import** — `GET /api/export` downloads it, `POST
  /api/import-data` restores (`replace`, owners) or merges (`merge`,
  editors) one into a workspace; `GET /api/export-all` bundles one per
  personal workspace. On every workspace row in Settings → Workspaces.
- **Snapshots** — `backups/workspaces/<ws>/<time>-<label>.zip`, kept on the
  server: an owner takes one (Settings → Backups; "Back up all" takes one
  per workspace they own), any member lists and downloads, an owner
  restores in place or deletes, an editor merges. Each snapshot is a FULL
  copy, never an incremental chain: any one restores on its own and
  deleting one never breaks another. The cost is size, bounded by
  `MAX_PER_WORKSPACE` (20) and the databases-only choice; snapshots count
  against nobody's quota, are not part of admin server snapshots, and go
  with the workspace when it is deleted. The guest workspace keeps none.
- **Page exports** (`/api/pages/{id}/export?mode=gamma`) are the same zip
  scoped to one page, for `import-data?mode=merge`
  ([import_export.md](import_export.md)).

Admin snapshots of the whole data directory (`gamma/backups.py`, Settings →
Server) are a different thing: a copy of every database for rollback with
the server stopped ([migrations.md](migrations.md)).

Admin: `GET /api/admin/workspaces` lists every workspace (`kind`, `access`,
`public_role`, `quota_mb`, `personal` = the account a personal one belongs
to or "", `default`, `used_bytes`, `members`) plus directories under
`workspaces/` that no row names — the source of Settings → Workspaces. Backups (`/api/export`,
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
  (`utils.withWorkspace`); share URLs never do. Upload URLs the BROWSER
  fetches itself — `<img>` sources and file-chip links rendered from block
  content, which the fetch wrapper's header never reaches — go through
  `utils.assetUrl` (the react-markdown `urlTransform` in `blockTree.jsx` and
  `widgets.jsx`), which appends `ws` or the share token; the bare
  `/api/uploads/<hash>.ext` stays what block content stores.
- Per-account browser state that names pages (open tabs, recents, pinned and
  extra folders, reading positions, page layouts, the restored session) is
  keyed `user@workspace` in localStorage and stored per account and
  workspace on the server (`user_prefs`); appearance and the AI provider
  choice follow the account everywhere (`db.USER_PREF_KEYS`).
- Switching (account menu → a workspace, or Settings → Members & sharing →
  Open) is a navigation to `/?ws=<id>`: tabs, recents, the open page and the
  live session all belong to the library being left, so the tab reloads.
- Settings → Workspaces (`settingsWorkspace.jsx`, `WorkspacesSettings`):
  every workspace I can open, in one place — my storage meter, then the
  Personal list (with Export all and New workspace, which creates a
  personal one and opens it) and the Shared list. Every row carries Open,
  Export ▾ (everything / databases only), Import ▾ (restore for owners,
  merge for editors) and Manage: `ManageWorkspaceDialog`, in settings-row
  sections — General (name, storage), Access (shared; admins edit, owners
  read), Members (the list with role menus and Invite, an `AccountPicker`
  over `/api/accounts`) and Actions (Make default on a personal one, Leave,
  Delete, and in admin mode Make shared / Make personal and Join), with
  only Open and Done in the footer. The dialog re-reads the workspace from
  the server after every change (`useWorkspace.reload`), so it always shows
  what is stored. Hidden for guests. The same dialog serves the admin in
  `admin` mode (below). Also exported:
  `useAccounts`, `useWorkspace(wsId)` (one workspace's state + every call
  on it), `AccessRows`, `StorageRow`, `MembersList`, `InviteDialog`,
  `NameDialog`, `WorkspaceDataMenus`, `workspaceMeta` (the switcher's
  one-line description).
- Settings → Backups (`settingsBackups.jsx`, `WorkspaceBackups`): my
  workspaces' server-kept snapshots, one section per workspace — Back up
  now ▾ (everything / databases only) for owners, "Back up all N
  workspaces" for every one I own, and per snapshot Download, Restore ▾
  (Replace for owners, Merge for editors — restoring the open workspace
  reloads the app) and Delete. Hidden for guests.
- Settings → Server (`settingsServer.jsx`, admins only): the storage
  defaults, every workspace on the server (`settingsWorkspacesAdmin.jsx`:
  shared and personal lists, New shared workspace with an owner picker,
  Manage in admin mode — access, quota, ownership, Make shared / Make
  personal, Join as owner), the whole-data-directory Server backups and
  the server log. The share popover's invite box is the same
  `AccountPicker` (one account per Invite).

## Decisions

- Chats and cover snapshots are workspace data (they name the workspace's
  pages) and are shared by its members; personal prefs and AI credentials
  are not.
- One workspace per tab, chosen once per load; no cross-workspace views. A
  page moves between workspaces through export/merge, not drag and drop.
- Two kinds, not one: a personal workspace is a person's own library
  (several allowed — work, life, play), a shared one is a group's, made by
  an admin. Users cannot create shared workspaces, so nothing a user makes
  escapes their quota and sharing is always a server-level decision.
- Public means "everyone with an account on this server", decided by an
  admin, with no join step — a lab's reading room. There is still no
  "anyone with the link can join" and nothing for people without an
  account; share links cover that per page.
- Only personal workspaces count against a person's quota. Sharing is not
  billed to whoever happened to create the workspace; a shared workspace
  that needs a cap gets its own (`quota_mb`), set by an admin.
- The default workspace is a pointer, not a kind: any personal workspace
  can be it, and it exists only so that requests naming no workspace have
  somewhere to land.

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

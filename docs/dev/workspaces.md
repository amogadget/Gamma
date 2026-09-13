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
  accounts (Notion-style). There is nothing public: a workspace is reachable
  only by its members. Page share links stay the way to let outsiders in
  ([api.md](api.md) "Share permissions").
- **Roles** (`workspace_members.role`): `owner` manages members, renames,
  deletes, restores backups; `editor` reads and writes; `viewer` reads. A
  workspace always keeps at least one owner. Server admins pass the owner
  checks of every workspace (recovery when the last owner is gone) but are
  not members: they read a workspace's pages only after adding themselves.
- **Storage limits** are an account's ([user_db.md](user_db.md)); uploads
  into a workspace count against its *billing account* — whoever created it,
  as long as they are still an owner, else any owner
  (`workspaces.billing_user`). `GET /api/quota` reports the limits that apply
  to the request's workspace and the billed account's total usage.
- The guest account has a personal workspace like anyone (wiped daily) and
  can neither create workspaces nor be invited.

On disk (`GAMMA_DATA_DIR`): `users.db` holds the `workspaces`,
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
| `require_ws(request, write=)` | the session's workspace id — `?ws=`, else the `X-Gamma-Workspace` header, else the account's default; 403 when not a member, or a viewer with `write=True` | every session-only data endpoint |
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

`/api/workspaces` (`routers/workspaces.py`, all session-only):

| Method | Path | Purpose |
|---|---|---|
| GET | `/workspaces` | mine: `{workspaces: [{id, name, role, personal, members, created_by, created_at}], default}` (also part of `GET /session`) |
| POST | `/workspaces` `{name}` | create; the caller becomes owner (guests 403) |
| GET | `/workspaces/{id}` | the workspace with `members: [{username, role, added_by, added_at}]` and `quota` (any member) |
| PUT | `/workspaces/{id}` `{name}` | rename (owner) |
| DELETE | `/workspaces/{id}` | delete with everything in it (owner; a personal workspace is refused) |
| PUT | `/workspaces/{id}/members/{user}` `{role}` | invite or change a role (owner; no guests, the last owner cannot be demoted) |
| DELETE | `/workspaces/{id}/members/{user}` | remove a member (owner) or leave (yourself; not the last owner, not your personal workspace) |
| GET | `/workspaces/find-page/{page_id}` | which of my workspaces holds this page — a deep link without `ws` |

Admin: `GET /api/admin/workspaces` lists every workspace with members and
upload size, plus directories under `workspaces/` that no row names.
Backups (`/api/export`, `/api/import-data`) take `?ws=` — any member exports,
merge needs an editor, replace an owner — and, for admins, `?user=` for an
account's personal workspace ([api.md](api.md)). `manage.py` has
`list-workspaces` and `set-member`.

## Frontend

- `GET /api/session` returns the account's workspaces; `App.jsx`
  `chooseWorkspace` picks one: the URL's `?ws=` when the account belongs to
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
  export/import of this workspace, the member list with role menus (owners),
  invite, leave, delete, the list of all my workspaces with Open, and New
  workspace (creates and opens). Hidden for guests.

## Decisions

- Chats and cover snapshots are workspace data (they name the workspace's
  pages) and are shared by its members; personal prefs and AI credentials
  are not.
- One workspace per tab, chosen once per load; no cross-workspace views. A
  page moves between workspaces through export/merge, not drag and drop.
- No public workspaces and no "anyone with the link can join": invitations
  by username only. Share links cover the public case per page.
- Billing follows the workspace's creator so a shared workspace does not
  multiply everyone's quota; an admin who wants a lab workspace on a bigger
  quota raises the creator's limit.

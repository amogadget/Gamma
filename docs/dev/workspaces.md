# Workspaces

An account identifies a person. A workspace holds a library: pages, uploaded
files, chats and search indexes. Each browser tab opens one workspace.

Use the account menu to switch libraries. **Settings → Workspaces** lists the
libraries you can open and provides their export, import and management
actions. **Settings → Backups** manages saved workspace snapshots.
Administrators manage shared workspaces under **Settings → Server** and
each account's personal workspaces on its row under **Settings → Users**.

## Personal and shared libraries

Every account starts with a personal workspace and can create more. Each
personal workspace has exactly one member, its owner. Use page share links
to give others access to individual pages; personal workspaces cannot invite
additional workspace members.

A server administrator creates shared workspaces and chooses their owner.
The owner can then invite existing accounts:

| Role | Read pages | Edit pages | Manage members, rename, delete or restore |
|---|---|---|---|
| Viewer | Yes | No | No |
| Editor | Yes | Yes | No |
| Owner | Yes | Yes | Yes |

A shared workspace must retain at least one owner. To transfer ownership,
make another member an owner before removing or demoting the current owner.

Administrators also choose shared workspace access:

- **Private:** only explicit members can open it.
- **Public:** every signed-in, non-guest account can open it with the
  configured viewer or editor role. Explicit membership takes precedence:
  an invited viewer stays a viewer even if public access permits editing.
  Public access creates no membership to leave and consumes no workspace
  creation slot.

Public does not mean anonymous. Page share links provide access for people
without accounts. The guest account has its own daily-reset personal
workspace; it cannot create workspaces, join shared ones or use public access.

Administrators may manage a workspace without joining it. This does not grant
access to its private pages: an administrator must join a private shared
workspace to read it. Personal workspaces cannot be joined.

## Defaults, conversion and storage

Each account chooses one personal workspace as its **default**. Requests that
name no workspace, including extension clips, use this library. Deleting the
default selects the oldest remaining personal workspace. The last personal
workspace cannot be deleted independently of the account.

Administrators can convert between kinds:

- **Personal → shared:** keep the owner; move the account's default if
  necessary. Refuse conversion of its last personal workspace.
- **Shared → personal:** require exactly one member, make that person the
  owner, reset access to private and the public role to viewer, and remove
  the workspace quota.

Workspace updates are atomic. A request combining a rename, conversion,
access change or default change either applies all fields or changes
nothing. Authorization happens before mutation; validation uses the resulting
kind. The model and CLI helpers share this transaction in
`backend/gamma/workspaces.py`.

An account's upload quota covers all its personal workspaces together. Shared
workspace uploads count against nobody's personal allowance; administrators
can give each shared workspace its own quota. `0` or `null` means unlimited.
`GET /api/quota` reports the selected workspace's limits. See
[storage limits](user_db.md) for per-file limits and quota accounting.

## Data ownership

```text
GAMMA_DATA_DIR/
  users.db                 accounts, sessions, workspaces, memberships,
                           page shares and account preferences
  workspaces/<id>/
    pages.db               blocks and the per-page operation log
    data.db                chats, cover snapshots and search indexes
    uploads/               PDFs, images and other attachments
```

Workspace IDs are random and stable. Renaming an account or workspace changes
database rows without moving files. Schema upgrades run through the
[versioned migration system](migrations.md).

Workspace members share chats and cover snapshots as well as pages. AI keys,
provider choice and appearance belong to the account. Open tabs, recents,
reading positions and saved layouts belong to an **account and workspace**.
Their browser caches use `user@workspace`; another account opening the same
shared library gets its own reading state. Unscoped legacy session caches are
not restored because their owner is unknown.

## Request contract

Keep identity and data location separate in endpoint code:

| Helper in `backend/gamma/auth.py` | Purpose |
|---|---|
| `require_user(request)` | Session username; account-only data such as AI settings |
| `require_ws(request, write=False)` | Workspace ID with effective viewer access |
| `require_ws(request, write=True)` | Workspace ID with editor or owner access |
| `resolve_ws(request)` | Read through a share token, otherwise normal workspace access |
| `require_ws_writer(request)` | Write through an edit share, otherwise workspace editor access |
| `share_scope_page(request)` | Page boundary that a share-enabled endpoint must enforce |

Without a share token, selection is `?ws=` first, then `X-Gamma-Workspace`,
then the account's default. An inaccessible explicit workspace is refused;
the server does not fall back to another library. A share token chooses its
own workspace and confines access to one page. Workspace roles and page
invites determine whether that person can view or edit it.

Pass the workspace ID to data helpers such as `connect_pages_db` and
`commit_ops`. Use `request.state.user` as the actor in the operation log.
Account-wide preference keys do not require access to the selected workspace;
workspace-specific preferences do.

The browser fetch wrapper adds the workspace header. Browser-issued image and
download requests need `assetUrl`, which adds `ws` or the share token to the
URL. Store bare `/api/uploads/<hash>.<ext>` URLs in block content. Page sockets
carry `ws` or `share` in their URL because browser WebSocket handshakes cannot
set these custom headers.

## API entry points

All paths below begin with `/api`. Full payloads and authorization rules are
in the [API reference](api.md).

| Method and path | Result or action |
|---|---|
| `GET /session` | Account, default workspace and accessible workspace list |
| `GET /workspaces/mine` | Accessible workspaces with upload sizes, plus account storage totals |
| `POST /workspaces` | Create a personal workspace; administrators may create shared ones or choose another owner |
| `GET /workspaces/{id}` | Details, effective role, explicit members and quota |
| `PUT /workspaces/{id}` | Atomic settings update; omitted fields stay unchanged |
| `DELETE /workspaces/{id}` | Delete the workspace, its content and its saved workspace backups |
| `PUT /workspaces/{id}/members/{user}` | Invite or change a membership role |
| `DELETE /workspaces/{id}/members/{user}` | Remove a member, or leave your own explicit membership |
| `GET /workspaces/find-page/{id}` | Locate a page or block among accessible workspaces |
| `GET /accounts` | `{accounts: [{username, is_admin}]}` for invite and owner pickers; non-guest accounts only |
| `GET /admin/workspaces` | Administrator's inventory, including orphaned directories |

`GET /session` and `/workspaces/mine` use `members` as a count. Workspace
details use `members` as an array. Details report `personal_of` as the owner's
username; the session list instead has a boolean `personal`.

## Browser startup and switching

`App.jsx` waits for the session and selects the workspace before loading
library data:

1. Use an explicit `?ws=` if accessible. Otherwise show an unavailable
   workspace screen and keep the requested URL intact.
2. For a page or block link without `ws`, try `find-page`.
3. Try `gamma-last-ws:<user>` from this browser.
4. Use the account's default, or its first accessible workspace.

`applyWorkspace` sets the fetch header, account/workspace session scope and
viewer role, then releases the `wsReady` startup gate. It never invents an
owner role for an unknown workspace. Viewer layout restoration also waits
for this scope.

Switching navigates to `/?ws=<id>` and reloads the app. Tabs, the current page
and the live editing session belong to the library being left. Within a
library, each page retains its queued saves when navigation starts before a
save finishes. See [collaboration](collab.md) for delivery and retry behavior.

## Export and backups

Workspace exports, saved workspace snapshots and Gamma page exports use
`gamma-backup-1` ZIP files (`backend/gamma/ws_backup.py`). They contain a
manifest, database snapshots and uploads unless databases-only was selected.

- **Export / Import:** Settings → Workspaces. Any member exports; editors
  may merge an import; owners may replace the workspace. Export all bundles
  the account's personal workspaces. API: `/export`, `/export-all`,
  `/import-data`.
- **Saved workspace snapshots:** Settings → Backups. Owners create or delete
  them, members list and download them, editors merge them, and owners restore
  them in place. Each ZIP is independent. Up to 20 are kept per workspace;
  they do not count against upload quotas. Guests cannot keep snapshots.
- **Server snapshots:** Settings → Server. These cover the whole data
  directory and are restored with the server stopped. They are separate from
  workspace snapshots; see [migrations and server backups](migrations.md).

Exports transfer library content. Passwords, sessions and private AI
credentials stay with the account.

## Current limits

- Some viewer screens still expose write controls; the server refuses those
  operations. Effective permissions remain a server decision.
- Shared workspace chats are visible to other workspace members.
- The account directory is visible to every signed-in non-guest account.
- Cross-workspace page transfer uses export and merge, with no direct move.
- The browser extension clips into the default workspace.
- The desktop shell refreshes its workspace list on navigation or menu open.

The historical reasoning is in [research/workspaces.md](../research/workspaces.md).
Executable coverage is in `backend/tests/test_workspaces.py`,
`frontend/tests/sessionState.test.mjs` and `frontend/tests/e2e/`.

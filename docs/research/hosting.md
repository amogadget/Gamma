# Hosting Gamma for many users

An assessment from 2026-09 of what it would take to run Gamma as a
multi-tenant service with open registration, using cloud object storage
(Cloudflare R2) and managed services (Supabase) to keep the bill down. It
records where the code is coupled to a single machine, which of those
couplings are cheap to loosen and which are a rewrite, and the shape that
was picked. The current mechanics live in
[dev/workspaces.md](../dev/workspaces.md), [dev/user_db.md](../dev/user_db.md),
[dev/collab.md](../dev/collab.md) and [dev/migrations.md](../dev/migrations.md);
nothing here is implemented.

## Where the code assumes one machine

Four couplings were found; they differ a lot in how hard they are to undo.

**Uploads are a local directory.** `storage.store_pdf` / `store_file` write
bytes under a content hash into `workspaces/<id>/uploads/`,
`find_upload_file` returns a `Path`, and the uploads route serves the file
with Range support, which pdf.js's range transport depends on. The module is
small (about 230 lines) and every consumer wants a local path (about 70
call sites: the uploads route, export zips, the manifest in `pdf_meta`, text
extraction in `pdf_text`, backups). This is the easy one.

**Databases are SQLite, one set per workspace.** `pages.db` holds the block
tree behind recursive CTEs, `block_fts` / `pdf_fts` are FTS5 tables, the
schema version is `PRAGMA user_version`, a backup is a zip of the
directory, and a mirror's base tree is stored locally. Swapping this for
Postgres means redoing full-text search, the migration runner, the op log
tables, the backup format and mirror storage. Quarter-scale work, not a
deployment change. SQLite also cannot live on object storage: it needs
random writes and file locks.

**Collaboration rooms are in-process.** `collab._rooms` is a dict; a page's
sockets and op fan-out must share one process. Several instances need
either a pub/sub layer or a guarantee that one workspace always lands on
one node.

**Heavy work is synchronous and native.** pdfium extraction (behind one lock
in `pdf_text`), PyPDF2 exports and AI calls run in the threadpool. That
rules out serverless runtimes: Cloudflare's Python Workers are Pyodide
without native libraries or long connections. A container is required.

The good news is that every data path already takes a workspace id and the
per-workspace directories are isolated, which is exactly what sharding by
workspace needs.

## The shape picked

Sharded SQLite nodes, object storage for bytes, Cloudflare at the edge.

```
browser
  │
  ▼
Cloudflare (DNS / CDN / WAF / Turnstile / rate rules)
  │  route by ?ws= / X-Gamma-Workspace with consistent hashing
  ▼
N app nodes (the Docker image; Fly.io, Hetzner, any VPS)
  ├─ a persistent disk per node = GAMMA_DATA_DIR for that node's workspaces
  ├─ uploads/ becomes a bounded cache of R2 (fetch on miss)
  └─ Litestream streams every SQLite file to R2
  │
  ▼
Cloudflare R2
  ├─ uploads/<ws>/<hash>.<ext>   read by the browser through presigned URLs
  └─ backups/<ws>/*.zip          the workspace snapshots
```

Why this and not a central database:

- PDFs are almost all of the bytes and all of the egress; R2 charges no
  egress, which Supabase Storage does not match. The SQLite files are small.
- With one workspace per node the in-process rooms keep working; nothing in
  the collaboration protocol changes.
- Moving a workspace between nodes can reuse the mirror machinery
  ([dev/mirror.md](../dev/mirror.md)), which already reconciles a
  workspace across two servers.
- `users.db` (accounts, sessions, memberships) is the one global file.
  Small deployments keep it on the default shard; past a few nodes it either
  gets its own node or becomes the one database worth moving to Postgres,
  since it has no block tree and no FTS.

Supabase earns its place only for managed auth (replacing the session-cookie
middleware in `auth.py`, which the browser extension and the MCP OAuth flow
also depend on) or when a single workspace outgrows one machine's SQLite,
which an outliner is unlikely to do.

### Local storage once R2 is in

Three modes were compared. Local-primary with R2 as a replica changes the
least but saves no disk. R2-primary with no local copy is not viable: the
manifest, text extraction, annotated-PDF export and backup zips all want a
file on disk, and re-downloading through the single pdfium lock would slow
every one of them. R2-primary with a bounded LRU cache on the node is the
one to build: uploads go straight to R2, the node keeps recently used
files, and one `open_upload(ws, filename)` entry replaces every local-path
lookup. The browser never goes through the node for bytes in any mode: the
uploads route answers an authorised request with a 302 to a presigned URL,
so R2 serves the Range requests (the bucket needs CORS that allows the
`Range` header).

The storage change itself: `store_pdf` / `store_file` write to R2 via the
S3 API and keep a cached copy; `cleanup_orphan_uploads` deletes the object
too; `ws_backup` writes snapshots to R2; new `GAMMA_R2_*` variables in
`config.py`, with the pure-local behaviour kept when they are unset so
self-hosters are untouched. Quotas, hashing and dedup do not change.

### R2 as the backup target

Two layers, both worth having. The existing workspace snapshot
(`ws_backup.py`, the `gamma-backup-1` zip that export, import and the
Backups pane share) can be stored in R2 by uploading after `create`,
listing objects in `list_backups` and downloading before `restore_zip`.
Since the uploads are already in R2, server-kept snapshots should be taken
with `uploads=False` and restored by hash from the main bucket; user
downloads stay complete for moving to another server. Underneath that,
Litestream as a sidecar follows each database's WAL into R2 without any
Gamma change, which turns a dead disk into a loss of seconds rather than a
day and gives node migration a source. Litestream is configured per
database file, so the configuration has to be generated from the workspace
list. Once both are in place the remaining single point is the R2 account,
which a periodic copy to a second provider covers cheaply.

## Open registration: what is missing

There is no self-service registration. `routers/auth.py` has login, logout,
session and guest login; accounts are made by an admin in Settings → Users
or `manage.py`. Opening the door needs, in order of importance:

- A registration endpoint with email verification. Accounts have no email
  column today, so `users.db` grows one and a sending service (Resend, SES,
  Postmark) is needed. Password reset rides the same channel; today only an
  admin can change a password.
- Abuse controls on that endpoint: Turnstile against scripts plus per-IP
  frequency. `ratelimit.py` is an in-process fixed window, adequate once a
  workspace is pinned to a node, but the registration path should also have
  an edge rule.
- A server setting for open / invite code / closed, next to the existing
  default quota and public URL in `server_settings.py`, so the door can be
  opened gradually.
- Per-account limits. The default quota is 0 (unlimited) and
  `workspaces.create` has no cap on personal workspaces per account. Set a
  real default, keep the per-user override that already exists, add a
  workspace count limit, and decide whether the daily-wiped guest account
  stays.

Things that already hold and only need checking:

- AI cost is the user's: provider keys are per-account entries, never
  server env, so nobody can burn the operator's quota.
- Outbound fetches (PDF resolution, link previews, the agent's web reach)
  go through `net_guard.guarded_urlopen`, which refuses private addresses
  and redirects to them; every new outbound path must too.
- `ratelimit.client_ip` trusts the first `X-Forwarded-For` hop; behind
  Cloudflare it must read `CF-Connecting-IP` or every visitor shares one
  bucket and the limiter locks the whole site.
- Anyone-with-the-link edit shares allow anonymous writes (rate limited per
  IP) and are where phishing pages get hosted; a report path and an admin
  kill switch for a share are needed.

Operations:

- Upgrades cannot roll: a server refuses a data directory newer than
  itself, so all nodes upgrade together, and the pre-migration snapshot of
  every workspace database takes real time at tens of thousands of
  workspaces. Measure it in staging first.
- `logbuf` is an in-memory scrubbed log that dies with the process; ship
  stdout to an external log store and alert on warning counts.
- The in-process schedulers (guest wipe, manifest generation, mirror sync
  rounds) run per node over that node's workspaces, so sharding avoids
  duplicate work; any genuinely global task would need a leader.

Compliance: `PRIVACY.md` exists; terms of service, self-service account
deletion (only admins delete today) and deletion that also reaches R2
objects and Litestream replicas (`remove_all` clears only the local
directory) are missing. Data export is already complete through the
Backups zip.

Suggested order: registration switch, email verification, default quota and
workspace cap first; run invite-only for a month or two; then open.

# gamma/

The backend package. `app.py` assembles the middleware + routers and serves the built frontend.

```
config.py          env config
db.py              schemas, SCHEMA_VERSION, per-workspace DB paths, user prefs
migrations.py      versioned data-directory upgrades (snapshot, numbered steps)
backups.py         server backups: snapshots under backups/ (create, zip, delete, restore)
normalize.py       content normalization of a workspace's files (migration + restore)
workspaces.py      workspaces + memberships (roles, billing, personal workspace)
auth.py            session middleware → request.state.user; request → workspace / share
seed.py            workspace file creation, guest welcome page, first admin
blocks_store.py    recursive-CTE tree helpers
storage.py         uploads (content-addressed) + orphan cleanup
ai_client.py       provider HTTP protocols + streaming response parsing
ai_context.py      PDF attachments, extraction, and chat context assembly
logseq_import.py   EDN / Markdown importers
app.py             assembly + SPA serving
routers/           one module per API area — see routers/README.md
```

## Data model — everything is a block

Each workspace's `pages.db` has the `unified_blocks` table (plus the `page_ops`
log). Rows form a tree via `parent_id`;
sibling order is the lexicographic `position` (fractional-index strings like `a0`, `a0V`).

```
parent_id = 'root'                         ← pages
   │  props.doc_id  → PDF page
   │  props.category = "quantum, review"   → labels (comma-separated)
   │
   ├─ block  (plain text)                  ← free note
   ├─ block  props.highlight_id+pdf_position   ← highlight on the PDF
   │     props.link_url / link_page_id         → clickable reference link
   └─ block  …nested children (indent/outdent)
```

Key columns: `id, parent_id, position, content, properties (JSON), created_at, updated_at`.

Invariants:
- Positions come from `generate_key_between` — never hand-write them.
- `PUT /blocks/{id}/children` replaces the whole subtree (delete + reinsert) and
  triggers orphan-upload cleanup.
- Timestamps are UTC ISO strings with a `Z` suffix (`page_now()`).

# gamma/

The backend package. `app.py` assembles the middleware + routers and serves the built frontend.

```
config.py          env config
db.py              schemas + per-user DB paths
auth.py            session middleware → request.state.user (+ daily guest reset)
seed.py            per-user DB creation, guest welcome page
blocks_store.py    recursive-CTE tree helpers
storage.py         uploads (content-addressed) + orphan cleanup
logseq_import.py   EDN / Markdown importers
app.py             assembly + SPA serving
routers/           one module per API area — see routers/README.md
```

## Data model — everything is a block

`pages.db` has one table, `unified_blocks`. Rows form a tree via `parent_id`;
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

# routers/

One module per API area. Mounted under `/api` in `gamma/app.py`.

| file | routes | does |
|------|--------|------|
| `auth.py`     | `/api/login`, `/logout`, `/session`, `/export`, `/import-data` | session cookies, workspace backups |
| `workspaces.py` | `/api/workspaces/*`               | workspaces: list/create/rename/delete, members and roles |
| `admin.py`    | `/api/admin/*`                      | accounts, server settings, every workspace, the server log |
| `blocks.py`   | `/api/blocks/*`                     | the block tree (CRUD, children, subtree, by-doc) |
| `uploads.py`  | `/api/uploads/*`                    | PDF/image upload + serving (content-addressed) |
| `pdf.py`      | `/api/resolve-pdf`                  | find a real PDF url (arXiv → meta tag → Unpaywall OA) |
| `metadata.py` | `/api/metadata/fetch`, `/cite`      | paper metadata + BibTeX + PPT citation (cached on the page) |
| `ai.py`       | `/api/ai/chat`, `/models`, providers | chat orchestration, AI settings, OAuth |
| `chats.py`    | `/api/chats/*`                      | saved per-page chat history (workspace data) |
| `collab.py`   | `/api/pages/{id}/ops`, `/api/ws/page/{id}` | the op write path + the page websocket |
| `prefs.py`    | `/api/prefs/*`, `/api/page-snaps*`  | per-account (and per-workspace) synced prefs, cover snapshots |
| `search.py`   | `/api/pdf-search`, `/tasks`         | FTS5 index over PDF text (pypdfium2, normalized via `gamma/textnorm.py`) |
| `shares.py`   | `/api/shares/*`                     | share tokens for public read-only views |
| `imports.py`  | `/api/import/*`                     | Logseq import + embedded-PDF-annotation import |

Gotchas:
- **Route order** for `/api/blocks/*`: static prefixes (`by-doc`, `children`, `subtree`) must register **before** `/{block_id}`.
- Every data endpoint resolves its WORKSPACE (`require_ws` / `resolve_ws` / `require_ws_writer` in `gamma/auth.py` — `?ws=`, the `X-Gamma-Workspace` header, a `?share=` token, else the account's personal workspace) and passes the id to the data helpers; `request.state.user` is the actor. Identity-only endpoints use `require_user`.
- Slow endpoints (downloads, AI, PyPDF2) are intentionally sync `def` — FastAPI threadpools them. Don't make them `async`.

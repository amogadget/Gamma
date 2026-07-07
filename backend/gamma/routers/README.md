# routers/

One module per API area. Mounted under `/api` in `gamma/app.py`.

| file | routes | does |
|------|--------|------|
| `auth.py`     | `/api/login`, `/logout`, `/me`      | session cookies |
| `blocks.py`   | `/api/blocks/*`                     | the block tree (CRUD, children, subtree, by-doc) |
| `uploads.py`  | `/api/uploads/*`                    | PDF/image upload + serving (content-addressed) |
| `pdf.py`      | `/api/resolve-pdf`                  | find a real PDF url (arXiv → meta tag → Unpaywall OA) |
| `metadata.py` | `/api/metadata/fetch`, `/cite`      | paper metadata + BibTeX + PPT citation (cached on the page) |
| `ai.py`       | `/api/ai/chat`, `/models`, prompts  | chat, Anthropic + OpenAI, streaming NDJSON |
| `search.py`   | `/api/search`, export               | full-text over notes/highlights |
| `shares.py`   | `/api/shares/*`                     | share tokens for public read-only views |
| `imports.py`  | `/api/import/*`                     | Logseq import + embedded-PDF-annotation import |

Gotchas:
- **Route order** for `/api/blocks/*`: static prefixes (`by-doc`, `children`, `subtree`) must register **before** `/{block_id}`.
- Read endpoints resolve the user from `?user=` (share fallback); writes require the session.
- Slow endpoints (downloads, AI, PyPDF2) are intentionally sync `def` — FastAPI threadpools them. Don't make them `async`.

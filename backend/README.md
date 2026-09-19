# backend/

FastAPI server. All state is SQLite + files under `GAMMA_DATA_DIR`, defaulting to the repo-root `data/` directory (git-ignored).

```
backend/
├── app.py            uvicorn entry — imports gamma.app:app
├── manage.py         user CRUD CLI (setup / create-user / …)
├── gamma/            the package — see gamma/README.md
└── tests/            in-process TestClient tests — see tests/README.md

data/                repo-root runtime data, outside backend source
├── users.db          global: accounts, sessions, workspaces + members, shares, personal prefs (schema-versioned)
└── workspaces/<id>/  one directory per workspace (pages.db, data.db, uploads/)
    ├── pages.db        the block tree (see gamma/README.md for schema)
    ├── data.db         AI chats, cover snapshots, search indexes
    └── uploads/        PDFs & images, named <sha256[:24]>
```

## Run

```bash
python -m venv venv && venv\Scripts\activate     # or: source venv/bin/activate
pip install -r requirements.txt
python manage.py setup                            # seed guest + missing workspace files (idempotent)
uvicorn app:app --host 127.0.0.1 --port 9001 --reload
```

Tests: `pip install -r requirements-dev.txt && python -m pytest tests -q`

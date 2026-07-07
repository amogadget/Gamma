# backend/

FastAPI server. All state is SQLite + files under a data dir (`GAMMA_DATA_DIR`, defaults here).

```
backend/
├── app.py            uvicorn entry — imports gamma.app:app
├── manage.py         user CRUD CLI (setup / create-user / …)
├── gamma/            the package — see gamma/README.md
├── tests/            in-process TestClient tests — see tests/README.md
├── users.db          global: accounts, sessions, share tokens
└── users/<name>/     per-user data (git-ignored)
    ├── pages.db        the block tree (see gamma/README.md for schema)
    ├── data.db         legacy annotations + AI chat history
    └── uploads/        PDFs & images, named <sha256[:24]>
```

## Run

```bash
python -m venv venv && venv\Scripts\activate     # or: source venv/bin/activate
pip install -r requirements.txt
python manage.py setup                            # seed guest + per-user DBs (idempotent)
uvicorn app:app --host 127.0.0.1 --port 9001 --reload
```

Tests: `pip install -r requirements-dev.txt && python -m pytest tests -q`

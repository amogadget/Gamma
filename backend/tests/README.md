# tests/

In-process API tests — FastAPI `TestClient` against a throwaway data dir. No server, no network.

```
conftest.py             throwaway GAMMA_DATA_DIR + client/auth fixtures (make_user → account + personal workspace, workspace_of)
test_auth.py            login / sessions / share-token access
test_workspaces.py      roles, workspace selection, atomic updates, public access, prefs scoping, quota, admin rescue
test_collab.py          operation batches, log catch-up, share scoping, socket fan-out and presence
test_migrations.py      the versioned data-directory upgrade on a hand-built pre-workspace layout (snapshot, resume, refusal) + backups (uploads, zip, restore)
test_backups_api.py     the admin backup endpoints (list / create / download / delete)
test_shares.py          page-keyed share links: note pages, asset/proxy scope, permissions
test_blocks.py          block tree CRUD, positions, subtree replace
test_search_export.py   search + export
test_units.py           pure helpers (positions, parsers)
```

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest tests -q
```

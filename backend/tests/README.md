# tests/

In-process API tests — FastAPI `TestClient` against a throwaway data dir. No server, no network.

```
conftest.py             throwaway GAMMA_DATA_DIR + client/auth fixtures
test_auth.py            login / sessions / share-token access
test_blocks.py          block tree CRUD, positions, subtree replace
test_search_export.py   search + export
test_units.py           pure helpers (positions, parsers)
```

```bash
pip install -r ../requirements-dev.txt
python -m pytest -q
```

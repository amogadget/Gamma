"""Integration tokens on the HTTP API (auth.py): a bearer token is the account
behind it, confined to the token's workspace, read-only unless made with
the write scope, and never a session that manages tokens or accounts."""

from fastapi.testclient import TestClient

from conftest import login, make_page, make_user, workspace_of
from gamma.integrations import create_token


def _bearer(token, ws=None):
    from gamma.app import app
    c = TestClient(app)
    c.headers["Authorization"] = f"Bearer {token}"
    if ws:
        c.headers["X-Gamma-Workspace"] = ws
    return c


def test_read_token_reads_and_cannot_write(guest):
    make_user("tok_reader", "pw")
    owner = login("tok_reader", "pw")
    ws = workspace_of("tok_reader")
    page = make_page(owner, "Token page")
    token = create_token("tok_reader", ws, "reader", 90)["token"]
    c = _bearer(token)
    me = c.get("/api/sync/whoami").json()
    assert me == {"user": "tok_reader", "workspace": {"id": ws, "name": me["workspace"]["name"]},
                  "role": "owner", "scope": "read"}
    assert c.get(f"/api/blocks/{page['id']}").json()["content"] == "Token page"
    r = c.post(f"/api/pages/{page['id']}/ops", json={"client": "t", "ops": [
        {"op": "set", "id": page["id"], "content": "renamed"}]})
    assert r.status_code == 403 and "read-only" in r.text
    assert c.post("/api/pages", json={"title": "x"}).status_code == 403


def test_write_token_writes_under_the_account(guest):
    make_user("tok_writer", "pw")
    owner = login("tok_writer", "pw")
    ws = workspace_of("tok_writer")
    page = make_page(owner, "Writable")
    token = create_token("tok_writer", ws, "mirror", 90, scope="write")["token"]
    c = _bearer(token, ws)
    r = c.post(f"/api/pages/{page['id']}/ops", json={"client": "sync", "ops": [
        {"op": "insert", "id": "tokblk", "parent": page["id"], "position": "a0", "content": "from token"}]})
    assert r.status_code == 200, r.text
    log = owner.get(f"/api/pages/{page['id']}/ops?since=0").json()["batches"]
    assert log[-1]["actor"] == "tok_writer" and log[-1]["client"] == "sync"
    created = c.post("/api/pages", json={"id": "tokpage_1", "title": "Brought over", "properties": {"folder": "f"}})
    assert created.status_code == 200 and created.json()["id"] == "tokpage_1"
    assert c.post("/api/pages", json={"id": "tokpage_1", "title": "again"}).status_code == 409
    assert c.post("/api/pages", json={"id": "bad id!", "title": "again"}).status_code == 400


def test_token_is_confined_and_is_no_session(guest):
    make_user("tok_confined", "pw")
    ws = workspace_of("tok_confined")
    other = make_user("tok_other", "pw")
    token = create_token("tok_confined", ws, "reader", 90)["token"]
    assert _bearer(token, other).get("/api/sync/whoami").status_code == 403
    c = _bearer(token)
    assert c.get("/api/integrations/tokens").status_code == 403
    assert c.post("/api/integrations/tokens", json={"name": "x"}).status_code == 403
    assert c.get("/api/admin/backups").status_code in (401, 403)
    assert _bearer("gamma_nope").get("/api/sync/whoami").status_code == 401
    # a viewer cannot mint a write token for a shared workspace
    admin_ws = make_user("tok_admin", "pw", is_admin=1)
    admin = login("tok_admin", "pw")
    shared = admin.post("/api/workspaces", json={"name": "Tok shared", "kind": "shared"}).json()
    admin.put(f"/api/workspaces/{shared['id']}/members/tok_confined", json={"role": "viewer"}).raise_for_status()
    viewer = login("tok_confined", "pw")
    viewer.headers["X-Gamma-Workspace"] = shared["id"]
    r = viewer.post("/api/integrations/tokens", json={"name": "w", "scope": "write"})
    assert r.status_code == 403, r.text
    assert viewer.post("/api/integrations/tokens", json={"name": "r"}).status_code == 201
    listed = viewer.get("/api/integrations/tokens").json()["tokens"]
    assert listed[0]["scope"] == "read"

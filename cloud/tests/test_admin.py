from conftest import invite, make_admin, register
from fastapi.testclient import TestClient

from gammacloud import mail


def test_admin_only(client):
    register(client)
    assert client.get("/api/admin/accounts").status_code == 403
    make_admin("alice")
    r = client.get("/api/admin/accounts")
    assert r.status_code == 200 and r.json()["total"] == 1


def test_accounts_admin_flow(client):
    register(client, "alice")
    make_admin("alice")
    with TestClient(client.app, base_url="http://testserver") as other_browser:
        bob = register(other_browser, "bob")
    r = client.get("/api/admin/accounts", params={"q": "bob"})
    assert [a["handle"] for a in r.json()["accounts"]] == ["bob"]
    r = client.patch(f"/api/admin/accounts/{bob['id']}", json={"plan": "pro", "verified": True})
    assert r.status_code == 200 and r.json()["account"]["plan"] == "pro" and r.json()["account"]["email_verified"]
    assert client.patch(f"/api/admin/accounts/{bob['id']}", json={"plan": "gold"}).status_code == 400
    r = client.get(f"/api/admin/accounts/{bob['id']}")
    assert r.status_code == 200 and any(a["event"] == "account.plan" for a in r.json()["audit"])
    n = len(mail.outbox)
    assert client.post(f"/api/admin/accounts/{bob['id']}/resend-verify").json()["already"] is True
    assert len(mail.outbox) == n
    me = client.get("/api/me").json()["account"]
    assert client.patch(f"/api/admin/accounts/{me['id']}", json={"is_admin": False}).status_code == 400
    assert client.post(f"/api/admin/accounts/{me['id']}/delete").status_code == 400
    assert client.post(f"/api/admin/accounts/{bob['id']}/delete").status_code == 200
    assert client.get(f"/api/admin/accounts/{bob['id']}").json()["account"]["deleted_at"]


def test_invites_and_clients(client):
    register(client)
    make_admin("alice")
    r = client.post("/api/admin/invites", json={"uses": 3, "plan": "plus", "note": "beta"})
    assert r.status_code == 200
    code = r.json()["invite"]["code"]
    assert any(i["code"] == code for i in client.get("/api/admin/invites").json()["invites"])
    assert client.delete(f"/api/admin/invites/{code}").status_code == 200
    assert client.delete(f"/api/admin/invites/{code}").status_code == 404
    r = client.post("/api/admin/clients", json={"name": "share host", "kind": "share-host",
                                                "redirect_uris": ["https://share.gammapdf.com/api/auth/cloud/callback"]})
    assert r.status_code == 200 and r.json()["client_id"].startswith("gc_")
    client_id = r.json()["client_id"]
    listed = client.get("/api/admin/clients").json()["clients"]
    assert listed[0]["client_id"] == client_id and "secret" not in str(listed)
    r = client.post("/api/admin/clients", json={"name": "bad", "kind": "container", "redirect_uris": ["http://x.example/cb"]})
    assert r.status_code == 400
    assert client.delete(f"/api/admin/clients/{client_id}").status_code == 200
    assert client.get("/api/admin/audit").status_code == 200


def test_bearer_token_cannot_admin(client):
    """A Gamma server's access token must never reach the admin API."""
    from test_oidc import pkce, signed_in_code, CALLBACK
    from conftest import verify
    from gammacloud import config
    register(client)
    make_admin("alice")
    verify(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    tokens = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                         "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier}).json()
    client.post("/api/logout")
    headers = {"Authorization": "Bearer " + tokens["access_token"]}
    assert client.get("/api/me", headers=headers).status_code == 200
    assert client.get("/api/admin/accounts", headers=headers).status_code == 401
    assert client.post("/api/me/password", json={"current": "x", "new": "yyyyyyyyy"}, headers=headers).status_code == 401
    assert invite()  # helper still works

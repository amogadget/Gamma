"""Administrator-confirmed public origins, including TLS-terminating proxies."""
import pytest
from fastapi.testclient import TestClient

from conftest import make_user
from gamma.db import connect_users_db
from gamma.server_settings import public_url_settings, validate_public_url
import test_mcp_oauth as oauth


@pytest.fixture
def admin(client, monkeypatch):
    from gamma.app import app
    monkeypatch.delenv("GAMMA_PUBLIC_URL", raising=False)
    monkeypatch.delenv("GAMMA_MCP_ALLOWED_HOSTS", raising=False)
    ws = make_user("origin-admin", "pw", is_admin=1)
    with connect_users_db() as conn:
        conn.execute("DELETE FROM settings WHERE key = 'public_url'")
        conn.execute("UPDATE users SET is_admin = 1 WHERE username = 'origin-admin'")
    with TestClient(app, base_url="http://gamma.example") as c:
        assert c.post("/api/login", json={"username": "origin-admin", "password": "pw"}).status_code == 200
        yield c, ws
    with connect_users_db() as conn:
        conn.execute("DELETE FROM settings WHERE key = 'public_url'")
        conn.execute("UPDATE users SET is_admin = 0 WHERE username = 'origin-admin'")


def test_confirmed_origin_enables_live_oauth_and_transport(admin, monkeypatch):
    c, ws = admin
    assert not c.get("/api/integrations/tokens").json()["oauth_available"]
    result = c.put("/api/admin/settings", json={"public_url": " https://GAMMA.example/ "},
                   headers={"Origin": "https://gamma.example"})
    assert result.status_code == 200, result.text
    assert result.json()["public_url"] == "https://gamma.example"
    assert public_url_settings()["public_url_source"] == "saved"
    # Read via a fresh application instance to verify persistence, not a cache.
    from gamma.app import create_app
    with TestClient(create_app(), base_url="http://gamma.example") as fresh:
        assert fresh.get("/.well-known/oauth-authorization-server").json()["issuer"] == "https://gamma.example"
    listing = c.get("/api/integrations/tokens").json()
    assert listing["oauth_available"] and listing["mcp_url"] == "https://gamma.example/mcp"
    assert "https://gamma.example/.well-known" in c.get("/mcp").headers["www-authenticate"]
    monkeypatch.setattr(oauth, "BASE", "https://gamma.example")
    client_id, code = oauth.approve(c, ws)
    token = oauth.exchange(c, client_id, code).json()["access_token"]
    manual = c.post("/api/integrations/tokens", json={"name": "Manual test"}).json()["token"]
    def rpc(bearer, host="gamma.example"):
        return c.post("/mcp", headers={"Host": host, "Authorization": f"Bearer {bearer}",
                      "Accept": "application/json, text/event-stream"},
                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert rpc(token).status_code == 200  # Same manager, created BEFORE confirmation.
    assert rpc(manual, "evil.example").status_code == 421
    assert c.put("/api/admin/settings", json={"public_url": "https://new.example"}).status_code == 200
    assert rpc(manual).status_code == 421  # Old host removed from the live allowlist.
    assert rpc(manual, "new.example").status_code == 200
    assert rpc(token, "new.example").status_code == 401  # Old OAuth resource cannot be retargeted.
    assert c.put("/api/admin/settings", json={"public_url": ""}).status_code == 200
    assert rpc(manual, "new.example").status_code == 421
    assert not c.get("/api/integrations/tokens").json()["oauth_available"]


def test_public_origin_permissions_and_override(admin, monkeypatch):
    c, _ = admin
    assert c.put("/api/admin/settings", json={"public_url": "https://gamma.example"},
                 headers={"Origin": "https://evil.example"}).status_code == 403
    assert c.put("/api/admin/settings", json={"public_url": "https://gamma.example"},
                 headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert public_url_settings()["public_url"] == ""
    monkeypatch.setenv("GAMMA_PUBLIC_URL", "https://managed.example")
    assert c.get("/api/admin/settings").json()["public_url_source"] == "environment"
    assert c.put("/api/admin/settings", json={"public_url": "https://gamma.example"}).status_code == 400
    make_user("origin-reader", "pw")
    c.post("/api/login", json={"username": "origin-reader", "password": "pw"})
    assert c.put("/api/admin/settings", json={"public_url": "https://gamma.example"}).status_code == 403
    assert c.get("/api/admin/settings").status_code == 403


@pytest.mark.parametrize("value", ["http://gamma.example", "https://gamma.example/path", "https://gamma.example?",
    "https://gamma.example#", "https://user:pw@gamma.example", "https://*.example", "https://gamma.example:bad",
    "https://gamma.example:0", "https://gamma.example:65536", "https://good.example\\@evil.example",
    "https://gamma.\nexample", "javascript:alert(1)", "https://"])
def test_unsafe_origins_rejected(value):
    with pytest.raises(ValueError):
        validate_public_url(value)


@pytest.mark.parametrize("value,expected", [("https://Gamma.example:443/", "https://gamma.example"),
    ("https://gamma.example:8443", "https://gamma.example:8443"), ("http://localhost:9001", "http://localhost:9001"),
    ("http://[::1]:9001/", "http://[::1]:9001"),
    ("https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"), ("", "")])
def test_public_origin_normalization(value, expected):
    assert validate_public_url(value) == expected


def test_invalid_setting_does_not_partially_save(admin):
    c, _ = admin
    before = c.get("/api/admin/settings").json()
    assert c.put("/api/admin/settings", json={"public_url": "http://gamma.example", "quota_mb": 123}).status_code == 400
    assert c.get("/api/admin/settings").json() == before

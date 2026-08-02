def test_session_requires_login(client):
    r = client.get("/api/blocks/root/children")
    assert r.status_code == 401


def test_bad_login_rejected(client):
    r = client.post("/api/login", json={"username": "nobody", "password": "wrong"})
    assert r.status_code == 401


def test_guest_login_and_session(guest):
    r = guest.get("/api/session")
    assert r.status_code == 200
    data = r.json()
    assert data["user"]
    assert data["is_guest"] is True


def test_user_guard_matching_header_passes(guest):
    r = guest.get("/api/blocks/root/children", headers={"X-Gamma-User": "guest"})
    assert r.status_code == 200


def test_user_guard_mismatch_rejected(guest):
    """A tab that believes it's another user must not read or write this
    session's data (the browser-wide cookie was switched under it)."""
    r = guest.get("/api/blocks/root/children", headers={"X-Gamma-User": "someone-else"})
    assert r.status_code == 409
    assert r.headers["X-Gamma-Session-User"] == "guest"
    assert len(r.headers["X-Gamma-Request-ID"]) == 8

    r = guest.post("/api/blocks", json={"parent_id": "root", "content": "x"},
                   headers={"X-Gamma-User": "someone-else"})
    assert r.status_code == 409


def test_user_guard_signed_out_session():
    """Guard header without a valid session → 409 with an empty session user
    (the frontend turns that into the auth-expired flow, not the conflict UI)."""
    from fastapi.testclient import TestClient
    from gamma.app import app
    with TestClient(app) as c:
        r = c.get("/api/blocks/root/children", headers={"X-Gamma-User": "ghost"})
        assert r.status_code == 409
        assert r.headers["X-Gamma-Session-User"] == ""


def test_ai_disabled_without_keys(guest):
    r = guest.get("/api/ai/models")
    assert r.status_code == 200
    data = r.json()
    assert data["enabled"] is False
    assert data["default_prompt"]
    assert data["metadata_prompt"]
    assert data["cite_prompt"]

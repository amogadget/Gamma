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


def test_ai_disabled_without_keys(guest):
    r = guest.get("/api/ai/models")
    assert r.status_code == 200
    data = r.json()
    assert data["enabled"] is False
    assert data["default_prompt"]
    assert data["metadata_prompt"]
    assert data["cite_prompt"]

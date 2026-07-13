"""Per-user prefs KV store (tab sync) + GUI-configured AI provider keys."""

import io
import zipfile

import bcrypt
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def alice(client):
    """A separate TestClient logged in as a real (non-guest) user."""
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'alice'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("alice", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("alice")
    c = TestClient(app)
    r = c.post("/api/login", json={"username": "alice", "password": "pw"})
    assert r.status_code == 200, r.text
    return c


# --- prefs -------------------------------------------------------------------

def test_prefs_unset_key_reads_empty(guest):
    r = guest.get("/api/prefs/open-tabs")
    assert r.status_code == 200
    body = r.json()
    assert body["value"] is None and body["updated_at"] == ""


def test_prefs_roundtrip_and_updated_at(guest):
    tabs = [{"id": "b1", "title": "Paper A"}, {"id": "b2", "title": "Paper B"}]
    r = guest.put("/api/prefs/open-tabs", json={"value": tabs})
    assert r.status_code == 200
    first = r.json()["updated_at"]
    assert first

    r = guest.get("/api/prefs/open-tabs")
    assert r.json()["value"] == tabs
    assert r.json()["updated_at"] == first

    # Last write wins, updated_at moves forward
    r = guest.put("/api/prefs/open-tabs", json={"value": []})
    assert r.json()["updated_at"] > first
    assert guest.get("/api/prefs/open-tabs").json()["value"] == []


def test_prefs_rejects_bad_keys_and_huge_values(guest):
    assert guest.get("/api/prefs/No%20Spaces").status_code == 400
    assert guest.put("/api/prefs/UPPER", json={"value": 1}).status_code == 400
    big = "x" * (70 * 1024)
    assert guest.put("/api/prefs/open-tabs", json={"value": big}).status_code == 413


def test_prefs_never_serve_the_reserved_ai_settings_key(guest):
    # The raw AI keys live under this prefs key — only the masked
    # /api/ai/settings endpoint may read it.
    assert guest.get("/api/prefs/ai-settings").status_code == 400
    assert guest.put("/api/prefs/ai-settings", json={"value": {}}).status_code == 400


def test_prefs_require_session(client):
    from gamma.app import app
    anon = TestClient(app)
    assert anon.get("/api/prefs/open-tabs").status_code == 401
    assert anon.put("/api/prefs/open-tabs", json={"value": []}).status_code == 401


# --- AI provider entries (GUI key management) ---------------------------------

def test_guest_cannot_store_keys(guest):
    r = guest.get("/api/ai/settings")
    assert r.status_code == 200
    assert r.json()["can_edit"] is False
    assert r.json()["providers"] == []
    r = guest.post("/api/ai/providers", json={"protocol": "anthropic", "api_key": "sk-x-guest-key"})
    assert r.status_code == 403


def test_added_provider_is_masked_and_enables_ai(alice):
    # No env keys exist at all — AI starts disabled until the user adds a provider
    assert alice.get("/api/ai/models").json()["enabled"] is False

    key = "sk-ant-api03-test-key-12345678"
    r = alice.post("/api/ai/providers", json={
        "protocol": "anthropic", "name": "My DeepSeek", "api_key": key,
        "base_url": "https://example.com/v1x", "models": "claude-test-model, claude-other",
    })
    assert r.status_code == 200, r.text
    provs = r.json()["providers"]
    assert len(provs) == 1
    p = provs[0]
    # Never echo the key — only a short hint
    assert key not in r.text
    assert p["key_hint"] == "…5678"
    assert p["name"] == "My DeepSeek" and p["protocol"] == "anthropic"
    assert p["base_url"] == "https://example.com/v1x"
    assert p["created_at"]

    models = alice.get("/api/ai/models").json()
    assert models["enabled"] is True
    assert models["default"] == f"{p['id']}:claude-test-model"
    assert [m["model"] for m in models["models"]] == ["claude-test-model", "claude-other"]
    assert models["models"][0]["provider_name"] == "My DeepSeek"

    # ...and the same masked view comes back on GET
    g = alice.get("/api/ai/settings").json()
    assert key not in str(g)
    assert g["providers"][0]["key_hint"] == "…5678"


def test_edit_without_key_keeps_the_stored_one(alice):
    pid = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    r = alice.put(f"/api/ai/providers/{pid}", json={"name": "Renamed", "models": "claude-solo"})
    assert r.status_code == 200, r.text
    p = r.json()["providers"][0]
    assert p["name"] == "Renamed" and p["key_hint"] == "…5678"
    models = alice.get("/api/ai/models").json()
    assert models["enabled"] is True  # key survived the edit
    assert models["default"] == f"{pid}:claude-solo"


def test_second_provider_adds_its_models(alice):
    r = alice.post("/api/ai/providers", json={
        "protocol": "openai", "api_key": "sk-openai-test-key-9876",
    })
    assert r.status_code == 200, r.text
    assert len(r.json()["providers"]) == 2
    models = alice.get("/api/ai/models").json()["models"]
    # openai entry has no model list — its protocol default appears
    assert [m["model"] for m in models] == ["claude-solo", "gpt-4o-mini"]


def test_provider_validation(alice):
    assert alice.post("/api/ai/providers", json={"protocol": "nope", "api_key": "k" * 20}).status_code == 400
    assert alice.post("/api/ai/providers", json={"protocol": "openai"}).status_code == 400  # no key
    assert alice.post("/api/ai/providers",
                      json={"protocol": "openai", "api_key": "sk-ok-key-123", "base_url": "ftp://x"}).status_code == 400
    assert alice.post("/api/ai/providers", json={"protocol": "openai", "api_key": "has space"}).status_code == 400
    assert alice.put("/api/ai/providers/does-not-exist", json={"name": "x"}).status_code == 404


def test_export_stays_owner_only(alice):
    # Keys ride along inside data.db in the owner's backup — which is fine
    # exactly because only the owner's session can request it.
    from gamma.app import app
    anon = TestClient(app)
    assert anon.get("/api/export").status_code == 401
    r = alice.get("/api/export")
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        assert "data.db" in z.namelist()


def test_deleting_all_providers_disables_ai(alice):
    for p in alice.get("/api/ai/settings").json()["providers"]:
        assert alice.delete(f"/api/ai/providers/{p['id']}").status_code == 200
    assert alice.get("/api/ai/settings").json()["providers"] == []
    assert alice.get("/api/ai/models").json()["enabled"] is False


# --- manage.py rename-user ----------------------------------------------------

def test_rename_user_moves_rows_and_directory(client):
    import manage
    from gamma.config import USERS_DIR
    from gamma.app import app

    manage.create_user("bob", "pw2")
    assert (USERS_DIR / "bob" / "pages.db").exists()

    manage.rename_user("bob", "bobby")
    assert not (USERS_DIR / "bob").exists()
    assert (USERS_DIR / "bobby" / "pages.db").exists()

    c = TestClient(app)
    assert c.post("/api/login", json={"username": "bob", "password": "pw2"}).status_code == 401
    assert c.post("/api/login", json={"username": "bobby", "password": "pw2"}).status_code == 200


def test_rename_user_refuses_guest_and_collisions(client, capsys):
    import manage
    manage.rename_user("guest", "someone")
    assert "cannot be renamed" in capsys.readouterr().out
    manage.create_user("carol", "pw3")
    manage.rename_user("carol", "bobby")  # bobby exists from the test above
    assert "already exists" in capsys.readouterr().out
    manage.rename_user("carol", "bad/name")
    assert "must be" in capsys.readouterr().out

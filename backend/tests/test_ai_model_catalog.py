"""Auto-fetched provider model catalogs: cached per entry, merged into the
chat selector's model list after the user's curated models, refreshed
periodically by the background watcher and on demand via
POST /api/ai/models/refresh (the chat header's ↻)."""

import bcrypt
import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def user(client):
    """A fresh real (non-guest) user per test, so catalogs don't leak between
    tests through the shared data dir."""
    import uuid

    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    name = "catalog_" + uuid.uuid4().hex[:8]
    with connect_users_db() as conn:
        conn.execute(
            "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
            (name, bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
        )
        conn.commit()
    create_user_dbs(name)
    c = TestClient(app)
    r = c.post("/api/login", json={"username": name, "password": "pw"})
    assert r.status_code == 200, r.text
    return c, name


def _add_provider(user, protocol="openai", models="gpt-5.6"):
    r = user.post(
        "/api/ai/providers",
        json={
            "protocol": protocol,
            "name": "Test provider",
            "api_key": "sk-test-1234567890",
            "models": models,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["providers"][-1]["id"]


def _live_fake(models):
    return lambda u, entry: list(models)


def test_models_starts_with_no_catalog(user):
    c, _ = user
    _add_provider(c)
    body = c.get("/api/ai/models").json()
    assert body["refreshed_at"] == ""
    assert [m["model"] for m in body["models"]] == ["gpt-5.6"]


def test_refresh_merges_catalog_after_curated_models(user, monkeypatch):
    c, _ = user
    _add_provider(c, models="gpt-5.6")
    monkeypatch.setattr(
        "gamma.routers.ai._live_models_for_entry", _live_fake(["gpt-5.6", "gpt-5.7-new", "gpt-5.8-new"])
    )

    r = c.post("/api/ai/models/refresh")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["refreshed"] == 1
    # Curated first, then catalog additions, deduped — the pinned list is
    # never reordered or clobbered.
    assert [m["model"] for m in body["models"]] == ["gpt-5.6", "gpt-5.7-new", "gpt-5.8-new"]
    assert body["refreshed_at"]
    assert [m["model"] for m in c.get("/api/ai/models").json()["models"]] == body_models(body)


def body_models(body):
    return [m["model"] for m in body["models"]]


def test_refresh_failure_keeps_previous_catalog(user, monkeypatch):
    c, _ = user
    _add_provider(c, models="gpt-5.6")
    monkeypatch.setattr("gamma.routers.ai._live_models_for_entry", _live_fake(["gpt-5.6", "gpt-5.7-new"]))
    first = c.post("/api/ai/models/refresh").json()
    assert first["refreshed"] == 1

    def boom(u, entry):
        raise RuntimeError("upstream down")

    monkeypatch.setattr("gamma.routers.ai._live_models_for_entry", boom)
    second = c.post("/api/ai/models/refresh").json()
    assert second["refreshed"] == 0
    # The old catalog survives the failed refetch, timestamp included.
    assert "gpt-5.7-new" in body_models(second)
    assert c.get("/api/ai/models").json()["refreshed_at"] == first["refreshed_at"]


def test_background_sweep_only_refetches_stale(user, monkeypatch):
    """The watcher's non-forced sweep must leave a fresh catalog alone (TTL
    guard) — one fetch per entry per day, not one per hourly check."""
    import gamma.routers.ai as ai_mod
    from gamma.ai_settings import load_provider_entries

    c, name = user
    pid = _add_provider(c)
    calls = []

    def fake(user_, entry):
        calls.append(entry.get("id"))
        return ["gpt-5.7-new"]

    monkeypatch.setattr(ai_mod, "_live_models_for_entry", fake)
    assert ai_mod.refresh_entry_catalog(name, pid) is True  # first fetch
    assert ai_mod.refresh_entry_catalog(name, pid) is False  # still fresh
    assert calls == [pid]
    entry = next(e for e in load_provider_entries(name) if e.get("id") == pid)
    assert entry["catalog_models"] == ["gpt-5.7-new"]


def test_guest_cannot_force_refresh(client):
    """A guest session of its own (not the shared `guest` fixture — that would
    leave the session-scoped client logged in before test_auth.py's
    unauthenticated-request test runs)."""
    from fastapi.testclient import TestClient
    from gamma.app import app

    g = TestClient(app)
    assert g.post("/api/login-guest").status_code == 200
    assert g.post("/api/ai/models/refresh").status_code == 403

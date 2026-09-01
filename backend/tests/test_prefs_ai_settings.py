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
    r = alice.post(
        "/api/ai/providers",
        json={
            "protocol": "anthropic",
            "name": "My DeepSeek",
            "api_key": key,
            "base_url": "https://example.com/v1x",
            "models": "claude-test-model, claude-other",
        },
    )
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
    r = alice.post(
        "/api/ai/providers",
        json={
            "protocol": "openai",
            "api_key": "sk-openai-test-key-9876",
        },
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["providers"]) == 2
    models = alice.get("/api/ai/models").json()["models"]
    # openai entry has no model list — its protocol default appears
    assert [m["model"] for m in models] == ["claude-solo", "gpt-4o-mini"]


def test_provider_validation(alice):
    assert alice.post("/api/ai/providers", json={"protocol": "nope", "api_key": "k" * 20}).status_code == 400
    assert alice.post("/api/ai/providers", json={"protocol": "openai"}).status_code == 400  # no key
    assert (
        alice.post(
            "/api/ai/providers", json={"protocol": "openai", "api_key": "sk-ok-key-123", "base_url": "ftp://x"}
        ).status_code
        == 400
    )
    assert alice.post("/api/ai/providers", json={"protocol": "openai", "api_key": "has space"}).status_code == 400
    assert alice.put("/api/ai/providers/does-not-exist", json={"name": "x"}).status_code == 404


# --- provider Test button (live probe) ----------------------------------------

def test_provider_test_probe_reports_ok(alice, monkeypatch):
    import gamma.routers.ai as ai_mod

    seen = {}

    def fake_call(messages, system, entry, rt, **kw):
        seen.update(entry)
        return "ok"

    monkeypatch.setattr(ai_mod, "_call_ai", fake_call)
    pid = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    r = alice.post(f"/api/ai/providers/{pid}/test")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["model"] == "claude-solo"
    assert isinstance(body["latency_ms"], int)
    # The probe goes through the tested entry's first model, not the default.
    assert seen == {"provider": pid, "model": "claude-solo"}


def test_provider_test_reports_upstream_failure_in_body(alice, monkeypatch):
    # A failed probe is a successful test: 200 with the upstream error in-body.
    # A 401 additionally carries the auth flag — the UI renders "reconnect"
    # instead of the raw upstream body.
    import gamma.routers.ai as ai_mod
    from gamma.ai_client import UpstreamError

    def fake_call(*a, **kw):
        raise UpstreamError(401, "upstream 401: token expired")

    monkeypatch.setattr(ai_mod, "_call_ai", fake_call)
    pid = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    r = alice.post(f"/api/ai/providers/{pid}/test")
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert r.json()["auth"] is True
    assert "401" in r.json()["error"]


def test_provider_test_non_auth_failure_is_not_flagged(alice, monkeypatch):
    import gamma.routers.ai as ai_mod
    from gamma.ai_client import UpstreamError

    def fake_call(*a, **kw):
        raise UpstreamError(502, "upstream 502: Bad gateway")

    monkeypatch.setattr(ai_mod, "_call_ai", fake_call)
    pid = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    body = alice.post(f"/api/ai/providers/{pid}/test").json()
    assert body["ok"] is False and body["auth"] is False


def test_provider_test_unknown_entry_404(alice):
    assert alice.post("/api/ai/providers/does-not-exist/test").status_code == 404


def test_probe_uses_configured_test_model(alice, monkeypatch):
    # Probe model priority: the entry-level test_model, else the model sent
    # with the request (the client's effective metadata model), else the first
    # model. The masked settings echo test_model so the form can edit it.
    import gamma.routers.ai as ai_mod

    seen = {}
    monkeypatch.setattr(ai_mod, "_call_ai", lambda m, s, entry, rt, **kw: seen.update(entry))
    pid = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    r = alice.put(f"/api/ai/providers/{pid}", json={"test_model": "claude-cheap"})
    assert r.status_code == 200
    assert r.json()["providers"][0]["test_model"] == "claude-cheap"
    assert alice.post(f"/api/ai/providers/{pid}/test").json()["ok"] is True
    assert seen["model"] == "claude-cheap"
    # An explicit test_model beats the request's fallback model.
    alice.post(f"/api/ai/providers/{pid}/test", json={"model": "claude-meta"})
    assert seen["model"] == "claude-cheap"

    alice.put(f"/api/ai/providers/{pid}", json={"test_model": ""})
    alice.post(f"/api/ai/providers/{pid}/test")
    assert seen["model"] == "claude-solo"
    # With no test_model, the request's metadata-model fallback wins over the
    # first model.
    alice.post(f"/api/ai/providers/{pid}/test", json={"model": "claude-meta"})
    assert seen["model"] == "claude-meta"
    assert alice.put(f"/api/ai/providers/{pid}", json={"test_model": "x" * 101}).status_code == 400


def test_probe_model_fallback_is_length_capped(alice, monkeypatch):
    """A client-supplied fallback is untrusted input: it reaches the provider
    as a model name, so it is capped like the stored field."""
    import gamma.routers.ai as ai_mod

    seen = {}
    monkeypatch.setattr(ai_mod, "_call_ai", lambda m, s, entry, rt, **kw: seen.update(entry))
    pid = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    alice.post(f"/api/ai/providers/{pid}/test", json={"model": "m" * 500})
    assert len(seen["model"]) == 100


# --- upstream error summarization ---------------------------------------------

def _http_error(code, body, reason="err"):
    import io
    import urllib.error
    return urllib.error.HTTPError("http://x", code, reason, None, io.BytesIO(body.encode()))


def test_upstream_detail_summarizes_noise_bodies():
    # HTML error pages (a proxy's 502) collapse to their <title>, JSON errors
    # to their message — a settings row never shows raw markup.
    from gamma.ai_client import upstream_detail

    html = "<!DOCTYPE html> <html><head><title>xwtim.com | 502:\n Bad gateway</title></head><body>Error</body></html>"
    assert upstream_detail(_http_error(502, html)) == "upstream 502: xwtim.com | 502: Bad gateway"
    js = '{"error": {"message": "Provided authentication token is expired.", "code": "token_expired"}}'
    assert upstream_detail(_http_error(401, js)) == "upstream 401: Provided authentication token is expired."
    assert upstream_detail(_http_error(500, "plain text failure")) == "upstream 500: plain text failure"
    assert upstream_detail(_http_error(502, "<html><body>no title</body></html>", "Bad Gateway")) \
        == "upstream 502: Bad Gateway"


def test_upstream_detail_still_caps_length():
    """Summarizing reads more bytes than it shows — the cap still holds, so a
    provider cannot push an unbounded string into a settings row."""
    from gamma.ai_client import upstream_detail

    detail = upstream_detail(_http_error(500, "x" * 9000), cap=100)
    assert detail == f"upstream 500: {'x' * 100}"


def test_upstream_detail_survives_a_malformed_body():
    from gamma.ai_client import upstream_detail

    # Truncated JSON, unterminated <title>, and an empty body all degrade to
    # something printable rather than raising inside an error path.
    assert "upstream 400: " in upstream_detail(_http_error(400, '{"error": {"mess'))
    assert upstream_detail(_http_error(502, "<html><title>unclosed", "Bad Gateway")) \
        == "upstream 502: Bad Gateway"
    assert upstream_detail(_http_error(503, "", "Unavailable")) == "upstream 503: Unavailable"


# --- login connection check (/api/ai/health) ----------------------------------

def test_ai_health_reports_unconfigured(guest):
    r = guest.post("/api/ai/health", json={})
    assert r.status_code == 200
    assert r.json() == {"configured": False, "ok": True}


def test_ai_health_requires_a_session():
    from gamma.app import app

    assert TestClient(app).post("/api/ai/health", json={}).status_code == 401


def test_ai_health_ping_checks_credential_for_free(alice, monkeypatch):
    # "ping" mode never runs a completion: API keys are checked via the
    # provider's model listing; 401 comes back as a broken-credential flag,
    # 404 (gateway without /v1/models) as ok-but-unverified.
    import gamma.routers.ai as ai_mod

    pid = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    seen = {}
    monkeypatch.setattr(ai_mod, "_call_ai", lambda *a, **kw: pytest.fail("ping must not spend tokens"))
    monkeypatch.setattr(ai_mod, "_model_catalog_json", lambda req: seen.update(url=req.full_url) or {})
    body = alice.post("/api/ai/health", json={"provider_id": pid, "mode": "ping"}).json()
    assert body["configured"] and body["ok"] is True
    assert "/v1/models" in seen["url"]

    def dead_key(req):
        raise _http_error(401, '{"error": {"message": "invalid x-api-key"}}')
    monkeypatch.setattr(ai_mod, "_model_catalog_json", dead_key)
    body = alice.post("/api/ai/health", json={"provider_id": pid, "mode": "ping"}).json()
    assert body["ok"] is False and body["auth"] is True
    assert "invalid x-api-key" in body["error"]

    def no_listing(req):
        raise _http_error(404, "")
    monkeypatch.setattr(ai_mod, "_model_catalog_json", no_listing)
    body = alice.post("/api/ai/health", json={"provider_id": pid, "mode": "ping"}).json()
    assert body["ok"] is True and body["unverified"] is True


def test_ai_health_ping_reports_a_non_auth_failure_without_the_auth_flag(alice, monkeypatch):
    """A 500 from the provider and an unreachable host are both "connection
    failed", never "your credential is broken" — the strip says different
    things and only one of them is actionable by re-entering a key."""
    import gamma.routers.ai as ai_mod

    def broken(req):
        raise _http_error(500, "<html><head><title>Bad gateway</title></head></html>")
    monkeypatch.setattr(ai_mod, "_model_catalog_json", broken)
    body = alice.post("/api/ai/health", json={"mode": "ping"}).json()
    assert body["ok"] is False and body["auth"] is False
    assert "Bad gateway" in body["error"] and "<html" not in body["error"]

    def unreachable(req):
        raise OSError("timed out")
    monkeypatch.setattr(ai_mod, "_model_catalog_json", unreachable)
    body = alice.post("/api/ai/health", json={"mode": "ping"}).json()
    assert body["ok"] is False and body["auth"] is False and "timed out" in body["error"]


def test_ai_health_names_the_entry_it_checked(alice, monkeypatch):
    """The strip is per-provider: the response carries the id (so a passing
    Test can clear it) and a display name (so the user knows which entry)."""
    import gamma.routers.ai as ai_mod

    monkeypatch.setattr(ai_mod, "_model_catalog_json", lambda req: {})
    entries = alice.get("/api/ai/settings").json()["providers"]
    body = alice.post("/api/ai/health", json={"provider_id": entries[1]["id"]}).json()
    assert body["provider_id"] == entries[1]["id"]
    assert body["provider_name"] and body["mode"] == "ping"


def test_ai_health_test_mode_runs_the_probe(alice, monkeypatch):
    # provider_id "" targets the first entry; "test" mode is the Test button's
    # tiny live completion.
    import gamma.routers.ai as ai_mod

    monkeypatch.setattr(ai_mod, "_call_ai", lambda *a, **kw: "ok")
    body = alice.post("/api/ai/health", json={"mode": "test"}).json()
    assert body["configured"] and body["ok"] is True
    assert body["model"] == "claude-solo" and body["provider_name"]


def test_ai_health_unknown_provider_id_falls_back_to_the_first_entry(alice, monkeypatch):
    """A stale saved pick (the entry was deleted) must still report on
    something rather than silently claiming nothing is configured."""
    import gamma.routers.ai as ai_mod

    monkeypatch.setattr(ai_mod, "_model_catalog_json", lambda req: {})
    first = alice.get("/api/ai/settings").json()["providers"][0]["id"]
    body = alice.post("/api/ai/health", json={"provider_id": "deleted-entry"}).json()
    assert body["configured"] and body["provider_id"] == first


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

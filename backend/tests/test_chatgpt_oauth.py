"""ChatGPT subscription sign-in: OAuth helpers, the connect endpoints, and the
chatgpt wire protocol (Responses API request shape + SSE parsing). All external
calls are faked — no network."""

import base64
import io
import json
import time
import urllib.error

import bcrypt
import pytest
from fastapi.testclient import TestClient

import gamma.chatgpt_oauth as co
from gamma.routers.ai import _chatgpt_request, _sse_deltas


def _fake_jwt(claims: dict) -> str:
    def seg(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")

    return f"{seg({'alg': 'none'})}.{seg(claims)}.sig"


def _fake_tokens(exp=None, email="tim@example.com", account="acct-123"):
    return {
        "access_token": _fake_jwt(
            {
                "exp": exp or int(time.time()) + 3600,
                "https://api.openai.com/auth": {"chatgpt_account_id": account},
            }
        ),
        "refresh_token": "rt-1",
        "id_token": _fake_jwt({"email": email}),
    }


@pytest.fixture(scope="module")
def erin(client):
    """A non-guest user (guests may not store credentials)."""
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'erin'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("erin", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("erin")
    c = TestClient(app)
    r = c.post("/api/login", json={"username": "erin", "password": "pw"})
    assert r.status_code == 200, r.text
    return c


# --- OAuth helpers ------------------------------------------------------------


def test_parse_callback_accepts_url_and_bare_code():
    url = "http://localhost:1455/auth/callback?code=abc123&state=st1"
    assert co.parse_callback(url, "st1") == "abc123"
    assert co.parse_callback("rawcode", "st1") == "rawcode"
    with pytest.raises(ValueError):
        co.parse_callback(url, "other-state")  # state mismatch
    with pytest.raises(ValueError):
        co.parse_callback("http://localhost:1455/auth/callback?error=denied", "st1")


def test_start_auth_url_carries_pkce_and_state():
    state, verifier, url = co.start_auth()
    assert state in url and "code_challenge=" in url and "S256" in url
    assert len(verifier) > 40
    assert url.startswith("https://auth.openai.com/oauth/authorize?")


def test_exchange_code_extracts_account_and_expiry(monkeypatch):
    monkeypatch.setattr(co, "_token_request", lambda form: _fake_tokens(exp=1_900_000_000))
    oauth = co.exchange_code("code", "verifier")
    assert oauth["account_id"] == "acct-123"
    assert oauth["email"] == "tim@example.com"
    assert oauth["expires_at"] == 1_900_000_000
    assert oauth["refresh_token"] == "rt-1"


# --- Connect endpoints --------------------------------------------------------


def test_guest_cannot_start_oauth(guest):
    assert guest.post("/api/ai/oauth/chatgpt/start").status_code == 403


def test_plain_add_endpoint_refuses_chatgpt_protocol(erin):
    r = erin.post("/api/ai/providers", json={"protocol": "chatgpt", "api_key": "x"})
    assert r.status_code == 400
    assert "sign" in r.json()["detail"].lower()


def test_model_catalog_needs_signin_before_connect(erin):
    # No connected ChatGPT entry yet — the account-gated list can't be served,
    # and a stale hardcoded one must not be.
    r = erin.post("/api/ai/model-catalog", json={"protocol": "chatgpt"})
    assert r.status_code == 400
    assert "sign in" in r.json()["detail"].lower()


def test_connect_flow_creates_masked_entry_and_models(erin, monkeypatch):
    import gamma.routers.ai as ai_mod

    monkeypatch.setattr(co, "_token_request", lambda form: _fake_tokens())
    # A fresh connect seeds its model list live from the account (first two).
    monkeypatch.setattr(
        ai_mod,
        "urlopen",
        lambda req, timeout=0: _FakeResp(
            {
                "models": [
                    {"slug": "gpt-6-sol", "visibility": "list"},
                    {"slug": "gpt-6-terra", "visibility": "list"},
                    {"slug": "gpt-6-luna", "visibility": "list"},
                ]
            }
        ),
    )
    state = erin.post("/api/ai/oauth/chatgpt/start").json()["state"]
    r = erin.post(
        "/api/ai/oauth/chatgpt/complete",
        json={
            "state": state,
            "callback": f"http://localhost:1455/auth/callback?code=abc&state={state}",
            "name": "My ChatGPT",
        },
    )
    assert r.status_code == 200, r.text
    entry = next(p for p in r.json()["providers"] if p["protocol"] == "chatgpt")
    assert entry["oauth_connected"] is True
    assert entry["account"] == "tim@example.com"
    assert entry["models"] == "gpt-6-sol, gpt-6-terra"
    assert "access" not in json.dumps(entry)  # tokens never reach the browser

    models = erin.get("/api/ai/models").json()
    assert any(m["model"] == "gpt-6-sol" and m["provider"] == entry["id"] for m in models["models"])

    # replay of the same state is rejected (one-shot verifier)
    r2 = erin.post("/api/ai/oauth/chatgpt/complete", json={"state": state, "callback": "code"})
    assert r2.status_code == 400


def test_expired_token_is_refreshed_lazily(erin, monkeypatch):
    from gamma.ai_settings import ai_runtime, load_provider_entries, save_provider_entries

    entries = load_provider_entries("erin")
    entry = next(e for e in entries if e.get("protocol") == "chatgpt")
    entry["oauth"]["expires_at"] = int(time.time()) - 10  # force expiry
    save_provider_entries("erin", entries)

    fresh = _fake_tokens(exp=int(time.time()) + 7200)
    monkeypatch.setattr(co, "_token_request", lambda form: fresh)
    rt = ai_runtime("erin")
    conf = rt["providers"][entry["id"]]
    assert conf["api_key"] == fresh["access_token"]
    # …and the refreshed token was persisted for the next request
    saved = next(e for e in load_provider_entries("erin") if e["id"] == entry["id"])
    assert saved["oauth"]["access_token"] == fresh["access_token"]


class _FakeResp:
    def __init__(self, body):
        self._body = body

    def read(self):
        return json.dumps(self._body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_model_catalog_asks_chatgpt_backend_live(erin, monkeypatch):
    import gamma.routers.ai as ai_mod

    entry = next(p for p in erin.get("/api/ai/settings").json()["providers"] if p["protocol"] == "chatgpt")
    seen = {}

    def fake_urlopen(req, timeout=0):
        seen["url"] = req.full_url
        seen["auth"] = req.get_header("Authorization")
        return _FakeResp(
            {
                "models": [
                    {"slug": "gpt-6-codex", "visibility": "list"},
                    {"slug": "gpt-5.1-codex", "visibility": "list"},
                    {"slug": "gpt-6-codex", "visibility": "list"},  # dupe collapses
                    {"slug": "gpt-5-codex-mini", "visibility": "hide"},  # usable, offered last
                    {"slug": "gpt-4-gone", "visibility": "none"},  # dropped
                ]
            }
        )

    monkeypatch.setattr(ai_mod, "urlopen", fake_urlopen)
    r = erin.post("/api/ai/model-catalog", json={"provider_id": entry["id"]})
    assert r.status_code == 200
    assert r.json()["models"] == ["gpt-6-codex", "gpt-5.1-codex", "gpt-5-codex-mini"]
    assert "chatgpt.com/backend-api/codex/models" in seen["url"]
    assert "client_version=" in seen["url"]
    assert seen["auth"].startswith("Bearer ")

    # No provider_id (pre-connect form): any connected chatgpt entry serves
    r = erin.post("/api/ai/model-catalog", json={"protocol": "chatgpt"})
    assert "gpt-6-codex" in r.json()["models"]


def test_model_catalog_falls_back_when_listing_fails(erin, monkeypatch):
    import gamma.routers.ai as ai_mod

    def boom(req, timeout=0):
        raise OSError("no route to host")

    monkeypatch.setattr(ai_mod, "urlopen", boom)
    r = erin.post("/api/ai/model-catalog", json={"protocol": "chatgpt"})
    assert r.status_code == 200
    assert r.json()["models"] == ai_mod._CHATGPT_MODEL_FALLBACK

    # API protocols need a key (typed or stored) before asking /v1/models
    r = erin.post("/api/ai/model-catalog", json={"protocol": "openai"})
    assert r.status_code == 400
    assert "key" in r.json()["detail"]


def test_api_model_catalog_uses_one_short_attempt(erin, monkeypatch):
    import gamma.routers.ai as ai_mod

    calls = []

    def timed_out(req, timeout=0):
        calls.append((req, timeout))
        raise TimeoutError("timed out")

    monkeypatch.setattr(ai_mod, "urlopen", timed_out)
    r = erin.post(
        "/api/ai/model-catalog",
        json={
            "protocol": "openai",
            "api_key": "sk-test",
        },
    )

    assert r.status_code == 400
    assert "timed out" in r.json()["detail"]
    assert len(calls) == 1
    assert calls[0][1] == 5
    assert calls[0][0].get_header("User-agent") == "Gamma/model-catalog"


def test_api_model_catalog_does_not_retry_auth_error(erin, monkeypatch):
    import gamma.routers.ai as ai_mod

    calls = 0

    def unauthorized(req, timeout=0):
        nonlocal calls
        calls += 1
        raise urllib.error.HTTPError(
            req.full_url,
            401,
            "Unauthorized",
            {},
            io.BytesIO(b'{"error":{"message":"bad key"}}'),
        )

    monkeypatch.setattr(ai_mod, "urlopen", unauthorized)
    r = erin.post(
        "/api/ai/model-catalog",
        json={
            "protocol": "openai",
            "api_key": "sk-bad",
        },
    )

    assert r.status_code == 400
    assert "bad key" in r.json()["detail"]
    assert calls == 1


# --- Wire protocol ------------------------------------------------------------


def test_chatgpt_request_shape_with_pdf_and_image():
    conf = {"api_key": "tok", "account_id": "acct-123", "base_url": "https://chatgpt.com/backend-api/codex"}
    msgs = [{"role": "assistant", "content": "earlier answer"}, {"role": "user", "content": "what does fig 2 show?"}]
    req = _chatgpt_request(conf, msgs, "be brief", "gpt-5.1", pdf_b64s=["UERG"], images=[("image/png", "SU1H")])
    body = json.loads(req.data)
    assert req.full_url.endswith("/responses")
    assert body["stream"] is True and body["store"] is False
    assert body["model"] == "gpt-5.1" and body["instructions"] == "be brief"
    assert body["input"][0]["content"][0]["type"] == "output_text"
    last = body["input"][-1]["content"]
    assert [p["type"] for p in last] == ["input_file", "input_image", "input_text"]
    assert last[0]["file_data"].startswith("data:application/pdf;base64,")
    assert req.get_header("Chatgpt-account-id") == "acct-123"
    assert req.get_header("Authorization") == "Bearer tok"


def test_chatgpt_sse_deltas_join_and_fail():
    ok = [
        b'data: {"type":"response.output_text.delta","delta":"Hel"}\n',
        b'data: {"type":"response.output_text.delta","delta":"lo"}\n',
        b'data: {"type":"response.completed","response":{"status":"completed"}}\n',
    ]
    assert "".join(_sse_deltas(ok, "chatgpt")) == "Hello"

    failed = [b'data: {"type":"response.failed","response":{"error":{"message":"quota hit"}}}\n']
    with pytest.raises(RuntimeError, match="quota hit"):
        list(_sse_deltas(failed, "chatgpt"))

    empty = [b'data: {"type":"response.completed","response":{"status":"completed"}}\n']
    with pytest.raises(RuntimeError, match="empty response"):
        list(_sse_deltas(empty, "chatgpt"))

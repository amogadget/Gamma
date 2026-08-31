"""/api/ai/translate: validation, the paragraph cache, and the JSON wire."""

import json

import bcrypt
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def carol(client):
    """A non-guest user with an Anthropic provider entry (translate needs one)."""
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'carol'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("carol", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("carol")
    c = TestClient(app)
    r = c.post("/api/login", json={"username": "carol", "password": "pw"})
    assert r.status_code == 200, r.text
    r = c.post("/api/ai/providers", json={"protocol": "anthropic", "api_key": "sk-ant-key-1234"})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture(scope="module")
def dave(client):
    """A second provider-holding user, for cross-user cache isolation."""
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'dave-tr'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("dave-tr", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("dave-tr")
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "dave-tr", "password": "pw"}).status_code == 200
    assert c.post("/api/ai/providers",
                  json={"protocol": "anthropic", "api_key": "sk-ant-key-5678"}).status_code == 200
    return c


def _fake_call(replies):
    """A _call_ai stand-in: records each batch it was sent, answers from
    `replies` (a callable on the batch) as the model's JSON-array reply."""
    calls = []

    def fake(messages, system, entry, rt, **kw):
        batch = json.loads(messages[-1]["content"])
        calls.append(batch)
        return json.dumps(replies(batch), ensure_ascii=False)

    return fake, calls


def test_translate_requires_auth():
    """No session at all: the endpoint must not be reachable."""
    from gamma.app import app

    c = TestClient(app)
    r = c.post("/api/ai/translate", json={"texts": ["hello"], "lang": "zh-CN"})
    assert r.status_code == 401


def test_translate_requires_a_provider():
    # Own TestClient: logging the shared session client in as guest would
    # leak that cookie into later test modules.
    from gamma.app import app

    c = TestClient(app)
    assert c.post("/api/login-guest").status_code == 200
    r = c.post("/api/ai/translate", json={"texts": ["hello"], "lang": "zh-CN"})
    assert r.status_code == 503


def test_translate_validation(carol):
    assert carol.post("/api/ai/translate", json={"texts": ["hi"], "lang": "klingon"}).status_code == 400
    assert carol.post("/api/ai/translate", json={"texts": [], "lang": "zh-CN"}).status_code == 400
    assert carol.post("/api/ai/translate", json={"texts": [1, 2], "lang": "zh-CN"}).status_code == 400
    assert carol.post("/api/ai/translate",
                      json={"texts": ["x"] * 201, "lang": "zh-CN"}).status_code == 400
    assert carol.post("/api/ai/translate",
                      json={"texts": ["x" * 40000, "y" * 40000], "lang": "zh-CN"}).status_code == 413


def test_translate_caches_per_paragraph(carol, monkeypatch):
    fake, calls = _fake_call(lambda batch: [f"译:{t}" for t in batch])
    monkeypatch.setattr("gamma.routers.ai._call_ai", fake)

    texts = ["The quick brown fox.", "  ", "Jumps over the lazy dog."]
    r = carol.post("/api/ai/translate", json={"texts": texts, "lang": "zh-CN"})
    assert r.status_code == 200, r.text
    body = r.json()
    # Whitespace-only paragraphs never reach the model and come back verbatim.
    assert body["translations"] == ["译:The quick brown fox.", "  ", "译:Jumps over the lazy dog."]
    assert calls == [["The quick brown fox.", "Jumps over the lazy dog."]]
    assert body["cached"] is False

    # Same request again: fully served from the cache, no upstream call.
    r = carol.post("/api/ai/translate", json={"texts": texts, "lang": "zh-CN"})
    assert r.status_code == 200
    assert r.json()["translations"][0] == "译:The quick brown fox."
    assert r.json()["cached"] is True
    assert len(calls) == 1

    # One new paragraph: only the miss goes upstream.
    r = carol.post("/api/ai/translate",
                   json={"texts": ["The quick brown fox.", "A new sentence."], "lang": "zh-CN"})
    assert r.status_code == 200
    assert r.json()["translations"] == ["译:The quick brown fox.", "译:A new sentence."]
    assert calls[-1] == ["A new sentence."]

    # A different target language is a different cache line.
    r = carol.post("/api/ai/translate", json={"texts": ["The quick brown fox."], "lang": "ja"})
    assert r.status_code == 200
    assert calls[-1] == ["The quick brown fox."]


def test_translate_cache_is_per_user(carol, dave, monkeypatch):
    """Carol's cached paragraph must never be served to another account."""
    fake, calls = _fake_call(lambda batch: [f"c:{t}" for t in batch])
    monkeypatch.setattr("gamma.routers.ai._call_ai", fake)
    para = "A paragraph shared between two accounts."

    assert carol.post("/api/ai/translate", json={"texts": [para], "lang": "de"}).status_code == 200
    assert len(calls) == 1

    r = dave.post("/api/ai/translate", json={"texts": [para], "lang": "de"})
    assert r.status_code == 200
    # Dave misses the cache entirely — his own call goes upstream.
    assert len(calls) == 2
    assert r.json()["cached"] is False


def test_translate_forwards_effort(carol, monkeypatch):
    seen = {}

    def fake(messages, system, entry, rt, **kw):
        seen.update(kw)
        return json.dumps([f"x:{t}" for t in json.loads(messages[-1]["content"])])

    monkeypatch.setattr("gamma.routers.ai._call_ai", fake)
    r = carol.post("/api/ai/translate",
                   json={"texts": ["an effort-test paragraph"], "lang": "fr", "effort": "low"})
    assert r.status_code == 200
    assert seen.get("effort") == "low"
    # Unknown values degrade to "" (parameter omitted), not an error.
    r = carol.post("/api/ai/translate",
                   json={"texts": ["a second effort-test paragraph"], "lang": "fr", "effort": "turbo"})
    assert r.status_code == 200
    assert seen.get("effort") == ""


def test_translate_tolerates_fenced_reply(carol, monkeypatch):
    monkeypatch.setattr("gamma.routers.ai._call_ai",
                        lambda *a, **k: 'Sure!\n```json\n["uno"]\n```')
    r = carol.post("/api/ai/translate", json={"texts": ["one fresh paragraph"], "lang": "es"})
    assert r.status_code == 200
    assert r.json()["translations"] == ["uno"]


def test_translate_salvages_miscounted_batch(carol, monkeypatch):
    # The model merges two paragraphs into one array element (the classic
    # "expected 5, got 4") — the endpoint retries per paragraph, where a
    # 1-element array can't misalign.
    def fake(messages, system, entry, rt, **kw):
        batch = json.loads(messages[-1]["content"])
        if len(batch) > 1:
            return json.dumps(["merged!"])  # wrong length
        return json.dumps([f"ok:{batch[0]}"])

    monkeypatch.setattr("gamma.routers.ai._call_ai", fake)
    r = carol.post("/api/ai/translate",
                   json={"texts": ["salvage paragraph one", "salvage paragraph two"], "lang": "de"})
    assert r.status_code == 200
    assert r.json()["translations"] == ["ok:salvage paragraph one", "ok:salvage paragraph two"]


def test_translate_unparseable_reply_degrades_to_original(carol, monkeypatch):
    # Provider reachable but talking garbage: paragraphs come back verbatim
    # (the viewer shows the original) and are NOT cached, so a later retry
    # can still improve them.
    monkeypatch.setattr("gamma.routers.ai._call_ai", lambda *a, **k: "no array here")
    r = carol.post("/api/ai/translate", json={"texts": ["another fresh paragraph"], "lang": "de"})
    assert r.status_code == 200
    assert r.json()["translations"] == ["another fresh paragraph"]

    def good(messages, system, entry, rt, **kw):
        return json.dumps([f"besser:{t}" for t in json.loads(messages[-1]["content"])])

    monkeypatch.setattr("gamma.routers.ai._call_ai", good)
    r = carol.post("/api/ai/translate", json={"texts": ["another fresh paragraph"], "lang": "de"})
    assert r.status_code == 200
    assert r.json()["translations"] == ["besser:another fresh paragraph"]


def test_translate_provider_failure_is_502(carol, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("upstream exploded")

    monkeypatch.setattr("gamma.routers.ai._call_ai", boom)
    r = carol.post("/api/ai/translate", json={"texts": ["a doomed paragraph"], "lang": "it"})
    assert r.status_code == 502


def test_translate_rate_limited_per_user(carol, dave, monkeypatch):
    """The per-user ceiling bounds cost; another account is unaffected."""
    from gamma import ratelimit
    from gamma.routers import ai as ai_router

    monkeypatch.setattr("gamma.routers.ai._call_ai",
                        lambda messages, *a, **k: json.dumps(
                            [f"r:{t}" for t in json.loads(messages[-1]["content"])]))
    monkeypatch.setattr(ai_router, "_TRANSLATE_RATE_MAX", 3)
    ratelimit.reset("ai-translate:carol")
    ratelimit.reset("ai-translate:dave-tr")

    codes = [
        carol.post("/api/ai/translate",
                   json={"texts": [f"rate paragraph {i}"], "lang": "ru"}).status_code
        for i in range(5)
    ]
    assert codes[:3] == [200, 200, 200]
    assert codes[3:] == [429, 429]
    # A different account still works.
    assert dave.post("/api/ai/translate",
                     json={"texts": ["dave rate paragraph"], "lang": "ru"}).status_code == 200
    ratelimit.reset("ai-translate:carol")
    ratelimit.reset("ai-translate:dave-tr")

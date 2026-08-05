"""Voice dictation endpoint: provider selection + OpenAI transcription wire."""

import io
import json
import urllib.error

import bcrypt
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def bob(client):
    """A separate TestClient logged in as a real (non-guest) user."""
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'bob'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("bob", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("bob")
    c = TestClient(app)
    r = c.post("/api/login", json={"username": "bob", "password": "pw"})
    assert r.status_code == 200, r.text
    return c


def _post_audio(client, **form):
    return client.post("/api/ai/transcribe", data=form,
                       files={"file": ("dictation.webm", b"\x1aE\xdf\xa3fake-opus", "audio/webm")})


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self._payload).encode()


def test_transcribe_requires_a_provider(bob):
    r = _post_audio(bob)
    assert r.status_code == 503


def test_transcribe_needs_an_openai_protocol_entry(bob):
    r = bob.post("/api/ai/providers", json={"protocol": "anthropic", "api_key": "sk-ant-key-1234"})
    assert r.status_code == 200, r.text
    r = _post_audio(bob)
    assert r.status_code == 503
    assert "OpenAI" in r.json()["detail"]


def test_transcribe_uses_the_openai_entry(bob, monkeypatch):
    r = bob.post("/api/ai/providers", json={"protocol": "openai", "api_key": "sk-oa-key-9876"})
    assert r.status_code == 200, r.text

    seen = {}

    def fake_urlopen(req, timeout=0):
        seen["url"] = req.full_url
        seen["auth"] = req.get_header("Authorization")
        seen["body"] = req.data
        return _FakeResponse({"text": " hello world "})

    from gamma.routers import ai
    monkeypatch.setattr(ai, "urlopen", fake_urlopen)

    r = _post_audio(bob)
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "hello world"
    assert r.json()["model"] == "gpt-4o-transcribe"
    assert seen["url"] == "https://api.openai.com/v1/audio/transcriptions"
    assert seen["auth"] == "Bearer sk-oa-key-9876"
    assert b"fake-opus" in seen["body"] and b"gpt-4o-transcribe" in seen["body"]


def test_transcribe_falls_back_to_whisper(bob, monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=0):
        calls.append(req.data)
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", None,
                                         io.BytesIO(b'{"error":{"message":"model not found"}}'))
        return _FakeResponse({"text": "second try"})

    from gamma.routers import ai
    monkeypatch.setattr(ai, "urlopen", fake_urlopen)

    r = _post_audio(bob)
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "second try", "model": "whisper-1"}
    assert b"whisper-1" in calls[1]


def test_transcribe_honors_the_model_override(bob, monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=0):
        seen["body"] = req.data
        return _FakeResponse({"text": "ok"})

    from gamma.routers import ai
    monkeypatch.setattr(ai, "urlopen", fake_urlopen)

    r = _post_audio(bob, model="gpt-4o-mini-transcribe", language="zh")
    assert r.status_code == 200, r.text
    assert r.json()["model"] == "gpt-4o-mini-transcribe"
    assert b"gpt-4o-mini-transcribe" in seen["body"]
    assert b'name="language"\r\n\r\nzh' in seen["body"]

    # Auto-detect sends no language field at all
    r = _post_audio(bob)
    assert r.status_code == 200
    assert b'name="language"' not in seen["body"]

    assert _post_audio(bob, model="bad model\r\nname").status_code == 400
    assert _post_audio(bob, language="not a language").status_code == 400


def test_transcribe_rejects_empty_audio(bob):
    r = bob.post("/api/ai/transcribe",
                 files={"file": ("dictation.webm", b"", "audio/webm")})
    assert r.status_code == 400

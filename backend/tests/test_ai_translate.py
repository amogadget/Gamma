"""/api/ai/translate: validation, the paragraph cache, and the JSON wire."""

import json

import bcrypt
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def carol(client):
    """A non-guest user with an Anthropic provider entry (translate needs one).

    The account name is file-unique: other test modules make their own 'carol'
    and the worker's data dir is shared across the files it runs.
    """
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma import workspaces

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'translate_carol'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("translate_carol", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    workspaces.ensure_personal("translate_carol")
    c = TestClient(app)
    r = c.post("/api/login", json={"username": "translate_carol", "password": "pw"})
    assert r.status_code == 200, r.text
    r = c.post("/api/ai/providers", json={"protocol": "anthropic", "api_key": "sk-ant-key-1234"})
    assert r.status_code == 200, r.text
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


def test_translate_dedupes_within_request(carol, monkeypatch):
    # The same paragraph appearing twice (running headers, repeated captions)
    # goes upstream once; the one translation fills both slots.
    fake, calls = _fake_call(lambda batch: [f"译:{t}" for t in batch])
    monkeypatch.setattr("gamma.routers.ai._call_ai", fake)
    r = carol.post("/api/ai/translate",
                   json={"texts": ["a twin paragraph", "a twin paragraph"], "lang": "it"})
    assert r.status_code == 200
    assert r.json()["translations"] == ["译:a twin paragraph", "译:a twin paragraph"]
    assert calls == [["a twin paragraph"]]


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


class _StreamResp:
    """An Anthropic SSE reply whose text arrives in the given pieces."""
    def __init__(self, pieces):
        self._lines = [("data: " + json.dumps({"type": "content_block_delta",
                                               "delta": {"type": "text_delta", "text": t}})
                        + "\n").encode() for t in pieces] + [b"data: [DONE]\n"]

    def __iter__(self):
        return iter(self._lines)

    def close(self):
        pass


def test_translate_streams_partials(carol, monkeypatch):
    """stream: true answers NDJSON — a partial line per paragraph as the
    model writes it (every request index sharing that source text), then the
    same final object a plain call returns; the cache is filled the same way."""
    import gamma.routers.ai as ai_mod
    monkeypatch.setattr(ai_mod, "_TRANSLATE_STREAM_INTERVAL", 0)
    opened = []

    def fake_open(messages, system, entry, rt, **kw):
        opened.append(json.loads(messages[-1]["content"]))
        assert kw.get("stream") is True
        return _StreamResp(['```json\n["第一', '段", "第', '二段"]\n```'])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = carol.post("/api/ai/translate", json={
        "texts": ["stream one", "stream two", "stream one"], "lang": "zh-CN", "stream": True})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    assert opened == [["stream one", "stream two"]]  # duplicate collapsed upstream
    assert lines[-1] == {"translations": ["第一段", "第二段", "第一段"],
                         "model": lines[-1]["model"], "cached": False}
    partials = lines[:-1]
    assert partials[0] == {"i": [0, 2], "text": "第一"}  # both slots of the shared source
    assert {"i": [0, 2], "text": "第一段"} in partials
    assert {"i": [1], "text": "第"} in partials
    # Cached now: the stream is just the final line, nothing goes upstream.
    r = carol.post("/api/ai/translate", json={
        "texts": ["stream two", "stream one"], "lang": "zh-CN", "stream": True})
    assert r.status_code == 200
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    assert lines == [{"translations": ["第二段", "第一段"], "model": lines[0]["model"], "cached": True}]
    assert len(opened) == 1


def test_translate_stream_reports_upstream_failure_in_band(carol, monkeypatch):
    import gamma.routers.ai as ai_mod

    def boom(*a, **kw):
        raise RuntimeError("provider down")

    monkeypatch.setattr(ai_mod, "_open_ai", boom)
    r = carol.post("/api/ai/translate", json={"texts": ["fails"], "lang": "de", "stream": True})
    assert r.status_code == 200
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    assert lines == [{"error": "translation failed: provider down"}]

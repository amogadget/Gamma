"""Token usage: the wire parser's ("usage", …) event per protocol, the
chat stream's {"usage"} line (one per agent round), the per-account
ai_usage rows behind GET /api/ai/usage, and the reset."""

import json

import pytest

from ai_fixtures import CONF, FakeResp, ai_provider, org, sse  # noqa: F401  (fixtures)
from gamma.ai_client import add_usage, normalize_usage, openai_request, sse_events


@pytest.fixture(scope="module", autouse=True)
def _provider(ai_provider):
    """Every chat here needs a provider entry on the module's account."""


def test_normalize_usage_per_protocol():
    # Anthropic counts the cached parts beside input_tokens; "input" is the whole prompt.
    assert normalize_usage({"input_tokens": 10, "output_tokens": 4, "cache_read_input_tokens": 90,
                            "cache_creation_input_tokens": 5}, "anthropic") == \
        {"input": 105, "output": 4, "cache_read": 90, "cache_write": 5}
    assert normalize_usage({"prompt_tokens": 20, "completion_tokens": 3,
                            "prompt_tokens_details": {"cached_tokens": 8}}, "openai") == \
        {"input": 20, "output": 3, "cache_read": 8, "cache_write": 0}
    assert normalize_usage({"input_tokens": 7, "output_tokens": 2,
                            "input_tokens_details": {"cached_tokens": 1}}, "chatgpt") == \
        {"input": 7, "output": 2, "cache_read": 1, "cache_write": 0}
    assert normalize_usage({"input_tokens": 0, "output_tokens": 0}, "openai-responses") is None
    assert normalize_usage(None, "openai") is None
    assert add_usage({"input": 1, "output": 2, "cache_read": 0, "cache_write": 0},
                     {"input": 3, "output": 4, "cache_read": 1, "cache_write": 0}) == \
        {"input": 4, "output": 6, "cache_read": 1, "cache_write": 0}


def test_openai_stream_asks_for_usage_chunk():
    body = json.loads(openai_request(CONF, [{"role": "user", "content": "hi"}], "", "m", stream=True).data)
    assert body["stream_options"] == {"include_usage": True}
    body = json.loads(openai_request(CONF, [{"role": "user", "content": "hi"}], "", "m").data)
    assert "stream_options" not in body


def test_sse_events_report_usage_last():
    anthropic = sse(
        {"type": "message_start", "message": {"usage": {"input_tokens": 12, "output_tokens": 1,
                                                        "cache_read_input_tokens": 100}}},
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 9}},
    )
    assert list(sse_events(anthropic, "anthropic")) == [
        ("text", "hi"), ("usage", {"input": 112, "output": 9, "cache_read": 100, "cache_write": 0})]

    openai = sse(
        {"choices": [{"delta": {"content": "hi"}}]},
        {"choices": [], "usage": {"prompt_tokens": 30, "completion_tokens": 5}},
    )
    assert list(sse_events(openai, "openai")) == [
        ("text", "hi"), ("usage", {"input": 30, "output": 5, "cache_read": 0, "cache_write": 0})]

    responses = sse(
        {"type": "response.output_text.delta", "delta": "hi"},
        {"type": "response.completed", "response": {"status": "completed",
                                                    "usage": {"input_tokens": 3, "output_tokens": 2}}},
    )
    assert list(sse_events(responses, "chatgpt")) == [
        ("text", "hi"), ("usage", {"input": 3, "output": 2, "cache_read": 0, "cache_write": 0})]

    # No report from the provider: no event, and nothing else changes.
    assert list(sse_events(sse({"choices": [{"delta": {"content": "x"}}]}), "openai")) == [("text", "x")]


def _turn(text, usage):
    return FakeResp([
        {"type": "message_start", "message": {"usage": usage}},
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 4}},
    ])


def test_chat_stream_emits_usage_and_records_it(org, monkeypatch):
    c, ids = org
    import gamma.routers.ai as ai_mod

    assert c.delete("/api/ai/usage").status_code == 200
    monkeypatch.setattr(ai_mod, "_open_ai",
                        lambda *a, **kw: _turn("Hello.", {"input_tokens": 50, "output_tokens": 1}))
    r = c.post("/api/ai/chat", json={"prompt": "hi", "stream": True})
    assert r.status_code == 200, r.text
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    assert "".join(l.get("delta", "") for l in lines) == "Hello."
    # The usage line is the last one.
    assert lines[-1] == {"usage": {"input": 50, "output": 4, "cache_read": 0, "cache_write": 0}}

    s = c.get("/api/ai/usage").json()
    assert s["windows"]["today"] == {"calls": 1, "input": 50, "output": 4, "cache_read": 0, "cache_write": 0}
    assert s["windows"]["all"]["calls"] == 1 and s["kinds"] == {"chat": s["windows"]["today"]}
    assert s["models"][0]["model"] == "claude-solo" and s["models"][0]["input"] == 50

    # Non-stream callers get the counts in the body.
    class _Ctx(FakeResp):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_read(resp, proto, on_usage=None):
        on_usage({"input": 7, "output": 1, "cache_read": 0, "cache_write": 0})
        return "ok"

    monkeypatch.setattr(ai_mod, "_open_ai", lambda *a, **kw: _Ctx([]))
    monkeypatch.setattr(ai_mod, "_read_reply", fake_read)
    r = c.post("/api/ai/chat", json={"prompt": "hi", "stream": False})
    assert r.status_code == 200 and r.json()["usage"]["input"] == 7
    assert c.get("/api/ai/usage").json()["windows"]["today"]["calls"] == 2


def test_agent_rounds_each_report_usage(org, monkeypatch):
    c, ids = org
    import gamma.routers.ai as ai_mod

    assert c.delete("/api/ai/usage").status_code == 200
    calls = []

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        calls.append(1)
        if len(calls) == 1:
            return FakeResp([
                {"type": "message_start", "message": {"usage": {"input_tokens": 100, "output_tokens": 1}}},
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "list_pages"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{}"}},
                {"type": "content_block_stop"},
                {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 20}},
            ])
        return _turn("Done.", {"input_tokens": 300, "output_tokens": 1})

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={"prompt": "list", "agent_scope": "folder", "folder": "",
                                     "stream": True})
    assert r.status_code == 200, r.text
    usage = [l["usage"] for l in (json.loads(l) for l in r.text.splitlines() if l.strip()) if "usage" in l]
    assert [u["input"] for u in usage] == [100, 300] and [u["output"] for u in usage] == [20, 4]
    today = c.get("/api/ai/usage").json()["windows"]["today"]
    assert today == {"calls": 2, "input": 400, "output": 24, "cache_read": 0, "cache_write": 0}

    # Reset forgets everything.
    assert c.delete("/api/ai/usage").json()["deleted"] == 2
    assert c.get("/api/ai/usage").json()["windows"]["all"]["calls"] == 0

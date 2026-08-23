"""Library-organizer AI tools: executor scope rules, wire-format translation
of tool definitions/calls per protocol, tool-call SSE parsing, and the
/api/ai/chat agent loop end-to-end with a faked provider."""

import json

import bcrypt
import pytest
from fastapi.testclient import TestClient

from gamma.ai_client import (
    anthropic_request,
    chatgpt_request,
    openai_request,
    openai_responses_request,
    sse_events,
    wire_protocol,
)
from gamma.ai_tools import FOLDER_TOOLS, run_folder_tool


@pytest.fixture(scope="module")
def org(client):
    """A non-guest user with a small library: two papers in folders, one loose note."""
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'organizer'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("organizer", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("organizer")
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "organizer", "password": "pw"}).status_code == 200

    def page(content, props):
        r = c.post("/api/blocks", json={"parent_id": "root", "content": content, "properties": props})
        assert r.status_code == 200, r.text
        return r.json()["id"]

    ids = {
        "a": page("cavity paper", {"folder": "readout", "doc_id": "d" * 24,
                                   "meta": {"authors": ["Ada One", "Bo Two"], "year": "2019", "venue": "Nature"}}),
        "b": page("qec paper", {"folder": "readout/nondestructive, cooling"}),
        "note": page("loose note", {}),
    }
    return c, ids


def _props(c, block_id):
    r = c.get(f"/api/blocks/{block_id}")
    assert r.status_code == 200
    return r.json()


# --- executor ----------------------------------------------------------------

def test_list_pages_scoped_and_annotated(org):
    c, ids = org
    text, action = run_folder_tool("organizer", "readout", "list_pages", {})
    assert action is None
    assert f"id={ids['a']}" in text and f"id={ids['b']}" in text
    assert ids["note"] not in text  # outside the folder
    assert "One et al., 2019, Nature" in text  # cached metadata surfaces
    # Root scope lists everything, including the loose note.
    root_text, _ = run_folder_tool("organizer", "", "list_pages", {})
    assert ids["note"] in root_text and "note" in root_text


def test_rename_page(org):
    c, ids = org
    text, action = run_folder_tool("organizer", "readout", "rename_page",
                                   {"page_id": ids["a"], "title": "  Ada2019 —  Cavity readout \n"})
    assert text.startswith("ok"), text
    assert action["kind"] == "rename" and "Ada2019 — Cavity readout" in action["summary"]
    assert _props(c, ids["a"])["content"] == "Ada2019 — Cavity readout"
    # No-op rename mutates nothing and reports no action.
    text, action = run_folder_tool("organizer", "readout", "rename_page",
                                   {"page_id": ids["a"], "title": "Ada2019 — Cavity readout"})
    assert action is None


def test_scope_blocks_outside_pages(org):
    c, ids = org
    text, action = run_folder_tool("organizer", "readout", "rename_page",
                                   {"page_id": ids["note"], "title": "hijack"})
    assert text.startswith("error") and action is None
    assert _props(c, ids["note"])["content"] == "loose note"
    text, _ = run_folder_tool("organizer", "readout", "rename_page",
                              {"page_id": "nope", "title": "x"})
    assert text.startswith("error")


def test_move_page_keeps_out_of_scope_tags(org):
    c, ids = org
    # Relative target resolves inside the scope; the "cooling" membership survives.
    text, action = run_folder_tool("organizer", "readout", "move_page",
                                   {"page_id": ids["b"], "folder": "fast"})
    assert text.startswith("ok"), text
    assert action["kind"] == "move" and "readout/fast" in action["summary"]
    tags = [t.strip() for t in _props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout/fast"]
    # "" files the page at the scope itself.
    run_folder_tool("organizer", "readout", "move_page", {"page_id": ids["b"], "folder": ""})
    tags = [t.strip() for t in _props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout"]


def test_move_at_root_replaces_all_folders(org):
    c, ids = org
    run_folder_tool("organizer", "", "move_page", {"page_id": ids["b"], "folder": "archive/2019"})
    assert _props(c, ids["b"])["properties"]["folder"] == "archive/2019"
    # Root + "" = out of every folder.
    run_folder_tool("organizer", "", "move_page", {"page_id": ids["b"], "folder": ""})
    assert _props(c, ids["b"])["properties"]["folder"] == ""
    # Restore for later tests.
    run_folder_tool("organizer", "", "move_page", {"page_id": ids["b"], "folder": "readout"})


def test_labels_are_off_limits(org):
    # Organizing never touches flat labels — folder membership changes only
    # through move_page.
    assert not any(t["name"] == "set_labels" for t in FOLDER_TOOLS)
    text, action = run_folder_tool("organizer", "", "set_labels",
                                   {"page_id": "x", "labels": ["y"]})
    assert text.startswith("error") and action is None


def test_unknown_tool_is_an_error_not_a_crash(org):
    text, action = run_folder_tool("organizer", "", "delete_page", {"page_id": "x"})
    assert text.startswith("error") and action is None


# --- wire formats ------------------------------------------------------------

_CONF = {"base_url": "https://example.test", "api_key": "k", "account_id": ""}
_TURNS = [
    {"role": "user", "content": "tidy up"},
    {"role": "assistant", "content": "listing", "tool_calls": [
        {"id": "c1", "name": "list_pages", "arguments": {}}]},
    {"role": "tool", "call_id": "c1", "content": "Pages…"},
]


def test_anthropic_wire_tools_and_results():
    req = anthropic_request(_CONF, [dict(m) for m in _TURNS], "sys", "m", tools=FOLDER_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0]["name"] == "list_pages" and "input_schema" in body["tools"][0]
    assert body["messages"][1]["content"] == [
        {"type": "text", "text": "listing"},
        {"type": "tool_use", "id": "c1", "name": "list_pages", "input": {}}]
    assert body["messages"][2] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "c1", "content": "Pages…"}]}


def test_openai_wire_tools_and_results():
    req = openai_request(_CONF, [dict(m) for m in _TURNS], "sys", "m", tools=FOLDER_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0] == {"type": "function", "function": {
        "name": "list_pages", "description": FOLDER_TOOLS[0]["description"],
        "parameters": FOLDER_TOOLS[0]["parameters"]}}
    call = body["messages"][2]["tool_calls"][0]
    assert call["function"]["name"] == "list_pages" and call["id"] == "c1"
    assert body["messages"][3] == {"role": "tool", "tool_call_id": "c1", "content": "Pages…"}


def test_chatgpt_wire_tools_and_results():
    req = chatgpt_request(_CONF, [dict(m) for m in _TURNS], "sys", "m", tools=FOLDER_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0]["type"] == "function" and body["tools"][0]["name"] == "list_pages"
    kinds = [i["type"] for i in body["input"]]
    assert kinds == ["message", "message", "function_call", "function_call_output"]
    assert body["input"][2]["call_id"] == "c1"
    assert body["input"][3] == {"type": "function_call_output", "call_id": "c1", "output": "Pages…"}


def test_openai_responses_wire_shape():
    req = openai_responses_request(_CONF, [dict(m) for m in _TURNS], "sys", "gpt-5.6-sol",
                                   tools=FOLDER_TOOLS)
    assert req.full_url == "https://example.test/v1/responses"
    assert req.headers["Authorization"] == "Bearer k"
    body = json.loads(req.data)
    assert body["instructions"] == "sys" and body["stream"] is True
    assert body["tools"][0]["type"] == "function" and body["tools"][0]["name"] == "list_pages"
    kinds = [i["type"] for i in body["input"]]
    assert kinds == ["message", "message", "function_call", "function_call_output"]


def test_wire_protocol_reroutes_official_openai_tools_only():
    def rt(base):
        return {"providers": {"p": {"protocol": "openai", "base_url": base}}}
    entry = {"provider": "p", "model": "m"}
    official = rt("https://api.openai.com")
    assert wire_protocol(official, entry, FOLDER_TOOLS) == "openai-responses"
    assert wire_protocol(official, entry, None) == "openai"  # plain chat: completions
    # Custom gateways may not implement /v1/responses — keep chat completions.
    assert wire_protocol(rt("http://localhost:4000"), entry, FOLDER_TOOLS) == "openai"
    chatgpt = {"providers": {"p": {"protocol": "chatgpt", "base_url": "https://chatgpt.com/backend-api/codex"}}}
    assert wire_protocol(chatgpt, entry, FOLDER_TOOLS) == "chatgpt"


def test_sse_events_openai_responses_dialect():
    stream = _sse(
        {"type": "response.output_text.delta", "delta": "hi"},
        {"type": "response.output_item.done", "item": {
            "type": "function_call", "call_id": "f2", "name": "move_page",
            "arguments": '{"page_id": "p", "folder": "x"}'}},
        {"type": "response.completed", "response": {"status": "completed"}},
    )
    events = list(sse_events(stream, "openai-responses"))
    assert events == [("text", "hi"), ("tool", {"id": "f2", "name": "move_page",
                                                "arguments": {"page_id": "p", "folder": "x"}})]


def test_attachments_ride_on_last_user_turn_not_tool_result():
    req = anthropic_request(_CONF, [dict(m) for m in _TURNS], "sys", "m",
                            pdf_b64s=["QUJD"], tools=FOLDER_TOOLS)
    body = json.loads(req.data)
    assert body["messages"][0]["content"][0]["type"] == "document"
    assert body["messages"][2]["content"][0]["type"] == "tool_result"


# --- SSE tool-call parsing ---------------------------------------------------

def _sse(*events):
    return iter([f"data: {json.dumps(e)}\n".encode() for e in events] + [b"data: [DONE]\n"])


def test_sse_events_anthropic_tool_use():
    stream = _sse(
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok "}},
        {"type": "content_block_start", "content_block": {"type": "tool_use", "id": "t1", "name": "rename_page"}},
        {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": '{"page_id": "p1",'}},
        {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": ' "title": "T"}'}},
        {"type": "content_block_stop"},
    )
    events = list(sse_events(stream, "anthropic"))
    assert events == [("text", "ok "),
                      ("tool", {"id": "t1", "name": "rename_page",
                                "arguments": {"page_id": "p1", "title": "T"}})]


def test_sse_events_openai_tool_calls_accumulate():
    stream = _sse(
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c9", "function": {"name": "move_page", "arguments": '{"page_'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": 'id": "p2", "folder": "x"}'}}]}, "finish_reason": "tool_calls"}]},
    )
    events = list(sse_events(stream, "openai"))
    assert events == [("tool", {"id": "c9", "name": "move_page",
                                "arguments": {"page_id": "p2", "folder": "x"}})]


def test_sse_events_chatgpt_function_call_item():
    stream = _sse(
        {"type": "response.output_text.delta", "delta": "hi"},
        {"type": "response.output_item.done", "item": {
            "type": "function_call", "call_id": "f1", "name": "list_pages", "arguments": "{}"}},
        {"type": "response.completed", "response": {"status": "completed"}},
    )
    events = list(sse_events(stream, "chatgpt"))
    assert events == [("text", "hi"), ("tool", {"id": "f1", "name": "list_pages", "arguments": {}})]


# --- /api/ai/chat agent loop -------------------------------------------------

class _FakeResp:
    def __init__(self, events):
        self._lines = [f"data: {json.dumps(e)}\n".encode() for e in events] + [b"data: [DONE]\n"]

    def __iter__(self):
        return iter(self._lines)

    def close(self):
        pass


def test_chat_agent_loop_streams_actions(org, monkeypatch):
    c, ids = org
    import gamma.routers.ai as ai_mod

    assert c.post("/api/ai/providers",
                  json={"protocol": "anthropic", "api_key": "sk-test-key-123",
                        "models": "claude-solo"}).status_code == 200

    opened = []

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        opened.append([dict(m) for m in messages])
        if len(opened) == 1:
            assert "library organizer" in system
            assert '"readout"' in system  # scope comes from THIS request's folder
            return _FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "rename_page"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"page_id": ids["a"], "title": "Ada2019 cavity"})}},
                {"type": "content_block_stop"},
            ])
        # Second round: the tool result is in the conversation; answer plainly.
        assert opened[1][-1]["role"] == "tool"
        assert opened[1][-1]["content"].startswith("ok")
        return _FakeResp([
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Renamed it."}},
        ])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={
        "prompt": "rename the cavity paper to Ada2019 cavity",
        "organize": True, "folder": "readout", "stream": True,
    })
    assert r.status_code == 200, r.text
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    actions = [l["action"] for l in lines if "action" in l]
    text = "".join(l.get("delta", "") for l in lines)
    assert len(opened) == 2
    assert actions and actions[0]["kind"] == "rename"
    assert text == "Renamed it."
    assert _props(c, ids["a"])["content"] == "Ada2019 cavity"


def test_chat_agent_round_budget_and_folder_switch(org, monkeypatch):
    """The folder is per request (switching folders re-scopes the next message)
    and tool_rounds caps the loop."""
    c, ids = org
    import gamma.routers.ai as ai_mod

    systems = []

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        systems.append(system)
        # Always ask for another tool round — only the budget can stop us.
        return _FakeResp([
            {"type": "content_block_start", "content_block":
                {"type": "tool_use", "id": "t1", "name": "list_pages"}},
            {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{}"}},
            {"type": "content_block_stop"},
        ])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={"prompt": "tidy", "organize": True,
                                     "folder": "cooling", "stream": True, "tool_rounds": 1})
    assert r.status_code == 200
    text = "".join(json.loads(l).get("delta", "") for l in r.text.splitlines() if l.strip())
    assert len(systems) == 1  # budget of 1: no second round opened
    assert "tool-round limit" in text
    assert '"cooling"' in systems[0]  # same conversation, new folder → new scope


def test_chat_without_organize_gets_no_tools(org, monkeypatch):
    c, _ = org
    import gamma.routers.ai as ai_mod

    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        seen["tools"] = kw.get("tools")
        return _FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "hi"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={"prompt": "hello", "stream": True})
    assert r.status_code == 200
    assert seen["tools"] is None

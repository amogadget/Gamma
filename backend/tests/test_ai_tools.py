"""Agent tools: the scope/permission registry, executor scope rules (folder
and page scopes), wire-format translation of tool definitions/calls per
protocol, tool-call SSE parsing, and the /api/ai/chat agent loop end-to-end
with a faked provider."""

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
from gamma.ai_context import TOOL_REPLAY_BUDGET, build_messages
from gamma.ai_tools import agent_system, agent_tools, run_agent_tool

ALL_TOOLS = agent_tools("folder")  # the full registry, for the wire tests


def _folder(path):
    return {"type": "folder", "folder": path}


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


# --- registry ----------------------------------------------------------------

def test_registry_scopes_and_permissions():
    assert [t["name"] for t in agent_tools("folder")] == [
        "list_pages", "read_page", "search_pdfs", "rename_page", "move_page"]
    # Paper chats get the read tools only — never rename/move.
    assert [t["name"] for t in agent_tools("page")] == ["read_page", "search_pdfs"]
    assert agent_tools("") == []  # plain chat
    assert [t["name"] for t in agent_tools("folder", {"rename": False, "move": False})] == [
        "list_pages", "read_page", "search_pdfs"]
    names = [t["name"] for t in agent_tools("folder", {"search": False})]
    assert "search_pdfs" not in names and "read_page" in names
    assert agent_tools("folder", {k: False for k in ("list", "read", "search", "rename", "move")}) == []
    assert agent_tools("folder", None) == ALL_TOOLS  # missing map = everything on


def test_agent_system_mentions_scope_and_armed_tools():
    text = agent_system(_folder("readout"))
    assert '"readout"' in text and "rename_page" in text
    page_text = agent_system({"type": "page", "page_id": "p1"}, {"search": False})
    assert 'page_id "p1"' in page_text
    assert "read_page" in page_text and "search_pdfs" not in page_text
    assert "suggest changes" in page_text  # no write tools in page scope
    # The base role prompt is user-replaceable; the mechanical lines stay.
    custom = agent_system(_folder(""), None, "Be terse.")
    assert custom.startswith("Be terse.") and "Available tools" in custom


# --- executors ---------------------------------------------------------------

def test_list_pages_scoped_and_annotated(org):
    c, ids = org
    text, action = run_agent_tool("organizer", _folder("readout"), "list_pages", {})
    assert action["kind"] == "list" and "2 pages" in action["summary"]
    assert f"id={ids['a']}" in text and f"id={ids['b']}" in text
    assert ids["note"] not in text  # outside the folder
    assert "One et al., 2019, Nature" in text  # cached metadata surfaces
    # Root scope lists everything, including the loose note.
    root_text, _ = run_agent_tool("organizer", _folder(""), "list_pages", {})
    assert ids["note"] in root_text and "note" in root_text


def test_rename_page(org):
    c, ids = org
    text, action = run_agent_tool("organizer", _folder("readout"), "rename_page",
                                  {"page_id": ids["a"], "title": "  Ada2019 —  Cavity readout \n"})
    assert text.startswith("ok"), text
    assert action["kind"] == "rename" and "Ada2019 — Cavity readout" in action["summary"]
    assert _props(c, ids["a"])["content"] == "Ada2019 — Cavity readout"
    # No-op rename mutates nothing, but still shows as a (non-error) chip.
    text, action = run_agent_tool("organizer", _folder("readout"), "rename_page",
                                  {"page_id": ids["a"], "title": "Ada2019 — Cavity readout"})
    assert action["kind"] == "rename" and not action.get("error")
    # Every chip carries the raw call so the chat can expand it.
    assert action["tool"] == "rename_page" and action["result"] == text
    assert action["args"]["title"] == "Ada2019 — Cavity readout"


def test_scope_blocks_outside_pages(org):
    c, ids = org
    text, action = run_agent_tool("organizer", _folder("readout"), "rename_page",
                                  {"page_id": ids["note"], "title": "hijack"})
    assert text.startswith("error") and action["error"] and action["kind"] == "error"
    assert _props(c, ids["note"])["content"] == "loose note"
    text, _ = run_agent_tool("organizer", _folder("readout"), "rename_page",
                             {"page_id": "nope", "title": "x"})
    assert text.startswith("error")


def test_move_page_keeps_out_of_scope_tags(org):
    c, ids = org
    # Relative target resolves inside the scope; the "cooling" membership survives.
    text, action = run_agent_tool("organizer", _folder("readout"), "move_page",
                                  {"page_id": ids["b"], "folder": "fast"})
    assert text.startswith("ok"), text
    assert action["kind"] == "move" and "readout/fast" in action["summary"]
    tags = [t.strip() for t in _props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout/fast"]
    # "" files the page at the scope itself.
    run_agent_tool("organizer", _folder("readout"), "move_page", {"page_id": ids["b"], "folder": ""})
    tags = [t.strip() for t in _props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout"]


def test_move_at_root_replaces_all_folders(org):
    c, ids = org
    run_agent_tool("organizer", _folder(""), "move_page", {"page_id": ids["b"], "folder": "archive/2019"})
    assert _props(c, ids["b"])["properties"]["folder"] == "archive/2019"
    # Root + "" = out of every folder.
    run_agent_tool("organizer", _folder(""), "move_page", {"page_id": ids["b"], "folder": ""})
    assert _props(c, ids["b"])["properties"]["folder"] == ""
    # Restore for later tests.
    run_agent_tool("organizer", _folder(""), "move_page", {"page_id": ids["b"], "folder": "readout"})


def test_unknown_or_out_of_scope_tools_error(org):
    text, action = run_agent_tool("organizer", _folder(""), "delete_page", {"page_id": "x"})
    assert text.startswith("error") and action["error"] and action["result"] == text
    text, action = run_agent_tool("organizer", _folder(""), "set_labels", {"page_id": "x"})
    assert text.startswith("error") and action["error"]
    # Write tools don't exist in page scope — same error as an unknown tool.
    text, _ = run_agent_tool("organizer", {"type": "page", "page_id": "x"},
                             "rename_page", {"page_id": "x", "title": "y"})
    assert text.startswith("error: unknown tool")


def test_read_page_returns_notes_and_respects_scope(org):
    c, ids = org
    r = c.post("/api/blocks", json={"parent_id": ids["a"], "content": "important note"})
    assert r.status_code == 200
    text, action = run_agent_tool("organizer", _folder("readout"), "read_page", {"page_id": ids["a"]})
    assert action["kind"] == "read" and action["summary"].startswith("Read “")
    assert "important note" in text  # the user's notes ride along
    # A page outside the scope is unreadable, same rule as the write tools.
    text, _ = run_agent_tool("organizer", _folder("readout"), "read_page", {"page_id": ids["note"]})
    assert text.startswith("error")


def test_read_page_pdf_offset_pages_through_long_documents(org, monkeypatch):
    """A long paper is read in windows: pdf_offset starts the excerpt there and
    the excerpt names the next offset while more text remains."""
    c, ids = org
    doc = "".join(f"[{i:04d}]" for i in range(200))  # 1200 chars, self-locating

    def fake_extract(src, char_limit, empty_page_cap=50, start_page=1):
        # Like the real extractor: stops after the "page" that crosses the
        # limit, so the result can overshoot char_limit a little.
        return doc if len(doc) <= char_limit else doc[:char_limit + 7]

    monkeypatch.setattr("gamma.ai_context.extract_text", fake_extract)
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")
    scope = _folder("readout")

    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 100})
    assert "[0000]" in text and "[0020]" not in text  # first window only
    assert "pdf_offset=100" in text  # continuation hint

    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 100, "pdf_offset": 100})
    assert "Document text (from char 100):" in text
    assert "[0017]" in text and "[0000]" not in text  # window slides
    assert "pdf_offset=200" in text

    # A window reaching the end has no continuation marker.
    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 20000})
    assert "[0199]" in text and "more text remains" not in text

    # An offset past the end reports the document's extracted length.
    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_offset": 5000})
    assert "past the end" in text and "1200" in text


def test_read_page_pdf_page_jumps_to_a_search_hit(org, monkeypatch):
    """pdf_page starts the excerpt at that PDF page (the shape search_pdfs
    hits come in), so the agent can read around a match with a small window."""
    from gamma.pdf_text import extract_text

    c, ids = org
    pages = [f"(page {i}) " + f"p{i}-body " * 10 for i in range(1, 6)]
    monkeypatch.setattr("gamma.pdf_text.iter_page_texts",
                        lambda src, max_pages=400: iter(pages))
    monkeypatch.setattr("gamma.ai_context.extract_text", extract_text)
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")
    scope = _folder("readout")

    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 4, "pdf_chars": 60})
    assert "Document text (from PDF page 4):" in text
    assert "(page 4)" in text and "(page 3)" not in text
    assert "pdf_page=4, pdf_offset=60" in text  # continuation keeps the page anchor

    # Continuing from that page with an offset labels and slices from there.
    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 4, "pdf_offset": 60,
                              "pdf_chars": 20000})
    assert "from PDF page 4, from char 60" in text and "(page 5)" in text
    assert "more text remains" not in text  # pages 4-5 end inside the window

    # A page past the end of the document says so instead of going silent.
    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 40})
    assert "no text at or after PDF page 40" in text


def test_read_window_cap_is_user_tunable(org, monkeypatch):
    """The scope's read_chars (the Settings "Read window" preference) caps
    pdf_chars per call, and the armed spec advertises the effective cap."""
    c, ids = org
    doc = "".join(f"[{i:04d}]" for i in range(200))
    monkeypatch.setattr("gamma.ai_context.extract_text",
                        lambda src, char_limit, empty_page_cap=50, start_page=1: doc[:char_limit + 7])
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")

    scope = {**_folder("readout"), "read_chars": 150}
    text, _ = run_agent_tool("organizer", scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 99999})
    assert "[0020]" in text and "[0030]" not in text  # clamped to ~150 chars
    assert "pdf_offset=150" in text
    # Unset / absurd values fall back to the stock 20000 cap.
    for bad in ({}, {"read_chars": 0}, {"read_chars": "x"}, {"read_chars": 10**9}):
        text, _ = run_agent_tool("organizer", {**_folder("readout"), **bad},
                                 "read_page", {"page_id": ids["a"], "pdf_chars": 99999})
        assert "[0199]" in text  # the whole 1200-char doc fits under 20000

    # The armed tool spec names the effective cap (and a default under it).
    spec = next(t for t in agent_tools("folder", read_chars=50000) if t["name"] == "read_page")
    assert "up to 50000" in spec["description"] and "default 6000" in spec["description"]
    spec = next(t for t in agent_tools("folder", read_chars=1500) if t["name"] == "read_page")
    assert "up to 1500" in spec["description"] and "default 1500" in spec["description"]
    spec = next(t for t in agent_tools("folder") if t["name"] == "read_page")
    assert "up to 20000" in spec["description"]
    assert "{read_cap}" not in spec["description"]  # template never leaks


def test_search_pdfs_scoped_snippets(org):
    import sqlite3 as sq
    from gamma.db import page_now, user_db_path
    from gamma.routers.search import _ensure_schema
    from gamma.textnorm import INDEX_VERSION

    c, ids = org
    doc = "d" * 24  # page a's doc_id
    with sq.connect(user_db_path("organizer", "data.db")) as db:
        _ensure_schema(db)
        db.execute("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)",
                   (doc, 3, "quantum error correction with cat qubits"))
        db.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                   "VALUES (?, ?, 1, ?)", (doc, page_now(), INDEX_VERSION))
        db.commit()
    text, action = run_agent_tool("organizer", _folder("readout"), "search_pdfs",
                                  {"query": "error correction"})
    assert action["kind"] == "search" and "1 hit" in action["summary"]
    assert "p.3" in text and "cat qubits" in text
    assert "not indexed" not in text  # everything in scope is stamped current
    # A folder without PDF papers has nothing to search.
    text, _ = run_agent_tool("organizer", _folder("cooling"), "search_pdfs", {"query": "cat"})
    assert text == "No PDF papers are reachable from this chat."


def test_page_scope_reaches_only_its_paper(org):
    c, ids = org
    scope = {"type": "page", "page_id": ids["a"]}
    text, action = run_agent_tool("organizer", scope, "read_page", {"page_id": ids["a"]})
    assert action["kind"] == "read" and "important note" in text
    # Any other page — even one in the same folder — is out of reach.
    text, _ = run_agent_tool("organizer", scope, "read_page", {"page_id": ids["b"]})
    assert text.startswith("error")
    # Search covers only this paper's PDF (seeded in the FTS test above).
    text, action = run_agent_tool("organizer", scope, "search_pdfs", {"query": "cat qubits"})
    assert "p.3" in text and action["kind"] == "search"


# --- wire formats ------------------------------------------------------------

_CONF = {"base_url": "https://example.test", "api_key": "k", "account_id": ""}
_TURNS = [
    {"role": "user", "content": "tidy up"},
    {"role": "assistant", "content": "listing", "tool_calls": [
        {"id": "c1", "name": "list_pages", "arguments": {}}]},
    {"role": "tool", "call_id": "c1", "content": "Pages…"},
]


def test_anthropic_wire_tools_and_results():
    req = anthropic_request(_CONF, [dict(m) for m in _TURNS], "sys", "m", tools=ALL_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0]["name"] == "list_pages" and "input_schema" in body["tools"][0]
    assert body["messages"][1]["content"] == [
        {"type": "text", "text": "listing"},
        {"type": "tool_use", "id": "c1", "name": "list_pages", "input": {}}]
    assert body["messages"][2] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "c1", "content": "Pages…"}]}


def test_openai_wire_tools_and_results():
    req = openai_request(_CONF, [dict(m) for m in _TURNS], "sys", "m", tools=ALL_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0] == {"type": "function", "function": {
        "name": "list_pages", "description": ALL_TOOLS[0]["description"],
        "parameters": ALL_TOOLS[0]["parameters"]}}
    call = body["messages"][2]["tool_calls"][0]
    assert call["function"]["name"] == "list_pages" and call["id"] == "c1"
    assert body["messages"][3] == {"role": "tool", "tool_call_id": "c1", "content": "Pages…"}


def test_chatgpt_wire_tools_and_results():
    req = chatgpt_request(_CONF, [dict(m) for m in _TURNS], "sys", "m", tools=ALL_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0]["type"] == "function" and body["tools"][0]["name"] == "list_pages"
    kinds = [i["type"] for i in body["input"]]
    assert kinds == ["message", "message", "function_call", "function_call_output"]
    assert body["input"][2]["call_id"] == "c1"
    assert body["input"][3] == {"type": "function_call_output", "call_id": "c1", "output": "Pages…"}


def test_openai_responses_wire_shape():
    req = openai_responses_request(_CONF, [dict(m) for m in _TURNS], "sys", "gpt-5.6-sol",
                                   tools=ALL_TOOLS)
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
    assert wire_protocol(official, entry, ALL_TOOLS) == "openai-responses"
    assert wire_protocol(official, entry, None) == "openai"  # plain chat: completions
    # Custom gateways may not implement /v1/responses — keep chat completions.
    assert wire_protocol(rt("http://localhost:4000"), entry, ALL_TOOLS) == "openai"
    chatgpt = {"providers": {"p": {"protocol": "chatgpt", "base_url": "https://chatgpt.com/backend-api/codex"}}}
    assert wire_protocol(chatgpt, entry, ALL_TOOLS) == "chatgpt"


def test_attachments_ride_on_last_user_turn_not_tool_result():
    req = anthropic_request(_CONF, [dict(m) for m in _TURNS], "sys", "m",
                            pdf_b64s=["QUJD"], tools=ALL_TOOLS)
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
            assert "library agent" in system
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
        "agent_scope": "folder", "folder": "readout", "stream": True,
    })
    assert r.status_code == 200, r.text
    lines = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    actions = [item["action"] for item in lines if "action" in item]
    text = "".join(item.get("delta", "") for item in lines)
    assert len(opened) == 2
    assert actions and actions[0]["kind"] == "rename"
    # The chip carries the raw call so the chat can expand the tool output.
    assert actions[0]["tool"] == "rename_page"
    assert actions[0]["args"]["title"] == "Ada2019 cavity"
    assert actions[0]["result"].startswith("ok")
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
    r = c.post("/api/ai/chat", json={"prompt": "tidy", "agent_scope": "folder",
                                     "folder": "cooling", "stream": True, "tool_rounds": 1})
    assert r.status_code == 200
    text = "".join(
        json.loads(line).get("delta", "")
        for line in r.text.splitlines()
        if line.strip()
    )
    assert len(systems) == 1  # budget of 1: no second round opened
    assert "tool-round limit" in text
    assert '"cooling"' in systems[0]  # same conversation, new folder → new scope


def test_chat_page_scope_arms_read_tools(org, monkeypatch):
    c, ids = org
    import gamma.routers.ai as ai_mod

    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        if "tools" not in seen:
            seen["tools"] = kw.get("tools")
            seen["system"] = system
            return _FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "read_page"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"page_id": ids["a"]})}},
                {"type": "content_block_stop"},
            ])
        return _FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "summary"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={"prompt": "what do my notes say?",
                                     "agent_scope": "page", "page_id": ids["a"], "stream": True})
    assert r.status_code == 200
    assert [t["name"] for t in seen["tools"]] == ["read_page", "search_pdfs"]
    assert f'page_id "{ids["a"]}"' in seen["system"]
    lines = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    reads = [item["action"] for item in lines if "action" in item]
    assert reads and reads[0]["kind"] == "read"


def test_chat_permissions_gate_tools_and_execution(org, monkeypatch):
    c, ids = org
    import gamma.routers.ai as ai_mod

    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        seen["tools"] = kw.get("tools")
        if len(seen.setdefault("rounds", [])) == 0:
            seen["rounds"].append(1)
            # Model tries a rename even though write permission is off.
            return _FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "rename_page"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"page_id": ids["a"], "title": "hacked"})}},
                {"type": "content_block_stop"},
            ])
        seen["blocked"] = messages[-1]["content"]
        return _FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "ok"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    before = _props(c, ids["a"])["content"]
    r = c.post("/api/ai/chat", json={"prompt": "rename stuff", "agent_scope": "folder",
                                     "folder": "readout", "stream": True,
                                     "permissions": {"rename": False, "move": False}})
    assert r.status_code == 200
    assert [t["name"] for t in seen["tools"]] == ["list_pages", "read_page", "search_pdfs"]
    assert seen["blocked"].startswith("error: tool not enabled")
    assert _props(c, ids["a"])["content"] == before  # nothing was renamed

    # Every permission off → plain chat, no tools at all.
    seen.clear()
    r = c.post("/api/ai/chat", json={"prompt": "hi", "agent_scope": "folder", "folder": "readout",
                                     "stream": True,
                                     "permissions": {k: False for k in
                                                     ("list", "read", "search", "rename", "move")}})
    assert r.status_code == 200
    assert seen["tools"] is None


def test_chat_without_agent_scope_gets_no_tools(org, monkeypatch):
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
    # A page scope without a page id is invalid → plain chat, not an error.
    seen.clear()
    r = c.post("/api/ai/chat", json={"prompt": "hello", "agent_scope": "page", "stream": True})
    assert r.status_code == 200
    assert seen["tools"] is None


# --- list_pages filters ------------------------------------------------------

def test_list_pages_filters_and_labels_mode(org):
    c, ids = org

    def page(content, props):
        r = c.post("/api/blocks", json={"parent_id": "root", "content": content, "properties": props})
        assert r.status_code == 200, r.text
        return r.json()["id"]

    jeff1 = page("erasure paper", {"folder": "labtest", "category": "Jeff, Yb"})
    jeff2 = page("tweezer gates", {"folder": "labtest/sub", "category": "jeff"})
    other = page("ldpc paper", {"folder": "labtest", "category": "qec"})
    # Exact label match, case-insensitive; only matching pages come back.
    text, action = run_agent_tool("organizer", _folder("labtest"), "list_pages", {"label": "jeff"})
    assert "2 pages" in action["summary"] and "jeff" in action["summary"]
    assert jeff1 in text and jeff2 in text and other not in text
    # Title substring filter.
    text, _ = run_agent_tool("organizer", _folder("labtest"), "list_pages",
                             {"title_contains": "LDPC"})
    assert other in text and jeff1 not in text
    # Relative subfolder filter resolves inside the scope.
    text, _ = run_agent_tool("organizer", _folder("labtest"), "list_pages", {"folder": "sub"})
    assert jeff2 in text and jeff1 not in text
    # No matches is a clear answer, not an empty-library claim.
    text, _ = run_agent_tool("organizer", _folder("labtest"), "list_pages", {"label": "nope"})
    assert "No pages match" in text
    # Labels mode: the vocabulary with counts, not page lines.
    text, action = run_agent_tool("organizer", _folder("labtest"), "list_pages",
                                  {"list_labels": True})
    assert "labels" in action["summary"]
    assert '- label "Jeff": 1 page' in text and '- label "jeff": 1 page' in text
    assert '- label "qec": 1 page' in text and '- folder "labtest": 2 pages' in text
    assert jeff1 not in text


# --- tool-history replay -----------------------------------------------------

def _payload(history):
    from types import SimpleNamespace
    return SimpleNamespace(history=history, prompt="now do it", selection="")


def test_build_messages_replays_tool_history():
    history = [
        {"role": "user", "text": "rename them"},
        {"role": "ai", "text": "Done.", "actions": [
            {"kind": "list", "tool": "list_pages", "args": {}, "result": "Pages (2): …"},
            {"kind": "rename", "tool": "rename_page",
             "args": {"page_id": "p1", "title": "New"}, "result": "ok — renamed"},
        ]},
    ]
    messages = build_messages(_payload(history), "", with_tools=True)
    roles = [m["role"] for m in messages]
    assert roles == ["user", "assistant", "tool", "tool", "assistant", "user"]
    calls = messages[1]["tool_calls"]
    assert [c["name"] for c in calls] == ["list_pages", "rename_page"]
    assert calls[1]["arguments"] == {"page_id": "p1", "title": "New"}
    # Result turns pair with the synthesized call ids.
    assert messages[2]["call_id"] == calls[0]["id"] and messages[2]["content"] == "Pages (2): …"
    assert messages[4]["content"] == "Done."
    # Plain chats must not replay tool turns (providers reject them untooled).
    plain = build_messages(_payload(history), "", with_tools=False)
    assert [m["role"] for m in plain] == ["user", "assistant", "user"]


def test_build_messages_replay_edge_cases():
    # Tool-only reply (no prose) still leaves its calls; chips saved before
    # tool recording existed (no "tool" field) are skipped entirely.
    history = [
        {"role": "user", "text": "go"},
        {"role": "ai", "text": "", "actions": [
            {"kind": "rename", "tool": "rename_page", "args": {"page_id": "p"}, "result": "ok"}]},
        {"role": "user", "text": "and this old one"},
        {"role": "ai", "text": "old reply", "actions": [{"kind": "list", "summary": "Listed 68"}]},
    ]
    messages = build_messages(_payload(history), "", with_tools=True)
    roles = [m["role"] for m in messages]
    assert roles == ["user", "assistant", "tool", "user", "assistant", "user"]
    assert not messages[4].get("tool_calls")


def test_build_messages_elides_old_results_over_budget():
    big = "x" * (TOOL_REPLAY_BUDGET - 100)
    history = [
        {"role": "user", "text": "a"},
        {"role": "ai", "text": "one", "actions": [
            {"kind": "read", "tool": "read_page", "args": {"page_id": "p1"}, "result": big}]},
        {"role": "user", "text": "b"},
        {"role": "ai", "text": "two", "actions": [
            {"kind": "read", "tool": "read_page", "args": {"page_id": "p2"}, "result": big}]},
    ]
    messages = build_messages(_payload(history), "", with_tools=True)
    tool_turns = [m for m in messages if m["role"] == "tool"]
    assert len(tool_turns) == 2
    assert "elided" in tool_turns[0]["content"]  # older result dropped…
    assert tool_turns[1]["content"] == big       # …newest kept in full


def test_anthropic_folds_user_turn_after_tool_only_reply():
    messages = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "name": "rename_page", "arguments": {"page_id": "p"}}]},
        {"role": "tool", "call_id": "c1", "content": "ok"},
        {"role": "user", "content": "thanks, next"},
    ]
    req = anthropic_request(_CONF, messages, "sys", "m", tools=ALL_TOOLS)
    wire = json.loads(req.data)["messages"]
    assert [m["role"] for m in wire] == ["user", "assistant", "user"]  # roles alternate
    assert wire[2]["content"] == [
        {"type": "tool_result", "tool_use_id": "c1", "content": "ok"},
        {"type": "text", "text": "thanks, next"}]


def test_chat_agent_history_replay_reaches_provider(org, monkeypatch):
    c, _ = org
    import gamma.routers.ai as ai_mod

    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        seen["messages"] = messages
        return _FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "hi"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    history = [
        {"role": "user", "text": "list please"},
        {"role": "ai", "text": "Found 2.", "actions": [
            {"kind": "list", "tool": "list_pages", "args": {}, "result": "Pages (2): …"}]},
    ]
    r = c.post("/api/ai/chat", json={"prompt": "now rename", "history": history,
                                     "agent_scope": "folder", "folder": "readout",
                                     "stream": True})
    assert r.status_code == 200
    replayed = [m for m in seen["messages"] if m.get("tool_calls") or m["role"] == "tool"]
    assert [m["role"] for m in replayed] == ["assistant", "tool"]
    assert replayed[0]["tool_calls"][0]["name"] == "list_pages"
    # The same history in a plain chat replays nothing.
    seen.clear()
    r = c.post("/api/ai/chat", json={"prompt": "hello", "history": history, "stream": True})
    assert r.status_code == 200
    assert all(not m.get("tool_calls") and m["role"] != "tool" for m in seen["messages"])

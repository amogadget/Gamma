"""Pure protocol code: tool definitions, calls and results on each provider
wire (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, the
ChatGPT backend), the SSE parsers' tool-call events, and how a saved chat's
tool history is replayed into the next request."""

import json

from gamma.ai_client import (
    anthropic_request,
    chatgpt_request,
    openai_request,
    openai_responses_request,
    sse_events,
    wire_protocol,
)
from gamma.ai_context import TOOL_REPLAY_BUDGET, build_messages

from ai_fixtures import ALL_TOOLS, CONF, TURNS, payload, sse


def test_anthropic_wire_tools_and_results():
    req = anthropic_request(CONF, [dict(m) for m in TURNS], "sys", "m", tools=ALL_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0]["name"] == "list_pages" and "input_schema" in body["tools"][0]
    assert body["messages"][1]["content"] == [
        {"type": "text", "text": "listing"},
        {"type": "tool_use", "id": "c1", "name": "list_pages", "input": {}}]
    assert body["messages"][2] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "c1", "content": "Pages…"}]}


def test_openai_wire_tools_and_results():
    req = openai_request(CONF, [dict(m) for m in TURNS], "sys", "m", tools=ALL_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0] == {"type": "function", "function": {
        "name": "list_pages", "description": ALL_TOOLS[0]["description"],
        "parameters": ALL_TOOLS[0]["parameters"]}}
    call = body["messages"][2]["tool_calls"][0]
    assert call["function"]["name"] == "list_pages" and call["id"] == "c1"
    assert body["messages"][3] == {"role": "tool", "tool_call_id": "c1", "content": "Pages…"}


def test_chatgpt_wire_tools_and_results():
    req = chatgpt_request(CONF, [dict(m) for m in TURNS], "sys", "m", tools=ALL_TOOLS)
    body = json.loads(req.data)
    assert body["tools"][0]["type"] == "function" and body["tools"][0]["name"] == "list_pages"
    kinds = [i["type"] for i in body["input"]]
    assert kinds == ["message", "message", "function_call", "function_call_output"]
    assert body["input"][2]["call_id"] == "c1"
    assert body["input"][3] == {"type": "function_call_output", "call_id": "c1", "output": "Pages…"}


def test_openai_responses_wire_shape():
    req = openai_responses_request(CONF, [dict(m) for m in TURNS], "sys", "gpt-5.6-sol",
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
    req = anthropic_request(CONF, [dict(m) for m in TURNS], "sys", "m",
                            pdf_b64s=["QUJD"], tools=ALL_TOOLS)
    body = json.loads(req.data)
    assert body["messages"][0]["content"][0]["type"] == "document"
    assert body["messages"][2]["content"][0]["type"] == "tool_result"


def test_sse_events_anthropic_tool_use():
    stream = sse(
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok "}},
        {"type": "content_block_start", "content_block": {"type": "tool_use", "id": "t1", "name": "rename_page"}},
        {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": '{"page_id": "p1",'}},
        {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": ' "title": "T"}'}},
        {"type": "content_block_stop"},
    )
    events = list(sse_events(stream, "anthropic"))
    # Argument deltas stream as they arrive (the raw JSON so far) so the UI
    # can preview a long argument; the parsed call follows at block stop.
    assert events == [("text", "ok "),
                      ("tool_delta", {"id": "t1", "name": "rename_page", "json": '{"page_id": "p1",'}),
                      ("tool_delta", {"id": "t1", "name": "rename_page",
                                      "json": '{"page_id": "p1", "title": "T"}'}),
                      ("tool", {"id": "t1", "name": "rename_page",
                                "arguments": {"page_id": "p1", "title": "T"}})]


def test_partial_tool_args_preview():
    from gamma.ai_client import partial_json_object, partial_json_strings
    # A streaming edit_block call: the id is complete, the content half-written.
    raw = '{"block_id": "b1", "content": "## Summary\\nThe paper sho'
    assert partial_json_object(raw) == {"block_id": "b1", "content": "## Summary\nThe paper sho"}
    # A trailing lone backslash / half escape is dropped, not an error.
    assert partial_json_object('{"a": "x\\')["a"] == "x"
    assert partial_json_object('{"a": "x\\u00')["a"] == "x"
    assert partial_json_object('{"a": "x\\\\')["a"] == "x\\"
    # Non-string values are skipped, later keys still read.
    assert partial_json_object('{"n": 3, "after_id": "z", "content": "hi') == {"after_id": "z", "content": "hi"}
    assert partial_json_object("") == {}
    assert partial_json_object('{"content": "ab"}') == {"content": "ab"}
    # Translation replies: a JSON array of strings, possibly fenced.
    assert partial_json_strings('```json\n["第一段", "第二') == ["第一段", "第二"]
    assert partial_json_strings('["a", "b"]') == ["a", "b"]
    assert partial_json_strings('["a", null, "b"]') == ["a"]
    assert partial_json_strings("Sure: [") == []


def test_sse_events_openai_tool_calls_accumulate():
    stream = sse(
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c9", "function": {"name": "move_page", "arguments": '{"page_'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": 'id": "p2", "folder": "x"}'}}]}, "finish_reason": "tool_calls"}]},
    )
    events = list(sse_events(stream, "openai"))
    assert events == [("tool_delta", {"id": "c9", "name": "move_page", "json": '{"page_'}),
                      ("tool_delta", {"id": "c9", "name": "move_page",
                                      "json": '{"page_id": "p2", "folder": "x"}'}),
                      ("tool", {"id": "c9", "name": "move_page",
                                "arguments": {"page_id": "p2", "folder": "x"}})]


def test_sse_events_responses_argument_deltas():
    stream = sse(
        {"type": "response.output_item.added", "item": {
            "type": "function_call", "id": "fc_1", "call_id": "f3", "name": "edit_block"}},
        {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": '{"block_id": "b",'},
        {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": ' "content": "x"}'},
        {"type": "response.output_item.done", "item": {
            "type": "function_call", "id": "fc_1", "call_id": "f3", "name": "edit_block",
            "arguments": '{"block_id": "b", "content": "x"}'}},
        {"type": "response.completed", "response": {"status": "completed"}},
    )
    events = list(sse_events(stream, "chatgpt"))
    assert events == [("tool_delta", {"id": "f3", "name": "edit_block", "json": '{"block_id": "b",'}),
                      ("tool_delta", {"id": "f3", "name": "edit_block",
                                      "json": '{"block_id": "b", "content": "x"}'}),
                      ("tool", {"id": "f3", "name": "edit_block",
                                "arguments": {"block_id": "b", "content": "x"}})]


def test_sse_events_chatgpt_function_call_item():
    stream = sse(
        {"type": "response.output_text.delta", "delta": "hi"},
        {"type": "response.output_item.done", "item": {
            "type": "function_call", "call_id": "f1", "name": "list_pages", "arguments": "{}"}},
        {"type": "response.completed", "response": {"status": "completed"}},
    )
    events = list(sse_events(stream, "chatgpt"))
    assert events == [("text", "hi"), ("tool", {"id": "f1", "name": "list_pages", "arguments": {}})]


def test_sse_events_openai_responses_dialect():
    stream = sse(
        {"type": "response.output_text.delta", "delta": "hi"},
        {"type": "response.output_item.done", "item": {
            "type": "function_call", "call_id": "f2", "name": "move_page",
            "arguments": '{"page_id": "p", "folder": "x"}'}},
        {"type": "response.completed", "response": {"status": "completed"}},
    )
    events = list(sse_events(stream, "openai-responses"))
    assert events == [("text", "hi"), ("tool", {"id": "f2", "name": "move_page",
                                                "arguments": {"page_id": "p", "folder": "x"}})]


def test_build_messages_replays_tool_history():
    history = [
        {"role": "user", "text": "rename them"},
        {"role": "ai", "text": "Done.", "actions": [
            {"kind": "list", "tool": "list_pages", "args": {}, "result": "Pages (2): …"},
            {"kind": "rename", "tool": "rename_page",
             "args": {"page_id": "p1", "title": "New"}, "result": "ok — renamed"},
        ]},
    ]
    messages = build_messages(payload(history), "", with_tools=True)
    roles = [m["role"] for m in messages]
    assert roles == ["user", "assistant", "tool", "tool", "assistant", "user"]
    calls = messages[1]["tool_calls"]
    assert [c["name"] for c in calls] == ["list_pages", "rename_page"]
    assert calls[1]["arguments"] == {"page_id": "p1", "title": "New"}
    # Result turns pair with the synthesized call ids.
    # Replayed results are flagged as snapshots from an earlier turn.
    assert messages[2]["call_id"] == calls[0]["id"]
    assert messages[2]["content"].endswith("\nPages (2): …")
    assert messages[2]["content"].startswith("[result from an earlier turn")
    assert messages[4]["content"] == "Done."
    # Plain chats must not replay tool turns (providers reject them untooled).
    plain = build_messages(payload(history), "", with_tools=False)
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
    messages = build_messages(payload(history), "", with_tools=True)
    roles = [m["role"] for m in messages]
    assert roles == ["user", "assistant", "tool", "user", "assistant", "user"]
    assert not messages[4].get("tool_calls")


def test_build_messages_replays_renamed_tools_under_current_name():
    history = [
        {"role": "user", "text": "where is X"},
        {"role": "ai", "text": "p.3", "actions": [
            {"kind": "search", "tool": "search_pdfs", "args": {"query": "x"}, "result": "hit"}]},
    ]
    messages = build_messages(payload(history), "", with_tools=True)
    assert messages[1]["tool_calls"][0]["name"] == "search_library"


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
    messages = build_messages(payload(history), "", with_tools=True)
    tool_turns = [m for m in messages if m["role"] == "tool"]
    assert len(tool_turns) == 2
    assert "elided" in tool_turns[0]["content"]  # older result dropped…
    assert tool_turns[1]["content"].endswith(big)  # …newest kept in full (after the snapshot note)


def test_anthropic_folds_user_turn_after_tool_only_reply():
    messages = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "name": "rename_page", "arguments": {"page_id": "p"}}]},
        {"role": "tool", "call_id": "c1", "content": "ok"},
        {"role": "user", "content": "thanks, next"},
    ]
    req = anthropic_request(CONF, messages, "sys", "m", tools=ALL_TOOLS)
    wire = json.loads(req.data)["messages"]
    assert [m["role"] for m in wire] == ["user", "assistant", "user"]  # roles alternate
    assert wire[2]["content"] == [
        {"type": "tool_result", "tool_use_id": "c1", "content": "ok"},
        {"type": "text", "text": "thanks, next"}]


PICTURE_TURNS = [
    {"role": "user", "content": "what does page 3 show?"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "c1", "name": "view_pdf_page", "arguments": {"page_id": "p", "pdf_page": 3}},
        {"id": "c2", "name": "read_page", "arguments": {"page_id": "p"}}]},
    {"role": "tool", "call_id": "c1", "content": "PDF page 3 attached", "images": [("image/png", "QUJD")]},
    {"role": "tool", "call_id": "c2", "content": "Title…"},
]


def test_tool_result_pictures_on_each_wire():
    """A tool result's `images` reach the model on every wire: inside the
    Anthropic tool_result, and — the OpenAI wires take only text there — as
    one user turn after the round's results, in call order."""
    body = json.loads(anthropic_request(CONF, [dict(m) for m in PICTURE_TURNS], "sys", "m",
                                        tools=ALL_TOOLS).data)
    results = body["messages"][2]["content"]
    assert [r["type"] for r in results] == ["tool_result", "tool_result"]
    assert results[0]["content"] == [
        {"type": "text", "text": "PDF page 3 attached"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}}]
    assert results[1]["content"] == "Title…"

    body = json.loads(openai_request(CONF, [dict(m) for m in PICTURE_TURNS], "sys", "m",
                                     tools=ALL_TOOLS).data)
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["system", "user", "assistant", "tool", "tool", "user"]
    assert body["messages"][3]["content"] == "PDF page 3 attached"
    picture = body["messages"][5]["content"]
    assert picture[0]["type"] == "text" and picture[1] == {
        "type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}

    for build in (chatgpt_request, openai_responses_request):
        body = json.loads(build(CONF, [dict(m) for m in PICTURE_TURNS], "sys", "m",
                                tools=ALL_TOOLS).data)
        kinds = [i["type"] for i in body["input"]]
        assert kinds == ["message", "function_call", "function_call", "function_call_output",
                         "function_call_output", "message"], build.__name__
        assert body["input"][3]["output"] == "PDF page 3 attached"
        assert body["input"][5]["role"] == "user"
        assert body["input"][5]["content"][1] == {
            "type": "input_image", "image_url": "data:image/png;base64,QUJD"}


def test_user_attachments_never_ride_on_a_tool_picture_turn():
    """The user's own attachments belong to their prompt, not to the picture
    turn the OpenAI wires append after a round's tool results."""
    body = json.loads(chatgpt_request(CONF, [dict(m) for m in PICTURE_TURNS], "sys", "m",
                                      pdf_b64s=["QUJD"], tools=ALL_TOOLS).data)
    assert body["input"][0]["content"][0]["type"] == "input_file"
    assert [c["type"] for c in body["input"][5]["content"]] == ["input_text", "input_image"]
    body = json.loads(openai_request(CONF, [dict(m) for m in PICTURE_TURNS], "sys", "m",
                                     pdf_b64s=["QUJD"], tools=ALL_TOOLS).data)
    assert body["messages"][1]["content"][0]["type"] == "file"
    assert [c["type"] for c in body["messages"][5]["content"]] == ["text", "image_url"]

"""Attached library pages enter both prompt context and the read-tool scope."""
import json

import pytest

from ai_fixtures import FakeResp, ai_provider, org, props  # noqa: F401
from gamma.ai_tools import run_agent_tool


@pytest.mark.parametrize("scope_type", ["page", "folder"])
def test_references_expand_reads_but_not_writes(org, scope_type):
    c, ids = org
    child = c.post("/api/blocks", json={"parent_id": ids["note"], "content": "mentionneedle"}).json()["id"]
    scope = {"type": scope_type, "page_id": ids["b"], "folder": "readout",
             "context_pages": [ids["note"], "missing"]}
    for tool, args in [("read_page", {"page_id": ids["note"]}),
                       ("read_block", {"block_id": child}),
                       ("search_library", {"query": "mentionneedle"})]:
        text, action = run_agent_tool(ids["ws"], scope, tool, args)
        assert not action.get("error"), text
        assert "mentionneedle" in text
    for tool, args in [("edit_block", {"block_id": child, "content": "changed"}),
                       ("create_block", {"parent_id": ids["note"], "content": "changed"}),
                       ("move_block", {"block_id": child, "parent_id": ids["b"]})]:
        text, action = run_agent_tool(ids["ws"], scope, tool, args)
        assert action.get("error"), text
    assert props(c, child)["content"] == "mentionneedle"
    # Removing the attachment removes access, too.
    text, action = run_agent_tool(ids["ws"], {**scope, "context_pages": []}, "read_page", {"page_id": ids["note"]})
    assert action.get("error"), text


def test_chat_resolves_reference_context_and_tools(org, ai_provider, monkeypatch):
    c, ids = org
    import gamma.routers.ai as ai
    calls = []

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        calls.append(messages)
        if len(calls) == 1:
            content = "\n".join(m["content"] for m in messages)
            assert f"Gamma page ID: {ids['note']}" in content
            assert f"Gamma page ID: {ids['b']}" in content
            assert ids["note"] in system and "read-only" in system
            return FakeResp([
                {"type": "content_block_start", "content_block": {"type": "tool_use", "id": "r1", "name": "read_page"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": json.dumps({"page_id": ids["note"]})}},
                {"type": "content_block_stop"},
            ])
        assert messages[-1]["role"] == "tool"
        assert "loose note" in messages[-1]["content"]
        return FakeResp([{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Read the reference."}}])

    monkeypatch.setattr(ai, "_open_ai", fake_open)
    response = c.post("/api/ai/chat", json={"prompt": "Compare @loose note", "agent_scope": "page",
        "page_id": ids["b"], "pages": [ids["b"], ids["note"]], "stream": True})
    assert response.status_code == 200, response.text
    assert "Read the reference." in response.text
    assert len(calls) == 2


def test_context_deduplicates_and_rejects_non_pages(org):
    from gamma.ai_context import gather_inputs
    from gamma.routers.ai import AIChatRequest
    c, ids = org
    child = c.post("/api/blocks", json={"parent_id": ids["note"], "content": "not a page"}).json()["id"]
    payload = AIChatRequest(prompt="read", pages=[ids["note"], ids["note"], child, "missing"])
    _, context, coverage = gather_inputs(ids["ws"], payload, False)
    assert context.count(f"Gamma page ID: {ids['note']}") == 1
    assert f"Gamma page ID: {child}" not in context
    assert len(coverage) == 1

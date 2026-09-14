"""The note-block tools — read_block, edit_block, create_block, move_block —
on a small note tree, and the chat features built on them: the streamed
edit preview and the cursor / attached-block focus section."""

import json
import re

from gamma.ai_tools import agent_system, run_agent_tool

from ai_fixtures import FakeResp, children, folder, notes, org, props  # noqa: F401  (fixtures)


def test_read_block_outline_with_ids(notes):
    c, ids = notes
    scope = folder("sandbox")
    text, action = run_agent_tool(ids["ws"], scope, "read_block", {"block_id": ids["page"]})
    assert action["kind"] == "read" and action["page_id"] == ids["page"]
    for key in ("top", "child", "other", "hl"):
        assert f"[{ids[key]}]" in text
    assert '(highlight: "measured T1 of 300 µs")' in text
    assert text.index(ids["top"]) < text.index(ids["child"])  # nesting in order
    assert "edit_block" in text  # the footer teaches the editing tools
    # A nested block id reads that subtree only, the block's own text in full.
    text, _ = run_agent_tool(ids["ws"], scope, "read_block", {"block_id": ids["top"]})
    assert "top-level idea" in text and ids["child"] in text
    assert ids["other"] not in text
    # Scope rules match the page tools.
    text, _ = run_agent_tool(ids["ws"], folder("readout"), "read_block",
                             {"block_id": ids["top"]})
    assert text.startswith("error")
    text, _ = run_agent_tool(ids["ws"], scope, "read_block", {"block_id": "nope"})
    assert text.startswith("error: no such block")


def test_edit_block(notes):
    c, ids = notes
    scope = folder("sandbox")
    text, action = run_agent_tool(ids["ws"], scope, "edit_block",
                                  {"block_id": ids["child"], "content": "sharper detail"})
    assert text.startswith("ok"), text
    assert action["kind"] == "edit" and action["page_id"] == ids["page"]
    assert props(c, ids["child"])["content"] == "sharper detail"
    # Page roots are refused — titles go through rename_page.
    text, _ = run_agent_tool(ids["ws"], scope, "edit_block",
                             {"block_id": ids["page"], "content": "x"})
    assert "rename_page" in text
    # No-op edit mutates nothing but still shows as a non-error chip.
    text, action = run_agent_tool(ids["ws"], scope, "edit_block",
                                  {"block_id": ids["child"], "content": "sharper detail"})
    assert text.startswith("ok") and not action.get("error")


def test_create_block_placement(notes):
    c, ids = notes
    scope = folder("sandbox")
    text, action = run_agent_tool(ids["ws"], scope, "create_block",
                                  {"parent_id": ids["page"], "content": "appended note"})
    assert action["kind"] == "create" and action["page_id"] == ids["page"]
    new_last = re.search(r"\[([^\]]+)\]", text).group(1)
    assert children(c, ids["page"])[-1] == new_last
    # after_id inserts between siblings.
    text, _ = run_agent_tool(ids["ws"], scope, "create_block",
                             {"parent_id": ids["page"], "content": "wedged in",
                              "after_id": ids["top"]})
    wedged = re.search(r"\[([^\]]+)\]", text).group(1)
    order = children(c, ids["page"])
    assert order.index(wedged) == order.index(ids["top"]) + 1
    # A bad anchor is refused, not guessed.
    text, _ = run_agent_tool(ids["ws"], scope, "create_block",
                             {"parent_id": ids["page"], "content": "x",
                              "after_id": ids["child"]})
    assert "after_id" in text and text.startswith("error")


def test_move_block_rules(notes):
    c, ids = notes
    scope = folder("sandbox")
    # Reparent under a sibling.
    text, action = run_agent_tool(ids["ws"], scope, "move_block",
                                  {"block_id": ids["other"], "parent_id": ids["top"]})
    assert text.startswith("ok"), text
    assert action["kind"] == "move" and action["page_id"] == ids["page"]
    assert children(c, ids["top"])[-1] == ids["other"]
    # Into its own subtree → refused.
    text, _ = run_agent_tool(ids["ws"], scope, "move_block",
                             {"block_id": ids["top"], "parent_id": ids["other"]})
    assert "into itself" in text
    # Page roots don't move this way.
    text, _ = run_agent_tool(ids["ws"], scope, "move_block",
                             {"block_id": ids["page"], "parent_id": ids["top"]})
    assert "move_page" in text
    # Highlights stay on their page; plain blocks may cross pages in scope.
    r = c.post("/api/blocks", json={"parent_id": "root", "content": "second page",
                                    "properties": {"folder": "sandbox"}})
    page2 = r.json()["id"]
    text, _ = run_agent_tool(ids["ws"], scope, "move_block",
                             {"block_id": ids["hl"], "parent_id": page2})
    assert "anchored" in text
    text, action = run_agent_tool(ids["ws"], scope, "move_block",
                                  {"block_id": ids["child"], "parent_id": page2})
    assert text.startswith("ok")
    assert action["page_id"] == page2 and action["src_page_id"] == ids["page"]
    assert children(c, page2) == [ids["child"]]
    # A page outside the scope can't receive blocks.
    text, _ = run_agent_tool(ids["ws"], folder("sandbox"), "move_block",
                             {"block_id": ids["child"], "parent_id": ids["a"]})
    assert text.startswith("error")


def test_chat_agent_streams_edit_preview(notes, monkeypatch):
    """A streamed edit_block call is previewed as "progress" lines — the block
    it targets plus the markdown written so far — before its action lands
    (the notes panel types the text into the block live); the action names
    the block it changed. Other tools' arguments are never previewed."""
    c, ids = notes
    import gamma.routers.ai as ai_mod
    assert c.post("/api/ai/providers",
                  json={"protocol": "anthropic", "api_key": "sk-test-key-123",
                        "models": "claude-solo"}).status_code == 200

    opened = []

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        opened.append(1)
        if len(opened) == 1:
            return FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "read_block"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"block_id": ids["page"]})}},
                {"type": "content_block_stop"},
            ])
        if len(opened) == 2:
            return FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t2", "name": "edit_block"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": '{"block_id": "' + ids["top"] + '", "content": "## Idea\\nfirst'}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": ' half"}'}},
                {"type": "content_block_stop"},
            ])
        return FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "Done."}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={
        "prompt": "rewrite the first idea", "agent_scope": "page",
        "page_id": ids["page"], "stream": True,
    })
    assert r.status_code == 200, r.text
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    progress = [l["progress"] for l in lines if "progress" in l]
    actions = [l["action"] for l in lines if "action" in l]
    assert len(opened) == 3
    # The read is a chip naming the page (no preview — only editors stream).
    assert actions[0]["tool"] == "read_block" and actions[0]["block_id"] == ids["page"]
    # The edit previewed twice — once per argument delta, the text so far —
    # and the preview comes BEFORE the action.
    assert [p["content"] for p in progress] == ["## Idea\nfirst", "## Idea\nfirst half"]
    assert all(p["tool"] == "edit_block" and p["block_id"] == ids["top"] and p["id"] == "t2"
               for p in progress)
    order = [next(k for k in ("progress", "action", "delta") if k in l) for l in lines
             if any(k in l for k in ("progress", "action", "delta"))]
    assert order.index("progress") < order.index("action", 1)
    assert actions[1]["kind"] == "edit" and actions[1]["block_id"] == ids["top"]
    assert props(c, ids["top"])["content"] == "## Idea\nfirst half"
    # Non-stream callers get text + actions only.
    opened.clear()
    r = c.post("/api/ai/chat", json={
        "prompt": "again", "agent_scope": "page", "page_id": ids["page"]})
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"response", "actions", "context"}
    assert [a["tool"] for a in r.json()["actions"]] == ["read_block", "edit_block"]
    assert "progress" not in r.text


def test_notes_focus_section_and_agent_prompt(notes):
    """The cursor block and attached block chips reach the model as an
    id-labelled outline (sub-blocks indented), scoped to the context page —
    page ids and foreign ids are dropped — and the agent prompt names them."""
    from types import SimpleNamespace
    from gamma.ai_context import notes_focus_section
    c, ids = notes
    # Own blocks: earlier tests move/edit the shared fixture ones.
    top = c.post("/api/blocks", json={"parent_id": ids["page"], "content": "focus idea"}).json()["id"]
    child = c.post("/api/blocks", json={"parent_id": top, "content": "focus detail"}).json()["id"]
    other = c.post("/api/blocks", json={"parent_id": ids["page"], "content": "attached thread"}).json()["id"]
    payload = SimpleNamespace(focus_block_id=top, page_id=ids["page"], pages=[],
                              context_blocks=[other, ids["page"], "nope", ids["hl"]])
    section = notes_focus_section(ids["ws"], payload)
    assert "cursor is on this note block" in section
    assert f"- [{top}] focus idea" in section
    assert f"  - [{child}] focus detail" in section   # sub-block, indented
    assert "attached to this message" in section
    assert f"[{other}] attached thread" in section
    assert f'[{ids["hl"]}] (highlight: "measured T1 of 300' in section
    assert f'[{ids["page"]}]' not in section and "nope" not in section
    # Nothing to point at → no section; a chip from a page outside the
    # context is dropped (the section is scoped to the request's pages).
    assert notes_focus_section(ids["ws"], SimpleNamespace(
        focus_block_id="", page_id=ids["page"], pages=[], context_blocks=[])) == ""
    assert notes_focus_section(ids["ws"], SimpleNamespace(
        focus_block_id="", page_id=ids["a"], pages=[], context_blocks=[other])) == ""
    text = agent_system({"type": "page", "page_id": ids["page"], "focus_block_id": top,
                         "context_blocks": [other, ids["page"]]})
    assert f'cursor is on note block "{top}"' in text
    assert f'"{other}"' in text and f'"{ids["page"]}".' not in text


def test_chat_carries_notes_focus(notes, monkeypatch):
    c, ids = notes
    import gamma.routers.ai as ai_mod
    assert c.post("/api/ai/providers",
                  json={"protocol": "anthropic", "api_key": "sk-test-key-123",
                        "models": "claude-solo"}).status_code == 200
    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        seen["messages"], seen["system"] = messages, system
        return FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "ok"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    top = c.post("/api/blocks", json={"parent_id": ids["page"], "content": "cursor block"}).json()["id"]
    other = c.post("/api/blocks", json={"parent_id": ids["page"], "content": "chip block"}).json()["id"]
    r = c.post("/api/ai/chat", json={
        "prompt": "expand this", "agent_scope": "page", "page_id": ids["page"],
        "focus_block_id": top, "context_blocks": [other],
        "note_passages": ["a selected sentence"]})
    assert r.status_code == 200, r.text
    user_turn = seen["messages"][-1]["content"]
    assert f"- [{top}] cursor block" in user_turn and f"[{other}] chip block" in user_turn
    assert "selected the following text in their own notes" in user_turn
    assert "a selected sentence" in user_turn
    assert f'cursor is on note block "{top}"' in seen["system"]

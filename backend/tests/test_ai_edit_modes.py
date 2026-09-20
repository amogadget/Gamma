"""edit_block modes: replace (default), append, prepend — the addition is
joined on its own line, existing text untouched, and the action says which."""

import pytest
from conftest import login, make_user, workspace_of

from gamma.ai_tools import join_block_text, run_agent_tool


def test_join_block_text_rules():
    assert join_block_text("first", "second", "append") == "first\nsecond"
    assert join_block_text("first", "second", "prepend") == "second\nfirst"
    assert join_block_text("", "only", "append") == "only"
    # Paragraph-level constructs (or multi-line text) get a blank line.
    assert join_block_text("intro", "- a point", "append") == "intro\n\n- a point"
    assert join_block_text("- a\n- b", "- c", "append") == "- a\n- b\n\n- c"
    assert join_block_text("text", "## Heading", "prepend") == "## Heading\n\ntext"
    assert join_block_text("text\n\n", "\nmore\n", "append") == "text\nmore"
    assert join_block_text("$$x$$", "y", "append") == "$$x$$\n\ny"


USER = "modes_user"


@pytest.fixture(scope="module")
def page(client):
    """A non-guest user (the tools take a workspace id) with one page."""
    make_user(USER, "pw")
    c = login(USER, "pw")
    r = c.post("/api/blocks", json={"parent_id": "root", "content": "modes page",
                                    "properties": {"folder": "modes"}})
    assert r.status_code == 200, r.text
    return c, r.json()["id"]


def _content(c, block_id):
    r = c.get(f"/api/blocks/{block_id}")
    assert r.status_code == 200
    return r.json()["content"]


def test_edit_block_append_prepend_replace(page):
    c, page_id = page
    scope = {"type": "page", "page_id": page_id}
    block = c.post("/api/blocks", json={"parent_id": page_id, "content": "Key result: T1 = 300 us."}).json()["id"]
    text, action = run_agent_tool(workspace_of(USER), scope, "edit_block",
                                  {"block_id": block, "mode": "append", "content": "Measured at 20 mK."})
    assert text.startswith("ok") and "(append)" in text, text
    assert action["kind"] == "edit" and action["mode"] == "append"
    assert action["summary"].startswith("Appended to a note")
    assert _content(c, block) == "Key result: T1 = 300 us.\nMeasured at 20 mK."
    text, action = run_agent_tool(workspace_of(USER), scope, "edit_block",
                                  {"block_id": block, "mode": "prepend", "content": "## Readout"})
    assert text.startswith("ok"), text
    assert action["summary"].startswith("Prepended to a note")
    assert _content(c, block) == "## Readout\n\nKey result: T1 = 300 us.\nMeasured at 20 mK."
    # Default stays replace; the action carries the mode either way.
    text, action = run_agent_tool(workspace_of(USER), scope, "edit_block",
                                  {"block_id": block, "content": "fresh text"})
    assert text == f"ok — block [{block}] updated"
    assert action["mode"] == "replace" and action["summary"].startswith("Edited a note")
    assert _content(c, block) == "fresh text"
    # Guards: an unknown mode and an empty addition are refused, untouched.
    text, _ = run_agent_tool(workspace_of(USER), scope, "edit_block",
                             {"block_id": block, "mode": "insert", "content": "x"})
    assert text.startswith("error: mode must be one of")
    text, _ = run_agent_tool(workspace_of(USER), scope, "edit_block",
                             {"block_id": block, "mode": "append", "content": "  "})
    assert text.startswith("error: nothing to add")
    assert _content(c, block) == "fresh text"
    # The armed spec offers the mode with its choices.
    from gamma.ai_tools import agent_tools
    spec = next(t for t in agent_tools("page", {}) if t["name"] == "edit_block")
    assert spec["parameters"]["properties"]["mode"]["enum"] == ["replace", "append", "prepend", "patch"]
    assert list(spec["parameters"]["properties"]) == ["block_id", "mode", "find", "content"]


def test_patch_block_text_rules():
    from gamma.ai_tools import patch_block_text
    assert patch_block_text("a b c", "b", "B") == ("a B c", None)
    assert patch_block_text("a b c", "b ", "") == ("a c", None)          # cut
    # Whitespace-relaxed fallback: a wrapped quote still hits once.
    assert patch_block_text("one two\nthree", "two three", "2 3") == ("one 2 3", None)
    text, err = patch_block_text("a b a", "a", "x")
    assert text is None and err.startswith("error: `find` matches 2 places")
    text, err = patch_block_text("a b c", "zzz", "x")
    assert text is None and err.startswith("error: `find` text not found")
    text, err = patch_block_text("a b c", "", "x")
    assert text is None and err.startswith("error: patch needs `find`")


def test_edit_block_patch_cuts_and_replaces_a_passage(page):
    c, page_id = page
    scope = {"type": "page", "page_id": page_id}
    body = "Setup: 20 mK.\n\nResult: T1 = 300 us, measured twice.\n\nOutlook: retry at 10 mK."
    block = c.post("/api/blocks", json={"parent_id": page_id, "content": body}).json()["id"]
    # Replace one passage; everything around it is untouched.
    text, action = run_agent_tool(workspace_of(USER), scope, "edit_block",
                                  {"block_id": block, "mode": "patch",
                                   "find": "T1 = 300 us", "content": "T1 = 310 us"})
    assert text.startswith("ok") and "(patch)" in text, text
    assert action["mode"] == "patch" and action["summary"].startswith("Edited part of a note")
    assert _content(c, block) == body.replace("300", "310")
    # An empty content cuts the passage.
    text, _ = run_agent_tool(workspace_of(USER), scope, "edit_block",
                             {"block_id": block, "mode": "patch",
                              "find": "\n\nOutlook: retry at 10 mK.", "content": ""})
    assert text.startswith("ok"), text
    assert _content(c, block) == "Setup: 20 mK.\n\nResult: T1 = 310 us, measured twice."
    # Guards leave the block alone: missing find, ambiguous find, no match.
    text, _ = run_agent_tool(workspace_of(USER), scope, "edit_block",
                             {"block_id": block, "mode": "patch", "content": "x"})
    assert text.startswith("error: patch needs `find`")
    text, _ = run_agent_tool(workspace_of(USER), scope, "edit_block",
                             {"block_id": block, "mode": "patch", "find": ": ", "content": " - "})
    assert text.startswith("error: `find` matches 2 places")
    text, _ = run_agent_tool(workspace_of(USER), scope, "edit_block",
                             {"block_id": block, "mode": "patch", "find": "nowhere", "content": ""})
    assert text.startswith("error: `find` text not found")
    assert _content(c, block) == "Setup: 20 mK.\n\nResult: T1 = 310 us, measured twice."
    from gamma.ai_tools import agent_tools
    spec = next(t for t in agent_tools("page", {}) if t["name"] == "edit_block")
    assert spec["parameters"]["properties"]["mode"]["enum"] == ["replace", "append", "prepend", "patch"]
    assert "find" in spec["parameters"]["properties"]

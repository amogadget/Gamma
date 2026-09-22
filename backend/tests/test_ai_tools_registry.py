"""The agent's tool registry: which tools each scope offers, how the
permission map prunes them, and what the system prompt tells the model."""

from gamma.ai_tools import agent_system, agent_tools

from ai_fixtures import ALL_PERMS, ALL_TOOLS, folder


def test_registry_scopes_and_permissions():
    assert [t["name"] for t in agent_tools("folder")] == [
        "list_pages", "read_page", "read_block", "view_pdf_page", "search_library", "search_papers",
        "fetch_paper", "rename_page", "move_page", "edit_block", "create_block", "move_block"]
    # Paper chats never rename/move pages; the note-block tools exist there.
    assert [t["name"] for t in agent_tools("page")] == [
        "read_page", "read_block", "view_pdf_page", "search_library", "search_papers", "fetch_paper",
        "edit_block", "create_block", "move_block"]
    assert agent_tools("") == []  # plain chat
    assert [t["name"] for t in agent_tools(
        "folder", {"rename": False, "move": False, "block_edit": False})] == [
        "list_pages", "read_page", "read_block", "view_pdf_page", "search_library", "search_papers", "fetch_paper"]
    names = [t["name"] for t in agent_tools("folder", {"search": False})]
    assert "search_library" not in names and "read_page" in names
    # One permission gates all three note-editing tools.
    names = [t["name"] for t in agent_tools("page", {"block_edit": False})]
    assert names == ["read_page", "read_block", "view_pdf_page", "search_library", "search_papers", "fetch_paper"]
    # The two web tools have their own permissions.
    names = [t["name"] for t in agent_tools("page", {"web_search": False, "web_read": False})]
    assert "search_papers" not in names and "fetch_paper" not in names and "read_page" in names
    assert agent_tools("folder", {k: False for k in ALL_PERMS}) == []
    assert agent_tools("folder", None) == ALL_TOOLS  # missing map = everything on


def test_agent_system_mentions_scope_and_armed_tools():
    text = agent_system(folder("readout"))
    assert '"readout"' in text and "rename_page" in text
    page_text = agent_system({"type": "page", "page_id": "p1"},
                             {"search": False, "block_edit": False})
    assert 'page_id "p1"' in page_text
    assert "read_page" in page_text and "search_library" not in page_text
    assert "suggest them" in page_text  # no write tools armed
    # With note editing armed, the editing guidance replaces the read-only line.
    edit_text = agent_system({"type": "page", "page_id": "p1"})
    assert "Note editing" in edit_text and "suggest them" not in edit_text
    # The base role prompt is user-replaceable; the mechanical lines stay.
    custom = agent_system(folder(""), None, "Be terse.")
    assert custom.startswith("Be terse.") and "Available tools" in custom


def test_block_tools_gated_by_permissions():
    armed = {t["name"] for t in agent_tools("page", {"block_read": False, "block_edit": False, "view": False,
                                                        "web_search": False, "web_read": False})}
    assert armed == {"read_page", "search_library"}


def test_agent_system_tells_the_model_how_to_link_pages():
    # The chat renders /?page=<id> links as open-in-place, so the prompt
    # asks for that form wherever a reading tool hands the model page ids.
    text = agent_system(folder(""))
    assert "/?page=<page_id>" in text
    assert "Use only page ids the tools returned" in text

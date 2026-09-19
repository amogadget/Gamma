"""search_library: notes hits before PDF hits, scope rules, the legacy
search_pdfs name, and what a page-scoped chat can reach."""

from gamma.ai_tools import agent_tools, run_agent_tool

from ai_fixtures import folder, indexed_pdf, org, props  # noqa: F401 (fixtures)


def test_search_library_scoped_snippets(org, indexed_pdf):
    c, ids = org
    text, action = run_agent_tool(ids["ws"], folder("readout"), "search_library",
                                  {"query": "error correction"})
    assert action["kind"] == "search" and "1 hit" in action["summary"]
    assert 'PDF "' in text and "p.3" in text and "cat qubits" in text
    assert "not indexed" not in text  # everything in scope is stamped current
    # A folder whose pages carry no PDF is searched by notes alone.
    r = c.post("/api/blocks", json={"parent_id": "root", "content": "text only",
                                    "properties": {"folder": "textonly"}})
    assert r.status_code == 200
    text, _ = run_agent_tool(ids["ws"], folder("textonly"), "search_library", {"query": "cat"})
    assert text.startswith("No notes or PDF text match") and "not answer from your own knowledge" in text
    c.delete(f"/api/blocks/{r.json()['id']}")
    # A folder with no pages at all says so.
    text, _ = run_agent_tool(ids["ws"], folder("nowhere"), "search_library", {"query": "cat"})
    assert text == "No pages are reachable from this chat."


def test_search_library_finds_notes_and_pdf_text(org, indexed_pdf):
    """Notes hits (block ids, from block_fts) come before PDF hits (page
    numbers, from pdf_fts); a page without a PDF is searchable by its notes,
    and the note index follows edits without any explicit rebuild."""
    c, ids = org
    title_a, title_b = props(c, ids["a"])["content"], props(c, ids["b"])["content"]
    r = c.post("/api/blocks", json={"parent_id": ids["b"],
                                    "content": "cat qubits need bias-preserving gates"})
    assert r.status_code == 200
    note_block = r.json()["id"]
    text, action = run_agent_tool(ids["ws"], folder("readout"), "search_library",
                                  {"query": "cat qubits"})
    assert action["kind"] == "search" and "2 hits" in action["summary"]
    lines = [l for l in text.splitlines() if l.startswith("- ")]
    assert lines[0].startswith(f'- note [{note_block}] in "{title_b}"')
    assert f"(page_id {ids['b']})" in lines[0] and "bias-preserving" in lines[0]
    assert lines[1].startswith(f'- PDF "{title_a}" p.3')
    # The page chat of the note-only page reaches its own notes, nothing else.
    text, _ = run_agent_tool(ids["ws"], {"type": "page", "page_id": ids["b"]},
                             "search_library", {"query": "cat qubits"})
    assert f"[{note_block}]" in text and "p.3" not in text
    # Editing the note re-indexes it on the next search.
    assert c.put(f"/api/blocks/{note_block}", json={"content": "zebra crossings"}).status_code == 200
    text, _ = run_agent_tool(ids["ws"], folder("readout"), "search_library", {"query": "zebra"})
    assert f"[{note_block}]" in text
    text, _ = run_agent_tool(ids["ws"], folder("readout"), "search_library",
                             {"query": "bias-preserving"})
    assert f"[{note_block}]" not in text
    c.delete(f"/api/blocks/{note_block}")


def test_deprecated_search_pdfs_still_dispatches(org, indexed_pdf):
    """Old chats saved `search_pdfs` calls; a model copying that name out of
    the replayed history is served by search_library, under the new name."""
    c, ids = org
    text, action = run_agent_tool(ids["ws"], folder("readout"), "search_pdfs",
                                  {"query": "cat qubits"})
    assert action["tool"] == "search_library" and action["kind"] == "search"
    assert "p.3" in text
    assert "search_pdfs" not in [t["name"] for t in agent_tools("folder")]  # never offered


def test_page_scope_reaches_only_its_paper(org, indexed_pdf):
    c, ids = org
    assert c.post("/api/blocks", json={"parent_id": ids["a"], "content": "important note"}).status_code == 200
    scope = {"type": "page", "page_id": ids["a"]}
    text, action = run_agent_tool(ids["ws"], scope, "read_page", {"page_id": ids["a"]})
    assert action["kind"] == "read" and "important note" in text
    # Any other page — even one in the same folder — is out of reach.
    text, _ = run_agent_tool(ids["ws"], scope, "read_page", {"page_id": ids["b"]})
    assert text.startswith("error")
    # Search covers only this paper's PDF (the indexed_pdf fixture).
    text, action = run_agent_tool(ids["ws"], scope, "search_library", {"query": "cat qubits"})
    assert "p.3" in text and action["kind"] == "search"

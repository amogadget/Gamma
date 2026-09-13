"""Agent tools: the scope/permission registry, executor scope rules (folder
and page scopes), wire-format translation of tool definitions/calls per
protocol, tool-call SSE parsing, and the /api/ai/chat agent loop end-to-end
with a faked provider."""

import json
from conftest import workspace_of
import re

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
    from gamma import workspaces

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'organizer'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("organizer", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    workspaces.ensure_personal("organizer")
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

ALL_PERMS = ("list", "read", "block_read", "search", "rename", "move", "block_edit")


def test_registry_scopes_and_permissions():
    assert [t["name"] for t in agent_tools("folder")] == [
        "list_pages", "read_page", "read_block", "search_library", "rename_page",
        "move_page", "edit_block", "create_block", "move_block"]
    # Paper chats never rename/move pages; the note-block tools exist there.
    assert [t["name"] for t in agent_tools("page")] == [
        "read_page", "read_block", "search_library",
        "edit_block", "create_block", "move_block"]
    assert agent_tools("") == []  # plain chat
    assert [t["name"] for t in agent_tools(
        "folder", {"rename": False, "move": False, "block_edit": False})] == [
        "list_pages", "read_page", "read_block", "search_library"]
    names = [t["name"] for t in agent_tools("folder", {"search": False})]
    assert "search_library" not in names and "read_page" in names
    # One permission gates all three note-editing tools.
    names = [t["name"] for t in agent_tools("page", {"block_edit": False})]
    assert names == ["read_page", "read_block", "search_library"]
    assert agent_tools("folder", {k: False for k in ALL_PERMS}) == []
    assert agent_tools("folder", None) == ALL_TOOLS  # missing map = everything on


def test_agent_system_mentions_scope_and_armed_tools():
    text = agent_system(_folder("readout"))
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
    custom = agent_system(_folder(""), None, "Be terse.")
    assert custom.startswith("Be terse.") and "Available tools" in custom


# --- executors ---------------------------------------------------------------

def test_list_pages_scoped_and_annotated(org):
    c, ids = org
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "list_pages", {})
    assert action["kind"] == "list" and "2 pages" in action["summary"]
    assert f"id={ids['a']}" in text and f"id={ids['b']}" in text
    assert ids["note"] not in text  # outside the folder
    assert "One et al., 2019, Nature" in text  # cached metadata surfaces
    # Root scope lists everything, including the loose note.
    root_text, _ = run_agent_tool(workspace_of("organizer"), _folder(""), "list_pages", {})
    assert ids["note"] in root_text and "note" in root_text


def test_rename_page(org):
    c, ids = org
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "rename_page",
                                  {"page_id": ids["a"], "title": "  Ada2019 —  Cavity readout \n"})
    assert text.startswith("ok"), text
    assert action["kind"] == "rename" and "Ada2019 — Cavity readout" in action["summary"]
    assert _props(c, ids["a"])["content"] == "Ada2019 — Cavity readout"
    # No-op rename mutates nothing, but still shows as a (non-error) chip.
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "rename_page",
                                  {"page_id": ids["a"], "title": "Ada2019 — Cavity readout"})
    assert action["kind"] == "rename" and not action.get("error")
    # Every chip carries the raw call so the chat can expand it.
    assert action["tool"] == "rename_page" and action["result"] == text
    assert action["args"]["title"] == "Ada2019 — Cavity readout"


def test_scope_blocks_outside_pages(org):
    c, ids = org
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "rename_page",
                                  {"page_id": ids["note"], "title": "hijack"})
    assert text.startswith("error") and action["error"] and action["kind"] == "error"
    assert _props(c, ids["note"])["content"] == "loose note"
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("readout"), "rename_page",
                             {"page_id": "nope", "title": "x"})
    assert text.startswith("error")


def test_move_page_keeps_out_of_scope_tags(org):
    c, ids = org
    # Relative target resolves inside the scope; the "cooling" membership survives.
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "move_page",
                                  {"page_id": ids["b"], "folder": "fast"})
    assert text.startswith("ok"), text
    assert action["kind"] == "move" and "readout/fast" in action["summary"]
    tags = [t.strip() for t in _props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout/fast"]
    # "" files the page at the scope itself.
    run_agent_tool(workspace_of("organizer"), _folder("readout"), "move_page", {"page_id": ids["b"], "folder": ""})
    tags = [t.strip() for t in _props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout"]


def test_move_at_root_replaces_all_folders(org):
    c, ids = org
    run_agent_tool(workspace_of("organizer"), _folder(""), "move_page", {"page_id": ids["b"], "folder": "archive/2019"})
    assert _props(c, ids["b"])["properties"]["folder"] == "archive/2019"
    # Root + "" = out of every folder.
    run_agent_tool(workspace_of("organizer"), _folder(""), "move_page", {"page_id": ids["b"], "folder": ""})
    assert _props(c, ids["b"])["properties"]["folder"] == ""
    # Restore for later tests.
    run_agent_tool(workspace_of("organizer"), _folder(""), "move_page", {"page_id": ids["b"], "folder": "readout"})


def test_unknown_or_out_of_scope_tools_error(org):
    text, action = run_agent_tool(workspace_of("organizer"), _folder(""), "delete_page", {"page_id": "x"})
    assert text.startswith("error") and action["error"] and action["result"] == text
    text, action = run_agent_tool(workspace_of("organizer"), _folder(""), "set_labels", {"page_id": "x"})
    assert text.startswith("error") and action["error"]
    # Write tools don't exist in page scope — same error as an unknown tool.
    text, _ = run_agent_tool(workspace_of("organizer"), {"type": "page", "page_id": "x"},
                             "rename_page", {"page_id": "x", "title": "y"})
    assert text.startswith("error: unknown tool")


def test_read_page_returns_notes_and_respects_scope(org):
    c, ids = org
    r = c.post("/api/blocks", json={"parent_id": ids["a"], "content": "important note"})
    assert r.status_code == 200
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "read_page", {"page_id": ids["a"]})
    assert action["kind"] == "read" and action["summary"].startswith("Read “")
    assert "important note" in text  # the user's notes ride along
    # A page outside the scope is unreadable, same rule as the write tools.
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("readout"), "read_page", {"page_id": ids["note"]})
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

    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 100})
    assert "[0000]" in text and "[0020]" not in text  # first window only
    assert "pdf_offset=100" in text  # continuation hint

    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 100, "pdf_offset": 100})
    assert "Document text (from char 100):" in text
    assert "[0017]" in text and "[0000]" not in text  # window slides
    assert "pdf_offset=200" in text

    # A window reaching the end has no continuation marker.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 20000})
    assert "[0199]" in text and "more text remains" not in text

    # An offset past the end reports the document's extracted length.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
                             {"page_id": ids["a"], "pdf_offset": 5000})
    assert "past the end" in text and "1200" in text


def test_read_page_pdf_page_jumps_to_a_search_hit(org, monkeypatch):
    """pdf_page starts the excerpt at that PDF page (the shape search_library
    hits come in), so the agent can read around a match with a small window."""
    from gamma.pdf_text import extract_text

    c, ids = org
    pages = [f"(page {i}) " + f"p{i}-body " * 10 for i in range(1, 6)]
    monkeypatch.setattr(
        "gamma.pdf_text.iter_page_texts",
        lambda src, max_pages=None, start_page=1: iter(pages[start_page - 1:]))
    monkeypatch.setattr("gamma.ai_context.extract_text", extract_text)
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")
    scope = _folder("readout")

    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 4, "pdf_chars": 60})
    assert "Document text (from PDF page 4):" in text
    assert "(page 4)" in text and "(page 3)" not in text
    assert "pdf_page=4, pdf_offset=60" in text  # continuation keeps the page anchor

    # Continuing from that page with an offset labels and slices from there.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 4, "pdf_offset": 60,
                              "pdf_chars": 20000})
    assert "from PDF page 4, from char 60" in text and "(page 5)" in text
    assert "more text remains" not in text  # pages 4-5 end inside the window

    # A page past the end of the document says so instead of going silent.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
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
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 99999})
    assert "[0020]" in text and "[0030]" not in text  # clamped to ~150 chars
    assert "pdf_offset=150" in text
    # Unset / absurd values fall back to the stock 20000 cap.
    for bad in ({}, {"read_chars": 0}, {"read_chars": "x"}, {"read_chars": 10**9}):
        text, _ = run_agent_tool(workspace_of("organizer"), {**_folder("readout"), **bad},
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


# --- note-block tools --------------------------------------------------------

@pytest.fixture(scope="module")
def notes(org):
    """A page with a small note tree (plus a highlight) for the block tools."""
    c, ids = org
    last_pos: dict = {}  # per-parent, so siblings get real fractional order

    def block(parent, content, props=None):
        r = c.post("/api/blocks", json={"parent_id": parent, "content": content,
                                        "properties": props or {},
                                        "before": last_pos.get(parent)})
        assert r.status_code == 200, r.text
        last_pos[parent] = r.json()["position"]
        return r.json()["id"]
    page = block("root", "notes playground")
    r = c.put(f"/api/blocks/{page}", json={"properties": {"folder": "sandbox"}})
    assert r.status_code == 200
    top = block(page, "top-level idea")
    child = block(top, "supporting detail")
    other = block(page, "second thread")
    hl = block(page, "why this matters",
               {"highlight_id": "h1", "quote": "measured T1 of 300 µs"})
    return c, {**ids, "page": page, "top": top, "child": child,
               "other": other, "hl": hl}


def _children(c, parent):
    r = c.get(f"/api/blocks/{parent}/children")
    assert r.status_code == 200
    return [b["id"] for b in r.json()["children"]]


def test_read_block_outline_with_ids(notes):
    c, ids = notes
    scope = _folder("sandbox")
    text, action = run_agent_tool(workspace_of("organizer"), scope, "read_block", {"block_id": ids["page"]})
    assert action["kind"] == "read" and action["page_id"] == ids["page"]
    for key in ("top", "child", "other", "hl"):
        assert f"[{ids[key]}]" in text
    assert '(highlight: "measured T1 of 300 µs")' in text
    assert text.index(ids["top"]) < text.index(ids["child"])  # nesting in order
    assert "edit_block" in text  # the footer teaches the editing tools
    # A nested block id reads that subtree only, the block's own text in full.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_block", {"block_id": ids["top"]})
    assert "top-level idea" in text and ids["child"] in text
    assert ids["other"] not in text
    # Scope rules match the page tools.
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("readout"), "read_block",
                             {"block_id": ids["top"]})
    assert text.startswith("error")
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_block", {"block_id": "nope"})
    assert text.startswith("error: no such block")


def test_edit_block(notes):
    c, ids = notes
    scope = _folder("sandbox")
    text, action = run_agent_tool(workspace_of("organizer"), scope, "edit_block",
                                  {"block_id": ids["child"], "content": "sharper detail"})
    assert text.startswith("ok"), text
    assert action["kind"] == "edit" and action["page_id"] == ids["page"]
    assert _props(c, ids["child"])["content"] == "sharper detail"
    # Page roots are refused — titles go through rename_page.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "edit_block",
                             {"block_id": ids["page"], "content": "x"})
    assert "rename_page" in text
    # No-op edit mutates nothing but still shows as a non-error chip.
    text, action = run_agent_tool(workspace_of("organizer"), scope, "edit_block",
                                  {"block_id": ids["child"], "content": "sharper detail"})
    assert text.startswith("ok") and not action.get("error")


def test_create_block_placement(notes):
    c, ids = notes
    scope = _folder("sandbox")
    text, action = run_agent_tool(workspace_of("organizer"), scope, "create_block",
                                  {"parent_id": ids["page"], "content": "appended note"})
    assert action["kind"] == "create" and action["page_id"] == ids["page"]
    new_last = re.search(r"\[([^\]]+)\]", text).group(1)
    assert _children(c, ids["page"])[-1] == new_last
    # after_id inserts between siblings.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "create_block",
                             {"parent_id": ids["page"], "content": "wedged in",
                              "after_id": ids["top"]})
    wedged = re.search(r"\[([^\]]+)\]", text).group(1)
    order = _children(c, ids["page"])
    assert order.index(wedged) == order.index(ids["top"]) + 1
    # A bad anchor is refused, not guessed.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "create_block",
                             {"parent_id": ids["page"], "content": "x",
                              "after_id": ids["child"]})
    assert "after_id" in text and text.startswith("error")


def test_move_block_rules(notes):
    c, ids = notes
    scope = _folder("sandbox")
    # Reparent under a sibling.
    text, action = run_agent_tool(workspace_of("organizer"), scope, "move_block",
                                  {"block_id": ids["other"], "parent_id": ids["top"]})
    assert text.startswith("ok"), text
    assert action["kind"] == "move" and action["page_id"] == ids["page"]
    assert _children(c, ids["top"])[-1] == ids["other"]
    # Into its own subtree → refused.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "move_block",
                             {"block_id": ids["top"], "parent_id": ids["other"]})
    assert "into itself" in text
    # Page roots don't move this way.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "move_block",
                             {"block_id": ids["page"], "parent_id": ids["top"]})
    assert "move_page" in text
    # Highlights stay on their page; plain blocks may cross pages in scope.
    r = c.post("/api/blocks", json={"parent_id": "root", "content": "second page",
                                    "properties": {"folder": "sandbox"}})
    page2 = r.json()["id"]
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "move_block",
                             {"block_id": ids["hl"], "parent_id": page2})
    assert "anchored" in text
    text, action = run_agent_tool(workspace_of("organizer"), scope, "move_block",
                                  {"block_id": ids["child"], "parent_id": page2})
    assert text.startswith("ok")
    assert action["page_id"] == page2 and action["src_page_id"] == ids["page"]
    assert _children(c, page2) == [ids["child"]]
    # A page outside the scope can't receive blocks.
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("sandbox"), "move_block",
                             {"block_id": ids["child"], "parent_id": ids["a"]})
    assert text.startswith("error")


def test_block_tools_gated_by_permissions():
    armed = {t["name"] for t in agent_tools("page", {"block_read": False, "block_edit": False})}
    assert armed == {"read_page", "search_library"}


def test_search_library_scoped_snippets(org):
    import sqlite3 as sq
    from gamma.db import page_now, ws_db_path
    from gamma.pdf_index import ensure_schema
    from gamma.textnorm import INDEX_VERSION

    c, ids = org
    doc = "d" * 24  # page a's doc_id
    with sq.connect(ws_db_path(workspace_of("organizer"), "data.db")) as db:
        ensure_schema(db)
        db.execute("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)",
                   (doc, 3, "quantum error correction with cat qubits"))
        db.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                   "VALUES (?, ?, 1, ?)", (doc, page_now(), INDEX_VERSION))
        db.commit()
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "search_library",
                                  {"query": "error correction"})
    assert action["kind"] == "search" and "1 hit" in action["summary"]
    assert 'PDF "' in text and "p.3" in text and "cat qubits" in text
    assert "not indexed" not in text  # everything in scope is stamped current
    # A folder whose pages carry no PDF is searched by notes alone.
    r = c.post("/api/blocks", json={"parent_id": "root", "content": "text only",
                                    "properties": {"folder": "textonly"}})
    assert r.status_code == 200
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("textonly"), "search_library", {"query": "cat"})
    assert text.startswith("No notes or PDF text match") and "not answer from your own knowledge" in text
    c.delete(f"/api/blocks/{r.json()['id']}")
    # A folder with no pages at all says so.
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("nowhere"), "search_library", {"query": "cat"})
    assert text == "No pages are reachable from this chat."


def test_search_library_finds_notes_and_pdf_text(org):
    """Notes hits (block ids, from block_fts) come before PDF hits (page
    numbers, from pdf_fts); a page without a PDF is searchable by its notes,
    and the note index follows edits without any explicit rebuild."""
    c, ids = org
    title_a, title_b = _props(c, ids["a"])["content"], _props(c, ids["b"])["content"]
    r = c.post("/api/blocks", json={"parent_id": ids["b"],
                                    "content": "cat qubits need bias-preserving gates"})
    assert r.status_code == 200
    note_block = r.json()["id"]
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "search_library",
                                  {"query": "cat qubits"})
    assert action["kind"] == "search" and "2 hits" in action["summary"]
    lines = [l for l in text.splitlines() if l.startswith("- ")]
    assert lines[0].startswith(f'- note [{note_block}] in "{title_b}"')
    assert f"(page_id {ids['b']})" in lines[0] and "bias-preserving" in lines[0]
    assert lines[1].startswith(f'- PDF "{title_a}" p.3')
    # The page chat of the note-only page reaches its own notes, nothing else.
    text, _ = run_agent_tool(workspace_of("organizer"), {"type": "page", "page_id": ids["b"]},
                             "search_library", {"query": "cat qubits"})
    assert f"[{note_block}]" in text and "p.3" not in text
    # Editing the note re-indexes it on the next search.
    assert c.put(f"/api/blocks/{note_block}", json={"content": "zebra crossings"}).status_code == 200
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("readout"), "search_library", {"query": "zebra"})
    assert f"[{note_block}]" in text
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("readout"), "search_library",
                             {"query": "bias-preserving"})
    assert f"[{note_block}]" not in text
    c.delete(f"/api/blocks/{note_block}")


def test_deprecated_search_pdfs_still_dispatches(org):
    """Old chats saved `search_pdfs` calls; a model copying that name out of
    the replayed history is served by search_library, under the new name."""
    c, ids = org
    text, action = run_agent_tool(workspace_of("organizer"), _folder("readout"), "search_pdfs",
                                  {"query": "cat qubits"})
    assert action["tool"] == "search_library" and action["kind"] == "search"
    assert "p.3" in text
    assert "search_pdfs" not in [t["name"] for t in agent_tools("folder")]  # never offered


def test_page_scope_reaches_only_its_paper(org):
    c, ids = org
    scope = {"type": "page", "page_id": ids["a"]}
    text, action = run_agent_tool(workspace_of("organizer"), scope, "read_page", {"page_id": ids["a"]})
    assert action["kind"] == "read" and "important note" in text
    # Any other page — even one in the same folder — is out of reach.
    text, _ = run_agent_tool(workspace_of("organizer"), scope, "read_page", {"page_id": ids["b"]})
    assert text.startswith("error")
    # Search covers only this paper's PDF (seeded in the FTS test above).
    text, action = run_agent_tool(workspace_of("organizer"), scope, "search_library", {"query": "cat qubits"})
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
    stream = _sse(
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
    stream = _sse(
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
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    actions = [l["action"] for l in lines if "action" in l]
    text = "".join(l.get("delta", "") for l in lines)
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
    text = "".join(json.loads(l).get("delta", "") for l in r.text.splitlines() if l.strip())
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
    assert [t["name"] for t in seen["tools"]] == [
        "read_page", "read_block", "search_library",
        "edit_block", "create_block", "move_block"]
    assert f'page_id "{ids["a"]}"' in seen["system"]
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    reads = [l["action"] for l in lines if "action" in l]
    assert reads and reads[0]["kind"] == "read"


def test_paper_chat_kicks_indexing_for_unindexed_doc(org, monkeypatch):
    """A paper chat (tools on or off) starts background indexing for a paper
    the FTS index doesn't hold, so the document map and search_library exist by
    the next turn instead of only after the model happens to call search."""
    c, ids = org
    import gamma.ai_context as ctx
    import gamma.routers.ai as ai_mod
    import gamma.routers.search as search_mod
    from gamma.db import page_now, ws_db_path
    from gamma.pdf_index import ensure_schema
    from gamma.textnorm import INDEX_VERSION

    # A provider so the chat runs (idempotent: earlier tests may have added one).
    assert c.post("/api/ai/providers",
                  json={"protocol": "anthropic", "api_key": "sk-test-key-123",
                        "models": "claude-solo"}).status_code == 200
    kicked = []
    monkeypatch.setattr(search_mod, "_index_missing_async",
                        lambda user, doc_ids: kicked.append((user, list(doc_ids))) or True)
    monkeypatch.setattr(ai_mod, "_open_ai", lambda *a, **kw: _FakeResp([
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}]))
    doc = "e" * 24
    fresh = c.post("/api/blocks", json={"parent_id": "root", "content": "fresh paper",
                                        "properties": {"doc_id": doc}}).json()["id"]
    # Plain (tools off) chat still kicks it — the index is what a later
    # tools-on turn needs, and it costs one query to check.
    r = c.post("/api/ai/chat", json={"prompt": "hi", "page_id": fresh, "stream": True})
    assert r.status_code == 200 and '"delta": "ok"' in r.text
    assert kicked == [(workspace_of("organizer"), [doc])]
    # Already indexed at the current version: nothing to kick.
    with __import__("sqlite3").connect(ws_db_path(workspace_of("organizer"), "data.db")) as db:
        ensure_schema(db)
        db.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                   "VALUES (?, ?, 1, ?)", (doc, page_now(), INDEX_VERSION))
        db.commit()
    assert ctx.ensure_indexed(workspace_of("organizer"), doc) is True
    assert len(kicked) == 1
    # A stale index version counts as missing.
    with __import__("sqlite3").connect(ws_db_path(workspace_of("organizer"), "data.db")) as db:
        db.execute("UPDATE pdf_fts_docs SET ver = ? WHERE doc_id = ?", (INDEX_VERSION - 1, doc))
        db.commit()
    assert ctx.ensure_indexed(workspace_of("organizer"), doc) is False
    assert kicked[-1] == (workspace_of("organizer"), [doc])


def test_chat_reports_context_coverage(org, monkeypatch):
    """The stream's first line says what the model was given: a truncated
    paper reports pages shown / total, a native attachment reports native."""
    c, ids = org
    import gamma.routers.ai as ai_mod
    import gamma.routers.search as search_mod

    assert c.post("/api/ai/providers",
                  json={"protocol": "anthropic", "api_key": "sk-test-key-123",
                        "models": "claude-solo"}).status_code == 200
    monkeypatch.setattr(search_mod, "_index_missing_async", lambda user, doc_ids: True)
    monkeypatch.setattr(ai_mod, "_open_ai", lambda *a, **kw: _FakeResp([
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}]))
    doc = "".join(f"[{i:04d}]" for i in range(200))  # 1200 chars
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")
    monkeypatch.setattr("gamma.ai_context.extract_text_pages",
                        lambda src, limit, empty_page_cap=50, start_page=1:
                        (doc if len(doc) <= limit else doc[:limit + 7], 3))
    monkeypatch.setattr("gamma.ai_context.page_count", lambda src: 22)
    doc_id = "d" * 24  # page a's doc_id

    r = c.post("/api/ai/chat", json={"prompt": "hi", "doc_id": doc_id, "stream": True,
                                     "context_char_limit": 500})
    assert r.status_code == 200
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    assert "context" in lines[0]
    (cover,) = lines[0]["context"]
    assert cover["doc_id"] == doc_id and cover["title"]  # page a's title
    assert cover["partial"] is True and cover["pages"] == 22 and cover["pages_shown"] == 3
    assert cover["native"] is False and cover["native_requested"] is False
    assert cover["chars"] == 500
    assert [l for l in lines if "delta" in l]

    # Fits whole: no truncation reported.
    r = c.post("/api/ai/chat", json={"prompt": "hi", "doc_id": doc_id, "stream": True,
                                     "context_char_limit": 5000})
    (cover,) = [json.loads(l) for l in r.text.splitlines() if l.strip()][0]["context"]
    assert cover["partial"] is False and cover["pages_shown"] == 3

    # Native attachment on a provider that takes it.
    monkeypatch.setattr("gamma.ai_context.load_pdf_b64", lambda u, d: "UERG")
    r = c.post("/api/ai/chat", json={"prompt": "hi", "doc_id": doc_id, "stream": True,
                                     "attach_pdf": True})
    (cover,) = [json.loads(l) for l in r.text.splitlines() if l.strip()][0]["context"]
    assert cover["native"] is True and cover["native_requested"] is True

    # Non-stream callers get the same report in the JSON body.
    class _Ctx(_FakeResp):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(ai_mod, "_open_ai", lambda *a, **kw: _Ctx([
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}]))
    monkeypatch.setattr(ai_mod, "_read_reply", lambda resp, proto: "ok")
    r = c.post("/api/ai/chat", json={"prompt": "hi", "doc_id": doc_id, "stream": False,
                                     "context_char_limit": 500})
    assert r.status_code == 200 and r.json()["context"][0]["partial"] is True


def test_chat_context_from_text_only_page(org, monkeypatch):
    """A page without a PDF is its notes: naming it by page_id (no doc_id)
    puts its title, properties and note tree into the context — even with
    include_notes off — framed as a page of the knowledge base."""
    c, ids = org
    import gamma.routers.ai as ai_mod

    assert c.post("/api/ai/providers",
                  json={"protocol": "anthropic", "api_key": "sk-test-key-123",
                        "models": "claude-solo"}).status_code == 200
    page = c.post("/api/pages", json={"title": "Reading plan", "folder": "plans"}).json()
    r = c.post("/api/blocks", json={"parent_id": page["id"], "content": "read the cat-qubit review"})
    top = r.json()
    c.post("/api/blocks", json={"parent_id": top["id"], "content": "focus on bias-preserving gates"})
    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        seen["messages"], seen["system"] = messages, system
        return _FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "ok"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={"prompt": "what should I read?", "page_id": page["id"],
                                     "include_notes": False, "stream": True})
    assert r.status_code == 200, r.text
    user_turn = seen["messages"][-1]["content"]
    assert user_turn.startswith("Context — pages from the user's knowledge base")
    assert "### Reading plan" in user_turn and "folders: plans" in user_turn
    assert "- read the cat-qubit review" in user_turn
    assert "  - focus on bias-preserving gates" in user_turn  # nesting kept
    assert "Here is the PDF text" not in user_turn and "EXCERPT" not in user_turn
    assert user_turn.rstrip().endswith("User question: what should I read?")
    assert "knowledge base" in seen["system"]  # the built-in prompt applies to page context
    lines = [json.loads(l) for l in r.text.splitlines() if l.strip()]
    (cover,) = lines[0]["context"]
    assert cover["title"] == "Reading plan" and cover["doc_id"] == "" and cover["partial"] is False

    # Several pages: a text-only page contributes its notes next to a PDF page.
    r = c.post("/api/ai/chat", json={"prompt": "compare", "pages": [page["id"], ids["a"]],
                                     "stream": True})
    assert r.status_code == 200
    user_turn = seen["messages"][-1]["content"]
    title_a = _props(c, ids["a"])["content"]
    assert "### Reading plan" in user_turn and "- read the cat-qubit review" in user_turn
    assert f"### {title_a}" in user_turn and "attachment: PDF" in user_turn
    titles = [e["title"] for e in [json.loads(l) for l in r.text.splitlines() if l.strip()][0]["context"]]
    assert titles == ["Reading plan", title_a]
    c.delete(f"/api/blocks/{page['id']}")


def test_models_flag_native_pdf_capability(org):
    """The chat UI keys the PDF button's default on native_pdf: API-key
    providers take the file, the ChatGPT sign-in (Codex backend) does not."""
    c, _ = org
    from gamma.ai_settings import ai_runtime
    rt = ai_runtime("organizer")
    assert rt["models"] and all(m["native_pdf"] is True for m in rt["models"])
    import gamma.ai_settings as st
    entries = st.load_provider_entries("organizer")
    entries.append({"id": "oauth1", "protocol": "chatgpt", "models": "gpt-x",
                    "oauth": {"access_token": "tok", "expires_at": 9_999_999_999}})
    st.save_provider_entries("organizer", entries)
    try:
        flags = {m["id"]: m["native_pdf"] for m in ai_runtime("organizer")["models"]}
        assert flags["oauth1:gpt-x"] is False
        r = c.get("/api/ai/models")
        assert {m["id"]: m["native_pdf"] for m in r.json()["models"]} == flags
    finally:
        st.save_provider_entries("organizer", [e for e in entries if e["id"] != "oauth1"])


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
                                     "permissions": {"rename": False, "move": False,
                                                     "block_edit": False}})
    assert r.status_code == 200
    assert [t["name"] for t in seen["tools"]] == [
        "list_pages", "read_page", "read_block", "search_library"]
    assert seen["blocked"].startswith("error: tool not enabled")
    assert _props(c, ids["a"])["content"] == before  # nothing was renamed

    # Every permission off → plain chat, no tools at all.
    seen.clear()
    r = c.post("/api/ai/chat", json={"prompt": "hi", "agent_scope": "folder", "folder": "readout",
                                     "stream": True,
                                     "permissions": {k: False for k in ALL_PERMS}})
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
    text, action = run_agent_tool(workspace_of("organizer"), _folder("labtest"), "list_pages", {"label": "jeff"})
    assert "2 pages" in action["summary"] and "jeff" in action["summary"]
    assert jeff1 in text and jeff2 in text and other not in text
    # Title substring filter.
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("labtest"), "list_pages",
                             {"title_contains": "LDPC"})
    assert other in text and jeff1 not in text
    # Relative subfolder filter resolves inside the scope.
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("labtest"), "list_pages", {"folder": "sub"})
    assert jeff2 in text and jeff1 not in text
    # No matches is a clear answer, not an empty-library claim.
    text, _ = run_agent_tool(workspace_of("organizer"), _folder("labtest"), "list_pages", {"label": "nope"})
    assert "No pages match" in text
    # Labels mode: the vocabulary with counts, not page lines.
    text, action = run_agent_tool(workspace_of("organizer"), _folder("labtest"), "list_pages",
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
    # Replayed results are flagged as snapshots from an earlier turn.
    assert messages[2]["call_id"] == calls[0]["id"]
    assert messages[2]["content"].endswith("\nPages (2): …")
    assert messages[2]["content"].startswith("[result from an earlier turn")
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


def test_build_messages_replays_renamed_tools_under_current_name():
    history = [
        {"role": "user", "text": "where is X"},
        {"role": "ai", "text": "p.3", "actions": [
            {"kind": "search", "tool": "search_pdfs", "args": {"query": "x"}, "result": "hit"}]},
    ]
    messages = build_messages(_payload(history), "", with_tools=True)
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
    messages = build_messages(_payload(history), "", with_tools=True)
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
            return _FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "read_block"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"block_id": ids["page"]})}},
                {"type": "content_block_stop"},
            ])
        if len(opened) == 2:
            return _FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t2", "name": "edit_block"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": '{"block_id": "' + ids["top"] + '", "content": "## Idea\\nfirst'}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": ' half"}'}},
                {"type": "content_block_stop"},
            ])
        return _FakeResp([{"type": "content_block_delta",
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
    assert _props(c, ids["top"])["content"] == "## Idea\nfirst half"
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
    section = notes_focus_section(workspace_of("organizer"), payload)
    assert "cursor is on this note block" in section
    assert f"- [{top}] focus idea" in section
    assert f"  - [{child}] focus detail" in section   # sub-block, indented
    assert "attached to this message" in section
    assert f"[{other}] attached thread" in section
    assert f'[{ids["hl"]}] (highlight: "measured T1 of 300' in section
    assert f'[{ids["page"]}]' not in section and "nope" not in section
    # Nothing to point at → no section; a chip from a page outside the
    # context is dropped (the section is scoped to the request's pages).
    assert notes_focus_section(workspace_of("organizer"), SimpleNamespace(
        focus_block_id="", page_id=ids["page"], pages=[], context_blocks=[])) == ""
    assert notes_focus_section(workspace_of("organizer"), SimpleNamespace(
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
        return _FakeResp([{"type": "content_block_delta",
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


def test_agent_system_tells_the_model_how_to_link_pages():
    # The chat renders /?page=<id> links as open-in-place, so the prompt
    # asks for that form wherever a reading tool hands the model page ids.
    text = agent_system(_folder(""))
    assert "/?page=<page_id>" in text
    assert "Use only page ids the tools returned" in text

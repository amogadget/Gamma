"""The page tools' executors — list_pages (filters, labels mode), rename_page,
move_page, read_page (windows through a long PDF, page anchors, the tunable
read cap) — and the folder-scope rules they share."""

from gamma.ai_tools import agent_tools, run_agent_tool

from ai_fixtures import folder, org, props  # noqa: F401  (org is a fixture)


def test_list_pages_scoped_and_annotated(org):
    c, ids = org
    text, action = run_agent_tool(ids["ws"], folder("readout"), "list_pages", {})
    assert action["kind"] == "list" and "2 pages" in action["summary"]
    assert f"id={ids['a']}" in text and f"id={ids['b']}" in text
    assert ids["note"] not in text  # outside the folder
    assert "One et al., 2019, Nature" in text  # cached metadata surfaces
    # Root scope lists everything, including the loose note.
    root_text, _ = run_agent_tool(ids["ws"], folder(""), "list_pages", {})
    assert ids["note"] in root_text and "note" in root_text


def test_rename_page(org):
    c, ids = org
    text, action = run_agent_tool(ids["ws"], folder("readout"), "rename_page",
                                  {"page_id": ids["a"], "title": "  Ada2019 —  Cavity readout \n"})
    assert text.startswith("ok"), text
    assert action["kind"] == "rename" and "Ada2019 — Cavity readout" in action["summary"]
    assert props(c, ids["a"])["content"] == "Ada2019 — Cavity readout"
    # No-op rename mutates nothing, but still shows as a (non-error) chip.
    text, action = run_agent_tool(ids["ws"], folder("readout"), "rename_page",
                                  {"page_id": ids["a"], "title": "Ada2019 — Cavity readout"})
    assert action["kind"] == "rename" and not action.get("error")
    # Every chip carries the raw call so the chat can expand it.
    assert action["tool"] == "rename_page" and action["result"] == text
    assert action["args"]["title"] == "Ada2019 — Cavity readout"


def test_scope_blocks_outside_pages(org):
    c, ids = org
    text, action = run_agent_tool(ids["ws"], folder("readout"), "rename_page",
                                  {"page_id": ids["note"], "title": "hijack"})
    assert text.startswith("error") and action["error"] and action["kind"] == "error"
    assert props(c, ids["note"])["content"] == "loose note"
    text, _ = run_agent_tool(ids["ws"], folder("readout"), "rename_page",
                             {"page_id": "nope", "title": "x"})
    assert text.startswith("error")


def test_move_page_keeps_out_of_scope_tags(org):
    c, ids = org
    # Relative target resolves inside the scope; the "cooling" membership survives.
    text, action = run_agent_tool(ids["ws"], folder("readout"), "move_page",
                                  {"page_id": ids["b"], "folder": "fast"})
    assert text.startswith("ok"), text
    assert action["kind"] == "move" and "readout/fast" in action["summary"]
    tags = [t.strip() for t in props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout/fast"]
    # "" files the page at the scope itself.
    run_agent_tool(ids["ws"], folder("readout"), "move_page", {"page_id": ids["b"], "folder": ""})
    tags = [t.strip() for t in props(c, ids["b"])["properties"]["folder"].split(",")]
    assert sorted(tags) == ["cooling", "readout"]


def test_move_at_root_replaces_all_folders(org):
    c, ids = org
    run_agent_tool(ids["ws"], folder(""), "move_page", {"page_id": ids["b"], "folder": "archive/2019"})
    assert props(c, ids["b"])["properties"]["folder"] == "archive/2019"
    # Root + "" = out of every folder.
    run_agent_tool(ids["ws"], folder(""), "move_page", {"page_id": ids["b"], "folder": ""})
    assert props(c, ids["b"])["properties"]["folder"] == ""
    # Restore for later tests.
    run_agent_tool(ids["ws"], folder(""), "move_page", {"page_id": ids["b"], "folder": "readout"})


def test_unknown_or_out_of_scope_tools_error(org):
    c, ids = org
    text, action = run_agent_tool(ids["ws"], folder(""), "delete_page", {"page_id": "x"})
    assert text.startswith("error") and action["error"] and action["result"] == text
    text, action = run_agent_tool(ids["ws"], folder(""), "set_labels", {"page_id": "x"})
    assert text.startswith("error") and action["error"]
    # Write tools don't exist in page scope — same error as an unknown tool.
    text, _ = run_agent_tool(ids["ws"], {"type": "page", "page_id": "x"},
                             "rename_page", {"page_id": "x", "title": "y"})
    assert text.startswith("error: unknown tool")


def test_read_page_returns_notes_and_respects_scope(org):
    c, ids = org
    r = c.post("/api/blocks", json={"parent_id": ids["a"], "content": "important note"})
    assert r.status_code == 200
    text, action = run_agent_tool(ids["ws"], folder("readout"), "read_page", {"page_id": ids["a"]})
    assert action["kind"] == "read" and action["summary"].startswith("Read “")
    assert "important note" in text  # the user's notes ride along
    # A page outside the scope is unreadable, same rule as the write tools.
    text, _ = run_agent_tool(ids["ws"], folder("readout"), "read_page", {"page_id": ids["note"]})
    assert text.startswith("error")


def test_read_page_pdf_offset_pages_through_long_documents(org, monkeypatch):
    """A long paper is read in windows: pdf_offset starts the excerpt there and
    the excerpt names the next offset while more text remains."""
    c, ids = org
    doc = "".join(f"[{i:04d}]" for i in range(200))  # 1200 chars, self-locating

    def fake_extract(src, char_limit, empty_page_cap=50, start_page=1, label_pages=False):
        # Like the real extractor: stops after the "page" that crosses the
        # limit, so the result can overshoot char_limit a little.
        return doc if len(doc) <= char_limit else doc[:char_limit + 7]

    monkeypatch.setattr("gamma.ai_context.extract_text", fake_extract)
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")
    scope = folder("readout")

    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 100})
    assert "[0000]" in text and "[0020]" not in text  # first window only
    assert "pdf_offset=100" in text  # continuation hint

    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 100, "pdf_offset": 100})
    assert "Document text (from char 100):" in text
    assert "[0017]" in text and "[0000]" not in text  # window slides
    assert "pdf_offset=200" in text

    # A window reaching the end has no continuation marker.
    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 20000})
    assert "[0199]" in text and "more text remains" not in text

    # An offset past the end reports the document's extracted length.
    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
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
    scope = folder("readout")

    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 4, "pdf_chars": 60})
    assert "Document text (from PDF page 4):" in text
    assert "(page 4)" in text and "(page 3)" not in text
    assert "pdf_page=4, pdf_offset=60" in text  # continuation keeps the page anchor

    # Continuing from that page with an offset labels and slices from there.
    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 4, "pdf_offset": 60,
                              "pdf_chars": 20000})
    assert "from PDF page 4, from char 60" in text and "(page 5)" in text
    assert "more text remains" not in text  # pages 4-5 end inside the window

    # A page past the end of the document says so instead of going silent.
    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
                             {"page_id": ids["a"], "pdf_page": 40})
    assert "no text at or after PDF page 40" in text


def test_read_window_cap_is_user_tunable(org, monkeypatch):
    """The scope's read_chars (the Settings "Read window" preference) caps
    pdf_chars per call, and the armed spec advertises the effective cap."""
    c, ids = org
    doc = "".join(f"[{i:04d}]" for i in range(200))
    monkeypatch.setattr("gamma.ai_context.extract_text",
                        lambda src, char_limit, empty_page_cap=50, start_page=1, label_pages=False: doc[:char_limit + 7])
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")

    scope = {**folder("readout"), "read_chars": 150}
    text, _ = run_agent_tool(ids["ws"], scope, "read_page",
                             {"page_id": ids["a"], "pdf_chars": 99999})
    assert "[0020]" in text and "[0030]" not in text  # clamped to ~150 chars
    assert "pdf_offset=150" in text
    # Unset / absurd values fall back to the stock 20000 cap.
    for bad in ({}, {"read_chars": 0}, {"read_chars": "x"}, {"read_chars": 10**9}):
        text, _ = run_agent_tool(ids["ws"], {**folder("readout"), **bad},
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
    text, action = run_agent_tool(ids["ws"], folder("labtest"), "list_pages", {"label": "jeff"})
    assert "2 pages" in action["summary"] and "jeff" in action["summary"]
    assert jeff1 in text and jeff2 in text and other not in text
    # Title substring filter.
    text, _ = run_agent_tool(ids["ws"], folder("labtest"), "list_pages",
                             {"title_contains": "LDPC"})
    assert other in text and jeff1 not in text
    # Relative subfolder filter resolves inside the scope.
    text, _ = run_agent_tool(ids["ws"], folder("labtest"), "list_pages", {"folder": "sub"})
    assert jeff2 in text and jeff1 not in text
    # No matches is a clear answer, not an empty-library claim.
    text, _ = run_agent_tool(ids["ws"], folder("labtest"), "list_pages", {"label": "nope"})
    assert "No pages match" in text
    # Labels mode: the vocabulary with counts, not page lines.
    text, action = run_agent_tool(ids["ws"], folder("labtest"), "list_pages",
                                  {"list_labels": True})
    assert "labels" in action["summary"]
    assert '- label "Jeff": 1 page' in text and '- label "jeff": 1 page' in text
    assert '- label "qec": 1 page' in text and '- folder "labtest": 2 pages' in text
    assert jeff1 not in text

"""/api/ai/chat end to end with a faked provider: the tool loop (rounds,
permissions, scope), what context a paper or a text-only page contributes,
the coverage report, indexing kicked for an unindexed paper, and the
history replay reaching the wire."""

import json

import pytest

from ai_fixtures import ALL_PERMS, FakeResp, ai_provider, org, props  # noqa: F401  (fixtures)


@pytest.fixture(scope="module", autouse=True)
def _provider(ai_provider):
    """Every chat here needs a provider entry on the module's account."""


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
            return FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "rename_page"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"page_id": ids["a"], "title": "Ada2019 cavity"})}},
                {"type": "content_block_stop"},
            ])
        # Second round: the tool result is in the conversation; answer plainly.
        assert opened[1][-1]["role"] == "tool"
        assert opened[1][-1]["content"].startswith("ok")
        return FakeResp([
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
    assert props(c, ids["a"])["content"] == "Ada2019 cavity"


def test_chat_agent_round_budget_and_folder_switch(org, monkeypatch):
    """The folder is per request (switching folders re-scopes the next message)
    and tool_rounds caps the loop."""
    c, ids = org
    import gamma.routers.ai as ai_mod

    systems = []

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        systems.append(system)
        # Always ask for another tool round — only the budget can stop us.
        return FakeResp([
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
            return FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "read_page"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"page_id": ids["a"]})}},
                {"type": "content_block_stop"},
            ])
        return FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "summary"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    r = c.post("/api/ai/chat", json={"prompt": "what do my notes say?",
                                     "agent_scope": "page", "page_id": ids["a"], "stream": True})
    assert r.status_code == 200
    assert [t["name"] for t in seen["tools"]] == [
        "read_page", "read_block", "search_library", "search_papers", "fetch_paper",
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
    monkeypatch.setattr(ai_mod, "_open_ai", lambda *a, **kw: FakeResp([
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}]))
    doc = "e" * 24
    fresh = c.post("/api/blocks", json={"parent_id": "root", "content": "fresh paper",
                                        "properties": {"doc_id": doc}}).json()["id"]
    # Plain (tools off) chat still kicks it — the index is what a later
    # tools-on turn needs, and it costs one query to check.
    r = c.post("/api/ai/chat", json={"prompt": "hi", "page_id": fresh, "stream": True})
    assert r.status_code == 200 and '"delta": "ok"' in r.text
    assert kicked == [(ids["ws"], [doc])]
    # Already indexed at the current version: nothing to kick.
    with __import__("sqlite3").connect(ws_db_path(ids["ws"], "data.db")) as db:
        ensure_schema(db)
        db.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                   "VALUES (?, ?, 1, ?)", (doc, page_now(), INDEX_VERSION))
        db.commit()
    assert ctx.ensure_indexed(ids["ws"], doc) is True
    assert len(kicked) == 1
    # A stale index version counts as missing.
    with __import__("sqlite3").connect(ws_db_path(ids["ws"], "data.db")) as db:
        db.execute("UPDATE pdf_fts_docs SET ver = ? WHERE doc_id = ?", (INDEX_VERSION - 1, doc))
        db.commit()
    assert ctx.ensure_indexed(ids["ws"], doc) is False
    assert kicked[-1] == (ids["ws"], [doc])


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
    monkeypatch.setattr(ai_mod, "_open_ai", lambda *a, **kw: FakeResp([
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}]))
    doc = "".join(f"[{i:04d}]" for i in range(200))  # 1200 chars
    monkeypatch.setattr("gamma.ai_context.pdf_path", lambda u, d: "fake.pdf")
    monkeypatch.setattr("gamma.ai_context.extract_text_pages",
                        lambda src, limit, empty_page_cap=50, start_page=1, label_pages=False:
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
    class _Ctx(FakeResp):
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
        return FakeResp([{"type": "content_block_delta",
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
    title_a = props(c, ids["a"])["content"]
    assert "### Reading plan" in user_turn and "- read the cat-qubit review" in user_turn
    assert f"### {title_a}" in user_turn and "attachment: PDF" in user_turn
    titles = [e["title"] for e in [json.loads(l) for l in r.text.splitlines() if l.strip()][0]["context"]]
    assert titles == ["Reading plan", title_a]
    c.delete(f"/api/blocks/{page['id']}")


def test_models_flag_native_pdf_capability(org):
    """The chat UI keys the PDF button's default on native_pdf: API-key
    providers take the file, the ChatGPT sign-in (Codex backend) does not."""
    c, ids = org
    from gamma.ai_settings import ai_runtime
    rt = ai_runtime(ids["user"])
    assert rt["models"] and all(m["native_pdf"] is True for m in rt["models"])
    import gamma.ai_settings as st
    entries = st.load_provider_entries(ids["user"])
    entries.append({"id": "oauth1", "protocol": "chatgpt", "models": "gpt-x",
                    "oauth": {"access_token": "tok", "expires_at": 9_999_999_999}})
    st.save_provider_entries(ids["user"], entries)
    try:
        flags = {m["id"]: m["native_pdf"] for m in ai_runtime(ids["user"])["models"]}
        assert flags["oauth1:gpt-x"] is False
        r = c.get("/api/ai/models")
        assert {m["id"]: m["native_pdf"] for m in r.json()["models"]} == flags
    finally:
        st.save_provider_entries(ids["user"], [e for e in entries if e["id"] != "oauth1"])


def test_chat_permissions_gate_tools_and_execution(org, monkeypatch):
    c, ids = org
    import gamma.routers.ai as ai_mod

    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        seen["tools"] = kw.get("tools")
        if len(seen.setdefault("rounds", [])) == 0:
            seen["rounds"].append(1)
            # Model tries a rename even though write permission is off.
            return FakeResp([
                {"type": "content_block_start", "content_block":
                    {"type": "tool_use", "id": "t1", "name": "rename_page"}},
                {"type": "content_block_delta", "delta": {"type": "input_json_delta",
                    "partial_json": json.dumps({"page_id": ids["a"], "title": "hacked"})}},
                {"type": "content_block_stop"},
            ])
        seen["blocked"] = messages[-1]["content"]
        return FakeResp([{"type": "content_block_delta",
                           "delta": {"type": "text_delta", "text": "ok"}}])

    monkeypatch.setattr(ai_mod, "_open_ai", fake_open)
    before = props(c, ids["a"])["content"]
    r = c.post("/api/ai/chat", json={"prompt": "rename stuff", "agent_scope": "folder",
                                     "folder": "readout", "stream": True,
                                     "permissions": {"rename": False, "move": False,
                                                     "block_edit": False}})
    assert r.status_code == 200
    assert [t["name"] for t in seen["tools"]] == [
        "list_pages", "read_page", "read_block", "search_library", "search_papers", "fetch_paper"]
    assert seen["blocked"].startswith("error: tool not enabled")
    assert props(c, ids["a"])["content"] == before  # nothing was renamed

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
        return FakeResp([{"type": "content_block_delta",
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


def test_chat_agent_history_replay_reaches_provider(org, monkeypatch):
    c, _ = org
    import gamma.routers.ai as ai_mod

    seen = {}

    def fake_open(messages, system, entry, rt, pdf_b64s=None, **kw):
        seen["messages"] = messages
        return FakeResp([{"type": "content_block_delta",
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

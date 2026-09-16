"""Shared fixtures and helpers of the AI test files (test_ai_*.py): a
per-module account with a small library, the note-tree page for the block
tools, a faked streaming provider response, and the wire-test constants."""

import json

import pytest

from conftest import login, make_user, workspace_of
from gamma.ai_tools import agent_tools

ALL_TOOLS = agent_tools("folder")  # the full registry, for the wire tests
ALL_PERMS = ("list", "read", "block_read", "search", "web_search", "web_read",
             "rename", "move", "block_edit")

CONF = {"base_url": "https://example.test", "api_key": "k", "account_id": ""}
TURNS = [
    {"role": "user", "content": "tidy up"},
    {"role": "assistant", "content": "listing", "tool_calls": [
        {"id": "c1", "name": "list_pages", "arguments": {}}]},
    {"role": "tool", "call_id": "c1", "content": "Pages…"},
]


def folder(path):
    return {"type": "folder", "folder": path}


@pytest.fixture(scope="module")
def org(client, request):
    """A non-guest account with a small library — two papers in folders, one
    loose note — private to the test module (its name is in the account's),
    so the AI test files never see each other's pages or provider entries.
    Returns (client, ids): the page ids, plus the account under "user" and
    its workspace id under "ws"."""
    user = "organizer-" + request.module.__name__.removeprefix("test_ai_").replace("_", "-")
    make_user(user, "pw")
    c = login(user, "pw")

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
    return c, {**ids, "user": user, "ws": workspace_of(user)}


@pytest.fixture(scope="module")
def indexed_pdf(org):
    """Page a's PDF with a searchable hit on physical page 3."""
    import sqlite3
    from gamma.db import page_now, ws_db_path
    from gamma.pdf_index import ensure_schema
    from gamma.textnorm import INDEX_VERSION

    _, ids = org
    doc = "d" * 24
    with sqlite3.connect(ws_db_path(ids["ws"], "data.db")) as db:
        ensure_schema(db)
        db.execute("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)",
                   (doc, 3, "quantum error correction with cat qubits"))
        db.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                   "VALUES (?, ?, 1, ?)", (doc, page_now(), INDEX_VERSION))
    return doc


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


@pytest.fixture(scope="module")
def ai_provider(org):
    """An Anthropic provider entry on the module's account, so /api/ai/chat
    runs (the wire is faked per test by patching routers.ai._open_ai)."""
    c, _ = org
    r = c.post("/api/ai/providers", json={"protocol": "anthropic", "api_key": "sk-test-key-123",
                                          "models": "claude-solo"})
    assert r.status_code == 200, r.text


def props(c, block_id):
    r = c.get(f"/api/blocks/{block_id}")
    assert r.status_code == 200
    return r.json()


def children(c, parent):
    r = c.get(f"/api/blocks/{parent}/children")
    assert r.status_code == 200
    return [b["id"] for b in r.json()["children"]]


def sse(*events):
    return iter([f"data: {json.dumps(e)}\n".encode() for e in events] + [b"data: [DONE]\n"])


class FakeResp:
    """What routers.ai._open_ai returns: an iterable of SSE lines."""

    def __init__(self, events):
        self._lines = [f"data: {json.dumps(e)}\n".encode() for e in events] + [b"data: [DONE]\n"]

    def __iter__(self):
        return iter(self._lines)

    def close(self):
        pass


def payload(history):
    from types import SimpleNamespace
    return SimpleNamespace(history=history, prompt="now do it", selection="")

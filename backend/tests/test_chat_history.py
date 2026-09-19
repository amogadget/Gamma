"""Chat history: the active conversation per bucket (`/api/chats`) plus the
archive/open/rename/delete lifecycle of earlier conversations
(`/api/chat-history`), and the hooks that keep history in step with the
bucket it belongs to (folder rename, page deletion)."""


def _msgs(*texts):
    return [{"role": "user" if i % 2 == 0 else "ai", "text": t} for i, t in enumerate(texts)]


def _sessions(client, bucket):
    r = client.get("/api/chat-history", params={"bucket": bucket})
    assert r.status_code == 200, r.text
    return r.json()["sessions"]


def test_active_chat_carries_a_title(guest):
    key = "home:hist/title"
    assert guest.put(f"/api/chats/{key}", json={"messages": _msgs("hello")}).status_code == 200
    assert guest.get(f"/api/chats/{key}").json() == {"messages": _msgs("hello"), "title": ""}
    # A save without a title keeps the stored one; an explicit title renames.
    guest.put(f"/api/chats/{key}", json={"messages": _msgs("hello"), "title": "  My   chat "})
    assert guest.get(f"/api/chats/{key}").json()["title"] == "My chat"
    guest.put(f"/api/chats/{key}", json={"messages": _msgs("hello", "hi")})
    assert guest.get(f"/api/chats/{key}").json()["title"] == "My chat"


def test_archive_moves_active_into_history_with_derived_title(guest):
    key = "home:hist/archive"
    guest.put(f"/api/chats/{key}", json={"messages": _msgs("stale")})
    # The client's copy wins over the stored row (its autosave may be pending).
    convo = _msgs("> quoted line\nWhat does section 3 say?", "It says…")
    r = guest.post("/api/chat-history/archive", json={"bucket": key, "messages": convo})
    assert r.status_code == 200 and r.json()["id"]
    assert guest.get(f"/api/chats/{key}").json()["messages"] == []
    (entry,) = _sessions(guest, key)
    assert entry["title"] == "What does section 3 say?"
    assert entry["count"] == 2 and entry["preview"].startswith("> quoted line")
    # Nothing to keep → no history row, active still cleared.
    r = guest.post("/api/chat-history/archive", json={"bucket": key, "messages": []})
    assert r.json()["id"] is None
    assert len(_sessions(guest, key)) == 1


def test_open_swaps_conversations_and_keeps_titles(guest):
    key = "home:hist/open"
    first = _msgs("first question", "first answer")
    entry_id = guest.post("/api/chat-history/archive",
                          json={"bucket": key, "messages": first, "title": "First"}).json()["id"]
    second = _msgs("second question")
    r = guest.post(f"/api/chat-history/{entry_id}/open",
                   json={"bucket": key, "messages": second, "title": "Second"})
    assert r.status_code == 200
    assert r.json() == {"messages": first, "title": "First"}
    assert guest.get(f"/api/chats/{key}").json() == {"messages": first, "title": "First"}
    # The opened entry left history; the previous active one took its place.
    sessions = _sessions(guest, key)
    assert [s["title"] for s in sessions] == ["Second"]
    assert all(s["id"] != entry_id for s in sessions)
    # Opening the archived "Second" brings "First" back into history, title intact.
    guest.post(f"/api/chat-history/{sessions[0]['id']}/open",
               json={"bucket": key, "messages": first, "title": "First"})
    assert guest.get(f"/api/chats/{key}").json()["title"] == "Second"
    assert [s["title"] for s in _sessions(guest, key)] == ["First"]
    assert guest.post("/api/chat-history/nope/open", json={"bucket": key}).status_code == 404


def test_rename_and_delete_history(guest):
    key = "home:hist/manage"
    entry_id = guest.post("/api/chat-history/archive",
                          json={"bucket": key, "messages": _msgs("q")}).json()["id"]
    assert guest.put(f"/api/chat-history/{entry_id}", json={"title": "Renamed"}).status_code == 200
    assert _sessions(guest, key)[0]["title"] == "Renamed"
    assert guest.put("/api/chat-history/missing", json={"title": "x"}).status_code == 404
    assert guest.delete(f"/api/chat-history/{entry_id}").status_code == 200
    assert _sessions(guest, key) == []


def test_history_is_per_bucket(guest):
    guest.post("/api/chat-history/archive", json={"bucket": "home:hist/a", "messages": _msgs("A")})
    guest.post("/api/chat-history/archive", json={"bucket": "home:hist/b", "messages": _msgs("B")})
    assert [s["title"] for s in _sessions(guest, "home:hist/a")] == ["A"]
    assert [s["title"] for s in _sessions(guest, "home:hist/b")] == ["B"]
    assert guest.post("/api/chat-history/archive", json={"bucket": "", "messages": _msgs("x")}).status_code == 400


def test_folder_rename_carries_history(guest):
    guest.post("/api/chat-history/archive", json={"bucket": "home:hr", "messages": _msgs("root")})
    guest.post("/api/chat-history/archive", json={"bucket": "home:hr/sub", "messages": _msgs("sub")})
    guest.post("/api/chat-history/archive", json={"bucket": "home:hrx", "messages": _msgs("other")})
    r = guest.post("/api/chats/folder-rename", json={"src": "hr", "dst": "hr2"})
    assert r.status_code == 200 and r.json()["history_moved"] == 2
    assert _sessions(guest, "home:hr") == [] and _sessions(guest, "home:hr/sub") == []
    assert [s["title"] for s in _sessions(guest, "home:hr2")] == ["root"]
    assert [s["title"] for s in _sessions(guest, "home:hr2/sub")] == ["sub"]
    assert [s["title"] for s in _sessions(guest, "home:hrx")] == ["other"]
    guest.post("/api/chats/folder-rename", json={"src": "hr2", "dst": ""})
    assert _sessions(guest, "home:hr2") == [] and _sessions(guest, "home:hr2/sub") == []


def test_page_delete_drops_its_history(guest):
    page = guest.post("/api/pages", json={"content": "Chatty page"}).json()
    guest.put(f"/api/chats/{page['id']}", json={"messages": _msgs("active")})
    guest.post("/api/chat-history/archive", json={"bucket": page["id"], "messages": _msgs("old")})
    assert len(_sessions(guest, page["id"])) == 1
    assert guest.delete(f"/api/blocks/{page['id']}").status_code == 200
    assert _sessions(guest, page["id"]) == []
    assert guest.get(f"/api/chats/{page['id']}").json()["messages"] == []

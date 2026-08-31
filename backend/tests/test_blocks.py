"""Core data model: block CRUD, tree replacement, ordering, search,
and the cleanup that must happen on delete."""

from fastapi.testclient import TestClient

from conftest import login, make_page, make_user


def test_create_and_subtree(guest):
    page = make_page(guest, "Tree page")
    tree = [
        {
            "id": "n1",
            "content": "parent note",
            "properties": {},
            "children": [
                {"id": "n2", "content": "child note", "properties": {}, "children": []},
            ],
        },
    ]
    r = guest.put(f"/api/blocks/{page['id']}/children", json={"blocks": tree})
    assert r.status_code == 200
    r = guest.get(f"/api/blocks/{page['id']}/subtree")
    assert r.status_code == 200
    kids = r.json()["block"]["children"]
    assert kids[0]["content"] == "parent note"
    assert kids[0]["children"][0]["content"] == "child note"


def test_sibling_order_is_lexicographic_on_position(guest):
    page = make_page(guest, "Order page")
    first = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "first"}).json()
    second = guest.post(
        "/api/blocks",
        json={
            "parent_id": page["id"],
            "content": "second",
            "before": first["position"],
        },
    ).json()
    assert first["position"] < second["position"]
    # insert BETWEEN first and second
    middle = guest.post(
        "/api/blocks",
        json={
            "parent_id": page["id"],
            "content": "middle",
            "before": first["position"],
            "after": second["position"],
        },
    ).json()
    assert first["position"] < middle["position"] < second["position"]
    r = guest.get(f"/api/blocks/{page['id']}/children")
    contents = [b["content"] for b in r.json()["children"]]
    assert contents == ["first", "middle", "second"]


def test_block_search(guest):
    page = make_page(guest, "Search page")
    guest.post("/api/blocks", json={"parent_id": page["id"], "content": "the zorbly quux appears"})
    r = guest.get("/api/block-search", params={"q": "zorbly"})
    assert any("zorbly" in b["content"] for b in r.json()["blocks"])
    # case-sensitive: no match for wrong case
    r = guest.get("/api/block-search", params={"q": "ZORBLY", "case": 1})
    assert not any("zorbly" in b["content"] for b in r.json()["blocks"])


def test_empty_block_search_returns_bounded_recent_blocks(guest):
    older = make_page(guest, "Recent older page")
    newer = make_page(guest, "Recent newer page")
    guest.post("/api/blocks", json={"parent_id": newer["id"], "content": ""})

    r = guest.get("/api/block-search", params={"q": "", "limit": 1})
    assert r.status_code == 200
    assert [b["id"] for b in r.json()["blocks"]] == [newer["id"]]

    # Negative and excessive limits remain bounded rather than invoking
    # SQLite's negative-LIMIT "no limit" behavior.
    assert len(guest.get("/api/block-search", params={"limit": -1}).json()["blocks"]) >= 1
    assert len(guest.get("/api/block-search", params={"limit": 5000}).json()["blocks"]) <= 50
    assert older["id"] != newer["id"]


def test_empty_block_search_requires_auth_and_is_user_scoped(client):
    make_user("recent_a", "recent-a-password")
    make_user("recent_b", "recent-b-password")
    alice = login("recent_a", "recent-a-password")
    bob = login("recent_b", "recent-b-password")
    try:
        make_page(alice, "Alice recent secret")
        make_page(bob, "Bob recent secret")

        anon = TestClient(alice.app)
        try:
            assert anon.get("/api/block-search").status_code == 401
        finally:
            anon.close()

        alice_text = [b["content"] for b in alice.get("/api/block-search").json()["blocks"]]
        bob_text = [b["content"] for b in bob.get("/api/block-search").json()["blocks"]]
        assert "Alice recent secret" in alice_text and "Bob recent secret" not in alice_text
        assert "Bob recent secret" in bob_text and "Alice recent secret" not in bob_text
    finally:
        alice.close()
        bob.close()


def test_block_search_is_separator_tolerant(guest):
    page = make_page(guest, "Continuous operation of a coherent 3,000-qubit system")
    r = guest.get("/api/block-search", params={"q": "3000"})
    hit = next((b for b in r.json()["blocks"] if b["id"] == page["id"]), None)
    assert hit, "'3000' should match the '3,000-qubit' title"
    assert hit["kind"] == "page"


def test_block_search_reports_kinds(guest):
    page = make_page(guest, "Kinds page")
    guest.post("/api/blocks", json={"parent_id": page["id"], "content": "a plaino note"})
    r = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "a hilite quote"})
    guest.put(f"/api/blocks/{r.json()['id']}", json={"properties": {"highlight_id": "h1"}})
    r = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "a linky region"})
    guest.put(f"/api/blocks/{r.json()['id']}", json={"properties": {"highlight_id": "h2", "link_page_id": page["id"]}})

    kinds = {
        b["content"]: b["kind"]
        for b in guest.get("/api/block-search", params={"q": "plaino|hilite|linky", "regex": 1, "limit": 50}).json()[
            "blocks"
        ]
    }
    assert kinds["a plaino note"] == "note"
    assert kinds["a hilite quote"] == "highlight"
    assert kinds["a linky region"] == "link"


def test_delete_purges_chats(guest):
    page = make_page(guest, "Doomed page")
    r = guest.put(f"/api/chats/{page['id']}", json={"messages": [{"role": "user", "text": "hi"}]})
    assert r.status_code == 200
    assert guest.get(f"/api/chats/{page['id']}").json()["messages"]
    r = guest.delete(f"/api/blocks/{page['id']}")
    assert r.status_code == 200
    assert guest.get(f"/api/chats/{page['id']}").json()["messages"] == []


def test_properties_merge_not_replace(guest):
    page = make_page(guest, "Props page", properties={"folder": "A"})
    guest.put(f"/api/blocks/{page['id']}", json={"properties": {"category": "x"}})
    r = guest.get(f"/api/blocks/{page['id']}/subtree")
    props = r.json()["block"]["properties"]
    assert props["folder"] == "A" and props["category"] == "x"

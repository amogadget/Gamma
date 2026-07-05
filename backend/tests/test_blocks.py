"""Core data model: block CRUD, tree replacement, ordering, search, replace,
and the cleanup that must happen on delete."""

from conftest import make_page


def test_create_and_subtree(guest):
    page = make_page(guest, "Tree page")
    tree = [
        {"id": "n1", "content": "parent note", "properties": {}, "children": [
            {"id": "n2", "content": "child note", "properties": {}, "children": []},
        ]},
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
    second = guest.post("/api/blocks", json={
        "parent_id": page["id"], "content": "second", "before": first["position"],
    }).json()
    assert first["position"] < second["position"]
    # insert BETWEEN first and second
    middle = guest.post("/api/blocks", json={
        "parent_id": page["id"], "content": "middle",
        "before": first["position"], "after": second["position"],
    }).json()
    assert first["position"] < middle["position"] < second["position"]
    r = guest.get(f"/api/blocks/{page['id']}/children")
    contents = [b["content"] for b in r.json()["children"]]
    assert contents == ["first", "middle", "second"]


def test_block_search_and_replace(guest):
    page = make_page(guest, "Search page")
    guest.post("/api/blocks", json={"parent_id": page["id"], "content": "the zorbly quux appears"})
    r = guest.get("/api/block-search", params={"q": "zorbly"})
    assert any("zorbly" in b["content"] for b in r.json()["blocks"])
    # case-sensitive: no match for wrong case
    r = guest.get("/api/block-search", params={"q": "ZORBLY", "case": 1})
    assert not any("zorbly" in b["content"] for b in r.json()["blocks"])
    # replace across notes
    r = guest.post("/api/blocks-replace", json={"query": "zorbly", "replacement": "shiny"})
    assert r.status_code == 200 and r.json()["changed"] >= 1
    r = guest.get("/api/block-search", params={"q": "shiny quux"})
    assert any("shiny quux" in b["content"] for b in r.json()["blocks"])


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

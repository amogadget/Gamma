"""The mirror's edge cases (docs/dev/mirror.md): two people editing at
once, typing while a round is in flight, moves against deletes, the same
position taken on both sides, a title renamed on both sides, props against
text, a round cut short between the push and its bookkeeping, a block moved
to another page while edited here, resolving a conflict after further
typing. Every case ends with both sides holding the same tree and nothing
written on either side lost."""
from fractional_indexing import generate_key_between
from gamma import sync_engine
from gamma.integrations import create_token
from test_mirror import Side, _pair, _sync, _transport  # noqa: F401 — the transport fixture applies here too


def flat(node, out=None):
    """``{id: {parent, content, props}}`` of every block under a subtree node."""
    out = {} if out is None else out
    for c in node.get("children", []):
        out[c["id"]] = {"parent": node["id"], "content": c["content"], "props": c.get("properties") or {}}
        flat(c, out)
    return out


def same_tree(remote, local, page_id):
    a, b = flat(remote.tree(page_id)), flat(local.tree(page_id))
    assert {k: (v["parent"], v["content"]) for k, v in a.items()} == {k: (v["parent"], v["content"]) for k, v in b.items()}
    assert [c["id"] for c in remote.tree(page_id)["children"]] == [c["id"] for c in local.tree(page_id)["children"]]
    return a


def conflicts(local):
    return local.client.get(f"/api/mirrors/{local.ws}/conflicts").json()["conflicts"]


def test_typing_while_a_round_pushes_is_kept_and_merged(monkeypatch):
    remote, local, _ = _pair()
    page = remote.page("Busy")
    remote.insert(page["id"], "b1", "alpha beta gamma")
    _sync(local)
    local.ops(page["id"], [{"op": "set", "id": "b1", "content": "alpha beta gamma LOCAL"}])
    real_push = sync_engine._push

    def push_with_interference(remote_, page_id, ops):
        # the remote edits the same block just before our batch lands, and we keep typing meanwhile
        remote.ops(page_id, [{"op": "set", "id": "b1", "content": "REMOTE alpha beta gamma"}])
        real_push(remote_, page_id, ops)
        local.ops(page_id, [{"op": "set", "id": "b1", "content": "alpha beta gamma LOCAL more", "base": "alpha beta gamma LOCAL"}])
    monkeypatch.setattr(sync_engine, "_push", push_with_interference)
    _sync(local)
    monkeypatch.setattr(sync_engine, "_push", real_push)
    assert local.texts(page["id"])["b1"] == "REMOTE alpha beta gamma LOCAL more"
    assert local.client.get(f"/api/mirrors/{local.ws}").json()["pending_local"] is True  # the typing came after the round started
    _sync(local)
    assert remote.texts(page["id"])["b1"] == "REMOTE alpha beta gamma LOCAL more"
    same_tree(remote, local, page["id"])
    assert local.client.get(f"/api/mirrors/{local.ws}").json()["pending_local"] is False


def test_two_clones_of_one_remote_edit_the_same_blocks():
    remote, a, _ = _pair()
    token = create_token(remote.name, remote.ws, "mirror-b", 90, scope="write")["token"]
    b = Side("mr_edge_b")
    r = b.client.post("/api/mirrors", json={"remote_url": "http://testserver", "token": token, "mode": "two-way"})
    assert r.status_code == 201, r.text
    b.bind(r.json()["workspace_id"])
    page = remote.page("Shared")
    remote.insert(page["id"], "s1", "one two three")
    remote.insert(page["id"], "s2", "second")
    _sync(a)
    _sync(b)
    a.ops(page["id"], [{"op": "set", "id": "s1", "content": "A one two three"}, {"op": "set", "id": "s2", "content": "second (A)"}])
    b.ops(page["id"], [{"op": "set", "id": "s1", "content": "one two three B"}, {"op": "delete", "id": "s2"}])
    for side in (a, b, a, b):
        _sync(side)
    for side in (remote, a, b):
        t = side.texts(page["id"])
        assert t["s1"] == "A one two three B", side.name
        assert t["s2"] == "second (A)", side.name  # A's edit beat B's delete
    assert {c["kind"] for c in conflicts(b)} == {"merged", "restored_remote_edit"}
    assert conflicts(a) == []


def test_a_move_here_beats_a_delete_there():
    remote, local, _ = _pair()
    page = remote.page("Moves")
    remote.insert(page["id"], "m1", "parent one", position="a0")
    remote.insert(page["id"], "m2", "parent two", position="a1")
    remote.insert(page["id"], "m3", "child", parent="m1")
    _sync(local)
    local.ops(page["id"], [{"op": "move", "id": "m3", "parent": "m2", "position": "a0"}])
    remote.ops(page["id"], [{"op": "delete", "id": "m3"}])
    _sync(local)
    t = same_tree(remote, local, page["id"])
    assert t["m3"]["parent"] == "m2"
    assert [c["kind"] for c in conflicts(local)] == ["kept_local_edit"]


def test_a_child_added_there_restores_a_subtree_deleted_here():
    remote, local, _ = _pair()
    page = remote.page("Restore")
    remote.insert(page["id"], "r1", "section")
    remote.insert(page["id"], "r2", "old child", parent="r1")
    _sync(local)
    local.ops(page["id"], [{"op": "delete", "id": "r1"}])
    remote.insert(page["id"], "r3", "new child", parent="r1")
    _sync(local)
    t = same_tree(remote, local, page["id"])
    assert t["r1"]["content"] == "section" and t["r2"]["parent"] == "r1" and t["r3"]["parent"] == "r1"
    assert [c["kind"] for c in conflicts(local)] == ["restored_remote_edit"]


def test_a_subtree_deleted_on_both_sides_is_simply_gone():
    remote, local, _ = _pair()
    page = remote.page("Both delete")
    remote.insert(page["id"], "d1", "doomed")
    remote.insert(page["id"], "d2", "child", parent="d1")
    remote.insert(page["id"], "d3", "kept")
    _sync(local)
    remote.ops(page["id"], [{"op": "delete", "id": "d1"}])
    local.ops(page["id"], [{"op": "delete", "id": "d1"}])
    st = _sync(local)
    assert set(same_tree(remote, local, page["id"])) == {"d3"}
    assert conflicts(local) == [] and st["blocks_removed"] == 0


def test_blocks_inserted_at_the_same_position_on_both_sides_both_survive():
    remote, local, _ = _pair()
    page = remote.page("Positions")
    remote.insert(page["id"], "p1", "first", position="a0")
    _sync(local)
    remote.ops(page["id"], [{"op": "insert", "id": "pR", "parent": page["id"], "position": "a1", "content": "remote's"}])
    local.ops(page["id"], [{"op": "insert", "id": "pL", "parent": page["id"], "position": "a1", "content": "local's"}])
    _sync(local)
    assert set(same_tree(remote, local, page["id"])) == {"p1", "pR", "pL"}
    st = _sync(local)
    assert (st["pages_pulled"], st["pages_pushed"]) == (0, 0)  # settled in one round


def test_the_page_title_merges_when_both_sides_rename():
    remote, local, _ = _pair()
    page = remote.page("Draft title")
    _sync(local)
    remote.ops(page["id"], [{"op": "set", "id": page["id"], "content": "Draft title (remote)"}])
    local.ops(page["id"], [{"op": "set", "id": page["id"], "content": "Local: Draft title"}])
    _sync(local)
    title = "Local: Draft title (remote)"
    assert remote.tree(page["id"])["content"] == title and local.tree(page["id"])["content"] == title
    assert [(c["kind"], c["block_id"], c["base"]) for c in conflicts(local)] == [("merged", page["id"], "Draft title")]


def test_props_changed_here_and_text_changed_there_both_survive():
    remote, local, _ = _pair()
    page = remote.page("Props")
    remote.ops(page["id"], [{"op": "insert", "id": "h1", "parent": page["id"], "position": "a0",
                             "content": "a highlight", "props": {"color": "yellow", "highlight_id": "hl-1"}}])
    _sync(local)
    local.ops(page["id"], [{"op": "set", "id": "h1", "props": {"color": "green"}}])
    remote.ops(page["id"], [{"op": "set", "id": "h1", "content": "a highlight, annotated"}])
    _sync(local)
    for side in (remote, local):
        t = flat(side.tree(page["id"]))["h1"]
        assert (t["content"], t["props"]["color"], t["props"]["highlight_id"]) == ("a highlight, annotated", "green", "hl-1"), side.name
    assert conflicts(local) == []


def test_the_same_edit_made_on_both_sides_is_not_doubled():
    remote, local, _ = _pair()
    page = remote.page("Same edit")
    remote.insert(page["id"], "e1", "one")
    _sync(local)
    remote.ops(page["id"], [{"op": "set", "id": "e1", "content": "one (more)"}])
    local.ops(page["id"], [{"op": "set", "id": "e1", "content": "one (more)"}])
    _sync(local)
    assert remote.texts(page["id"])["e1"] == "one (more)" and local.texts(page["id"])["e1"] == "one (more)"
    assert conflicts(local) == []


def test_a_round_cut_short_after_the_push_is_repaired_by_the_next(monkeypatch):
    remote, local, _ = _pair()
    page = remote.page("Cut")
    remote.insert(page["id"], "c1", "one", position="a0")
    _sync(local)
    local.insert(page["id"], "c2", "two (local)", position="a1")
    local.ops(page["id"], [{"op": "set", "id": "c1", "content": "one (local)"}])
    real_save = sync_engine._save_state
    calls = {"n": 0}

    def flaky(conn, page_id, seq, base):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("disk full")
        real_save(conn, page_id, seq, base)
    monkeypatch.setattr(sync_engine, "_save_state", flaky)
    st = local.client.post(f"/api/mirrors/{local.ws}/sync?wait=1").json()["status"]
    assert "disk full" in st["last_error"] and page["id"] in st["retry"]
    assert remote.texts(page["id"]) == {"c1": "one (local)", "c2": "two (local)"}  # the push had landed
    _sync(local)
    assert same_tree(remote, local, page["id"]) and local.texts(page["id"]) == {"c1": "one (local)", "c2": "two (local)"}
    assert conflicts(local) == []


def test_resolving_a_conflict_after_more_typing_keeps_the_typing():
    remote, local, _ = _pair()
    page = remote.page("Late resolve")
    remote.insert(page["id"], "t1", "alpha beta gamma delta")
    _sync(local)
    remote.ops(page["id"], [{"op": "set", "id": "t1", "content": "ALPHA beta gamma delta"}])
    local.ops(page["id"], [{"op": "set", "id": "t1", "content": "alpha beta gamma DELTA"}])
    _sync(local)
    c = conflicts(local)
    assert [x["kind"] for x in c] == ["merged"] and local.texts(page["id"])["t1"] == "ALPHA beta gamma DELTA"
    # more typing lands on the merged text before the person looks at the conflict
    local.ops(page["id"], [{"op": "set", "id": "t1", "content": "ALPHA beta gamma DELTA epsilon", "base": "ALPHA beta gamma DELTA"}])
    r = local.client.post(f"/api/mirrors/{local.ws}/conflicts/{c[0]['id']}", json={"choice": "theirs"})
    assert r.status_code == 200
    # the remote's version is put back, but the words typed since stay
    assert local.texts(page["id"])["t1"] == "ALPHA beta gamma delta epsilon"
    _sync(local)
    assert remote.texts(page["id"])["t1"] == "ALPHA beta gamma delta epsilon"


def test_a_block_moved_to_another_page_there_while_edited_here():
    remote, local, _ = _pair()
    a = remote.page("Page A")
    b = remote.page("Page B")
    remote.insert(a["id"], "x1", "travelling block")
    _sync(local)
    local.ops(a["id"], [{"op": "set", "id": "x1", "content": "travelling block (edited here)"}])
    r = remote.client.post("/api/blocks/x1/reorder", json={"parent_id": b["id"]})
    assert r.status_code == 200, r.text
    # the page whose block left may wait for the next round (its push is refused, quietly)
    # while the page that received it moves the block over; nothing is an error
    st = _sync(local)
    assert not st.get("last_error")
    st = _sync(local)
    assert not st.get("retry"), st  # nothing stuck
    # the block lives in exactly one page on each side, the same page on both, with the edit
    homes = {}
    for side in (remote, local):
        pages = [p for p in (a["id"], b["id"]) if "x1" in flat(side.tree(p))]
        assert len(pages) == 1, (side.name, pages)
        homes[side.name] = pages[0]
        assert flat(side.tree(pages[0]))["x1"]["content"] == "travelling block (edited here)", side.name
    assert len(set(homes.values())) == 1
    for p in (a["id"], b["id"]):
        same_tree(remote, local, p)


def test_edits_during_an_unreachable_remote_stay_pending_and_land_later(monkeypatch):
    remote, local, _ = _pair()
    page = remote.page("Offline")
    remote.insert(page["id"], "o1", "text")
    _sync(local)
    local.ops(page["id"], [{"op": "set", "id": "o1", "content": "text (typed on the train)"}])
    real = sync_engine.default_fetch

    def down(method, path, body, headers):
        raise ConnectionError("cannot reach the remote")
    monkeypatch.setattr(sync_engine, "default_fetch", down)
    st = local.client.post(f"/api/mirrors/{local.ws}/sync?wait=1").json()["status"]
    assert st["last_error"]
    assert local.client.get(f"/api/mirrors/{local.ws}").json()["pending_local"] is True
    monkeypatch.setattr(sync_engine, "default_fetch", real)
    _sync(local)
    assert remote.texts(page["id"])["o1"] == "text (typed on the train)"
    assert local.client.get(f"/api/mirrors/{local.ws}").json()["pending_local"] is False

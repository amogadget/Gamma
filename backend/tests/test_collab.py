"""Collaborative editing: the op batch write (gamma/ops.py), the per-page op
log and its catch-up read, the page websocket (presence + fan-out), and the
server-side writers that must reach a page's room."""

import pytest
from fractional_indexing import generate_key_between
from starlette.websockets import WebSocketDisconnect

from conftest import login, make_page, make_user, workspace_of

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       b"\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82")


def _ops(client, page_id, ops, client_id="t", **kw):
    return client.post(f"/api/pages/{page_id}/ops", json={"client": client_id, "ops": ops}, **kw)


def _tree(client, page_id, **kw):
    return client.get(f"/api/blocks/{page_id}/subtree", **kw).json()["block"]["children"]


def _keys(n):
    keys, prev = [], None
    for _ in range(n):
        prev = generate_key_between(prev, None)
        keys.append(prev)
    return keys


# --- the op batch --------------------------------------------------------------

def test_ops_batch_insert_set_move_delete(guest):
    page = make_page(guest, "Ops page")
    k1, k2, k3 = _keys(3)
    r = _ops(guest, page["id"], [
        {"op": "insert", "id": "opA", "parent": page["id"], "position": k1, "content": "a"},
        {"op": "insert", "id": "opB", "parent": page["id"], "position": k2, "content": "b",
         "props": {"color": "red", "quote": "q"}},
        {"op": "insert", "id": "opC", "parent": page["id"], "position": k3, "content": "c"},
    ])
    assert r.status_code == 200, r.text
    assert r.json()["seq"] == 1
    assert [o["position"] for o in r.json()["ops"]] == [k1, k2, k3]

    # set: content is one value, props is a patch (null deletes a key)
    r = _ops(guest, page["id"], [{"op": "set", "id": "opB", "content": "b2", "props": {"quote": None, "n": 1}}])
    assert r.status_code == 200 and r.json()["seq"] == 2
    b = guest.get("/api/blocks/opB").json()
    assert b["content"] == "b2" and b["properties"] == {"color": "red", "n": 1}

    # move: C under A, then delete A's subtree
    r = _ops(guest, page["id"], [{"op": "move", "id": "opC", "parent": "opA"}])
    assert r.status_code == 200
    kids = _tree(guest, page["id"])
    assert [c["id"] for c in kids] == ["opA", "opB"]
    assert [c["id"] for c in kids[0]["children"]] == ["opC"]
    r = _ops(guest, page["id"], [{"op": "delete", "id": "opA"}])
    assert r.status_code == 200 and r.json()["seq"] == 4
    assert [c["id"] for c in _tree(guest, page["id"])] == ["opB"]
    assert guest.get("/api/blocks/opC").status_code == 404

    # the log holds every batch, per page, and catch-up reads after a seq
    log = guest.get(f"/api/pages/{page['id']}/ops", params={"since": 0}).json()
    assert log["seq"] == 4 and [b["seq"] for b in log["batches"]] == [1, 2, 3, 4]
    assert log["batches"][0]["client"] == "t" and log["batches"][0]["actor"] == "guest"
    assert log["batches"][3]["ops"] == [{"op": "delete", "id": "opA"}]
    tail = guest.get(f"/api/pages/{page['id']}/ops", params={"since": 3}).json()
    assert [b["seq"] for b in tail["batches"]] == [4]
    assert guest.get(f"/api/pages/{page['id']}/ops", params={"since": 4}).json()["batches"] == []
    # the tree fetch says which log position it reflects
    assert guest.get(f"/api/blocks/{page['id']}/subtree").json()["seq"] == 4
    assert "seq" not in guest.get("/api/blocks/opB/subtree").json()
    # another page has its own sequence
    other = make_page(guest, "Other ops page")
    assert _ops(guest, other["id"], [{"op": "insert", "id": "opZ", "parent": other["id"], "content": "z"}]).json()["seq"] == 1


def test_ops_position_collision_is_rekeyed(guest):
    page = make_page(guest, "Collision page")
    (k,) = _keys(1)
    assert _ops(guest, page["id"], [{"op": "insert", "id": "colA", "parent": page["id"], "position": k, "content": "first"}]).status_code == 200
    r = _ops(guest, page["id"], [{"op": "insert", "id": "colB", "parent": page["id"], "position": k, "content": "second"}])
    assert r.status_code == 200
    applied = r.json()["ops"][0]["position"]
    assert applied != k and applied > k  # the echo carries the final key
    assert [c["content"] for c in _tree(guest, page["id"])] == ["first", "second"]
    # a move onto an occupied key is re-keyed the same way (lands right after it)
    assert _ops(guest, page["id"], [{"op": "insert", "id": "colC", "parent": page["id"], "content": "third"}]).status_code == 200
    r = _ops(guest, page["id"], [{"op": "move", "id": "colC", "parent": page["id"], "position": k}])
    assert r.status_code == 200
    assert [c["content"] for c in _tree(guest, page["id"])] == ["first", "third", "second"]
    # a missing position appends
    assert _ops(guest, page["id"], [{"op": "insert", "id": "colD", "parent": page["id"], "content": "last"}]).status_code == 200
    assert [c["content"] for c in _tree(guest, page["id"])][-1] == "last"


def test_ops_rejects_bad_structure(guest):
    page = make_page(guest, "Rules page")
    other = make_page(guest, "Rules other")
    assert _ops(guest, page["id"], [
        {"op": "insert", "id": "ruA", "parent": page["id"], "content": "a"},
        {"op": "insert", "id": "ruB", "parent": "ruA", "content": "b"},
    ]).status_code == 200
    # cycle
    r = _ops(guest, page["id"], [{"op": "move", "id": "ruA", "parent": "ruB"}])
    assert r.status_code == 400 and "subtree" in r.json()["detail"]
    # the page itself is never moved / deleted / re-inserted through ops
    assert _ops(guest, page["id"], [{"op": "move", "id": page["id"], "parent": "ruA"}]).status_code == 403
    assert _ops(guest, page["id"], [{"op": "delete", "id": page["id"]}]).status_code == 403
    # ops never create pages
    assert _ops(guest, page["id"], [{"op": "insert", "id": "ruP", "parent": "root", "content": "p"}]).status_code == 403
    # blocks of another page are out of reach, unknown ones are 404
    assert _ops(guest, page["id"], [{"op": "set", "id": other["id"], "content": "x"}]).status_code == 403
    assert _ops(guest, page["id"], [{"op": "set", "id": "nope", "content": "x"}]).status_code == 404
    assert _ops(guest, page["id"], [{"op": "insert", "id": "ruC", "parent": other["id"], "content": "c"}]).status_code == 403
    # a bad batch writes nothing (the earlier op in it is rolled back)
    seq = guest.get(f"/api/pages/{page['id']}/ops").json()["seq"]
    r = _ops(guest, page["id"], [
        {"op": "set", "id": "ruA", "content": "rolled back"},
        {"op": "insert", "id": "bad id!", "parent": page["id"], "content": "x"},
    ])
    assert r.status_code == 400
    assert guest.get("/api/blocks/ruA").json()["content"] == "a"
    assert guest.get(f"/api/pages/{page['id']}/ops").json()["seq"] == seq
    # empty / oversized batches, unknown ops (pydantic: 422), not a page (404)
    assert _ops(guest, page["id"], []).status_code == 400
    assert _ops(guest, page["id"], [{"op": "explode", "id": "ruA"}]).status_code == 422
    assert _ops(guest, "ruA", [{"op": "set", "id": "ruB", "content": "x"}]).status_code == 404
    # deleting a block that is already gone is a no-op (a retried batch)
    assert _ops(guest, page["id"], [{"op": "delete", "id": "gone"}]).status_code == 200


def test_ops_touch_only_changed_rows(guest):
    page = make_page(guest, "Stamp page")
    assert _ops(guest, page["id"], [
        {"op": "insert", "id": "stA", "parent": page["id"], "content": "a"},
        {"op": "insert", "id": "stB", "parent": page["id"], "content": "b"},
    ]).status_code == 200
    before_a = guest.get("/api/blocks/stA").json()["updated_at"]
    before_b = guest.get("/api/blocks/stB").json()["updated_at"]
    before_page = guest.get(f"/api/blocks/{page['id']}").json()["updated_at"]
    r = _ops(guest, page["id"], [{"op": "set", "id": "stB", "content": "b2"}])
    assert r.status_code == 200
    assert guest.get("/api/blocks/stA").json()["updated_at"] == before_a
    assert guest.get("/api/blocks/stB").json()["updated_at"] == r.json()["at"] != before_b
    # the page root is stamped once per batch (home-feed order, index fingerprint)
    assert guest.get(f"/api/blocks/{page['id']}").json()["updated_at"] == r.json()["at"] != before_page
    # created_at survives a set
    assert guest.get("/api/blocks/stB").json()["created_at"] < r.json()["at"]


def test_ops_insert_retry_is_idempotent(guest):
    page = make_page(guest, "Retry page")
    batch = [{"op": "insert", "id": "reA", "parent": page["id"], "content": "a", "props": {"k": 1}}]
    first = _ops(guest, page["id"], batch)
    assert first.status_code == 200
    r = _ops(guest, page["id"], batch)  # the network ate the first response
    assert r.status_code == 200 and r.json()["seq"] == first.json()["seq"] + 1
    kids = _tree(guest, page["id"])
    assert len(kids) == 1 and kids[0]["properties"] == {"k": 1}


def test_ops_delete_sweeps_orphan_uploads(guest):
    page = make_page(guest, "Sweep page")
    url = guest.post("/api/upload-image", files={"file": ("dot.png", PNG, "image/png")}).json()["url"]
    name = url.rsplit("/", 1)[-1]
    assert _ops(guest, page["id"], [{"op": "insert", "id": "swA", "parent": page["id"], "content": f"![]({url})"}]).status_code == 200
    # editing the text away drops the reference → swept
    r = _ops(guest, page["id"], [{"op": "set", "id": "swA", "content": "plain"}])
    assert name in r.json()["removed_uploads"]
    # a plain text edit sweeps nothing (no reference could have gone)
    assert _ops(guest, page["id"], [{"op": "set", "id": "swA", "content": "plainer"}]).json()["removed_uploads"] == []


def test_ops_log_prunes_and_catchup_reports_gap(guest, monkeypatch):
    from gamma import ops
    monkeypatch.setattr(ops, "KEEP_OPS", 3)
    monkeypatch.setattr(ops, "PRUNE_EVERY", 1)
    page = make_page(guest, "Prune page")
    for i in range(6):
        assert _ops(guest, page["id"], [{"op": "insert", "id": f"pr{i}", "parent": page["id"], "content": str(i)}]).status_code == 200
    log = guest.get(f"/api/pages/{page['id']}/ops", params={"since": 3}).json()
    assert [b["seq"] for b in log["batches"]] == [4, 5, 6]
    assert guest.get(f"/api/pages/{page['id']}/ops", params={"since": 0}).status_code == 410
    assert guest.get(f"/api/pages/{page['id']}/ops", params={"since": 1}).status_code == 410


# --- shares --------------------------------------------------------------------

@pytest.fixture(scope="module")
def owner():
    make_user("owner_collab", "ownerpw12345")
    return login("owner_collab", "ownerpw12345")


@pytest.fixture(scope="module")
def editor():
    make_user("editor_collab", "editorpw1234")
    return login("editor_collab", "editorpw1234")


def _share(owner_client, page_id, **settings):
    r = owner_client.post(f"/api/share/{page_id}")
    assert r.status_code == 200, r.text
    if settings:
        r = owner_client.put(f"/api/share-settings/{page_id}", json=settings)
        assert r.status_code == 200, r.text
    return r.json()["token"]


def test_ops_share_editor_is_confined_to_the_page(owner, editor, client):
    page = make_page(owner, "Shared ops", properties={"doc_id": "shared_doc"})
    other = make_page(owner, "Owner private")
    token = _share(owner, page["id"], audience="list", users=[{"name": "editor_collab", "role": "edit"}])
    q = {"share": token}
    r = _ops(editor, page["id"], [{"op": "insert", "id": "shA", "parent": page["id"], "content": "from editor"}], params=q)
    assert r.status_code == 200, r.text
    assert owner.get(f"/api/pages/{page["id"]}/ops").json()["batches"][-1]["actor"] == "editor_collab"
    # rename yes, page properties no
    assert _ops(editor, page["id"], [{"op": "set", "id": page["id"], "content": "Renamed by editor"}], params=q).status_code == 200
    r = _ops(editor, page["id"], [{"op": "set", "id": page["id"], "props": {"doc_id": "evil"}}], params=q)
    assert r.status_code == 403
    assert owner.get(f"/api/blocks/{page['id']}").json()["properties"]["doc_id"] == "shared_doc"
    # nothing outside the page, with or without naming it
    assert _ops(editor, other["id"], [{"op": "insert", "id": "shB", "parent": other["id"], "content": "x"}], params=q).status_code == 403
    assert _ops(editor, page["id"], [{"op": "set", "id": other["id"], "content": "x"}], params=q).status_code == 403
    # the editor's own account never saw the page; the log is readable with the token
    assert editor.get(f"/api/pages/{page['id']}/ops").status_code == 404
    assert editor.get(f"/api/pages/{page['id']}/ops", params=q).status_code == 200
    # view-only and anonymous callers cannot write
    _share(owner, page["id"], audience="anyone", role="view", users=[])
    assert _ops(editor, page["id"], [{"op": "set", "id": "shA", "content": "x"}], params=q).status_code == 403
    from fastapi.testclient import TestClient
    from gamma.app import app
    anon = TestClient(app)
    assert _ops(anon, page["id"], [{"op": "set", "id": "shA", "content": "x"}], params=q).status_code == 403
    assert anon.get(f"/api/pages/{page['id']}/ops", params=q).status_code == 200


# --- the websocket -------------------------------------------------------------

def _recv(ws, kind):
    """Next message of a kind (skipping presence chatter)."""
    for _ in range(20):
        msg = ws.receive_json()
        if msg["t"] == kind:
            return msg
    raise AssertionError(f"no {kind} message")


def _hello(ws):
    """The hello a fresh socket receives; its seq is the page's log position,
    the base every later sequence number is checked against."""
    msg = ws.receive_json()
    assert msg["t"] == "hello"
    return msg


def test_socket_hello_and_fanout(guest):
    page = make_page(guest, "Socket page")
    with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=aa") as a:
        hello = _hello(a)
        assert hello["client"] == "aa"
        assert [p["client"] for p in hello["peers"]] == ["aa"] and hello["peers"][0]["name"] == "guest"
        with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=bb") as b:
            hb = _hello(b)
            assert hb["color"] != hello["color"] and {p["client"] for p in hb["peers"]} == {"aa", "bb"}
            assert _recv(a, "join")["peer"]["client"] == "bb"
            # a write reaches both, tagged with the writer's client id and the next seq
            r = _ops(guest, page["id"], [{"op": "insert", "id": "wsA", "parent": page["id"], "content": "hi"}], client_id="aa")
            assert r.status_code == 200
            for ws in (a, b):
                m = _recv(ws, "ops")
                assert m["seq"] == hello["seq"] + 1 and m["client"] == "aa" and m["actor"] == "guest"
                assert m["ops"][0]["id"] == "wsA" and m["ops"][0]["position"]
        assert _recv(a, "leave")["client"] == "bb"


def test_socket_cursor_presence(guest):
    page = make_page(guest, "Socket cursor page")
    assert _ops(guest, page["id"], [{"op": "insert", "id": "wsC", "parent": page["id"], "content": "hi"}]).status_code == 200
    with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=aa") as a, \
            guest.websocket_connect(f"/api/ws/page/{page['id']}?client=bb") as b:
        _hello(a), _hello(b)
        # a cursor travels to the others only
        a.send_json({"t": "cursor", "block": "wsC", "anchor": 1, "head": 2})
        assert _recv(b, "cursor") == {"t": "cursor", "client": "aa", "block": "wsC", "anchor": 1, "head": 2}
        # a later joiner sees it in the hello
        with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=cc") as c:
            assert next(p for p in _hello(c)["peers"] if p["client"] == "aa")["block"] == "wsC"
        assert _recv(a, "leave")["client"] == "cc"


def test_socket_cursor_rides_on_a_batch(guest):
    page = make_page(guest, "Socket batch cursor page")
    assert _ops(guest, page["id"], [{"op": "insert", "id": "wsR", "parent": page["id"], "content": "hi"}]).status_code == 200
    with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=aa") as a, \
            guest.websocket_connect(f"/api/ws/page/{page['id']}?client=bb") as b:
        _hello(a), _hello(b)
        # a caret sent with a batch rides along on the fan-out (to the writer
        # too — it is the batch's ack for the others' bookkeeping), and is
        # the writer's presence from then on
        r = guest.post(f"/api/pages/{page['id']}/ops", json={
            "client": "aa", "ops": [{"op": "set", "id": "wsR", "content": "hi there"}],
            "cursor": {"block": "wsR", "anchor": 8, "head": 8}})
        assert r.status_code == 200
        for ws in (a, b):
            m = _recv(ws, "ops")
            assert m["client"] == "aa" and m["cursor"] == {"block": "wsR", "anchor": 8, "head": 8}
        with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=cc") as c:
            pa = next(p for p in _hello(c)["peers"] if p["client"] == "aa")
            assert (pa["block"], pa["anchor"], pa["head"]) == ("wsR", 8, 8)
        assert _recv(a, "leave")["client"] == "cc"
        # a batch without one changes nothing about presence
        assert _ops(guest, page["id"], [{"op": "set", "id": "wsR", "content": "hi"}], client_id="aa").status_code == 200
        assert "cursor" not in _recv(b, "ops")


def test_socket_server_side_writers_reach_the_room(guest):
    """The single-block endpoints and the page writers publish ops too; a
    whole-subtree replace can't be expressed as ops and publishes a reload."""
    page = make_page(guest, "Socket writers page")
    assert _ops(guest, page["id"], [{"op": "insert", "id": "wsD", "parent": page["id"], "content": "hi"}]).status_code == 200
    with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=dd") as d:
        seq = _hello(d)["seq"]
        assert guest.put("/api/blocks/wsD", json={"content": "edited", "properties": {"x": 1}}).status_code == 200
        m = _recv(d, "ops")
        assert m["seq"] == seq + 1
        assert m["ops"] == [{"op": "set", "id": "wsD", "content": "edited", "props": {"x": 1}}]
        assert guest.put(f"/api/blocks/{page['id']}", json={"content": "Renamed socket page"}).status_code == 200
        assert _recv(d, "ops")["ops"][0] == {"op": "set", "id": page["id"], "content": "Renamed socket page"}
        assert guest.delete("/api/blocks/wsD").status_code == 200
        assert _recv(d, "ops")["ops"] == [{"op": "delete", "id": "wsD"}]
        assert guest.put(f"/api/blocks/{page['id']}/children", json={"blocks": [{"content": "bulk"}]}).status_code == 200
        reload = _recv(d, "reload")
        assert reload["seq"] == seq + 4  # one batch per write above
        log = guest.get(f"/api/pages/{page['id']}/ops", params={"since": reload["seq"] - 1}).json()
        assert log["batches"][0]["ops"] == [{"op": "reload"}]


def test_socket_cross_page_move_and_ai_edit(guest):
    src = make_page(guest, "Move src")
    dst = make_page(guest, "Move dst")
    blk = guest.post("/api/blocks", json={"parent_id": src["id"], "content": "travels"}).json()
    with guest.websocket_connect(f"/api/ws/page/{src['id']}?client=s") as s, \
            guest.websocket_connect(f"/api/ws/page/{dst['id']}?client=d") as d:
        s.receive_json(), d.receive_json()
        r = guest.post(f"/api/blocks/{blk['id']}/reorder", json={"parent_id": dst["id"], "before": None, "after": None})
        assert r.status_code == 200
        assert _recv(s, "ops")["ops"] == [{"op": "delete", "id": blk["id"]}]
        assert _recv(d, "reload")
        # an AI tool edit runs in a worker thread; its op still lands in the room
        from gamma.ai_tools import run_agent_tool
        text, action = run_agent_tool(workspace_of("guest"), {"type": "page", "page_id": dst["id"]}, "edit_block",
                                      {"block_id": blk["id"], "content": "travelled, edited by ai"})
        assert action["kind"] == "edit", text
        m = _recv(d, "ops")
        assert m["client"] == "ai" and m["ops"] == [{"op": "set", "id": blk["id"], "content": "travelled, edited by ai"}]


def test_socket_auth(guest, owner, editor):
    """A websocket session needs a running portal: clients made by login()
    are used outside a ``with``, so sockets open on context clients that
    carry the same cookies."""
    from fastapi.testclient import TestClient
    from gamma.app import app
    page = make_page(owner, "Socket auth page")
    other = make_page(owner, "Socket auth other")
    token = _share(owner, page["id"])
    with TestClient(app) as anon:
        # no session, no token → refused before accept
        with pytest.raises(WebSocketDisconnect):
            with anon.websocket_connect(f"/api/ws/page/{page['id']}"):
                pass
        # a view share admits anonymous viewers as presence-only peers
        with anon.websocket_connect(f"/api/ws/page/{page['id']}?share={token}") as ws:
            me = ws.receive_json()["peers"][0]
            assert me["name"] == "Anonymous" and me["user"] == "" and me["can_edit"] is False
        # the token only opens its own page
        with pytest.raises(WebSocketDisconnect):
            with anon.websocket_connect(f"/api/ws/page/{other['id']}?share={token}"):
                pass
    with TestClient(app, cookies=editor.cookies) as ed:
        # another account can't join someone else's page by id
        with pytest.raises(WebSocketDisconnect):
            with ed.websocket_connect(f"/api/ws/page/{page['id']}"):
                pass
        # an invited editor joins with edit rights under their own name
        _share(owner, page["id"], audience="list", users=[{"name": "editor_collab", "role": "edit"}])
        with ed.websocket_connect(f"/api/ws/page/{page['id']}?share={token}") as ws:
            me = ws.receive_json()["peers"][0]
            assert me["name"] == "editor_collab" and me["can_edit"] is True
    with TestClient(app, cookies=owner.cookies) as ow:
        with pytest.raises(WebSocketDisconnect):
            with ow.websocket_connect("/api/ws/page/nope"):
                pass


def test_set_with_base_merges_concurrent_edits(guest):
    from gamma import textmerge
    # the pure merge: different spans both survive, an equal base is a plain replace
    assert textmerge.merge("hello world", "hello brave world", "hello world!") == ("hello brave world!", True)
    assert textmerge.merge("hello world", "hello brave world", "hello world") == ("hello brave world", True)
    lines = lambda *xs: chr(10).join(xs)  # noqa: E731
    assert textmerge.merge(lines("a", "b", "c"), lines("a", "b", "c", "d"), lines("A", "b", "c"))[0] == lines("A", "b", "c", "d")
    assert textmerge.map_offset("hello world!", "hello brave world!", 12) == 18
    assert textmerge.map_offset("hello world!", "hello brave world!", 3) == 3

    page = make_page(guest, "Merge page")
    blk = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "hello world"}).json()
    # two clients edit from the same base: the second is merged, not replaced
    assert _ops(guest, page["id"], [{"op": "set", "id": blk["id"], "content": "hello brave world", "base": "hello world"}], client_id="a").status_code == 200
    r = _ops(guest, page["id"], [{"op": "set", "id": blk["id"], "content": "hello world!", "base": "hello world"}], client_id="b")
    assert r.status_code == 200
    assert r.json()["ops"] == [{"op": "set", "id": blk["id"], "content": "hello brave world!"}]  # merged text echoed, no base
    assert _tree(guest, page["id"])[0]["content"] == "hello brave world!"
    # a base equal to the current text, or no base at all: plain replace
    assert _ops(guest, page["id"], [{"op": "set", "id": blk["id"], "content": "fresh", "base": "hello brave world!"}]).status_code == 200
    assert _tree(guest, page["id"])[0]["content"] == "fresh"
    assert _ops(guest, page["id"], [{"op": "set", "id": blk["id"], "content": "plain"}]).status_code == 200
    assert _tree(guest, page["id"])[0]["content"] == "plain"
    # the log holds the merged text, never the base
    batches = guest.get(f"/api/pages/{page['id']}/ops", params={"since": 0}).json()["batches"]
    assert all("base" not in op for b in batches for op in b["ops"])
    assert batches[2]["ops"][0]["content"] == "hello brave world!"


def test_merged_batch_remaps_the_writers_caret(guest):
    page = make_page(guest, "Caret merge page")
    blk = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "hello world"}).json()
    with guest.websocket_connect(f"/api/ws/page/{page['id']}?client=w") as w:
        w.receive_json()
        assert _ops(guest, page["id"], [{"op": "set", "id": blk["id"], "content": "hello brave world", "base": "hello world"}], client_id="a").status_code == 200
        _recv(w, "ops")
        r = guest.post(f"/api/pages/{page['id']}/ops", json={
            "client": "b", "ops": [{"op": "set", "id": blk["id"], "content": "hello world!", "base": "hello world"}],
            "cursor": {"block": blk["id"], "anchor": 12, "head": 12}})
        assert r.status_code == 200
        m = _recv(w, "ops")
        assert m["ops"][0]["content"] == "hello brave world!"
        assert m["cursor"] == {"block": blk["id"], "anchor": 18, "head": 18}

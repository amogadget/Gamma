"""The mirror (gamma/sync_engine.py, routers/mirrors.py) end to end: a
workspace of one account is the "remote", a mirror workspace of another
account follows it through the real HTTP API — the engine's transport is
an in-process TestClient carrying the write token."""

import io

import pytest
from fastapi.testclient import TestClient
from fractional_indexing import generate_key_between

from conftest import login, make_user, workspace_of
from gamma import sync_engine
from gamma.db import connect_pages_db, ws_uploads_dir
from gamma.integrations import create_token

PDF = b"%PDF-1.4 mirror test\n" + b"m" * 1500


@pytest.fixture(autouse=True)
def _transport(monkeypatch):
    """The engine talks to "the remote" through a cookie-less TestClient."""
    from gamma.app import app
    c = TestClient(app)

    def fetch(method, path, body, headers):
        r = c.request(method, path, content=body, headers=headers)
        return r.status_code, r.content

    monkeypatch.setattr(sync_engine, "default_fetch", fetch)
    # rounds run only when a test asks (the create endpoint's background fill would race the inline ones)
    monkeypatch.setattr(sync_engine, "sync_in_background", lambda ws: None)


class Side:
    """One account with its personal workspace and a client bound to it."""

    def __init__(self, name):
        self.name = name
        self.ws = make_user(name, "pw")
        self.client = login(name, "pw")
        self.client.headers["X-Gamma-Workspace"] = self.ws

    def bind(self, ws):
        self.ws = ws
        self.client.headers["X-Gamma-Workspace"] = ws

    def page(self, title, **props):
        r = self.client.post("/api/pages", json={"title": title, "properties": props})
        assert r.status_code == 200, r.text
        return r.json()

    def ops(self, page_id, ops):
        r = self.client.post(f"/api/pages/{page_id}/ops", json={"client": "t", "ops": ops})
        assert r.status_code == 200, r.text
        return r.json()

    def insert(self, page_id, bid, content, parent=None, position=None):
        return self.ops(page_id, [{"op": "insert", "id": bid, "parent": parent or page_id,
                                   "position": position or generate_key_between(None, None), "content": content}])

    def tree(self, page_id):
        r = self.client.get(f"/api/blocks/{page_id}/subtree")
        return r.json()["block"] if r.status_code == 200 else None

    def texts(self, page_id):
        t = self.tree(page_id)
        return None if t is None else {c["id"]: c["content"] for c in t["children"]}

    def pages(self):
        return {b["id"]: b for b in self.client.get("/api/blocks/root/children").json()["children"]}


_n = [0]


def _pair(mode="two-way", scope="write"):
    """A remote side, a token on its workspace, and a local side whose
    mirror follows it (created through the API, first round run inline)."""
    _n[0] += 1
    remote = Side(f"mr_remote{_n[0]}")
    local = Side(f"mr_local{_n[0]}")
    token = create_token(remote.name, remote.ws, "mirror", 90, scope=scope)["token"]
    r = local.client.post("/api/mirrors", json={"remote_url": "http://testserver", "token": token, "mode": mode})
    assert r.status_code == 201, r.text
    mirror = r.json()
    local.bind(mirror["workspace_id"])
    return remote, local, mirror


def _sync(local):
    r = local.client.post(f"/api/mirrors/{local.ws}/sync?wait=1")
    assert r.status_code == 200, r.text
    status = r.json()["status"]
    assert not status.get("last_error"), status
    return status


def test_create_validates_the_remote_and_fills_the_copy():
    remote, local, mirror = _pair()
    assert mirror["remote_ws"] == remote.ws and mirror["mode"] == "two-way"
    assert mirror["status"]["remote_user"] == remote.name and mirror["name"].endswith("(offline copy)")
    page = remote.page("Paper A", folder="physics")
    remote.insert(page["id"], "blkA1", "first note")
    remote.insert(page["id"], "blkA2", "second note")
    status = _sync(local)
    assert status["pages_pulled"] >= 1
    assert local.texts(page["id"]) == {"blkA1": "first note", "blkA2": "second note"}
    assert local.pages()[page["id"]]["properties"]["folder"] == "physics"
    # a second round changes nothing and pushes nothing
    status = _sync(local)
    assert status["pages_pulled"] == 0 and status["pages_pushed"] == 0
    listed = local.client.get("/api/mirrors").json()["mirrors"]
    assert [m["workspace_id"] for m in listed] == [local.ws]
    bad = local.client.post("/api/mirrors", json={"remote_url": "http://testserver", "token": "gamma_wrong"})
    assert bad.status_code == 400


def test_edits_flow_both_ways_and_different_blocks_merge():
    remote, local, _ = _pair()
    page = remote.page("Shared")
    remote.insert(page["id"], "b1", "one")
    remote.insert(page["id"], "b2", "two")
    _sync(local)
    # local edit → remote, under the token's account
    local.ops(page["id"], [{"op": "set", "id": "b1", "content": "one (local)"}])
    local.insert(page["id"], "b3", "three from local")
    status = _sync(local)
    assert status["pages_pushed"] == 1
    assert remote.texts(page["id"]) == {"b1": "one (local)", "b2": "two", "b3": "three from local"}
    log = remote.client.get(f"/api/pages/{page['id']}/ops?since=0").json()["batches"]
    assert log[-1]["actor"] == remote.name and log[-1]["client"] == "sync"
    # both sides edit different blocks between rounds → both survive
    remote.ops(page["id"], [{"op": "set", "id": "b2", "content": "two (remote)"}])
    local.ops(page["id"], [{"op": "set", "id": "b3", "content": "three (local again)"}])
    _sync(local)
    expect = {"b1": "one (local)", "b2": "two (remote)", "b3": "three (local again)"}
    assert remote.texts(page["id"]) == expect and local.texts(page["id"]) == expect
    # the local copy's own log marks the engine's writes
    with connect_pages_db(local.ws) as conn:
        clients = {r[0] for r in conn.execute("SELECT client FROM page_ops WHERE page_id = ?", (page["id"],))}
    assert "sync" in clients
    assert local.client.get(f"/api/mirrors/{local.ws}/conflicts").json()["conflicts"] == []


def test_same_block_edits_merge_by_span_and_are_reported():
    remote, local, _ = _pair()
    page = remote.page("Same block")
    remote.insert(page["id"], "s1", "alpha beta gamma delta")
    _sync(local)
    remote.ops(page["id"], [{"op": "set", "id": "s1", "content": "ALPHA beta gamma delta"}])
    local.ops(page["id"], [{"op": "set", "id": "s1", "content": "alpha beta gamma DELTA"}])
    _sync(local)
    merged = "ALPHA beta gamma DELTA"
    assert local.texts(page["id"])["s1"] == merged and remote.texts(page["id"])["s1"] == merged
    conflicts = local.client.get(f"/api/mirrors/{local.ws}/conflicts").json()["conflicts"]
    assert [(c["kind"], c["block_id"], c["mine"], c["theirs"], c["result"]) for c in conflicts] == [
        ("merged", "s1", "alpha beta gamma DELTA", "ALPHA beta gamma delta", merged)]
    # choosing "mine" writes it back as an ordinary edit, which the next round pushes
    r = local.client.post(f"/api/mirrors/{local.ws}/conflicts/{conflicts[0]['id']}", json={"choice": "mine"})
    assert r.status_code == 200
    _sync(local)
    assert remote.texts(page["id"])["s1"] == "alpha beta gamma DELTA"
    assert local.client.get(f"/api/mirrors/{local.ws}/conflicts").json()["conflicts"] == []


def test_an_edit_beats_a_delete_in_both_directions():
    remote, local, _ = _pair()
    page = remote.page("Edit vs delete")
    remote.insert(page["id"], "d1", "remote will delete me")
    remote.insert(page["id"], "d2", "local will delete me")
    remote.insert(page["id"], "d3", "untouched, deleted remotely")
    _sync(local)
    remote.ops(page["id"], [{"op": "delete", "id": "d1"}, {"op": "delete", "id": "d3"},
                            {"op": "set", "id": "d2", "content": "remote edited"}])
    local.ops(page["id"], [{"op": "set", "id": "d1", "content": "local edited"}, {"op": "delete", "id": "d2"}])
    _sync(local)
    expect = {"d1": "local edited", "d2": "remote edited"}
    assert local.texts(page["id"]) == expect and remote.texts(page["id"]) == expect
    kinds = sorted((c["kind"], c["block_id"]) for c in
                   local.client.get(f"/api/mirrors/{local.ws}/conflicts").json()["conflicts"])
    assert kinds == [("kept_local_edit", "d1"), ("restored_remote_edit", "d2")]


def test_pages_come_and_go_on_both_sides():
    remote, local, _ = _pair()
    keep = remote.page("Keep")
    gone_remote = remote.page("Deleted remotely")
    gone_local = remote.page("Deleted locally")
    edited_then_deleted = remote.page("Edited here, deleted there")
    for p in (keep, gone_remote, gone_local, edited_then_deleted):
        remote.insert(p["id"], f"{p['id']}_c", "note")
    _sync(local)
    # new pages on each side
    new_remote = remote.page("New remote", folder="in")
    new_local = local.page("New local")
    local.insert(new_local["id"], "nl1", "local note")
    # deletions
    remote.client.delete(f"/api/blocks/{gone_remote['id']}").raise_for_status()
    local.client.delete(f"/api/blocks/{gone_local['id']}").raise_for_status()
    # deleted there, edited here → comes back there
    local.ops(edited_then_deleted["id"], [{"op": "set", "id": f"{edited_then_deleted['id']}_c", "content": "kept"}])
    remote.client.delete(f"/api/blocks/{edited_then_deleted['id']}").raise_for_status()
    _sync(local)
    lp, rp = local.pages(), remote.pages()
    assert new_remote["id"] in lp and lp[new_remote["id"]]["properties"]["folder"] == "in"
    assert new_local["id"] in rp and remote.texts(new_local["id"]) == {"nl1": "local note"}
    assert gone_remote["id"] not in lp and gone_local["id"] not in rp
    assert edited_then_deleted["id"] in rp and remote.texts(edited_then_deleted["id"]) == {
        f"{edited_then_deleted['id']}_c": "kept"}
    kinds = {c["kind"] for c in local.client.get(f"/api/mirrors/{local.ws}/conflicts").json()["conflicts"]}
    assert kinds == {"page_restored"}
    # renaming a page is a root set that travels
    remote.ops(keep["id"], [{"op": "set", "id": keep["id"], "content": "Keep (renamed)"}])
    _sync(local)
    assert local.pages()[keep["id"]]["content"] == "Keep (renamed)"


def test_files_travel_by_hash():
    remote, local, _ = _pair()
    up = remote.client.post("/api/uploads", files={"file": ("paper.pdf", io.BytesIO(PDF), "application/pdf")}).json()
    page = remote.client.post(f"/api/blocks/by-doc/{up['doc_id']}", json={"default_title": "paper.pdf"}).json()
    _sync(local)
    assert (ws_uploads_dir(local.ws) / f"{up['doc_id']}.pdf").read_bytes() == PDF
    assert local.pages()[page["id"]]["properties"]["doc_id"] == up["doc_id"]
    # a file added on the local copy reaches the remote when its block does
    img = local.client.post("/api/upload-file", files={"file": ("pic.png", io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"p" * 100), "image/png")}).json()
    name = img["url"].rsplit("/", 1)[1]
    local.insert(page["id"], "imgblk", f"![pic]({img['url']})")
    status = _sync(local)
    assert status["files_pushed"] == 1
    assert (ws_uploads_dir(remote.ws) / name).is_file()
    assert remote.texts(page["id"])["imgblk"] == f"![pic]({img['url']})"


def test_pull_only_with_a_read_token():
    remote, local, mirror = _pair(scope="read")
    assert mirror["mode"] == "pull"
    page = remote.page("Read only")
    remote.insert(page["id"], "r1", "alpha beta gamma delta")
    _sync(local)
    assert local.texts(page["id"]) == {"r1": "alpha beta gamma delta"}
    local.ops(page["id"], [{"op": "set", "id": "r1", "content": "ALPHA beta gamma delta"}])
    status = _sync(local)
    assert status["pages_pushed"] == 0 and remote.texts(page["id"]) == {"r1": "alpha beta gamma delta"}
    # the local edit survives a later remote change to another span of the same block
    remote.ops(page["id"], [{"op": "set", "id": "r1", "content": "alpha beta gamma DELTA"}])
    _sync(local)
    assert local.texts(page["id"])["r1"] == "ALPHA beta gamma DELTA"
    assert remote.texts(page["id"])["r1"] == "alpha beta gamma DELTA"


def test_the_sync_log_names_what_a_round_did():
    remote, local, _ = _pair()
    page = remote.page("Logged")
    remote.insert(page["id"], "lg1", "one")
    _sync(local)
    local.ops(page["id"], [{"op": "set", "id": "lg1", "content": "one (local)"}])
    gone = remote.page("Gone")
    _sync(local)
    remote.client.delete(f"/api/blocks/{gone['id']}").raise_for_status()
    _sync(local)
    log = local.client.get(f"/api/mirrors/{local.ws}/log").json()["changes"]
    actions = [(c["action"], c["title"]) for c in log]
    assert actions[0] == ("deleted here", "Gone")  # newest first
    # a round works its pages in id order, so the middle two may swap
    assert set(actions[1:3]) == {("created here", "Gone"), ("pushed", "Logged")}
    assert actions[3] == ("created here", "Logged")
    assert log[0]["exists"] is False and next(c for c in log if c["action"] == "pushed")["exists"] is True
    info = local.client.get(f"/api/mirrors/{local.ws}").json()
    assert info["conflicts_open"] == 0 and info["status"]["last_sync"]


def test_a_round_reports_its_progress_and_an_interrupted_one_is_reset(monkeypatch):
    remote, local, _ = _pair()
    for i in range(3):
        remote.page(f"Progress {i}")
    seen = []
    real = sync_engine._sync_page

    def spy(ws, *a, **kw):
        seen.append(sync_engine.get_mirror(ws)["status"]["progress"])
        return real(ws, *a, **kw)

    monkeypatch.setattr(sync_engine, "_sync_page", spy)
    _sync(local)
    assert [(p["done"], p["total"], p["first"]) for p in seen] == [(0, 3, True), (1, 3, True), (2, 3, True)]
    info = local.client.get(f"/api/mirrors/{local.ws}").json()
    assert info["status"]["running"] is False and "progress" not in info["status"]
    assert info["interval_s"] == 0  # the tests run with GAMMA_SYNC_INTERVAL=0
    # a later round is no longer "first"
    remote.page("Later")
    seen.clear()
    _sync(local)
    assert seen and all(p["first"] is False for p in seen)
    # the server stopped in the middle of a round: the flag it left is reset at startup
    sync_engine._save(local.ws, status={**info["status"], "running": True, "started_at": "2026-01-01T00:00:00.000000Z",
                                        "progress": {"done": 1, "total": 9}})
    sync_engine.reset_interrupted()
    st = sync_engine.get_mirror(local.ws)["status"]
    assert st["running"] is False and st["interrupted"] is True and "progress" not in st
    assert "interrupted" not in _sync(local)  # the next round clears the note


def test_an_unexpected_error_in_one_page_does_not_stick_the_round(monkeypatch):
    remote, local, _ = _pair()
    bad = remote.page("Explodes")
    good = remote.page("Fine")
    real = sync_engine._sync_page

    def boom(ws, remote_, page_id, **kw):
        if page_id == bad["id"]:
            raise KeyError("a bug in the engine")
        return real(ws, remote_, page_id, **kw)

    monkeypatch.setattr(sync_engine, "_sync_page", boom)
    r = local.client.post(f"/api/mirrors/{local.ws}/sync?wait=1")
    status = r.json()["status"]
    assert status["running"] is False and bad["id"] in status["last_error"]
    assert good["id"] in local.pages() and bad["id"] not in local.pages()
    monkeypatch.setattr(sync_engine, "_sync_page", real)
    assert list(status["retry"]) == [bad["id"]]
    _sync(local)  # retried next time from the mirror's retry list (the feed's cursor has moved past it)
    assert sync_engine.get_mirror(local.ws)["status"]["retry"] == {}
    assert bad["id"] in local.pages()


def test_stop_mirroring_keeps_the_workspace():
    remote, local, _ = _pair()
    page = remote.page("Stays")
    _sync(local)
    assert local.client.delete(f"/api/mirrors/{local.ws}").status_code == 200
    assert local.client.get(f"/api/mirrors/{local.ws}").status_code == 404
    assert page["id"] in local.pages()
    assert local.client.post(f"/api/mirrors/{local.ws}/sync?wait=1").status_code == 404

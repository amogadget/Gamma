"""Native payload protection survives the upstream feed/mirror integration."""

import json
import uuid

import pytest

from conftest import login, make_page, make_user
from gamma import ops, sync_engine
from gamma.db import connect_pages_db, ws_uploads_dir
from test_native_undo import create_audio, create_ink


@pytest.fixture
def native_page():
    ws = make_user("native-sync-compat", "pw")
    with login("native-sync-compat", "pw") as client:
        page = make_page(client, properties={"doc_id": "0123456789abcdef01234567"})["id"]
        ink = create_ink(client, page)
        bid = str(uuid.uuid4())
        response = client.put(f"/api/blocks/{bid}/note", json={
            "parent_id": ink, "content": "native text", "expected_revision": 0})
        assert response.status_code == 200, response.text
        yield client, ws, page, bid


def test_mirror_generic_patch_cannot_change_native_revision(native_page):
    client, ws, page, bid = native_page
    before = client.get(f"/api/blocks/{bid}").json()
    with connect_pages_db(ws) as conn:
        seq = ops.latest_seq(conn, page)
    with pytest.raises(ops.OpError) as error:
        sync_engine._apply_local(ws, page, [
            {"op": "set", "id": bid, "content": "overwritten",
             "props": {"note_revision": 99}}])
    assert error.value.status == 409
    assert client.get(f"/api/blocks/{bid}").json() == before
    with connect_pages_db(ws) as conn:
        assert ops.latest_seq(conn, page) == seq


def test_native_writes_notify_feed_and_keep_delete_provenance_private(native_page):
    client, ws, page, bid = native_page
    notifications = []
    listener = lambda workspace, writer: notifications.append((workspace, writer))
    ops.commit_listeners.append(listener)
    try:
        parent = client.get(f"/api/blocks/{bid}").json()["parent_id"]
        response = client.put(f"/api/blocks/{bid}/note", json={
            "parent_id": parent, "content": "edited native text", "expected_revision": 1})
        assert response.status_code == 200, response.text
        assert (ws, "native") in notifications
        response = client.get("/api/sync/changes")
        assert response.status_code == 200, response.text
        assert page in response.text
        deleted = ops.commit_ops(ws, page, [{"op": "delete", "id": bid}],
                                 actor="native-sync-compat", client="sync")
        assert deleted["ops"] == [{"op": "delete", "id": bid}]
        assert (ws, "sync") in notifications
        with connect_pages_db(ws) as conn:
            raw = json.loads(conn.execute(
                "SELECT ops FROM page_ops WHERE page_id = ? AND seq = ?",
                (page, deleted["seq"])).fetchone()[0])
            assert raw[0]["deleted"][0]["id"] == bid
            batches, _ = ops.ops_since(conn, page, deleted["seq"] - 1)
            assert batches[0]["ops"] == [{"op": "delete", "id": bid}]
    finally:
        ops.commit_listeners.remove(listener)


def test_page_delete_tombstone_clears_native_undo_history(native_page):
    client, ws, page, bid = native_page
    ops.commit_ops(ws, page, [{"op": "delete", "id": bid}], actor="native-sync-compat")
    response = client.delete(f"/api/blocks/{page}")
    assert response.status_code == 200, response.text
    with connect_pages_db(ws) as conn:
        assert conn.execute("SELECT actor FROM deleted_pages WHERE page_id = ?", (page,)).fetchone() == ("native-sync-compat",)
        assert ops._recorded_deletion(conn, page, bid) is None
        assert ops.latest_seq(conn, page) == 0


@pytest.mark.parametrize("root_kind", ["note", "ink", "audio", "ordinary-parent"])
@pytest.mark.parametrize("omit_payload", [False, True])
def test_mirror_relocation_refuses_native_subtree_before_deleting(native_page, root_kind, omit_payload):
    client, ws, page, note = native_page
    ink = client.get(f"/api/blocks/{note}").json()["parent_id"]
    bid = note if root_kind == "note" else ink
    if root_kind == "audio":
        bid = create_audio(client, page, events_for=ink)
    if root_kind == "ordinary-parent":
        response = client.post("/api/blocks", json={"parent_id": page, "content": "wrapper"})
        assert response.status_code == 200, response.text
        bid = response.json()["id"]
        ops.commit_ops(ws, page, [{"op": "move", "id": ink, "parent": bid}], actor="test")
    ordinary_page = make_page(client)["id"]
    ordinary = client.post("/api/blocks", json={"parent_id": ordinary_page, "content": "keep me"}).json()["id"]
    target = make_page(client)["id"]
    pages = (ordinary_page, page, target)
    before = {pid: client.get(f"/api/blocks/{pid}/subtree").json() for pid in pages}
    files = {p.name: p.read_bytes() for p in ws_uploads_dir(ws).iterdir() if p.is_file()}
    block = client.get(f"/api/blocks/{bid}").json()
    with connect_pages_db(ws) as conn:
        log_before = conn.execute("SELECT * FROM page_ops ORDER BY page_id, seq").fetchall()
    with pytest.raises(ops.OpError) as error:
        sync_engine._apply_local(ws, target, [
            {"op": "insert", "id": ordinary, "parent": target, "content": "keep me"},
            {"op": "insert", "id": bid, "parent": target, "content": block["content"],
             "props": {} if omit_payload else block["properties"]}])
    assert error.value.status == 409
    assert "must stay in their PDF page" in error.value.detail
    assert {pid: client.get(f"/api/blocks/{pid}/subtree").json() for pid in pages} == before
    assert {p.name: p.read_bytes() for p in ws_uploads_dir(ws).iterdir() if p.is_file()} == files
    with connect_pages_db(ws) as conn:
        assert conn.execute("SELECT * FROM page_ops ORDER BY page_id, seq").fetchall() == log_before


@pytest.mark.parametrize("props", [{"native_note": True}, {"type": "pdf_ink"}, {"type": "audio"}])
def test_new_native_payload_rejects_batch_before_ordinary_relocation(native_page, props):
    client, ws, page, _ = native_page
    ordinary = client.post("/api/blocks", json={"parent_id": page, "content": "keep me"}).json()["id"]
    target = make_page(client)["id"]
    pages = (page, target)
    before = {pid: client.get(f"/api/blocks/{pid}/subtree").json() for pid in pages}
    files = {p.name: p.read_bytes() for p in ws_uploads_dir(ws).iterdir() if p.is_file()}
    with connect_pages_db(ws) as conn:
        log_before = conn.execute("SELECT * FROM page_ops ORDER BY page_id, seq").fetchall()
    with pytest.raises(ops.OpError) as error:
        sync_engine._apply_local(ws, target, [
            {"op": "insert", "id": ordinary, "parent": target, "content": "keep me"},
            {"op": "insert", "id": str(uuid.uuid4()), "parent": target, "props": props}])
    assert error.value.status == 409
    assert {pid: client.get(f"/api/blocks/{pid}/subtree").json() for pid in pages} == before
    assert {p.name: p.read_bytes() for p in ws_uploads_dir(ws).iterdir() if p.is_file()} == files
    with connect_pages_db(ws) as conn:
        assert conn.execute("SELECT * FROM page_ops ORDER BY page_id, seq").fetchall() == log_before

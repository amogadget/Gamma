"""Undoing the deletion of a native block (the Web's Ctrl+Z).

The reserved-property guards make a generic insert of a native payload a 409
(``test_native_ink.py::test_generic_writers_cannot_touch_reserved_ink_fields``,
``test_native_ai_protection.py``), which used to make deleting an iPad
annotation in the Web irreversible: Ctrl+Z re-inserts the block it deleted, and
once the delete committed there was no row left to verify against.

``gamma/ops.py`` now records what a delete removed — for the native rows only —
in the page's own op log, and a later insert of that same id in that same page is
checked against the record: the writer has to reproduce the payload exactly, the
RECORDED properties are restored (revisions included), and the provenance is
never handed to clients. This file pins both halves of that contract:

- the actual Web wire sequence (a delete op, then the insert op the editor's undo
  mints) restores the annotation with its revision intact and the iPad's CAS
  still working;
- nested native notes travel with their ink block, and a batch that cannot be
  fully applied writes nothing without consuming the provenance;
- forging is still refused: an invented id, an edited manifest, another page,
  another workspace, a lossy plain insert, a rewritten native note;
- the record is durable (it is in ``pages.db``) and invisible on the wire.

PNGs are built by hand, exactly as the other native tests do: the server
validates them without an image library.
"""

import json
import sqlite3
import struct
import uuid
import zlib

import pytest

from conftest import login, make_page, make_user, workspace_of


def png_bytes(width=2, height=2, rgba=(0, 0, 0, 0)):
    raw = b"".join(b"\x00" + bytes(rgba) * width for _ in range(height))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def m4a_bytes(payload=b"audio"):
    return ((16 + len(payload)).to_bytes(4, "big") + b"ftyp" + b"M4A "
            + (0).to_bytes(4, "big") + payload)


@pytest.fixture
def owner():
    make_user("undo-owner", "undo-password")
    with login("undo-owner", "undo-password") as client:
        yield client


def ws_of(username="undo-owner"):
    return workspace_of(username)


def ws_pages_db(username="undo-owner"):
    from gamma.config import WORKSPACES_DIR
    return str(WORKSPACES_DIR / ws_of(username) / "pages.db")


def asset(client, data=b"opaque PencilKit serialization", ext="pkdrawing"):
    ctype = {"png": "image/png", "m4a": "audio/mp4",
             "inkjson": "application/json"}.get(ext, "application/octet-stream")
    if ext == "png":
        data = png_bytes(5, 5)
    result = client.post("/api/assets", files={"file": (f"drawing.{ext}", data, ctype)})
    assert result.status_code == 200, result.text
    return result.json()


def page(client, doc_id="0123456789abcdef01234567"):
    return make_page(client, properties={"doc_id": doc_id})


def create_ink(client, parent_id, **overrides):
    """One native ink annotation; returns its block id."""
    block_id = str(uuid.uuid4())
    body = {"parent_id": parent_id, "pdf_page": 1,
            "ink_asset": asset(client)["url"],
            "preview_asset": asset(client, ext="png")["url"],
            "bounds": {"x": 10, "y": 20, "width": 30, "height": 40},
            "crop_box": {"width": 612, "height": 792}, "expected_revision": 0,
            **overrides}
    result = client.put(f"/api/blocks/{block_id}/ink", json=body)
    assert result.status_code == 200, result.text
    return block_id


def create_note(client, block_id, parent_id, content, expected_revision=0):
    result = client.put(f"/api/blocks/{block_id}/note", json={
        "parent_id": parent_id, "content": content, "expected_revision": expected_revision})
    assert result.status_code == 200, result.text
    return result.json()


def create_audio(client, parent_id, segments=2, events_for=None):
    block_id = str(uuid.uuid4())
    items = [{"id": str(uuid.uuid4()),
              "asset": asset(client, m4a_bytes(f"segment {n}".encode()), "m4a")["url"],
              "duration": 1.5 + n} for n in range(segments)]
    body = {"parent_id": parent_id, "expected_revision": 0, "audio_state": "stopped",
            "segments": items}
    if events_for:
        # A stroke event names the block it happened in — block references are
        # weak, so this is any id, including an annotation's.
        body["replay_events"] = [{
            "id": str(uuid.uuid4()), "kind": "stroke", "segment_id": items[0]["id"],
            "start": 0.0, "end": 1.0, "pdf_page": 1,
            "block_id": events_for, "stroke_id": "stroke-1"}]
    result = client.put(f"/api/blocks/{block_id}/audio", json=body)
    assert result.status_code == 200, result.text
    return block_id


def ops(client, page_id, batch, client_name="web-test", query=""):
    """Exactly what the editor's collab session posts."""
    return client.post(f"/api/pages/{page_id}/ops{query}",
                       json={"client": client_name, "ops": batch})


def block(client, block_id, query=""):
    result = client.get(f"/api/blocks/{block_id}{query}")
    assert result.status_code == 200, result.text
    return result.json()


def delete_op(block_id):
    return {"op": "delete", "id": block_id}


def undo_insert_op(node, position="a0", **overrides):
    """The insert op ``blockOps.diffTrees`` mints for a block the base tree lost:
    the id, its parent, a fresh fractional position, the text and the FULL
    properties the editor last saw."""
    return {"op": "insert", "id": node["id"], "parent": node["parent_id"],
            "position": position, "content": node["content"],
            "props": node["properties"], **overrides}


# --- the Web's own sequence ----------------------------------------------------


def test_web_delete_then_undo_restores_the_ink_block(owner):
    """Delete (the row menu) then Ctrl+Z, as the editor sends it."""
    doc = page(owner)
    block_id = create_ink(owner, doc["id"])
    assert owner.put(f"/api/blocks/{block_id}", json={"content": "iPad caption"}).status_code == 200
    before = block(owner, block_id)
    recorded_revision = before["properties"]["ink_revision"]

    deleted = ops(owner, doc["id"], [delete_op(block_id)])
    assert deleted.status_code == 200, deleted.text
    # The restore provenance is the server's own record: it is NOT in the
    # response the editor reads (the room fan-out is built from the same list).
    assert deleted.json()["ops"] == [{"op": "delete", "id": block_id}]
    assert owner.get(f"/api/blocks/{block_id}").status_code == 404

    restored = ops(owner, doc["id"], [undo_insert_op(before)])
    assert restored.status_code == 200, restored.text
    assert [op["op"] for op in restored.json()["ops"]] == ["insert"]

    after = block(owner, block_id)
    assert after["parent_id"] == doc["id"]
    assert after["content"] == "iPad caption"
    assert after["properties"] == before["properties"]
    # The revision resumed where the annotation stopped — not a fresh 1 — so the
    # iPad's CAS and a queued offline save still line up.
    assert after["properties"]["ink_revision"] == recorded_revision
    cas = owner.put(f"/api/blocks/{block_id}/ink", json={
        "parent_id": doc["id"], "pdf_page": 1,
        "ink_asset": before["properties"]["ink_asset"],
        "preview_asset": before["properties"]["preview_asset"],
        "bounds": {"x": 11, "y": 20, "width": 30, "height": 40},
        "crop_box": {"width": 612, "height": 792},
        "expected_revision": recorded_revision})
    assert cas.status_code == 200, cas.text
    assert cas.json()["properties"]["ink_revision"] == recorded_revision + 1


def test_restore_keeps_children_and_the_page_wiring(owner):
    """The block comes back where it was, with what hung under it and no extra
    descendant: a restore is an insert of the recorded block."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    note_id = str(uuid.uuid4())
    create_note(owner, note_id, ink_id, "a plain child note")
    ink_before = block(owner, ink_id)
    note_before = block(owner, note_id)

    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200
    assert owner.get(f"/api/blocks/{note_id}").status_code == 404  # the cascade went too

    # A plain child note carries no reserved property, so it needs no record.
    restored = ops(owner, doc["id"], [undo_insert_op(ink_before), {
        "op": "insert", "id": note_id, "parent": ink_id, "position": "a1",
        "content": note_before["content"], "props": note_before["properties"]}])
    assert restored.status_code == 200, restored.text
    assert block(owner, note_id)["content"] == "a plain child note"
    tree = owner.get(f"/api/blocks/{doc['id']}/subtree").json()["block"]
    assert [c["id"] for c in tree["children"]] == [ink_id]
    assert [c["id"] for c in tree["children"][0]["children"]] == [note_id]


def test_nested_native_notes_restore_in_one_batch(owner):
    """A native note is payload-bearing too: every block of a deleted iPad
    annotation's subtree is recorded, and one undo batch brings them back."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    outer_id, inner_id = str(uuid.uuid4()), str(uuid.uuid4())
    create_note(owner, outer_id, ink_id, "outer offline note")
    create_note(owner, inner_id, outer_id, "inner offline note")

    nodes = [block(owner, ink_id), block(owner, outer_id), block(owner, inner_id)]
    revisions = {n["id"]: n["properties"]["note_revision"] for n in nodes[1:]}

    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200
    assert owner.get(f"/api/blocks/{inner_id}").status_code == 404

    batch = [undo_insert_op(n, position=f"a{i}") for i, n in enumerate(nodes)]
    restored = ops(owner, doc["id"], batch)
    assert restored.status_code == 200, restored.text
    for node in nodes:
        after = block(owner, node["id"])
        assert after["properties"] == node["properties"], node["id"]
        assert after["content"] == node["content"], node["id"]
        assert after["parent_id"] == node["parent_id"], node["id"]
    # A note's revision is its outbox expectation: it resumes, it is not reset
    # and it is not advanced by the restore itself.
    for note_id, revision in revisions.items():
        assert block(owner, note_id)["properties"]["note_revision"] == revision
    fresh = create_note(owner, outer_id, ink_id, "after the restore", expected_revision=1)
    assert fresh["properties"]["note_revision"] == 2


def test_audio_block_restores_its_manifest(owner):
    doc = page(owner)
    audio_id = create_audio(owner, doc["id"])
    before = block(owner, audio_id)
    revision = before["properties"]["audio_revision"]
    assert len(before["properties"]["segments"]) == 2

    assert ops(owner, doc["id"], [delete_op(audio_id)]).status_code == 200
    restored = ops(owner, doc["id"], [undo_insert_op(before)])
    assert restored.status_code == 200, restored.text
    after = block(owner, audio_id)
    assert after["properties"]["segments"] == before["properties"]["segments"]
    assert after["properties"]["duration"] == before["properties"]["duration"]
    assert after["properties"]["audio_revision"] == revision
    assert after["properties"]["audio_state"] == "stopped"
    # The iPad's recording session resumes against the same revision. It sends
    # the client-owned segment fields only — ``start_time`` is server-derived.
    client_segments = [{k: s[k] for k in ("id", "asset", "duration")}
                       for s in after["properties"]["segments"]]
    assert owner.put(f"/api/blocks/{audio_id}/audio", json={
        "parent_id": doc["id"], "audio_state": "stopped",
        "segments": client_segments, "expected_revision": revision}).status_code == 200


def test_a_props_only_restore_keeps_the_recorded_state(owner):
    """The editor sends the payload it holds; the RECORDED properties win (an
    undo restores the server's last state, not a stale copy of it)."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    assert ops(owner, doc["id"], [{"op": "set", "id": ink_id, "props": {"color": "#fff"}}]
               ).status_code == 200
    before = block(owner, ink_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    stale = dict(before, properties={**before["properties"], "color": "#000"})
    restored = ops(owner, doc["id"], [undo_insert_op(stale)])
    assert restored.status_code == 200, restored.text
    assert block(owner, ink_id)["properties"]["color"] == "#fff"


# --- atomicity ------------------------------------------------------------------


def test_a_batch_that_cannot_be_applied_writes_nothing_and_keeps_the_record(owner):
    """One bad op fails the whole batch (nothing written) — and the provenance
    survives the rollback, so the honest retry still restores everything."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    note_id = str(uuid.uuid4())
    create_note(owner, note_id, ink_id, "offline text")
    ink_before, note_before = block(owner, ink_id), block(owner, note_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    tampered = dict(note_before, properties={**note_before["properties"], "note_revision": 9})
    refused = ops(owner, doc["id"], [undo_insert_op(ink_before),
                                     undo_insert_op(tampered, "a1")])
    assert refused.status_code == 409, refused.text
    # Nothing landed — not even the valid op that preceded the bad one.
    assert owner.get(f"/api/blocks/{ink_id}").status_code == 404
    assert owner.get(f"/api/blocks/{note_id}").status_code == 404
    assert owner.get(f"/api/blocks/{doc['id']}/subtree").json()["block"]["children"] == []

    retried = ops(owner, doc["id"], [undo_insert_op(ink_before), undo_insert_op(note_before, "a1")])
    assert retried.status_code == 200, retried.text
    assert block(owner, ink_id)["properties"] == ink_before["properties"]
    assert block(owner, note_id)["content"] == "offline text"
    assert block(owner, note_id)["properties"]["note_revision"] == 1


def test_a_native_note_may_not_be_rewritten_by_a_restore(owner):
    """A note's text IS its payload, so a restore may not replace it — the batch
    is refused whole instead of resurrecting the note with new text."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    note_id = str(uuid.uuid4())
    create_note(owner, note_id, ink_id, "offline text")
    ink_before, note_before = block(owner, ink_id), block(owner, note_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    rewritten = dict(note_before, content="text the server never recorded")
    refused = ops(owner, doc["id"], [undo_insert_op(ink_before), undo_insert_op(rewritten, "a1")])
    assert refused.status_code == 409, refused.text
    assert owner.get(f"/api/blocks/{ink_id}").status_code == 404

    ok = ops(owner, doc["id"], [undo_insert_op(ink_before), undo_insert_op(note_before, "a1")])
    assert ok.status_code == 200, ok.text
    assert block(owner, note_id)["content"] == "offline text"
    assert block(owner, note_id)["properties"]["note_revision"] == 1


# --- forging is still refused ---------------------------------------------------


def test_a_fresh_native_payload_is_still_a_forgery(owner):
    """No deletion recorded this id: the guard is exactly what it was."""
    doc = page(owner)
    real = create_ink(owner, doc["id"])
    before = block(owner, real)

    # Never deleted, never existed: a copied payload under a new id.
    invented = dict(before, id=str(uuid.uuid4()))
    assert ops(owner, doc["id"], [undo_insert_op(invented)]).status_code == 409
    # The page still has exactly the one annotation it started with.
    assert owner.get(f"/api/blocks/{doc['id']}/subtree").json()["block"]["children"] == [
        {**before, "children": []}]

    # A deleted id, but a payload that was never recorded there: another
    # annotation's manifest, however valid on its own.
    other = create_ink(owner, doc["id"], bounds={"x": 1, "y": 2, "width": 3, "height": 4})
    borrowed = block(owner, other)["properties"]
    assert ops(owner, doc["id"], [delete_op(real)]).status_code == 200
    assert ops(owner, doc["id"], [{
        "op": "insert", "id": real, "parent": doc["id"], "position": "a0",
        "content": "", "props": borrowed}]).status_code == 409
    # The plain-text form of the same id is a lossy downgrade, not a restore.
    plain = {**before, "properties": {k: v for k, v in before["properties"].items()
                                      if k not in ("type", "ink_asset", "preview_asset")}}
    assert ops(owner, doc["id"], [undo_insert_op(plain)]).status_code == 409
    # And the honest one still works.
    assert ops(owner, doc["id"], [undo_insert_op(before)]).status_code == 200


@pytest.mark.parametrize("key,value", [
    ("ink_revision", 99),                       # an escalated revision
    ("pdf_page", 3),                            # a different page anchor
    ("type", "audio"),                          # another kind entirely
    ("bounds", {"x": 0, "y": 0, "width": 1, "height": 1}),
    ("preview_asset", "/api/assets/" + "b" * 64 + ".png"),
])
def test_an_edited_manifest_is_refused(owner, key, value):
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    tampered = dict(before, properties={**before["properties"], key: value})
    assert ops(owner, doc["id"], [undo_insert_op(tampered)]).status_code == 409
    assert owner.get(f"/api/blocks/{ink_id}").status_code == 404
    assert ops(owner, doc["id"], [undo_insert_op(before)]).status_code == 200


def test_an_invented_replay_reference_is_refused(owner):
    """The recorded payload had no replay; a restore may not add one (the ink
    endpoint is where a real one is attached, digest-checked)."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)
    assert "replay_asset" not in before["properties"]
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    tampered = dict(before, properties={
        **before["properties"], "replay_asset": "/api/assets/" + "c" * 64 + ".inkjson"})
    assert ops(owner, doc["id"], [undo_insert_op(tampered)]).status_code == 409


def test_a_deletion_does_not_authorize_another_page(owner):
    """Same workspace, same id, same payload — different page: the record is
    that page's own, so the insert is a forgery there."""
    first = page(owner, "aaaaaaaaaaaaaaaaaaaaaaaa")
    second = page(owner, "bbbbbbbbbbbbbbbbbbbbbbbb")
    ink_id = create_ink(owner, first["id"])
    before = block(owner, ink_id)
    assert ops(owner, first["id"], [delete_op(ink_id)]).status_code == 200

    assert ops(owner, second["id"], [undo_insert_op(before, parent=second["id"])]
               ).status_code == 409
    assert owner.get(f"/api/blocks/{second['id']}/subtree").json()["block"]["children"] == []
    assert ops(owner, first["id"], [undo_insert_op(before)]).status_code == 200


def test_a_deletion_does_not_authorize_another_workspace(owner):
    """The record lives in the workspace's own pages.db, so another account's
    otherwise-identical request finds nothing to verify against."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    make_user("undo-other", "undo-password")
    with login("undo-other", "undo-password") as other:
        other_doc = page(other, "cccccccccccccccccccccccc")
        assert ops(other, other_doc["id"], [undo_insert_op(before, parent=other_doc["id"])]
                   ).status_code == 409
        assert other.get(f"/api/blocks/{ink_id}").status_code == 404

    assert ops(owner, doc["id"], [undo_insert_op(before)]).status_code == 200


def test_a_share_editor_restores_only_inside_its_page(owner):
    """Provenance is not an extra permission: an edit share reaches it exactly
    as far as it reaches the page itself."""
    doc = page(owner)
    other = page(owner, "dddddddddddddddddddddddd")
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200
    share = owner.post(f"/api/share/{doc['id']}", json={"audience": "users", "role": "edit"})
    assert share.status_code == 200, share.text
    token = share.json()["token"]

    make_user("undo-guest", "undo-password")
    with login("undo-guest", "undo-password") as editor:
        denied = ops(editor, other["id"], [undo_insert_op(before, parent=other["id"])],
                     query=f"?share={token}")
        assert denied.status_code == 403, denied.text
        allowed = ops(editor, doc["id"], [undo_insert_op(before)], query=f"?share={token}")
        assert allowed.status_code == 200, allowed.text
        assert editor.get(f"/api/blocks/{ink_id}?share={token}").status_code == 200


# --- the record itself ----------------------------------------------------------


def test_a_deleted_block_stays_an_explicit_conflict_for_the_native_endpoints(owner):
    """The record serves the Web's undo, not the native writers. A queued iPad
    update of a block somebody deleted on purpose stays a revision conflict
    (revision 0) and resurrects nothing — a stale client may not bring an
    annotation back behind the deleter's back — while the Web's generic undo
    still restores it."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    conflict = owner.put(f"/api/blocks/{ink_id}/ink", json={
        "parent_id": doc["id"], "pdf_page": 1,
        "ink_asset": before["properties"]["ink_asset"],
        "preview_asset": before["properties"]["preview_asset"],
        "bounds": {"x": 10, "y": 20, "width": 30, "height": 40},
        "crop_box": {"width": 612, "height": 792},
        "expected_revision": before["properties"]["ink_revision"]})
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["current_revision"] == 0
    assert owner.get(f"/api/blocks/{ink_id}").status_code == 404  # nothing came back

    # The same id through the generic path (the Web's undo) does restore.
    assert ops(owner, doc["id"], [undo_insert_op(before)]).status_code == 200
    assert block(owner, ink_id)["properties"] == before["properties"]


def test_the_record_is_durable_and_never_on_the_wire(owner):
    """It lives in pages.db (so it survives a restart and travels in a backup)
    and is stripped from every client-facing read of the log."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    with sqlite3.connect(ws_pages_db()) as conn:
        seq, raw = conn.execute("SELECT seq, ops FROM page_ops WHERE page_id = ? "
                                "ORDER BY seq DESC LIMIT 1", (doc["id"],)).fetchone()
    assert isinstance(seq, int)
    logged = json.loads(raw)
    assert [op["op"] for op in logged] == ["delete"]
    recorded = logged[0]["deleted"]
    assert [snap["id"] for snap in recorded] == [ink_id]
    assert recorded[0]["properties"] == before["properties"]
    assert recorded[0]["content"] == before["content"]

    # A catch-up read must not hand it over: the shape is the pre-existing one.
    catchup = owner.get(f"/api/pages/{doc['id']}/ops?since=0")
    assert catchup.status_code == 200, catchup.text
    assert catchup.json()["batches"], "the batch should be in the log"
    for batch in catchup.json()["batches"]:
        for op in batch["ops"]:
            assert "deleted" not in op

    # A plain block's delete records no payload at all: no growth, no change.
    plain = owner.post("/api/blocks", json={"parent_id": doc["id"], "content": "plain"}).json()
    assert ops(owner, doc["id"], [delete_op(plain["id"])]).status_code == 200
    with sqlite3.connect(ws_pages_db()) as conn:
        last = json.loads(conn.execute(
            "SELECT ops FROM page_ops WHERE page_id = ? ORDER BY seq DESC LIMIT 1",
            (doc["id"],)).fetchone()[0])
    assert last == [{"op": "delete", "id": plain["id"]}]


def test_a_row_that_merely_mentions_the_id_cannot_shadow_the_record(owner):
    """The lookup names the id it wants inside a recorded deletion, so newer
    batches whose text happens to contain the id (and the word "deleted") cannot
    hide the record from it."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)
    assert ops(owner, doc["id"], [delete_op(ink_id)]).status_code == 200

    # An ordinary property VALUE is the id: in the log's JSON that is the id in
    # quotes, which is exactly what a text-matching lookup keys on.
    for _ in range(30):
        assert ops(owner, doc["id"], [{
            "op": "insert", "id": str(uuid.uuid4()), "parent": doc["id"],
            "props": {"mention": ink_id}, "content": "a note, deleted? no"}]
        ).status_code == 200
    with sqlite3.connect(ws_pages_db()) as conn:
        lookalikes = conn.execute(
            "SELECT COUNT(*) FROM page_ops WHERE page_id = ? AND ops LIKE ?",
            (doc["id"], f'%"{ink_id}"%')).fetchone()[0]
    assert lookalikes > 16, "the fixture has to flood the log with id mentions"

    restored = ops(owner, doc["id"], [undo_insert_op(before)])
    assert restored.status_code == 200, restored.text
    assert block(owner, ink_id)["properties"] == before["properties"]


def test_other_deletions_that_reference_the_id_do_not_hide_its_record(owner):
    """An audio manifest names the blocks its stroke events happened in, so the
    record of a deleted recording can mention a deleted annotation's id over and
    over. The lookup matches ``deleted[].id``, so those rows can neither stand in
    for the annotation's own record nor hide it — and each recording still
    restores from its own."""
    doc = page(owner)
    victim = create_ink(owner, doc["id"])
    victim_before = block(owner, victim)

    recordings = []
    for _ in range(12):
        audio_id = create_audio(owner, doc["id"], segments=1, events_for=victim)
        recordings.append(block(owner, audio_id))

    assert ops(owner, doc["id"], [delete_op(victim)]).status_code == 200
    # Deleted after the annotation, so every one of these newer records mentions
    # the annotation's id inside its replay manifest.
    assert ops(owner, doc["id"], [delete_op(r["id"]) for r in recordings]).status_code == 200

    restored = ops(owner, doc["id"], [undo_insert_op(victim_before)])
    assert restored.status_code == 200, restored.text
    assert block(owner, victim)["properties"] == victim_before["properties"]

    # The reverse direction too: a recording's own record still wins for its id.
    recording = recordings[-1]
    back = ops(owner, doc["id"], [undo_insert_op(recording)])
    assert back.status_code == 200, back.text
    assert block(owner, recording["id"])["properties"] == recording["properties"]


def test_an_incoming_delete_op_cannot_inject_a_record(owner):
    """The record is written from the rows that are deleted, so a request cannot
    supply one: an extra field on a delete op is dropped and the logged entry
    names the deleted block and nothing else."""
    doc = page(owner)
    victim = create_ink(owner, doc["id"])
    forged_id = str(uuid.uuid4())
    assert ops(owner, doc["id"], [{
        "op": "delete", "id": victim,
        "deleted": [{"id": forged_id, "content": "",
                     "properties": {"type": "pdf_ink",
                                    "ink_asset": "/api/assets/" + "d" * 64 + ".pkdrawing"}}]},
    ]).status_code == 200
    with sqlite3.connect(ws_pages_db()) as conn:
        raw = conn.execute("SELECT ops FROM page_ops WHERE page_id = ? ORDER BY seq DESC LIMIT 1",
                           (doc["id"],)).fetchone()[0]
    entry = json.loads(raw)[0]
    assert entry["op"] == "delete" and entry["id"] == victim
    assert [snap["id"] for snap in entry["deleted"]] == [victim]
    assert owner.get(f"/api/blocks/{victim}").status_code == 404
    # The forged id was never recorded, so it is still a forgery.
    assert ops(owner, doc["id"], [{
        "op": "insert", "id": forged_id, "parent": doc["id"], "position": "a0",
        "content": "", "props": {"type": "pdf_ink",
                                 "ink_asset": "/api/assets/" + "d" * 64 + ".pkdrawing"}}]
    ).status_code == 409


def test_bulk_subtree_replace_records_nothing(owner):
    """Documented limit: ``PUT /blocks/{id}/children`` (imports, the paste-tree
    path) rewrites the tree without ops, so it leaves no provenance — an undo of
    THAT is still refused and the annotation has to come back from the iPad."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    before = block(owner, ink_id)

    replace = owner.put(f"/api/blocks/{doc['id']}/children", json={"blocks": []})
    assert replace.status_code == 200, replace.text
    assert owner.get(f"/api/blocks/{ink_id}").status_code == 404
    assert ops(owner, doc["id"], [undo_insert_op(before)]).status_code == 409


def test_a_second_delete_and_undo_cycle_works(owner):
    """Each delete records the state of its own moment, so a block can be
    deleted and undone more than once."""
    doc = page(owner)
    ink_id = create_ink(owner, doc["id"])
    assert owner.put(f"/api/blocks/{ink_id}", json={"content": "first caption"}).status_code == 200
    first = delete_and_undo(owner, doc, ink_id)
    assert first["content"] == "first caption"

    assert owner.put(f"/api/blocks/{ink_id}", json={"content": "second caption"}).status_code == 200
    second = delete_and_undo(owner, doc, ink_id)
    assert second["content"] == "second caption"
    assert second["properties"] == first["properties"]


def delete_and_undo(owner, doc, block_id):
    """One full editor cycle: delete, then the undo insert of the node the
    editor still holds."""
    node = block(owner, block_id)
    assert ops(owner, doc["id"], [delete_op(block_id)]).status_code == 200
    restored = ops(owner, doc["id"], [undo_insert_op(node)])
    assert restored.status_code == 200, restored.text
    return block(owner, block_id)

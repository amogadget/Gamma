"""Native (iPad) annotation endpoints: assets, ink, replay previews, notes.

Ported from the standalone native backend and re-pointed at this branch's model:
workspace-scoped auth (``?ws=`` / ``X-Gamma-Workspace``, members and shares),
the shared ops write path (CAS + op log + room fan-out), reserved-property
protection against generic writers, and assets that travel through backups,
scoped exports and readable Markdown bundles.

PNGs are built by hand: the server validates them without an image library
(``gamma.native_ink.png_dimensions``), and these tests must be able to do the
same with nothing but the standard library.
"""

import base64
import io
import json
import os
import sqlite3
import struct
import time
import uuid
import zipfile
import zlib

import pytest
from fastapi.testclient import TestClient

from conftest import login, make_page, make_user, workspace_of


def png_bytes(width=2, height=2, rgba=(0, 0, 0, 0)):
    """A minimal, structurally valid PNG (signature + IHDR + IDAT + IEND)."""
    raw = b"".join(b"\x00" + bytes(rgba) * width for _ in range(height))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def m4a_bytes(payload=b"audio"):
    """A plausible ISO-BMFF ``ftyp`` box; the audio itself stays opaque."""
    return (16 + len(payload)).to_bytes(4, "big") + b"ftyp" + b"M4A " + (0).to_bytes(4, "big") + payload


@pytest.fixture
def owner():
    make_user("ink-owner", "ink-password")
    with login("ink-owner", "ink-password") as client:
        yield client


def ws_of(username="ink-owner"):
    return workspace_of(username)


def asset(client, data=b"opaque PencilKit serialization", ext="pkdrawing"):
    ctype = {"png": "image/png", "m4a": "audio/mp4",
             "inkjson": "application/json"}.get(ext, "application/octet-stream")
    if ext == "png":
        data = png_bytes(5, 5)
    result = client.post("/api/assets", files={"file": (f"drawing.{ext}", data, ctype)})
    assert result.status_code == 200, result.text
    return result.json()


def payload(client):
    page = make_page(client, properties={"doc_id": "abcdef1234567890abcdef12"})
    return {"parent_id": page["id"], "pdf_page": 1,
            "ink_asset": asset(client)["url"], "preview_asset": asset(client, ext="png")["url"],
            "bounds": {"x": 10, "y": 20, "width": 30, "height": 40},
            "crop_box": {"width": 612, "height": 792}, "expected_revision": 0}


def replay_document(source_hash, *, points=None, png_size=(2, 2), strokes=True):
    return {"format": "gamma-ink-replay-v1", "source_sha256": source_hash,
            "width": 612, "height": 792, "strokes": ([{
                "id": "stroke-1", "bounds": {"x": 1, "y": 1, "width": 2, "height": 2},
                "png": base64.b64encode(
                    png_bytes(png_size[0], png_size[1], (0, 0, 0, 255))).decode(),
                "points": points or [{"x": 1, "y": 1, "t": 0, "radius": 1}]}] if strokes else [])}


def replay_asset(client, source_hash, data=None):
    data = data or replay_document(source_hash)
    result = client.post("/api/assets", files={"file": (
        "replay.inkjson", json.dumps(data).encode(), "application/json")})
    assert result.status_code == 200, result.text
    return result.json()


# --- assets -------------------------------------------------------------------


def test_asset_store_is_content_addressed_and_scoped(owner):
    first = asset(owner, b"unique bytes for the store")
    assert len(first["filename"].split(".")[0]) == 64 and first["already_existed"] is False
    again = asset(owner, b"unique bytes for the store")
    assert again["filename"] == first["filename"] and again["already_existed"] is True
    # The bytes land in the REQUEST's workspace uploads directory.
    from gamma.db import ws_uploads_dir
    assert (ws_uploads_dir(ws_of()) / first["filename"]).is_file()
    served = owner.get(first["url"])
    assert served.status_code == 200 and served.content == b"unique bytes for the store"
    assert served.headers["cache-control"] == "private, no-cache"
    assert served.headers["x-content-type-options"] == "nosniff"
    # The legacy alias names the same file with the same private policy.
    alias = owner.get(first["url"].replace("/assets/", "/uploads/"))
    assert alias.status_code == 200 and alias.content == b"unique bytes for the store"
    assert alias.headers["cache-control"] == "private, no-cache"
    # An explicit workspace header resolves the same scope.
    scoped = owner.get(first["url"], headers={"X-Gamma-Workspace": ws_of()})
    assert scoped.status_code == 200
    # A HEAD asks for the metadata alone (a client sizes an asset before
    # fetching it), under either URL form.
    head = owner.head(first["url"])
    assert head.status_code == 200 and head.content == b""
    assert head.headers["content-type"] == "application/octet-stream"
    assert owner.head(first["url"].replace("/assets/", "/uploads/")).status_code == 200
    # An explicit ?ws= names the same workspace.
    assert owner.get(first["url"], params={"ws": ws_of()}).status_code == 200
    assert owner.get(first["url"]).headers["content-disposition"] == \
        f'inline; filename="{first["filename"]}"'
    assert owner.get("/api/assets/" + "a" * 64 + ".pkdrawing").status_code == 404


def test_assets_auth_validation_and_quota(owner, monkeypatch):
    from fastapi import HTTPException
    from gamma import native_ink as native_core
    from gamma.app import app
    uploaded = asset(owner, b"unique quota bytes")
    with TestClient(app) as anonymous:
        assert anonymous.get(uploaded["url"]).status_code == 401
        assert anonymous.post("/api/assets", files={"file": ("x.pkdrawing", b"a")}).status_code == 401
    # Another account's workspace cannot read it, by hash or by any scope form.
    make_user("ink-other", "password")
    with login("ink-other", "password") as other:
        assert other.get(uploaded["url"]).status_code == 404
        assert other.get(uploaded["url"], headers={"X-Gamma-Workspace": ws_of()}).status_code == 403
        assert other.post("/api/assets", files={"file": (
            "x.pkdrawing", b"other bytes", "application/octet-stream")}).status_code == 200
    for name, mime, data in [("x.mp3", "audio/mpeg", b"audio"),
                             ("x.png", "image/png", b"fake"),
                             ("x.pkdrawing", "application/octet-stream", b""),
                             ("x.inkjson", "application/json", b"not json")]:
        assert owner.post("/api/assets", files={"file": (name, data, mime)}).status_code == 400
    # A declared type that does not match the extension is refused.
    assert owner.post("/api/assets", files={"file": (
        "x.pkdrawing", uuid.uuid4().bytes, "image/png")}).status_code == 400

    def deny(*args):
        raise HTTPException(507, "quota")
    monkeypatch.setattr(native_core, "check_upload_allowed", deny)
    assert asset(owner, b"unique quota bytes")["already_existed"]
    assert owner.post("/api/assets", files={"file": (
        "x.pkdrawing", uuid.uuid4().bytes, "application/octet-stream")}).status_code == 507
    monkeypatch.undo()
    replay = replay_asset(owner, "a" * 64)
    alias = owner.get(replay["url"].replace("/assets/", "/uploads/"))
    assert alias.status_code == 200 and alias.headers["content-type"].startswith("application/json")


def test_asset_upload_cap_and_png_validation(owner, monkeypatch):
    from gamma.routers import native_ink
    # Corrupt CRC: structurally bad PNGs are refused rather than stored.
    broken = bytearray(png_bytes(3, 3))
    broken[-5] ^= 0xFF
    assert owner.post("/api/assets", files={"file": ("x.png", bytes(broken), "image/png")}).status_code == 400
    monkeypatch.setattr(native_ink, "ASSET_MAX_BYTES", 16)
    assert owner.post("/api/assets", files={"file": (
        "x.pkdrawing", b"x" * 32, "application/octet-stream")}).status_code == 413


# --- ink ----------------------------------------------------------------------


def test_ink_retries_preserve_notes_and_scope(owner):
    body = payload(owner)
    block_id = str(uuid.uuid4())
    url = f"/api/blocks/{block_id}/ink"
    first = owner.put(url, json=body)
    assert first.status_code == 200, first.text
    block = first.json()
    assert block["properties"]["type"] == "pdf_ink"
    assert block["properties"]["ink_revision"] == 1
    assert block["content"] == "" and block["parent_id"] == body["parent_id"]
    assert owner.put(url, json=body).json() == block
    note = owner.put(f"/api/blocks/{block_id}", json={"content": "annotation note",
                                                     "properties": {"custom": 1}})
    assert note.status_code == 200, note.text
    child = owner.post("/api/blocks", json={"parent_id": block_id, "content": "child"}).json()
    changed = {**body, "bounds": {"x": 11, "y": 20, "width": 30, "height": 40}}
    assert owner.put(url, json=changed).status_code == 409
    changed["expected_revision"] = 1
    saved = owner.put(url, json=changed).json()
    assert saved["content"] == "annotation note"
    assert saved["properties"]["custom"] == 1
    assert saved["properties"]["ink_revision"] == 2
    assert owner.put(url, json=changed).json() == saved
    assert owner.get(f"/api/blocks/{block_id}/children").json()["children"][0]["id"] == child["id"]
    assert owner.put(url, json={**changed, "pdf_page": 2}).status_code == 409
    assert owner.put(url, json={**changed, "parent_id": make_page(owner)["id"]}).status_code == 409
    assert owner.put("/api/blocks/not-a-uuid/ink", json=body).status_code == 422
    # A client UUID already used for a plain block cannot be hijacked.
    occupied = str(uuid.uuid4())
    from gamma.db import ws_db_path
    with sqlite3.connect(ws_db_path(ws_of(), "pages.db")) as conn:
        conn.execute("UPDATE unified_blocks SET id = ? WHERE id = ?", (occupied, child["id"]))
    assert owner.put(f"/api/blocks/{occupied}/ink", json=body).status_code == 409


def test_ink_save_is_one_ops_batch_and_notifies_the_page(owner):
    body = payload(owner)
    block_id = str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{block_id}/ink", json=body).status_code == 200
    # The page's op log carries the batch, so a client with the page open sees
    # the annotation arrive without refetching the tree.
    log = owner.get(f"/api/pages/{body['parent_id']}/ops").json()
    assert log["seq"] >= 1
    batch = log["batches"][-1]
    assert batch["client"] == "native" and batch["actor"] == "ink-owner"
    assert [op["op"] for op in batch["ops"]] == ["insert"]
    assert batch["ops"][0]["props"]["type"] == "pdf_ink"
    updated = {**body, "bounds": {"x": 12, "y": 20, "width": 30, "height": 40},
               "expected_revision": 1}
    assert owner.put(f"/api/blocks/{block_id}/ink", json=updated).status_code == 200
    log = owner.get(f"/api/pages/{body['parent_id']}/ops?since={batch['seq']}").json()
    assert [op["op"] for op in log["batches"][-1]["ops"]] == ["set"]
    # The saved block is the ops-visible state, not a private side table.
    assert owner.get(f"/api/blocks/{block_id}").json()["properties"]["ink_revision"] == 2


def test_replay_missing_preserve_clear_and_source_change(owner):
    body = payload(owner)
    block_id = str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{block_id}/ink", json=body).status_code == 200
    source_hash = body["ink_asset"].rsplit("/", 1)[-1].split(".", 1)[0]
    replay = replay_asset(owner, source_hash)
    attached = owner.put(f"/api/blocks/{block_id}/ink",
                         json={**body, "replay_asset": replay["url"], "expected_revision": 1})
    assert attached.status_code == 200, attached.text
    assert attached.json()["properties"]["ink_revision"] == 2
    preserved = owner.put(f"/api/blocks/{block_id}/ink", json={
        **body, "bounds": {"x": 11, "y": 20, "width": 30, "height": 40}, "expected_revision": 2})
    assert preserved.status_code == 200, preserved.text
    assert preserved.json()["properties"]["replay_asset"] == replay["url"]
    cleared = owner.put(f"/api/blocks/{block_id}/ink", json={**body,
                                                             "replay_asset": None, "expected_revision": 3})
    assert cleared.status_code == 200
    assert "replay_asset" not in cleared.json()["properties"]
    changed_source = asset(owner, b"changed source for replay")
    removed = owner.put(f"/api/blocks/{block_id}/ink", json={
        **body, "ink_asset": changed_source["url"], "expected_revision": 4})
    assert removed.status_code == 200, removed.text
    assert "replay_asset" not in removed.json()["properties"]
    missing = owner.put(f"/api/blocks/{uuid.uuid4()}/ink", json={**body,
                                                                 "replay_asset": "/api/assets/" + "f" * 64 + ".inkjson"})
    assert missing.status_code == 404


def test_replay_preview_backfill_preserves_revision_and_source(owner):
    body = payload(owner)
    block_id = str(uuid.uuid4())
    saved = owner.put(f"/api/blocks/{block_id}/ink", json=body).json()
    owner.put(f"/api/blocks/{block_id}", json={"content": "existing note", "properties": {"custom": 7}})
    child = owner.post("/api/blocks", json={"parent_id": block_id, "content": "child"}).json()
    source_hash = body["ink_asset"].rsplit("/", 1)[-1].split(".", 1)[0]
    replay = replay_asset(owner, source_hash)
    result = owner.put(f"/api/blocks/{block_id}/replay-preview", json={
        "ink_asset": body["ink_asset"], "replay_asset": replay["url"]})
    assert result.status_code == 200, result.text
    updated = result.json()
    assert updated["properties"]["replay_asset"] == replay["url"]
    assert updated["properties"]["ink_revision"] == saved["properties"]["ink_revision"]
    assert updated["properties"]["custom"] == 7
    assert updated["content"] == "existing note"
    assert owner.get(f"/api/blocks/{block_id}/children").json()["children"][0]["id"] == child["id"]
    missing = owner.put(f"/api/blocks/{block_id}/replay-preview", json={
        "ink_asset": body["ink_asset"], "replay_asset": "/api/assets/" + "f" * 64 + ".inkjson"})
    assert missing.status_code == 404
    wrong_replay = replay_asset(owner, "b" * 64)
    assert owner.put(f"/api/blocks/{block_id}/replay-preview", json={
        "ink_asset": body["ink_asset"], "replay_asset": wrong_replay["url"]}).status_code == 409
    wrong = {**body, "ink_asset": asset(owner, b"different drawing source")["url"]}
    assert owner.put(f"/api/blocks/{block_id}/replay-preview", json={
        "ink_asset": wrong["ink_asset"], "replay_asset": replay["url"]}).status_code == 409
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/replay-preview", json={
        "ink_asset": body["ink_asset"], "replay_asset": replay["url"]}).status_code == 404


def test_replay_asset_validation_limits_and_source_hash(owner):
    bad_cases = [
        ({"format": "gamma-ink-replay-v1", "source_sha256": "a" * 64,
          "width": 10, "height": 10, "strokes": [{"id": "s", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1},
                                                  "png": "not-base64",
                                                  "points": [{"x": 0, "y": 0, "t": 0, "radius": 1}]}]}, 400),
        (replay_document("a" * 64, png_size=(4097, 1)), 400),
        (replay_document("a" * 64, points=[{"x": 1, "y": 1, "t": 1, "radius": 1},
                                           {"x": 1, "y": 1, "t": 0, "radius": 1}]), 400),
        (replay_document("a" * 64, points=[{"x": 1, "y": 1, "t": 0, "radius": 1}] * 200001), 400),
    ]
    for data, expected in bad_cases:
        result = owner.post("/api/assets", files={"file": (
            "bad.inkjson", json.dumps(data).encode(), "application/json")})
        assert result.status_code == expected, result.text
    body = payload(owner)
    wrong = replay_asset(owner, "b" * 64)
    save = owner.put(f"/api/blocks/{uuid.uuid4()}/ink", json={**body, "replay_asset": wrong["url"]})
    assert save.status_code == 422, save.text


@pytest.mark.parametrize("patch", [
    {"pdf_page": 0}, {"pdf_page": True}, {"expected_revision": -1},
    {"coordinate_space": "screen"}, {"content": "not allowed"},
    {"ink_asset": "/api/assets/../../secret.pkdrawing"},
    {"preview_asset": "https://example.com/image.png"},
    {"bounds": {"x": 600, "y": 0, "width": 100, "height": 20}},
    {"bounds": {"x": 0, "y": 0, "width": 0, "height": 20}},
])
def test_invalid_geometry(owner, patch):
    body = payload(owner)
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/ink", json={**body, **patch}).status_code == 422


def test_ink_save_requires_stored_assets(owner):
    body = payload(owner)
    body["ink_asset"] = "/api/assets/" + "a" * 64 + ".pkdrawing"
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/ink", json=body).status_code == 404
    body = payload(owner)
    body["preview_asset"] = "/api/assets/" + "a" * 64 + ".png"
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/ink", json=body).status_code == 404
    # A parent that is not a PDF page is refused outright.
    plain = make_page(owner, "No PDF")
    body = payload(owner)
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/ink", json={**body, "parent_id": plain["id"]}).status_code == 409
    assert owner.put(f"/api/blocks/{uuid.uuid4()}/ink", json={**body, "parent_id": "nope"}).status_code == 404


# --- reserved native fields vs generic writers ---------------------------------


def _an_ink_block(owner):
    body = payload(owner)
    block_id = str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{block_id}/ink", json=body).status_code == 200
    return body, block_id


def test_generic_writers_cannot_touch_reserved_ink_fields(owner):
    body, block_id = _an_ink_block(owner)
    page_id = body["parent_id"]
    # PUT /blocks/{id}
    for patch in ({"ink_asset": body["preview_asset"]}, {"ink_revision": 99},
                  {"type": "note"}, {"bounds": {"x": 0, "y": 0, "width": 1, "height": 1}},
                  {"replay_asset": None}, {"pdf_page": 3}):
        r = owner.put(f"/api/blocks/{block_id}", json={"properties": patch})
        assert r.status_code == 409, (patch, r.text)
    # The page ops endpoint (what the editor's collaboration session posts).
    for patch in ({"ink_asset": None}, {"ink_revision": 99}, {"preview_asset": "x"}):
        r = owner.post(f"/api/pages/{page_id}/ops", json={"client": "web", "ops": [
            {"op": "set", "id": block_id, "props": patch}]})
        assert r.status_code == 409, (patch, r.text)
    # Unrelated properties and the text stay writable.
    r = owner.post(f"/api/pages/{page_id}/ops", json={"client": "web", "ops": [
        {"op": "set", "id": block_id, "content": "web caption", "props": {"color": "#fff"}}]})
    assert r.status_code == 200, r.text
    block = owner.get(f"/api/blocks/{block_id}").json()
    assert block["content"] == "web caption" and block["properties"]["color"] == "#fff"
    assert block["properties"]["ink_asset"] == body["ink_asset"]
    assert block["properties"]["ink_revision"] == 1
    # A generic writer cannot invent a native block either.
    for props in ({"type": "pdf_ink"}, {"type": "audio"}, {"segments": []},
                  {"native_note": True, "note_revision": 1}, {"ink_asset": body["ink_asset"]}):
        r = owner.post(f"/api/pages/{page_id}/ops", json={"client": "web", "ops": [
            {"op": "insert", "id": f"blk-{uuid.uuid4().hex[:8]}", "parent": page_id,
             "content": "", "props": props}]})
        assert r.status_code == 409, (props, r.text)
    r = owner.post("/api/blocks", json={"parent_id": page_id, "content": "forged",
                                        "properties": {"type": "pdf_ink"}})
    assert r.status_code == 409, r.text
    r = owner.post("/api/blocks", json={"parent_id": "root", "content": "forged page",
                                        "properties": {"native_note": True}})
    assert r.status_code == 409, r.text
    # A page title (a content write on the root) is untouched by all of this.
    assert owner.put(f"/api/blocks/{page_id}", json={"content": "Renamed"}).status_code == 200


def test_generic_note_edit_moves_note_revision(owner):
    body = payload(owner)
    ink_id, note_id = str(uuid.uuid4()), str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{ink_id}/ink", json=body).status_code == 200
    url = f"/api/blocks/{note_id}/note"
    note = {"parent_id": ink_id, "content": "offline note", "expected_revision": 0}
    first = owner.put(url, json=note)
    assert first.status_code == 200, first.text
    assert first.json()["properties"]["note_revision"] == 1
    # A Web edit moves the revision, so the queued offline save conflicts.
    assert owner.put(f"/api/blocks/{note_id}", json={"content": "web edit"}).status_code == 200
    assert owner.get(f"/api/blocks/{note_id}").json()["properties"]["note_revision"] == 2
    conflict = owner.put(url, json=note)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["current_revision"] == 2
    updated = owner.put(url, json={**note, "content": "changed", "expected_revision": 2})
    assert updated.status_code == 200, updated.text
    assert updated.json()["properties"]["note_revision"] == 3
    # The versioned CAS on the ink block is independent of the note's.
    assert owner.get(f"/api/blocks/{ink_id}").json()["properties"]["ink_revision"] == 1


def test_bulk_subtree_write_preserves_native_payload(owner):
    body, block_id = _an_ink_block(owner)
    source_hash = body["ink_asset"].rsplit("/", 1)[-1].split(".", 1)[0]
    preview = replay_asset(owner, source_hash)["url"]
    assert owner.put(f"/api/blocks/{block_id}/replay-preview", json={
        "ink_asset": body["ink_asset"], "replay_asset": preview}).status_code == 200
    created = owner.get(f"/api/blocks/{block_id}").json()
    # A stale Web tree (up to date text, no replay, old geometry) replaces the
    # page's children — the recorded payload must survive it.
    stale = {"id": block_id, "content": "Web note edit from older tree",
             "properties": {"type": "pdf_ink", "ink_asset": body["ink_asset"],
                            "pdf_page": 1, "custom": "kept"},
             "children": []}
    response = owner.put(f"/api/blocks/{body['parent_id']}/children", json={"blocks": [stale]})
    assert response.status_code == 200, response.text
    restored = owner.get(f"/api/blocks/{block_id}/subtree").json()["block"]
    assert restored["content"] == "Web note edit from older tree"
    assert restored["properties"]["replay_asset"] == preview
    assert restored["properties"]["ink_revision"] == created["properties"]["ink_revision"]
    assert restored["properties"]["custom"] == "kept"
    # ... and a bulk write may not conjure a native payload on a plain block.
    r = owner.put(f"/api/blocks/{body['parent_id']}/children", json={"blocks": [
        {"id": "plain-bulk-1", "content": "x", "properties": {"type": "audio"}, "children": []}]})
    assert r.status_code == 409, r.text


# --- notes ---------------------------------------------------------------------


def test_native_note_outbox(owner):
    body = payload(owner)
    ink_id, note_id = str(uuid.uuid4()), str(uuid.uuid4())
    owner.put(f"/api/blocks/{ink_id}/ink", json=body)
    url = f"/api/blocks/{note_id}/note"
    note = {"parent_id": ink_id, "content": "offline note", "expected_revision": 0}
    first = owner.put(url, json=note)
    assert first.status_code == 200, first.text
    assert first.json()["properties"] == {"native_note": True, "note_revision": 1}
    assert owner.put(url, json=note).json() == first.json()
    assert owner.put(url, json={**note, "content": "changed"}).status_code == 409
    owner.put(f"/api/blocks/{note_id}", json={"content": "web edit"})
    assert owner.put(url, json={**note, "content": "changed", "expected_revision": 1}).status_code == 409
    updated = owner.put(url, json={**note, "content": "changed", "expected_revision": 2})
    assert updated.json()["properties"]["note_revision"] == 3
    assert owner.put(url, json={**note, "parent_id": body["parent_id"]}).status_code == 409
    assert owner.put(f"/api/blocks/not-a-uuid/note", json=note).status_code == 422


def test_nested_native_notes_require_bounded_ink_ancestry(owner):
    body = payload(owner)
    ink_id = str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{ink_id}/ink", json=body).status_code == 200
    parent = ink_id
    note_ids = []
    for _ in range(3):
        note_id = str(uuid.uuid4())
        note = {"parent_id": parent, "content": "nested", "expected_revision": 0}
        url = f"/api/blocks/{note_id}/note"
        result = owner.put(url, json=note)
        assert result.status_code == 200, result.text
        assert owner.put(url, json=note).json() == result.json()
        note_ids.append(note_id)
        parent = note_id
    plain = owner.post("/api/blocks", json={"parent_id": ink_id, "content": "ordinary text"}).json()
    url = f"/api/blocks/{uuid.uuid4()}/note"
    assert owner.put(url, json={"parent_id": plain["id"], "content": "no takeover"}).status_code == 409
    # Reparenting a native ancestor outside ink invalidates descendants too.
    owner.post(f"/api/blocks/{note_ids[0]}/reorder", json={"parent_id": body["parent_id"]})
    assert owner.put(url, json={"parent_id": parent, "content": "detached"}).status_code == 409
    # A corrupt cycle must terminate instead of hanging or accepting the write.
    from gamma.db import ws_db_path
    with sqlite3.connect(ws_db_path(ws_of(), "pages.db")) as conn:
        conn.execute("UPDATE unified_blocks SET parent_id = ? WHERE id = ?", (parent, note_ids[0]))
    assert owner.put(url, json={"parent_id": parent, "content": "cycle"}).status_code == 409


# --- workspace and share scope -------------------------------------------------


def test_share_editor_writes_are_confined_to_the_shared_page(owner):
    """An edit share may annotate its own page — in the SHARING workspace — and
    nothing else; a view share and an anonymous visitor may only read."""
    from gamma.app import app
    shared = make_page(owner, "Shared page", properties={"doc_id": "aaaaaaaaaaaaaaaaaaaaaaaa"})
    private = make_page(owner, "Private page", properties={"doc_id": "bbbbbbbbbbbbbbbbbbbbbbbb"})
    private_asset = asset(owner, b"private only bytes")
    preview = asset(owner, ext="png")
    private_ink = str(uuid.uuid4())
    private_body = {"parent_id": private["id"], "pdf_page": 1,
                    "ink_asset": private_asset["url"], "preview_asset": preview["url"],
                    "bounds": {"x": 1, "y": 1, "width": 10, "height": 10},
                    "crop_box": {"width": 612, "height": 792}, "expected_revision": 0}
    assert owner.put(f"/api/blocks/{private_ink}/ink", json=private_body).status_code == 200

    # Editing is never anonymous: an invited, signed-in editor.
    link = owner.post(f"/api/share/{shared['id']}", json={
        "audience": "users", "role": "edit"}).json()
    token = link["token"]
    assert link["role"] == "edit"
    make_user("ink-share-editor", "share-password")
    with login("ink-share-editor", "share-password") as editor:
        edit = {"share": token}
        uploaded = editor.post("/api/assets", params=edit, files={
            "file": ("drawing.pkdrawing", b"visitor drawing", "application/octet-stream")})
        assert uploaded.status_code == 200, uploaded.text
        block_id = str(uuid.uuid4())
        saved = editor.put(f"/api/blocks/{block_id}/ink", params=edit, json={
            "parent_id": shared["id"], "pdf_page": 1, "ink_asset": uploaded.json()["url"],
            "preview_asset": preview["url"],
            "bounds": {"x": 2, "y": 2, "width": 20, "height": 20},
            "crop_box": {"width": 612, "height": 792}, "expected_revision": 0})
        assert saved.status_code == 200, saved.text
        # The annotation landed in the SHARING workspace, where its owner sees
        # it like any other edit on that page.
        assert owner.get(f"/api/blocks/{block_id}").status_code == 200
        # ... and never outside the shared page.
        assert editor.put(f"/api/blocks/{uuid.uuid4()}/ink", params=edit, json={
            **private_body, "expected_revision": 0}).status_code == 403
        assert editor.put(f"/api/blocks/{private_ink}/replay-preview", params=edit, json={
            "ink_asset": private_asset["url"],
            "replay_asset": "/api/assets/" + "a" * 64 + ".inkjson"}).status_code == 403
        assert editor.put(f"/api/blocks/{uuid.uuid4()}/note", params=edit, json={
            "parent_id": private_ink, "content": "off topic"}).status_code == 403
        assert editor.put(f"/api/blocks/{uuid.uuid4()}/highlight", params=edit,
                          json=_highlight_body(private["id"])).status_code == 403
        assert editor.get(uploaded.json()["url"], params=edit).status_code == 200
        assert editor.get(private_asset["url"], params=edit).status_code == 404
        # The asset names work under either URL form, with the same rule.
        assert editor.get(uploaded.json()["url"].replace("/assets/", "/uploads/"),
                          params=edit).status_code == 200
        assert editor.get(private_asset["url"].replace("/assets/", "/uploads/"),
                          params=edit).status_code == 404
        # Without the share parameter this account is simply in its own
        # workspace, where neither file exists.
        assert editor.get(private_asset["url"]).status_code == 404

    # A public view link reads its page's assets and refuses every write path.
    view_token = owner.post(f"/api/share/{private['id']}", json={
        "audience": "anyone", "role": "view"}).json()["token"]
    with TestClient(app) as anonymous:
        read = {"share": view_token}
        assert anonymous.get(private_asset["url"], params=read).status_code == 200
        assert anonymous.get(asset(owner, ext="png")["url"], params=read).status_code == 200
        assert anonymous.get(private_asset["url"]).status_code == 401
        assert anonymous.post("/api/assets", params=read, files={
            "file": ("x.pkdrawing", b"nope", "application/octet-stream")}).status_code == 403
        assert anonymous.put(f"/api/blocks/{uuid.uuid4()}/ink", params=read, json={
            **private_body, "expected_revision": 0}).status_code == 403
        assert anonymous.put(f"/api/blocks/{uuid.uuid4()}/highlight", params=read,
                             json=_highlight_body(private["id"])).status_code == 403
        assert anonymous.put(f"/api/blocks/{uuid.uuid4()}/audio", params=read, json={
            "parent_id": private["id"], "expected_revision": 0, "audio_state": "stopped",
            "segments": []}).status_code == 403


def _highlight_body(page_id):
    rect = {"x1": 1, "y1": 1, "x2": 2, "y2": 2, "width": 10, "height": 10, "pageNumber": 1}
    return {"parent_id": page_id, "quote": "q", "color": "#ffe28f",
            "pdf_position": {"pageNumber": 1, "boundingRect": rect, "rects": [rect]}}


# --- cleanup, backups and exports ----------------------------------------------


def test_cleanup_and_export_restore(owner):
    from gamma.db import ws_db_path, ws_uploads_dir
    from gamma.storage import cleanup_orphan_uploads
    body = payload(owner)
    body["ink_asset"] = asset(owner, uuid.uuid4().bytes)["url"]
    source_hash = body["ink_asset"].rsplit("/", 1)[-1].split(".", 1)[0]
    body["replay_asset"] = replay_asset(owner, source_hash)["url"]
    block_id = str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{block_id}/ink", json=body).status_code == 200
    pending = asset(owner, uuid.uuid4().bytes)
    uploads = ws_uploads_dir(ws_of())
    old = time.time() - 365 * 24 * 60 * 60
    for ref in (body["ink_asset"], body["preview_asset"], body["replay_asset"]):
        os.utime(uploads / ref.rsplit("/", 1)[-1], (old, old))
    with sqlite3.connect(ws_db_path(ws_of(), "pages.db")) as conn:
        cleanup_orphan_uploads(conn, uploads)
        # Native sources remain available even after a prolonged offline gap.
        assert (uploads / pending["filename"]).exists()
        os.utime(uploads / pending["filename"], (old, old))
        assert pending["filename"] not in cleanup_orphan_uploads(conn, uploads)
        assert (uploads / pending["filename"]).exists()
        # Referenced native files remain byte-preserved too.
        for ref in (body["ink_asset"], body["preview_asset"], body["replay_asset"]):
            assert (uploads / ref.rsplit("/", 1)[-1]).exists()
    # Deleting an unrelated block runs the same sweep (startup and every
    # reference-dropping write do): the annotation's assets must survive it.
    unrelated = owner.post("/api/blocks", json={"parent_id": body["parent_id"],
                                                "content": "unrelated"}).json()
    assert owner.delete(f"/api/blocks/{unrelated['id']}").status_code == 200
    for ref in (body["ink_asset"], body["preview_asset"], body["replay_asset"]):
        assert (uploads / ref.rsplit("/", 1)[-1]).exists()
    # The other export formats still render a page that carries native
    # annotations (they do not flatten PencilKit strokes, but they must not
    # break on them either).
    for mode in ("notes-pdf", "obsidian", "logseq-graph", "zotero-rdf"):
        assert owner.get(f"/api/pages/{body['parent_id']}/export?mode={mode}").status_code == 200, mode
    for mode in ("gamma", "readable"):
        response = owner.get(f"/api/pages/{body['parent_id']}/export?mode={mode}")
        assert response.status_code == 200, response.text
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            for ref in (body["ink_asset"], body["preview_asset"], body["replay_asset"]):
                assert ("uploads/" if mode == "gamma" else "assets/") + ref.rsplit("/", 1)[-1] \
                    in archive.namelist()
            if mode == "readable":
                markdown = next(archive.read(name).decode()
                                for name in archive.namelist() if name.endswith(".md"))
                assert body["ink_asset"].rsplit("/", 1)[-1] in markdown
                assert body["replay_asset"].rsplit("/", 1)[-1] in markdown
        if mode == "gamma":
            restored = owner.post("/api/import-data?mode=merge", files={
                "file": ("ink.zip", response.content, "application/zip")})
            assert restored.status_code == 200, restored.text
    full = owner.get("/api/export")
    with zipfile.ZipFile(io.BytesIO(full.content)) as archive:
        assert "uploads/" + body["ink_asset"].rsplit("/", 1)[-1] in archive.namelist()
        assert "uploads/" + body["replay_asset"].rsplit("/", 1)[-1] in archive.namelist()
    owner.delete(f"/api/blocks/{block_id}")
    assert (uploads / body["ink_asset"].rsplit("/", 1)[-1]).exists()
    assert (uploads / body["replay_asset"].rsplit("/", 1)[-1]).exists()


def test_backup_restores_native_assets_into_a_fresh_workspace(owner):
    """The whole-workspace backup is the portability promise: the recorded
    bytes and the block that names them come back together."""
    from gamma.db import ws_uploads_dir
    body, block_id = _an_ink_block(owner)
    backup = owner.get("/api/export")
    assert backup.status_code == 200, backup.text
    make_user("ink-restore", "restore-password")
    with login("ink-restore", "restore-password") as other:
        target = ws_of("ink-restore")
        imported = other.post("/api/import-data?mode=replace", files={
            "file": ("backup.zip", backup.content, "application/zip")})
        assert imported.status_code == 200, imported.text
        assert (ws_uploads_dir(target) / body["ink_asset"].rsplit("/", 1)[-1]).is_file()
        # Scoped to the receiving workspace, the restored asset is readable and
        # the annotation block is intact.
        assert other.get(body["ink_asset"]).status_code == 200
        restored = other.get(f"/api/blocks/{block_id}").json()
        assert restored["properties"]["type"] == "pdf_ink"
        assert restored["properties"]["ink_asset"] == body["ink_asset"]

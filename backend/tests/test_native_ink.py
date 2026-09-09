"""Native Gamma ink: durable retries, scope, assets and backup preservation."""
import io
import os
import sqlite3
import time
import uuid
import zipfile

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from conftest import make_page, make_user, login


@pytest.fixture
def owner():
    make_user("ink-owner", "ink-password")
    with login("ink-owner", "ink-password") as client:
        yield client


def asset(client, data=b"opaque PencilKit serialization", ext="pkdrawing"):
    if ext == "png":
        output = io.BytesIO()
        Image.new("RGBA", (5, 5)).save(output, format="PNG")
        data = output.getvalue()
    result = client.post("/api/assets", files={"file": (
        f"drawing.{ext}", data, "image/png" if ext == "png" else "application/octet-stream")})
    assert result.status_code == 200, result.text
    return result.json()


def payload(client):
    page = make_page(client, properties={"doc_id": "abcdef1234567890abcdef12"})
    return {"parent_id": page["id"], "pdf_page": 1,
            "ink_asset": asset(client)["url"], "preview_asset": asset(client, ext="png")["url"],
            "bounds": {"x": 10, "y": 20, "width": 30, "height": 40},
            "crop_box": {"width": 612, "height": 792}, "expected_revision": 0}


def test_ink_retries_preserve_notes_and_scope(owner):
    body = payload(owner)
    block_id = str(uuid.uuid4())
    url = f"/api/blocks/{block_id}/ink"
    first = owner.put(url, json=body)
    assert first.status_code == 200, first.text
    block = first.json()
    assert block["properties"]["type"] == "pdf_ink"
    assert block["properties"]["ink_revision"] == 1
    assert owner.put(url, json=body).json() == block
    owner.put(f"/api/blocks/{block_id}", json={"content": "annotation note", "properties": {"custom": 1}})
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
    from gamma.db import user_db_path
    with sqlite3.connect(user_db_path("ink-owner", "pages.db")) as conn:
        conn.execute("UPDATE unified_blocks SET id = ? WHERE id = ?", (occupied, child["id"]))
    assert owner.put(f"/api/blocks/{occupied}/ink", json=body).status_code == 409


def test_assets_auth_validation_and_quota(owner, monkeypatch):
    from gamma.app import app
    from gamma.routers import ink
    from fastapi import HTTPException
    uploaded = asset(owner, b"unique quota bytes")
    assert len(uploaded["filename"].split(".")[0]) == 64
    served = owner.get(uploaded["url"])
    assert served.content == b"unique quota bytes"
    assert served.headers["cache-control"] == "private, no-cache"
    with TestClient(app) as anonymous:
        assert anonymous.get(uploaded["url"]).status_code == 401
        assert anonymous.post("/api/assets", files={"file": ("x.pkdrawing", b"a")}).status_code == 401
    make_user("ink-other", "password")
    with login("ink-other", "password") as other:
        assert other.get(uploaded["url"]).status_code == 404
    for name, mime, data in [("x.mp3", "audio/mpeg", b"audio"),
                              ("x.png", "image/png", b"fake"),
                              ("x.pkdrawing", "application/octet-stream", b"")]:
        assert owner.post("/api/assets", files={"file": (name, data, mime)}).status_code == 400
    def deny(*args):
        raise HTTPException(507, "quota")
    monkeypatch.setattr(ink, "check_upload_allowed", deny)
    assert asset(owner, b"unique quota bytes")["already_existed"]
    assert owner.post("/api/assets", files={"file": ("x.pkdrawing", uuid.uuid4().bytes,
                                                                  "application/octet-stream")}).status_code == 507
    preview = asset(owner, ext="png")
    alias = owner.get(preview["url"].replace("/assets/", "/uploads/"))
    assert alias.headers["cache-control"] == "private, no-cache"
    share_page = make_page(owner, properties={"doc_id": "aaaa1111aaaa1111aaaa1111"})
    token_response = owner.post("/api/share/aaaa1111aaaa1111aaaa1111")
    assert token_response.status_code == 200, token_response.text
    token = token_response.json()["token"]
    with TestClient(app) as anonymous:
        assert anonymous.get(preview["url"] + f"?share={token}").status_code == 401
        assert anonymous.get(preview["url"].replace("/assets/", "/uploads/") + f"?share={token}").status_code == 401
    owner.delete(f"/api/blocks/{share_page['id']}")


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


def test_cleanup_and_export_restore(owner):
    from gamma.db import user_db_path, user_uploads_dir
    from gamma.storage import cleanup_orphan_uploads, INK_STAGING_SECONDS
    body = payload(owner)
    body["ink_asset"] = asset(owner, uuid.uuid4().bytes)["url"]
    block_id = str(uuid.uuid4())
    assert owner.put(f"/api/blocks/{block_id}/ink", json=body).status_code == 200
    pending = asset(owner, uuid.uuid4().bytes)
    uploads = user_uploads_dir("ink-owner")
    old = time.time() - INK_STAGING_SECONDS - 100
    for ref in (body["ink_asset"], body["preview_asset"]):
        os.utime(uploads / ref.rsplit("/", 1)[-1], (old, old))
    with sqlite3.connect(user_db_path("ink-owner", "pages.db")) as conn:
        cleanup_orphan_uploads(conn, uploads)
        assert (uploads / pending["filename"]).exists()
        os.utime(uploads / pending["filename"], (old, old))
        assert pending["filename"] in cleanup_orphan_uploads(conn, uploads)
    for mode in ("gamma", "readable"):
        response = owner.get(f"/api/pages/{body['parent_id']}/export?mode={mode}")
        assert response.status_code == 200, response.text
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            for ref in (body["ink_asset"], body["preview_asset"]):
                assert ("uploads/" if mode == "gamma" else "assets/") + ref.rsplit("/", 1)[-1] in archive.namelist()
        if mode == "gamma":
            restored = owner.post("/api/import-data?mode=merge", files={"file": ("ink.zip", response.content, "application/zip")})
            assert restored.status_code == 200, restored.text
    full = owner.get("/api/export")
    with zipfile.ZipFile(io.BytesIO(full.content)) as archive:
        assert "uploads/" + body["ink_asset"].rsplit("/", 1)[-1] in archive.namelist()
    owner.delete(f"/api/blocks/{block_id}")
    assert not (uploads / body["ink_asset"].rsplit("/", 1)[-1]).exists()


def test_native_note_outbox(owner):
    body = payload(owner)
    ink_id, note_id = str(uuid.uuid4()), str(uuid.uuid4())
    owner.put(f"/api/blocks/{ink_id}/ink", json=body)
    url = f"/api/blocks/{note_id}/note"
    note = {"parent_id": ink_id, "content": "offline note", "expected_revision": 0}
    first = owner.put(url, json=note)
    assert first.status_code == 200, first.text
    assert owner.put(url, json=note).json() == first.json()
    assert owner.put(url, json={**note, "content": "changed"}).status_code == 409
    owner.put(f"/api/blocks/{note_id}", json={"content": "web edit"})
    assert owner.put(url, json={**note, "content": "changed", "expected_revision": 1}).status_code == 409
    updated = owner.put(url, json={**note, "content": "changed", "expected_revision": 2})
    assert updated.json()["properties"]["note_revision"] == 3
    assert owner.put(url, json={**note, "parent_id": body["parent_id"]}).status_code == 409


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
    from gamma.db import user_db_path
    with sqlite3.connect(user_db_path("ink-owner", "pages.db")) as conn:
        conn.execute("UPDATE unified_blocks SET parent_id = ? WHERE id = ?", (parent, note_ids[0]))
    assert owner.put(url, json={"parent_id": parent, "content": "cycle"}).status_code == 409

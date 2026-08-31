"""Scoped Gamma archive export and additive merge security boundaries."""

import io
import json
import sqlite3
import tempfile
import zipfile

import pytest
from fastapi.testclient import TestClient

from conftest import login, make_page, make_user
from gamma.app import app


_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c626001000000ffff03000006000557"
    "bfabd40000000049454e44ae426082"
)


@pytest.fixture(scope="module")
def gamma_donor(client):
    make_user("gamma-donor", "password12345")
    return login("gamma-donor", "password12345")


@pytest.fixture(scope="module")
def gamma_receiver(client):
    make_user("gamma-receiver", "password12345")
    return login("gamma-receiver", "password12345")


def _archive(response):
    assert response.status_code == 200, response.text
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    for name in archive.namelist():
        assert not name.startswith("/")
        assert not any(part in {"", ".", ".."} for part in name.split("/"))
    return archive


def _sqlite_rows(archive, name, query):
    with tempfile.NamedTemporaryFile(suffix=".db") as output:
        output.write(archive.read(name))
        output.flush()
        with sqlite3.connect(output.name) as connection:
            return connection.execute(query).fetchall()


def _zip_with_extra(payload: bytes, name: str, data: bytes) -> bytes:
    source = zipfile.ZipFile(io.BytesIO(payload))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for info in source.infolist():
            archive.writestr(info, source.read(info.filename))
        archive.writestr(name, data)
    return output.getvalue()


def _zip_replace(payload: bytes, name: str, data: bytes) -> bytes:
    source = zipfile.ZipFile(io.BytesIO(payload))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for info in source.infolist():
            if info.filename != name:
                archive.writestr(info, source.read(info.filename))
        archive.writestr(name, data)
    return output.getvalue()


def _save_chat(client, key, text):
    response = client.put(
        f"/api/chats/{key}",
        json={"messages": [{"role": "user", "content": text}]},
    )
    assert response.status_code == 200, response.text


def test_gamma_page_export_is_exact_and_records_missing_uploads(gamma_donor):
    uploaded = gamma_donor.post(
        "/api/upload-image",
        files={"file": ("scoped.png", _PNG, "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    image_url = uploaded.json()["url"]
    image_name = image_url.rsplit("/", 1)[-1]
    missing_name = "abcdef0123456789abcdef01.png"
    page = make_page(
        gamma_donor,
        "Scoped single page",
        properties={"folder": "scoped/page", "source_url": image_url},
    )
    child_id = "scoped-page-child"
    response = gamma_donor.put(
        f"/api/blocks/{page['id']}/children",
        json={
            "blocks": [{
                "id": child_id,
                "content": f"![image]({image_url}) ![missing](/api/uploads/{missing_name})",
                "properties": {"custom": "kept"},
                "children": [],
            }]
        },
    )
    assert response.status_code == 200, response.text
    _save_chat(gamma_donor, page["id"], "page chat")
    _save_chat(gamma_donor, "home:scoped/page", "folder chat must not ride")
    outside = make_page(gamma_donor, "Outside scoped page")
    _save_chat(gamma_donor, outside["id"], "outside chat")

    archive = _archive(gamma_donor.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma"},
    ))
    manifest = json.loads(archive.read("manifest.json"))
    assert manifest["format"] == "gamma-backup-1"
    assert manifest["kind"] == "scoped"
    assert manifest["scope"] == {
        "type": "page",
        "folder": None,
        "page_ids": [page["id"]],
        "pages": 1,
    }
    assert manifest["uploads"]["included"] == [image_name]
    assert manifest["uploads"]["missing"] == [missing_name]
    assert archive.read(f"uploads/{image_name}") == _PNG
    assert not any(name.endswith(missing_name) for name in archive.namelist())

    blocks = _sqlite_rows(
        archive,
        "pages.db",
        "SELECT id, parent_id, content, properties FROM unified_blocks ORDER BY id",
    )
    assert {row[0] for row in blocks} == {page["id"], child_id}
    assert next(row for row in blocks if row[0] == child_id)[3] == '{"custom": "kept"}'
    chats = _sqlite_rows(
        archive,
        "data.db",
        "SELECT block_id, messages FROM chats ORDER BY block_id",
    )
    assert [row[0] for row in chats] == [page["id"]]
    assert "page chat" in chats[0][1]


def test_gamma_folder_export_scopes_pages_and_home_chats(gamma_donor):
    exact = make_page(gamma_donor, "Scoped exact", properties={"folder": "scope-root"})
    nested = make_page(gamma_donor, "Scoped nested", properties={"folder": "scope-root/deep"})
    sibling = make_page(gamma_donor, "Scoped sibling", properties={"folder": "scope-rootish"})
    _save_chat(gamma_donor, exact["id"], "exact page chat")
    _save_chat(gamma_donor, nested["id"], "nested page chat")
    _save_chat(gamma_donor, sibling["id"], "sibling page chat")
    _save_chat(gamma_donor, "home:scope-root", "exact folder chat")
    _save_chat(gamma_donor, "home:scope-root/deep", "nested folder chat")
    _save_chat(gamma_donor, "home:scope-rootish", "sibling folder chat")

    archive = _archive(gamma_donor.get(
        "/api/folders/export",
        params={"name": "scope-root", "mode": "gamma", "op": "scope-op"},
    ))
    manifest = json.loads(archive.read("manifest.json"))
    assert manifest["scope"]["type"] == "folder"
    assert manifest["scope"]["folder"] == "scope-root"
    assert set(manifest["scope"]["page_ids"]) == {exact["id"], nested["id"]}
    block_ids = {
        row[0] for row in _sqlite_rows(
            archive,
            "pages.db",
            "SELECT id FROM unified_blocks",
        )
    }
    assert exact["id"] in block_ids and nested["id"] in block_ids
    assert sibling["id"] not in block_ids
    chat_ids = {
        row[0] for row in _sqlite_rows(
            archive,
            "data.db",
            "SELECT block_id FROM chats",
        )
    }
    assert chat_ids == {
        exact["id"],
        nested["id"],
        "home:scope-root",
        "home:scope-root/deep",
    }
    progress = gamma_donor.get(
        "/api/folders/export-progress",
        params={"op": "scope-op"},
    ).json()
    assert progress["active"] is False
    assert progress["done"] == progress["total"] == 2


def test_gamma_export_merges_cross_account_and_is_idempotent(
    gamma_donor,
    gamma_receiver,
):
    uploaded = gamma_donor.post(
        "/api/upload-image",
        files={"file": ("merge.png", _PNG + b"merge", "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    image_url = uploaded.json()["url"]
    page = make_page(
        gamma_donor,
        "Scoped merge source",
        properties={"folder": "merge-scope", "source_url": image_url},
    )
    child_id = "scoped-merge-child"
    response = gamma_donor.put(
        f"/api/blocks/{page['id']}/children",
        json={
            "blocks": [{
                "id": child_id,
                "content": f"kept image ![merge]({image_url})",
                "properties": {"nested": {"value": 7}},
                "children": [],
            }]
        },
    )
    assert response.status_code == 200, response.text
    _save_chat(gamma_donor, page["id"], "merge page chat")
    exported = gamma_donor.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma"},
    )
    assert exported.status_code == 200, exported.text

    replace = gamma_receiver.post(
        "/api/import-data",
        files={"file": ("scoped.zip", exported.content, "application/zip")},
    )
    assert replace.status_code == 400
    assert gamma_receiver.get(f"/api/blocks/{page['id']}").status_code == 404

    imported = gamma_receiver.post(
        "/api/import-data",
        params={"mode": "merge"},
        files={"file": ("scoped.zip", exported.content, "application/zip")},
    )
    assert imported.status_code == 200, imported.text
    result = imported.json()
    assert result["pages_added"] == 1
    assert result["chats_added"] == 1
    assert result["uploads_added"] == 1
    children = gamma_receiver.get(
        f"/api/blocks/{page['id']}/children"
    ).json()["children"]
    child = next(value for value in children if value["id"] == child_id)
    assert child["properties"] == {"nested": {"value": 7}}
    assert gamma_receiver.get(image_url).content == _PNG + b"merge"
    assert gamma_receiver.get(f"/api/chats/{page['id']}").json()["messages"][0][
        "content"
    ] == "merge page chat"

    repeated = gamma_receiver.post(
        "/api/import-data",
        params={"mode": "merge"},
        files={"file": ("scoped.zip", exported.content, "application/zip")},
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["pages_added"] == 0
    assert repeated.json()["pages_skipped"] == 1
    assert repeated.json()["chats_added"] == 0
    assert repeated.json()["uploads_added"] == 0


def test_gamma_export_requires_owner_and_page_root(gamma_donor, gamma_receiver):
    page = make_page(
        gamma_donor,
        "Scoped private page",
        properties={"doc_id": "abcdef0123456789abcdef01"},
    )
    response = gamma_donor.put(
        f"/api/blocks/{page['id']}/children",
        json={
            "blocks": [{
                "id": "scoped-private-child",
                "content": "child",
                "properties": {},
                "children": [],
            }]
        },
    )
    assert response.status_code == 200, response.text
    token = gamma_donor.post(
        "/api/share/abcdef0123456789abcdef01"
    ).json()["token"]
    anonymous = TestClient(app)
    assert anonymous.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma"},
    ).status_code == 401
    assert anonymous.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma", "share": token},
    ).status_code == 403
    assert gamma_receiver.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma", "user": "gamma-donor"},
    ).status_code == 404
    assert gamma_donor.get(
        "/api/pages/scoped-private-child/export",
        params={"mode": "gamma"},
    ).status_code == 400


def test_gamma_export_rejects_malformed_refs_and_symlinks(gamma_donor):
    malformed = make_page(gamma_donor, "Malformed scoped ref")
    response = gamma_donor.put(
        f"/api/blocks/{malformed['id']}",
        json={"content": "bad /api/uploads/../../secret.pdf"},
    )
    assert response.status_code == 200, response.text
    assert gamma_donor.get(
        f"/api/pages/{malformed['id']}/export",
        params={"mode": "gamma"},
    ).status_code == 400

    from gamma.db import user_uploads_dir

    uploads = user_uploads_dir("gamma-donor")
    outside = uploads.parent / "outside-scoped-image.png"
    outside.write_bytes(_PNG)
    link_name = "abcdef0123456789abcdef02.png"
    link = uploads / link_name
    link.symlink_to(outside)
    try:
        linked = make_page(
            gamma_donor,
            "Symlink scoped ref",
            properties={"source_url": f"/api/uploads/{link_name}"},
        )
        assert gamma_donor.get(
            f"/api/pages/{linked['id']}/export",
            params={"mode": "gamma"},
        ).status_code == 400
    finally:
        link.unlink(missing_ok=True)
        outside.unlink(missing_ok=True)


def test_gamma_export_resource_limits(gamma_donor, monkeypatch):
    first = make_page(gamma_donor, "Limit first", properties={"folder": "gamma-limits"})
    make_page(gamma_donor, "Limit second", properties={"folder": "gamma-limits"})
    monkeypatch.setattr("gamma.routers.export._GAMMA_MAX_PAGES", 1)
    assert gamma_donor.get(
        "/api/folders/export",
        params={"name": "gamma-limits", "mode": "gamma"},
    ).status_code == 413

    monkeypatch.setattr("gamma.routers.export._GAMMA_MAX_PAGES", 500)
    monkeypatch.setattr("gamma.routers.export._GAMMA_MAX_BLOCKS", 0)
    assert gamma_donor.get(
        f"/api/pages/{first['id']}/export",
        params={"mode": "gamma"},
    ).status_code == 413

    uploaded = gamma_donor.post(
        "/api/upload-image",
        files={"file": ("limit.png", _PNG + b"limit", "image/png")},
    )
    upload_page = make_page(
        gamma_donor,
        "Upload limit",
        properties={"source_url": uploaded.json()["url"]},
    )
    monkeypatch.setattr("gamma.routers.export._GAMMA_MAX_BLOCKS", 100_000)
    monkeypatch.setattr("gamma.routers.export._GAMMA_MAX_UPLOAD_BYTES", 1)
    assert gamma_donor.get(
        f"/api/pages/{upload_page['id']}/export",
        params={"mode": "gamma"},
    ).status_code == 413


def test_gamma_import_rejects_malicious_archive_names(gamma_donor, gamma_receiver):
    page = make_page(gamma_donor, "Archive validation source")
    exported = gamma_donor.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma"},
    )
    assert exported.status_code == 200, exported.text

    cases = [
        ("../escape.txt", b"escape"),
        ("unexpected.txt", b"unexpected"),
        ("uploads/not-a-digest.pdf", b"%PDF"),
        ("uploads/abcdef0123456789abcdef03.exe", b"bad"),
    ]
    for name, data in cases:
        payload = _zip_with_extra(exported.content, name, data)
        response = gamma_receiver.post(
            "/api/import-data",
            params={"mode": "merge"},
            files={"file": ("malicious.zip", payload, "application/zip")},
        )
        assert response.status_code == 400, (name, response.text)

    duplicate = io.BytesIO()
    original = zipfile.ZipFile(io.BytesIO(exported.content))
    with pytest.warns(UserWarning, match="Duplicate name"):
        with zipfile.ZipFile(duplicate, "w") as archive:
            for info in original.infolist():
                archive.writestr(info, original.read(info.filename))
            archive.writestr("manifest.json", original.read("manifest.json"))
    response = gamma_receiver.post(
        "/api/import-data",
        params={"mode": "merge"},
        files={"file": ("duplicate.zip", duplicate.getvalue(), "application/zip")},
    )
    assert response.status_code == 400


def test_gamma_import_resource_limits(gamma_donor, gamma_receiver, monkeypatch):
    page = make_page(gamma_donor, "Import limits source")
    exported = gamma_donor.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma"},
    )
    assert exported.status_code == 200, exported.text

    monkeypatch.setattr("gamma.routers.auth._IMPORT_MAX_ARCHIVE_BYTES", 1)
    response = gamma_receiver.post(
        "/api/import-data",
        params={"mode": "merge"},
        files={"file": ("large.zip", exported.content, "application/zip")},
    )
    assert response.status_code == 413

    monkeypatch.setattr(
        "gamma.routers.auth._IMPORT_MAX_ARCHIVE_BYTES",
        1024 * 1024 * 1024,
    )
    monkeypatch.setattr("gamma.routers.auth._IMPORT_MAX_ENTRIES", 1)
    response = gamma_receiver.post(
        "/api/import-data",
        params={"mode": "merge"},
        files={"file": ("entries.zip", exported.content, "application/zip")},
    )
    assert response.status_code == 413


def test_gamma_import_rejects_manifest_upload_mismatch(gamma_donor, gamma_receiver):
    page = make_page(gamma_donor, "Manifest mismatch source")
    exported = gamma_donor.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "gamma"},
    )
    assert exported.status_code == 200, exported.text
    filename = "abcdef0123456789abcdef04.png"
    payload = _zip_with_extra(
        exported.content,
        f"uploads/{filename}",
        _PNG,
    )
    archive = zipfile.ZipFile(io.BytesIO(payload))
    manifest = json.loads(archive.read("manifest.json"))
    manifest["uploads"]["included"].append(filename)
    payload = _zip_replace(
        payload,
        "manifest.json",
        json.dumps(manifest).encode(),
    )
    response = gamma_receiver.post(
        "/api/import-data",
        params={"mode": "merge"},
        files={"file": ("mismatch.zip", payload, "application/zip")},
    )
    assert response.status_code == 400

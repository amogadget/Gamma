"""Blank notebooks: ``PUT /api/blank-pdfs/{id}``.

A notebook is an ordinary library page carrying a generated PDF, so these tests
pin both halves: the real, empty, correctly sized document behind the page, and
the workspace-scoped, idempotent creation contract in front of it.
"""

import io
import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PyPDF2 import PdfReader

from conftest import login, make_page, make_user, workspace_of


def create(client, **options):
    return client.put(f"/api/blank-pdfs/{uuid.uuid4()}", json=options)


def test_blank_pdf_is_distinct_from_note_and_has_real_pages(guest):
    note = make_page(guest, "Ordinary note")
    assert not note.get("properties", {}).get("doc_id")
    response = create(guest, title="Writing notebook", page_size="letter",
                      orientation="landscape", page_count=3, folder="Classes/Physics")
    assert response.status_code == 200, response.text
    block = response.json()
    assert block["parent_id"] == "root" and block["content"] == "Writing notebook"
    props = block["properties"]
    assert props["pdf_kind"] == "blank" and props["folder"] == "Classes/Physics"
    assert props["blank_pdf"]["width"] == 792 and props["blank_pdf"]["height"] == 612
    assert props["blank_pdf"]["initial_page_count"] == 3
    assert props["doc_id"] and props["source_url"] == f"/api/uploads/{props['doc_id']}.pdf"
    pdf = guest.get(props["source_url"])
    assert pdf.status_code == 200
    reader = PdfReader(io.BytesIO(pdf.content))
    assert len(reader.pages) == 3
    assert float(reader.pages[0].mediabox.width) == 792
    assert float(reader.pages[0].mediabox.height) == 612
    assert all(not (page.extract_text() or "").strip() for page in reader.pages)
    # A second notebook is a second page with its own document identity, even
    # when the geometry is identical.
    again = create(guest, title="Writing notebook", page_size="letter",
                   orientation="landscape", page_count=3)
    assert again.json()["id"] != block["id"]
    assert again.json()["properties"]["doc_id"] != props["doc_id"]
    # It is a normal page: listing, viewer manifest and by-doc lookup all work.
    assert guest.get(f"/api/pdf-info/{props['doc_id']}").json()["pages"] == 3
    assert guest.get(f"/api/blocks/by-doc/{props['doc_id']}").json()["id"] == block["id"]
    assert any(p["id"] == block["id"] for p in guest.get("/api/blocks/root/children").json()["children"])


def test_blank_pdf_retry_does_not_duplicate_or_undo_later_rename(guest):
    route = f"/api/blank-pdfs/{uuid.uuid4()}"
    body = {"title": "Blank notebook", "page_count": 2}
    first = guest.put(route, json=body)
    assert first.status_code == 200, first.text
    assert guest.put(route, json=body).json() == first.json()
    identity = first.json()["id"]
    guest.put(f"/api/blocks/{identity}", json={"content": "Renamed later"})
    assert guest.put(route, json=body).json()["content"] == "Renamed later"
    assert guest.put(route, json={"title": "Different request"}).status_code == 409
    # Renaming first is not a "different request": the fingerprint is the
    # creation payload, and the page keeps its title.
    assert guest.put(route, json=body).status_code == 200


@pytest.mark.parametrize("options", [
    {"page_count": 0}, {"page_count": 101}, {"page_count": True}, {"page_size": "poster"},
    {"orientation": "upside-down"}, {"title": "   "}, {"unknown": 1},
])
def test_invalid_blank_pdf_options(guest, options):
    assert create(guest, **options).status_code == 422
    assert guest.put("/api/blank-pdfs/not-a-uuid", json={}).status_code == 422


def test_blank_pdf_quota_failure_publishes_nothing(guest, monkeypatch):
    from gamma.db import ws_uploads_dir

    def reject(*args, **kwargs):
        raise HTTPException(507, "test quota exceeded")
    monkeypatch.setattr("gamma.storage.check_upload_allowed", reject)
    uploads = ws_uploads_dir(workspace_of("guest"))
    before = sorted(p.name for p in uploads.iterdir()) if uploads.exists() else []
    identity = str(uuid.uuid4())
    response = guest.put(f"/api/blank-pdfs/{identity}", json={})
    assert response.status_code == 507
    assert guest.get(f"/api/blocks/{identity}/subtree").status_code == 404
    assert sorted(p.name for p in uploads.iterdir()) == before


def test_blank_pdf_requires_authentication(client):
    from gamma.app import app
    with TestClient(app) as anonymous:
        assert create(anonymous).status_code == 401


def test_blank_pdf_owner_and_workspace_scope(guest):
    block = create(guest).json()
    make_user("blank-other", "test-password")
    with login("blank-other", "test-password") as other:
        assert other.get(block["properties"]["source_url"]).status_code == 404
        assert other.get(f"/api/blocks/{block['id']}/subtree").status_code == 404
        # Naming the other workspace explicitly is refused, not silently
        # redirected to the caller's own.
        assert other.get(block["properties"]["source_url"],
                         headers={"X-Gamma-Workspace": workspace_of("guest")}).status_code == 403
        assert other.put(f"/api/blank-pdfs/{uuid.uuid4()}", json={},
                         headers={"X-Gamma-Workspace": workspace_of("guest")}).status_code == 403
        # ... while an explicit scope for its OWN workspace works.
        own = other.put(f"/api/blank-pdfs/{uuid.uuid4()}", json={},
                        params={"ws": workspace_of("blank-other")})
        assert own.status_code == 200, own.text
    # An explicit scope serves the notebook's PDF for its own member.
    assert guest.get(block["properties"]["source_url"],
                     params={"ws": workspace_of("guest")}).status_code == 200


def test_blank_pdf_is_refused_through_a_share_link(guest):
    """Creating a library page is a workspace action, not a page action."""
    from fastapi.testclient import TestClient
    from gamma.app import app
    page = make_page(guest, "Shared page", properties={"doc_id": "cccccccccccccccccccccccc"})
    token = guest.post(f"/api/share/{page['id']}", json={
        "audience": "anyone", "role": "view"}).json()["token"]
    with TestClient(app) as anonymous:
        assert anonymous.put(f"/api/blank-pdfs/{uuid.uuid4()}",
                             params={"share": token}, json={}).status_code in (401, 403)


def test_handwriting_lands_on_a_blank_notebook(guest):
    """The point of the notebook: an iPad annotation targets an ordinary page,
    so the generated PDF and the native ink endpoints compose."""
    import struct
    import zlib

    def upload(data, ext, ctype):
        response = guest.post("/api/assets", files={"file": (f"drawing.{ext}", data, ctype)})
        assert response.status_code == 200, response.text
        return response.json()

    def png():
        raw = b"".join(b"\x00" + bytes(4) * 4 for _ in range(4))

        def chunk(kind, data):
            return (struct.pack(">I", len(data)) + kind + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

        return (b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

    notebook = create(guest, title="Lecture notes", page_count=2).json()
    block_id = str(uuid.uuid4())
    saved = guest.put(f"/api/blocks/{block_id}/ink", json={
        "parent_id": notebook["id"], "pdf_page": 2,
        "ink_asset": upload(b"notebook drawing", "pkdrawing", "application/octet-stream")["url"],
        "preview_asset": upload(png(), "png", "image/png")["url"],
        "bounds": {"x": 10, "y": 10, "width": 40, "height": 20},
        "crop_box": {"width": 595.2756, "height": 841.8898},
        "expected_revision": 0})
    assert saved.status_code == 200, saved.text
    assert saved.json()["properties"]["pdf_page"] == 2
    # The page keeps its generated document and gains the annotation as a
    # normal child block, both visible to the Web client.
    children = guest.get(f"/api/blocks/{notebook['id']}/children").json()["children"]
    assert [c["id"] for c in children] == [block_id]
    assert guest.get(notebook["properties"]["source_url"]).status_code == 200
    assert guest.get(f"/api/pages/{notebook['id']}/ops").json()["batches"][-1]["client"] == "native"

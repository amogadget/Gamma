"""Zotero RDF page/folder export, security boundaries, limits, and round trips."""

import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from conftest import login, make_page, make_user
from gamma.app import app
from gamma.zotero_import import parse_zotero_rdf


def _blank_pdf_bytes():
    from PyPDF2 import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _put_children(client, page_id, tree):
    response = client.put(f"/api/blocks/{page_id}/children", json={"blocks": tree})
    assert response.status_code == 200, response.text


def _positioned(highlight_id, quote, note="", area=False):
    rect = {
        "x1": 50.0, "y1": 60.0, "x2": 250.0, "y2": 160.0,
        "width": 800.0, "height": 1035.0,
    }
    position = {"pageNumber": 1, "boundingRect": rect, "rects": [rect]}
    if area:
        position["area"] = True
    return {
        "id": highlight_id,
        "content": note,
        "children": [],
        "properties": {
            "highlight_id": highlight_id,
            "quote": quote,
            "pdf_page": 1,
            "color": "rgba(170, 235, 170, 0.65)",
            "pdf_position": position,
        },
    }


def _zip(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    for name in archive.namelist():
        parts = name.replace("\\", "/").split("/")
        assert not name.startswith("/")
        assert not any(part in {".", ".."} for part in parts)
    return archive


def _rdf(archive):
    name = next(item for item in archive.namelist() if item.endswith(".rdf"))
    text = archive.read(name).decode("utf-8")
    assert "<rdf:resource" not in text
    return name, text, parse_zotero_rdf(text)


def _paper(client, prefix):
    upload = client.post(
        "/api/uploads",
        files={"file": ("paper.pdf", _blank_pdf_bytes(), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text
    page = make_page(client, f"Attention {prefix}", properties={
        "doc_id": upload.json()["doc_id"],
        "source_url": upload.json()["source_url"],
        "folder": f"{prefix}ML/Transformers",
        "category": "transformers, attention",
        "meta": {
            "title": f"Attention {prefix}",
            "authors": ["Ashish Vaswani", "Noam Shazeer"],
            "year": "2017",
            "venue": "Nature",
            "volume": "647",
            "pages": "1-11",
            "doi": "10.1038/s41586-000-00000-0",
            "arxiv_id": "1706.03762",
        },
    })
    _put_children(client, page["id"], [
        _positioned(f"{prefix}h1", "the quoted passage", note="what I thought"),
        {
            "id": f"{prefix}n1",
            "content": "Read this **twice** & carefully.",
            "properties": {},
            "children": [
                {"id": f"{prefix}n1a", "content": "sub point", "properties": {}, "children": []},
            ],
        },
    ])
    return page


def test_page_zotero_export_roundtrips_metadata_notes_and_pdf(guest):
    page = _paper(guest, "zea")
    archive = _zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf"},
    ))
    rdf_name, _, items = _rdf(archive)
    assert len(items) == 1
    item = items[0]
    assert item["title"] == "Attention zea"
    assert item["meta"] == {
        "title": "Attention zea",
        "authors": ["Ashish Vaswani", "Noam Shazeer"],
        "year": "2017",
        "venue": "Nature",
        "volume": "647",
        "pages": "1-11",
        "doi": "10.1038/s41586-000-00000-0",
        "arxiv_id": "1706.03762",
        "source": "zotero",
    }
    assert item["tags"] == ["transformers", "attention"]
    assert item["folders"] == ["zeaML/Transformers"]
    assert "Read this **twice** & carefully." in item["notes"][0]["text"]
    assert "- sub point" in item["notes"][0]["text"]
    base = rdf_name.rsplit("/", 1)[0]
    pdf = archive.read(f"{base}/{item['pdf_paths'][0]}")
    assert pdf.startswith(b"%PDF") and b"/Highlight" in pdf


_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c626001000000ffff03000006000557"
    "bfabd40000000049454e44ae426082"
)


def test_zotero_export_note_images_are_safe_and_bounded(guest):
    from PyPDF2 import PdfReader

    page = _paper(guest, "zeaimg")
    uploaded = guest.post(
        "/api/upload-image",
        files={"file": ("figure.png", _PNG, "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    image_url = uploaded.json()["url"]
    image_name = image_url.rsplit("/", 1)[-1]
    uploaded_two = guest.post(
        "/api/upload-image",
        files={"file": ("second.png", _PNG + b"second", "image/png")},
    )
    image_two_url = uploaded_two.json()["url"]
    image_two_name = image_two_url.rsplit("/", 1)[-1]
    _put_children(guest, page["id"], [
        _positioned(
            "zeaimg-h",
            "<quoted & safe>",
            note=(
                f"see ![figure]({image_url}) and again ![same]({image_url}) "
                f"plus ![second]({image_two_url})"
            ),
        ),
        {
            "id": "zeaimg-note",
            "content": f"<script>alert(1)</script> figure: ![figure]({image_url})",
            "properties": {},
            "children": [],
        },
    ])

    archive = _zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf"},
    ))
    rdf_name, rdf, items = _rdf(archive)
    base = rdf_name.rsplit("/", 1)[0]
    first_arc = f"{base}/files/1/{image_name}"
    second_arc = f"{base}/files/1/{image_two_name}"
    assert archive.read(first_arc) == _PNG
    assert archive.read(second_arc) == _PNG + b"second"
    assert archive.namelist().count(first_arc) == 1  # repeated refs share one payload
    assert f"files/1/{image_name}" in rdf and "image/png" in rdf
    assert rdf.count("data:image/png;base64,") >= 3
    assert "<script>" not in rdf and "&amp;lt;script&amp;gt;" in rdf
    assert "&amp;lt;quoted &amp;amp; safe&amp;gt;" in rdf

    item_notes = [note["text"] for note in items[0]["notes"]]
    assert len(item_notes) == 2  # top-level note plus the image-bearing highlight Memo
    highlight_note = next(note for note in item_notes if "p.1" in note)
    assert "<quoted & safe>" in highlight_note and "see" in highlight_note

    pdf = archive.read(f"{base}/{items[0]['pdf_paths'][0]}")
    annotations = PdfReader(io.BytesIO(pdf)).pages[0]["/Annots"]
    contents = [str(annotation.get_object().get("/Contents") or "") for annotation in annotations]
    assert any(
        f"(image: {image_name} — see item notes)" in content
        and f"(image: {image_two_name} — see item notes)" in content
        for content in contents
    )
    assert not any("![figure]" in content for content in contents)

    without_notes_archive = _zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf", "notes": 0},
    ))
    without_notes_rdf, _, without_notes_items = _rdf(without_notes_archive)
    without_notes = without_notes_items[0]
    assert without_notes["notes"] == []
    without_notes_base = without_notes_rdf.rsplit("/", 1)[0]
    without_notes_pdf = without_notes_archive.read(
        f"{without_notes_base}/{without_notes['pdf_paths'][0]}"
    )
    disabled_annotations = PdfReader(io.BytesIO(without_notes_pdf)).pages[0]["/Annots"]
    disabled_contents = [
        str(annotation.get_object().get("/Contents") or "")
        for annotation in disabled_annotations
    ]
    assert any(f"(image: {image_name})" in content for content in disabled_contents)
    assert not any("see item notes" in content for content in disabled_contents)

    imported = guest.post(
        "/api/import/zotero",
        files={
            "file": (
                "highlight-images.zip",
                io.BytesIO(archive.fp.getvalue()),
                "application/zip",
            )
        },
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["notes_imported"] == 2

    _, exported_again, items_again = _rdf(_zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf"},
    )))
    assert len(items_again[0]["notes"]) == 2
    assert exported_again.count('rdf:about="#gamma_highlight_note_') == 1


def test_highlight_image_memo_missing_and_inline_size_limit(guest, monkeypatch):
    page = make_page(guest, "Zea missing image")
    uploaded = guest.post(
        "/api/upload-image",
        files={"file": ("large.png", _PNG, "image/png")},
    )
    image_url = uploaded.json()["url"]
    image_name = image_url.rsplit("/", 1)[-1]
    missing_name = "abcdef0123456789abcdef01.png"
    _put_children(guest, page["id"], [
        _positioned(
            "zea-missing-h",
            "missing and large",
            note=(
                f"missing ![gone](/api/uploads/{missing_name}) "
                f"large ![large]({image_url})"
            ),
        ),
    ])
    monkeypatch.setattr("gamma.routers.export._EMBED_IMAGE_CAP", 1)
    archive = _zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf"},
    ))
    rdf_name, rdf, items = _rdf(archive)
    base = rdf_name.rsplit("/", 1)[0]
    assert "data:image/png;base64," not in rdf
    assert archive.read(f"{base}/files/1/{image_name}") == _PNG
    assert not any(name.endswith(f"/{missing_name}") for name in archive.namelist())
    note = items[0]["notes"][0]["text"]
    assert f"(image: {missing_name})" in note
    assert f"(image: {image_name})" in note


def test_deep_highlight_image_notes_use_iterative_traversal():
    from gamma.routers.export import _image_highlights
    from gamma.zotero_export import highlight_memo_html, note_html

    root = {
        "id": "deep-highlight",
        "content": "root",
        "properties": {
            "highlight_id": "deep-highlight",
            "pdf_page": 9,
            "quote": "deep quote",
        },
        "children": [],
    }
    current = root
    for index in range(1500):
        child = {
            "id": f"deep-{index}",
            "content": "tail" if index == 1499 else "",
            "properties": {},
            "children": [],
        }
        current["children"] = [child]
        current = child
    current["content"] += " ![deep](/api/uploads/abcdef0123456789abcdef01.png)"

    assert _image_highlights(root) == [root]
    html = highlight_memo_html(root)
    assert "p.9" in html and "deep quote" in html
    assert "(image: abcdef0123456789abcdef01.png)" in html
    assert html.count("<li>") == 1500
    assert note_html({
        "content": "kept",
        "children": [{
            "content": "",
            "children": [{"content": "", "children": []}],
        }],
    }) == "<p>kept</p>"


def test_zotero_export_switches(guest):
    page = _paper(guest, "zeb")
    archive = _zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf", "notes": 0, "highlights": 0},
    ))
    rdf_name, _, items = _rdf(archive)
    assert items[0]["notes"] == []
    base = rdf_name.rsplit("/", 1)[0]
    assert b"/Highlight" not in archive.read(f"{base}/{items[0]['pdf_paths'][0]}")

    no_pdf = _zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf", "pdf": 0},
    ))
    assert _rdf(no_pdf)[2][0]["pdf_paths"] == []
    assert not any("/files/" in name for name in no_pdf.namelist())


def test_folder_zotero_export_scopes_nested_collections(guest):
    make_page(guest, "Zec in folder", properties={
        "folder": "zec/research/optics, zec/cooking",
        "meta": {"arxiv_id": "2101.00001"},
    })
    make_page(guest, "Zec in subfolder", properties={"folder": "zec/research/optics/lasers"})
    make_page(guest, "Zec sibling prefix", properties={"folder": "zec/research/opticsx"})
    response = guest.get(
        "/api/folders/export",
        params={"name": "zec/research/optics", "mode": "zotero-rdf"},
    )
    items = _rdf(_zip(response))[2]
    by_title = {item["title"]: item for item in items}
    assert set(by_title) == {"Zec in folder", "Zec in subfolder"}
    assert by_title["Zec in folder"]["folders"] == ["zec/research/optics"]
    assert by_title["Zec in subfolder"]["folders"] == ["zec/research/optics/lasers"]


def test_zotero_export_reimports_via_endpoint(guest):
    make_page(guest, "Zed paper one", properties={
        "folder": "zed-roundtrip",
        "meta": {"authors": ["Ada Lovelace"], "year": "1843", "venue": "Notes"},
    })
    make_page(guest, "Zed paper two", properties={"folder": "zed-roundtrip/deep"})
    exported = guest.get(
        "/api/folders/export",
        params={"name": "zed-roundtrip", "mode": "zotero-rdf"},
    )
    imported = guest.post(
        "/api/import/zotero",
        files={"file": ("library.zip", io.BytesIO(exported.content), "application/zip")},
        data={"folder": "zed-imported"},
    )
    assert imported.status_code == 200, imported.text
    data = imported.json()
    assert data["items"] == 2 and data["pages_created"] == 2 and data["skipped"] == []


def test_export_reuses_imported_zotero_note_key(guest):
    page = make_page(guest, "Zed stable note")
    _put_children(guest, page["id"], [{
        "id": "zed-stable-note",
        "content": "keep me once",
        "properties": {"zotero_note": "#original_note_key"},
        "children": [],
    }])
    archive = _zip(guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf", "pdf": 0},
    ))
    assert 'rdf:about="#original_note_key"' in _rdf(archive)[1]


def test_generated_item_keys_do_not_collide_across_single_page_exports(guest):
    pages = [make_page(guest, f"Zee unique {index}") for index in (1, 2)]
    created_ids = []
    for page in pages:
        exported = guest.get(
            f"/api/pages/{page['id']}/export",
            params={"mode": "zotero-rdf", "pdf": 0},
        )
        imported = guest.post(
            "/api/import/zotero",
            files={"file": ("single.zip", io.BytesIO(exported.content), "application/zip")},
        )
        assert imported.status_code == 200, imported.text
        assert imported.json()["pages_created"] == 1
        created_ids.append(imported.json()["pages"][0]["id"])
    assert len(set(created_ids)) == 2


def test_zotero_export_share_scope_and_taxonomy_scrub():
    make_user("zshare", "password12345")
    owner = login("zshare", "password12345")
    shared = make_page(owner, "Zef shared", properties={
        "doc_id": "zef_shared_doc",
        "folder": "secret/folder",
        "category": "secret-label",
    })
    other = make_page(owner, "Zef private", properties={"doc_id": "zef_private_doc"})
    token = owner.post("/api/share/zef_shared_doc").json()["token"]
    anon = TestClient(app)

    archive = _zip(anon.get(
        f"/api/pages/{shared['id']}/export",
        params={"mode": "zotero-rdf", "share": token},
    ))
    items = _rdf(archive)[2]
    assert [item["title"] for item in items] == ["Zef shared"]
    assert items[0]["folders"] == [] and items[0]["tags"] == []
    assert anon.get(
        f"/api/pages/{other['id']}/export",
        params={"mode": "zotero-rdf", "share": token},
    ).status_code == 403
    assert anon.get(
        "/api/folders/export",
        params={"name": "secret", "mode": "zotero-rdf", "share": token},
    ).status_code == 403


def test_zotero_export_cross_user_and_user_param_are_isolated():
    make_user("zowner", "password12345")
    make_user("zother", "password12345")
    owner = login("zowner", "password12345")
    other = login("zother", "password12345")
    page = make_page(owner, "Zeg owner only")
    assert other.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf"},
    ).status_code == 404
    anon = TestClient(app)
    assert anon.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf", "user": "zowner"},
    ).status_code == 401


def test_zotero_export_rejects_unsafe_folder_and_bounds(guest, monkeypatch):
    make_page(guest, "Zeh unsafe folder", properties={"folder": ".."})
    assert guest.get(
        "/api/folders/export",
        params={"name": "..", "mode": "zotero-rdf"},
    ).status_code == 400

    make_page(guest, "Zeh bound one", properties={"folder": "zeh-bound"})
    make_page(guest, "Zeh bound two", properties={"folder": "zeh-bound"})
    monkeypatch.setattr("gamma.routers.export._ZOTERO_MAX_PAGES", 1)
    response = guest.get(
        "/api/folders/export",
        params={"name": "zeh-bound", "mode": "zotero-rdf"},
    )
    assert response.status_code == 413


def test_folder_export_progress_is_operation_scoped(guest):
    make_page(guest, "Zep one", properties={"folder": "zep-one"})
    make_page(guest, "Zep two a", properties={"folder": "zep-two"})
    make_page(guest, "Zep two b", properties={"folder": "zep-two"})

    assert guest.get(
        "/api/folders/export",
        params={"name": "zep-one", "mode": "zotero-rdf", "op": "op-one"},
    ).status_code == 200
    assert guest.get(
        "/api/folders/export",
        params={"name": "zep-two", "mode": "zotero-rdf", "op": "op-two"},
    ).status_code == 200

    first = guest.get("/api/folders/export-progress", params={"op": "op-one"}).json()
    second = guest.get("/api/folders/export-progress", params={"op": "op-two"}).json()
    assert first == {"active": False, "total": 1, "done": 1, "title": "Zep one"}
    assert second["active"] is False and second["total"] == second["done"] == 2
    assert guest.get("/api/folders/export-progress", params={"op": "../bad"}).status_code == 400

    make_user("zprogress", "password12345")
    other = login("zprogress", "password12345")
    assert other.get("/api/folders/export-progress", params={"op": "op-one"}).json() == {
        "active": False, "total": 0, "done": 0, "title": "",
    }
    assert TestClient(app).get(
        "/api/folders/export-progress", params={"op": "op-one"}
    ).status_code == 401


def test_zotero_image_attachment_counts_toward_archive_limit(guest, monkeypatch):
    page = make_page(guest, "Zeq image cap")
    uploaded = guest.post(
        "/api/upload-image",
        files={"file": ("cap.png", _PNG, "image/png")},
    )
    _put_children(guest, page["id"], [{
        "id": "zeq-image",
        "content": f"![cap]({uploaded.json()['url']})",
        "properties": {},
        "children": [],
    }])
    monkeypatch.setattr("gamma.routers.export._ZOTERO_MAX_ARCHIVE_BYTES", 1)
    response = guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf"},
    )
    assert response.status_code == 413


def test_zotero_export_rejects_pdf_and_aggregate_byte_limits(guest, monkeypatch):
    page = _paper(guest, "zei")
    monkeypatch.setattr("gamma.routers.export._ZOTERO_MAX_PDF_BYTES", 8)
    response = guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf"},
    )
    assert response.status_code == 413

    monkeypatch.setattr("gamma.routers.export._ZOTERO_MAX_PDF_BYTES", 128 * 1024 * 1024)
    monkeypatch.setattr("gamma.routers.export._ZOTERO_MAX_ARCHIVE_BYTES", 8)
    response = guest.get(
        f"/api/pages/{page['id']}/export",
        params={"mode": "zotero-rdf", "highlights": 0},
    )
    assert response.status_code == 413


@pytest.mark.parametrize("mode", ["zotero", "ZOTERO-RDF", "../zotero-rdf"])
def test_export_rejects_unknown_modes(guest, mode):
    page = make_page(guest, f"Zej mode {mode}")
    assert guest.get(f"/api/pages/{page['id']}/export", params={"mode": mode}).status_code == 400

"""Gamma-to-Gamma export: mode=gamma produces a scoped account backup
(gamma-backup-1 layout) that /api/import-data?mode=merge on any Gamma imports
additively — pages with their whole block trees, referenced uploads, chats."""

import io
import json
import zipfile

import pytest

from conftest import login as _login, make_page, make_user as _make_user, workspace_of


@pytest.fixture(scope="module")
def gdonor(client):
    _make_user("gdonor", "gdonorpw")
    return _login("gdonor", "gdonorpw")


@pytest.fixture(scope="module")
def greceiver(client):
    _make_user("greceiver", "greceiverpw")
    return _login("greceiver", "greceiverpw")


def _blank_pdf_bytes(width=612):
    """width varies per test: uploads dedupe by content hash, so two tests
    using identical bytes would share one file — and orphan cleanup would then
    rightly keep it while the other test's page still references it."""
    from PyPDF2 import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=width, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _donor_library(gdonor):
    up = gdonor.post("/api/uploads", files={"file": ("g.pdf", _blank_pdf_bytes(), "application/pdf")})
    assert up.status_code == 200, up.text
    paper = make_page(gdonor, "Gx paper", properties={
        "doc_id": up.json()["doc_id"], "source_url": up.json()["source_url"],
        "folder": "gxfolder/sub", "category": "gxtag",
        "meta": {"title": "Gx paper", "authors": ["Ada"], "year": "2024"},
    })
    rect = {"x1": 50.0, "y1": 60.0, "x2": 250.0, "y2": 160.0, "width": 612.0, "height": 792.0}
    r = gdonor.put(f"/api/blocks/{paper['id']}/children", json={"blocks": [
        {"id": "gxh1", "content": "my thought", "children": [], "properties": {
            "highlight_id": "gxh1", "quote": "a quote", "pdf_page": 1,
            "color": "rgba(170, 235, 170, 0.65)",
            "pdf_position": {"pageNumber": 1, "boundingRect": rect, "rects": [rect]},
        }},
    ]})
    assert r.status_code == 200, r.text
    note = make_page(gdonor, "Gx note page", properties={"folder": "gxfolder"})
    r = gdonor.put(f"/api/chats/{paper['id']}", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200, r.text
    return paper, note, up.json()


def test_gamma_folder_export_merges_into_another_account(gdonor, greceiver):
    paper, note, up = _donor_library(gdonor)

    r = gdonor.get("/api/folders/export", params={"name": "gxfolder", "mode": "gamma"})
    assert r.status_code == 200, r.text
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    # the /api/export backup layout: DBs + manifest at the root, flat uploads/
    assert {"pages.db", "data.db", "manifest.json"} <= names
    assert json.loads(z.read("manifest.json"))["format"] == "gamma-backup-1"
    pdf_name = up["source_url"].rsplit("/", 1)[-1]
    assert f"uploads/{pdf_name}" in names

    imp = greceiver.post("/api/import-data", params={"mode": "merge"},
                         files={"file": ("gx.zip", r.content, "application/zip")})
    assert imp.status_code == 200, imp.text
    d = imp.json()
    assert d["pages_added"] == 2 and d["uploads_added"] == 1

    # Whole block tree intact: same ids, highlight properties preserved.
    got = greceiver.get(f"/api/blocks/{paper['id']}").json()
    assert got["properties"]["folder"] == "gxfolder/sub"
    assert got["properties"]["meta"]["authors"] == ["Ada"]
    children = greceiver.get(f"/api/blocks/{paper['id']}/children").json()["children"]
    hl = next(c for c in children if c["id"] == "gxh1")
    assert hl["content"] == "my thought"
    assert hl["properties"]["pdf_position"]["pageNumber"] == 1
    # The PDF came along and serves.
    assert greceiver.get(up["source_url"]).status_code == 200
    # The paper's AI chat merged too.
    chat = greceiver.get(f"/api/chats/{paper['id']}").json()
    assert chat["messages"] and chat["messages"][0]["content"] == "hi"

    # Merge is idempotent: the same zip again adds nothing.
    again = greceiver.post("/api/import-data", params={"mode": "merge"},
                           files={"file": ("gx.zip", r.content, "application/zip")})
    assert again.status_code == 200, again.text
    assert again.json()["pages_added"] == 0
    assert again.json()["pages_skipped"] == 2


def test_gamma_export_delete_reimport_is_near_identical(gdonor):
    """The disaster-recovery round trip: export a folder, delete its pages
    from the SAME account (orphan cleanup removes their uploads), merge the
    zip back — every block row must come back byte-identical (id, parent,
    content, properties, created_at, updated_at, even sibling positions); the
    one allowed difference is the root pages' own position, which the merge
    regenerates to append after the existing pages. Files and chats too."""
    import sqlite3

    from gamma.db import ws_db_path, ws_uploads_dir

    up = gdonor.post("/api/uploads", files={"file": ("rt.pdf", _blank_pdf_bytes(width=611), "application/pdf")})
    assert up.status_code == 200, up.text
    pdf_name = up.json()["source_url"].rsplit("/", 1)[-1]
    paper = make_page(gdonor, "Rt paper", properties={
        "doc_id": up.json()["doc_id"], "source_url": up.json()["source_url"],
        "folder": "rtfolder/deep", "category": "rt",
        "meta": {"title": "Rt paper", "year": "2025"},
    })
    rect = {"x1": 50.0, "y1": 60.0, "x2": 250.0, "y2": 160.0, "width": 612.0, "height": 792.0}
    r = gdonor.put(f"/api/blocks/{paper['id']}/children", json={"blocks": [
        {"id": "rth1", "content": "thought", "properties": {
            "highlight_id": "rth1", "quote": "q", "pdf_page": 1,
            "color": "rgba(170, 235, 170, 0.65)",
            "pdf_position": {"pageNumber": 1, "boundingRect": rect, "rects": [rect]},
        }, "children": [
            {"id": "rth1a", "content": "nested note", "properties": {}, "children": []},
        ]},
        {"id": "rtn1", "content": "free note", "properties": {}, "children": []},
    ]})
    assert r.status_code == 200, r.text
    note = make_page(gdonor, "Rt note", properties={"folder": "rtfolder"})
    assert gdonor.put(f"/api/chats/{paper['id']}",
                      json={"messages": [{"role": "user", "content": "rt chat"}]}).status_code == 200

    def rows_of(ids):
        with sqlite3.connect(ws_db_path(workspace_of("gdonor"), "pages.db")) as conn:
            placeholders = ",".join("?" for _ in ids)
            return sorted(conn.execute(
                "WITH RECURSIVE sub(id) AS ("
                f"  SELECT id FROM unified_blocks WHERE id IN ({placeholders})"
                "  UNION ALL"
                "  SELECT b.id FROM unified_blocks b JOIN sub ON b.parent_id = sub.id)"
                " SELECT id, parent_id, position, content, properties, created_at, updated_at"
                " FROM unified_blocks WHERE id IN (SELECT id FROM sub)", ids).fetchall())

    page_ids = [paper["id"], note["id"]]
    before = rows_of(page_ids)
    assert len(before) == 5  # 2 roots + highlight + nested note + free note
    pdf_bytes_before = (ws_uploads_dir(workspace_of("gdonor")) / pdf_name).read_bytes()

    exp = gdonor.get("/api/folders/export", params={"name": "rtfolder", "mode": "gamma"})
    assert exp.status_code == 200, exp.text

    for pid in page_ids:
        assert gdonor.delete(f"/api/blocks/{pid}").status_code == 200
    assert rows_of(page_ids) == []
    # orphan cleanup took the now-unreferenced PDF with the pages
    assert not (ws_uploads_dir(workspace_of("gdonor")) / pdf_name).exists()

    imp = gdonor.post("/api/import-data", params={"mode": "merge"},
                      files={"file": ("rt.zip", exp.content, "application/zip")})
    assert imp.status_code == 200, imp.text
    assert imp.json()["pages_added"] == 2

    after = rows_of(page_ids)
    assert len(after) == len(before)
    by_id_before = {r[0]: r for r in before}
    for row in after:
        want = by_id_before[row[0]]
        if row[1] == "root":
            # merge appends root pages after the existing ones — position is
            # the ONE field allowed to change
            assert row[:2] == want[:2] and row[3:] == want[3:]
        else:
            assert row == want
    # the PDF is back byte-identical, and the chat survived the round trip
    assert (ws_uploads_dir(workspace_of("gdonor")) / pdf_name).read_bytes() == pdf_bytes_before
    chat = gdonor.get(f"/api/chats/{paper['id']}").json()
    assert chat["messages"][0]["content"] == "rt chat"


def test_gamma_single_page_export(gdonor):
    page = make_page(gdonor, "Gx single", properties={"category": "solo"})
    r = gdonor.get(f"/api/pages/{page['id']}/export", params={"mode": "gamma"})
    assert r.status_code == 200, r.text
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert "pages.db" in z.namelist()
    scope = json.loads(z.read("manifest.json"))["scope"]
    assert scope == {"folder": None, "pages": 1}


def test_unknown_mode_rejected(gdonor):
    page = make_page(gdonor, "Gx mode check")
    r = gdonor.get(f"/api/pages/{page['id']}/export", params={"mode": "nonsense"})
    assert r.status_code == 400

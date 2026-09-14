"""GET /api/pdf-info/{doc_id} and gamma/pdf_meta.py — the document manifest
the viewer lays a PDF out from (docs/dev/pdf_loading.md)."""

import io
import sqlite3
import time

from gamma import pdf_meta, pdf_text
from gamma.db import ws_db_path

from conftest import workspace_of


def _pdf(pages=1, rotate_last=0, width=612, height=792):
    from PyPDF2 import PdfWriter

    w = PdfWriter()
    for i in range(pages):
        w.add_blank_page(width=width, height=height)
    if rotate_last:
        w.pages[-1].rotate(rotate_last)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _upload(guest, data, name="m.pdf"):
    r = guest.post("/api/uploads", files={"file": (name, data, "application/pdf")})
    assert r.status_code == 200, r.text
    return r.json()["doc_id"]


def test_manifest_has_every_page_size_with_rotation_applied(guest):
    data = _pdf(pages=3, rotate_last=90)
    doc_id = _upload(guest, data)
    r = guest.get(f"/api/pdf-info/{doc_id}")
    assert r.status_code == 200, r.text
    info = r.json()
    assert info["doc_id"] == doc_id
    assert info["bytes"] == len(data)
    assert info["pages"] == 3
    assert info["dims"][0] == [612, 792]
    assert info["dims"][1] == [612, 792]
    assert info["dims"][2] == [792, 612], "a /Rotate 90 page is reported the way pdf.js lays it out"
    assert "max-age" in r.headers["cache-control"]


def test_manifest_is_computed_in_the_background_on_upload(guest):
    doc_id = _upload(guest, _pdf(pages=2, width=500, height=700))
    ws = workspace_of("guest")
    for _ in range(50):
        if pdf_meta.get(ws, doc_id):
            break
        time.sleep(0.05)
    info = pdf_meta.get(ws, doc_id)
    assert info and info["pages"] == 2 and info["dims"] == [[500, 700], [500, 700]]


def test_manifest_is_stored_once_and_served_from_the_table(guest, monkeypatch):
    doc_id = _upload(guest, _pdf(pages=1))
    assert guest.get(f"/api/pdf-info/{doc_id}").status_code == 200
    calls = []
    monkeypatch.setattr(pdf_text, "page_sizes", lambda src: calls.append(src) or [])
    r = guest.get(f"/api/pdf-info/{doc_id}")
    assert r.status_code == 200 and r.json()["pages"] == 1
    assert calls == [], "a stored manifest is not walked again"


def test_unreadable_pdf_is_recorded_as_zero_pages_and_not_cached(guest):
    doc_id = _upload(guest, b"%PDF-1.4\nnot really a pdf\n%%EOF\n")
    r = guest.get(f"/api/pdf-info/{doc_id}")
    assert r.status_code == 200
    assert r.json()["pages"] == 0 and r.json()["dims"] == []
    assert r.headers["cache-control"] == "no-store"


def test_unknown_and_malformed_ids(guest):
    assert guest.get("/api/pdf-info/" + "0" * 24).status_code == 404
    assert guest.get("/api/pdf-info/not-hex").status_code == 400


def test_purge_drops_manifests_of_documents_no_page_carries(guest):
    doc_id = _upload(guest, _pdf(pages=1))
    ws = workspace_of("guest")
    assert pdf_meta.ensure(ws, doc_id)
    with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
        pdf_meta.purge(conn, live_docs={doc_id})
        conn.commit()
    assert pdf_meta.get(ws, doc_id), "a live document keeps its manifest"
    with sqlite3.connect(ws_db_path(ws, "data.db")) as conn:
        assert pdf_meta.purge(conn, live_docs=set()) >= 1
        conn.commit()
    assert pdf_meta.get(ws, doc_id) is None

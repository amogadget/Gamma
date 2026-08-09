"""PDF export with highlights: coordinate round-trip through the embedded-
annotation importer, note flattening, and the HTTP endpoint end to end."""

import io

from conftest import make_page

from gamma.pdf_export import annotate_pdf, parse_css_color

PAGE_W, PAGE_H = 612, 792


def _blank_pdf(pages=1, rotate=0):
    from PyPDF2 import PdfWriter

    w = PdfWriter()
    for i in range(pages):
        w.add_blank_page(width=PAGE_W, height=PAGE_H)
        if rotate:
            w.pages[i].rotate(rotate)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _position(page=1, x1=100, y1=72, x2=300, y2=92, w=PAGE_W, h=PAGE_H, extra_rects=None):
    """Viewer-space position: top-left origin, rects carry the render size."""
    rects = [{"x1": x1, "y1": y1, "x2": x2, "y2": y2, "width": w, "height": h, "pageNumber": page}]
    rects += extra_rects or []
    return {"pageNumber": page, "boundingRect": dict(rects[0]), "rects": rects}


def test_annotate_roundtrips_through_import_extractor():
    """Burn a highlight in, then read it back with the importer's extractor —
    the two coordinate conversions must be exact inverses."""
    from PyPDF2 import PdfReader
    from gamma.routers.imports import _extract_pdf_annotations

    # Viewer rect at doubled render size: same normalized position.
    pos = _position(x1=200, y1=144, x2=600, y2=184, w=PAGE_W * 2, h=PAGE_H * 2)
    out, written = annotate_pdf(
        _blank_pdf(),
        [{"position": pos, "color": "rgba(170, 235, 170, 0.65)", "note": "my note"}],
        author="tester",
    )
    assert written == 1

    found = _extract_pdf_annotations(PdfReader(io.BytesIO(out)))
    assert len(found) == 1
    a = found[0]
    assert a["page"] == 1
    assert a["content"] == "my note"
    br = a["position"]["boundingRect"]
    # Importer reports top-left-origin PDF points: 200/2=100 … 184/2=92.
    assert abs(br["x1"] - 100) < 0.01 and abs(br["y1"] - 72) < 0.01
    assert abs(br["x2"] - 300) < 0.01 and abs(br["y2"] - 92) < 0.01
    # /CA round-trips too: re-import gives back the exact exported shade.
    assert a["color"] == "rgba(170, 235, 170, 0.65)"


def test_annotate_multiline_and_skips_unusable():
    from PyPDF2 import PdfReader

    multiline = _position(extra_rects=[
        {"x1": 50, "y1": 100, "x2": 500, "y2": 120, "width": PAGE_W, "height": PAGE_H, "pageNumber": 1},
    ])
    out, written = annotate_pdf(_blank_pdf(pages=2), [
        {"position": multiline, "color": None, "note": ""},
        {"position": _position(page=99), "color": None, "note": ""},   # page out of range
        {"position": {"pageNumber": 1, "rects": []}, "note": ""},       # no rects
    ])
    assert written == 1
    annots = PdfReader(io.BytesIO(out)).pages[0]["/Annots"]
    obj = annots[0].get_object()
    assert str(obj["/Subtype"]) == "/Highlight"
    assert len(obj["/QuadPoints"]) == 16  # two quads, one per line rect
    assert "/Contents" not in obj  # empty note omitted


def test_annotate_area_as_square():
    """An area note (position carries area: true) exports as a /Square
    annotation over the rect, not a /Highlight with quad points."""
    from PyPDF2 import PdfReader

    pos = _position()
    pos["area"] = True
    out, written = annotate_pdf(
        _blank_pdf(),
        [{"position": pos, "color": "rgba(155, 205, 255, 0.65)", "note": "figure note"}],
        author="tester",
    )
    assert written == 1
    obj = PdfReader(io.BytesIO(out)).pages[0]["/Annots"][0].get_object()
    assert str(obj["/Subtype"]) == "/Square"
    assert "/QuadPoints" not in obj
    rect = [float(v) for v in obj["/Rect"]]
    # Viewer top-left-origin y ∈ [72, 92] on a 792pt page → PDF y ∈ [700, 720].
    assert rect == [100, 700, 300, 720]
    assert str(obj["/Contents"]) == "figure note"
    assert str(obj["/T"]) == "tester"
    assert float(obj["/CA"]) == 0.65
    assert int(obj["/BS"]["/W"]) == 2


def test_annotate_rotated_page():
    """On a 90°-rotated page the viewer's x axis runs along PDF y."""
    from PyPDF2 import PdfReader

    # Rendered size is swapped (H x W); a rect near the view's top-left.
    pos = {"pageNumber": 1, "boundingRect": None, "rects": [
        {"x1": 79.2, "y1": 61.2, "x2": 158.4, "y2": 122.4,
         "width": PAGE_H, "height": PAGE_W, "pageNumber": 1},
    ]}
    out, written = annotate_pdf(_blank_pdf(rotate=90), [{"position": pos, "note": ""}])
    assert written == 1
    rect = [float(v) for v in PdfReader(io.BytesIO(out)).pages[0]["/Annots"][0].get_object()["/Rect"]]
    # u ∈ [0.1, 0.2] of 792 → pdf y ∈ [79.2, 158.4]; v ∈ [0.1, 0.2] of 612 → pdf x ∈ [61.2, 122.4]
    assert abs(rect[0] - 61.2) < 0.01 and abs(rect[1] - 79.2) < 0.01
    assert abs(rect[2] - 122.4) < 0.01 and abs(rect[3] - 158.4) < 0.01


def test_parse_css_color():
    assert parse_css_color("rgba(255, 226, 143, 0.65)") == (1.0, 226 / 255, 143 / 255, 0.65)
    assert parse_css_color("#ff0000") == (1.0, 0.0, 0.0, 1.0)
    assert parse_css_color("bogus") == parse_css_color(None)  # falls back to yellow


def test_export_pdf_endpoint(guest):
    from PyPDF2 import PdfReader

    up = guest.post("/api/uploads", files={"file": ("p.pdf", _blank_pdf(), "application/pdf")})
    assert up.status_code == 200, up.text
    page = make_page(guest, "Annotated paper",
                     properties={"doc_id": up.json()["doc_id"], "source_url": up.json()["source_url"]})
    r = guest.put(f"/api/blocks/{page['id']}/children", json={"blocks": [
        {"id": "hl1", "content": "top comment", "properties": {
            "highlight_id": "hl1", "quote": "quoted text", "pdf_page": 1,
            "color": "rgba(155, 205, 255, 0.65)", "pdf_position": _position(),
        }, "children": [
            {"id": "note1", "content": "nested note", "properties": {}, "children": []},
        ]},
        {"id": "free1", "content": "a free note (no highlight)", "properties": {}, "children": []},
        {"id": "link1", "content": "", "properties": {
            "highlight_id": "link1", "link_url": "https://example.com",
            "pdf_position": _position(y1=300, y2=320),
        }, "children": []},
    ]})
    assert r.status_code == 200, r.text

    r = guest.get(f"/api/pages/{page['id']}/export-pdf")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert "annotated.pdf" in r.headers["content-disposition"]
    assert r.headers["x-annotations-written"] == "1"  # link region excluded

    obj = PdfReader(io.BytesIO(r.content)).pages[0]["/Annots"][0].get_object()
    assert str(obj["/Subtype"]) == "/Highlight"
    assert str(obj["/Contents"]) == "top comment\n- nested note"
    assert str(obj["/T"]) == "guest"


def test_import_annotations_strip_rewrites_pdf(guest):
    """strip: true removes the embedded markup annotations from the stored
    file after importing them as blocks, so they can't render twice. Link
    annotations survive; the import stays idempotent afterwards."""
    from PyPDF2 import PdfReader

    annotated, written = annotate_pdf(
        _blank_pdf(),
        [{"position": _position(), "color": "rgba(170, 235, 170, 0.65)", "note": "kept as block"}],
    )
    assert written == 1

    up = guest.post("/api/uploads", files={"file": ("a.pdf", annotated, "application/pdf")})
    assert up.status_code == 200, up.text
    doc_id, source_url = up.json()["doc_id"], up.json()["source_url"]
    page = make_page(guest, "Strip me", properties={"doc_id": doc_id, "source_url": source_url})

    r = guest.post("/api/import/pdf-annotations",
                   json={"block_id": page["id"], "doc_id": doc_id, "strip": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "found": 1, "imported": 1, "stripped": 1}

    # The stored file no longer carries the highlight annotation…
    stored = guest.get(source_url).content
    for pdf_page in PdfReader(io.BytesIO(stored)).pages:
        annots = pdf_page.get("/Annots")
        assert not annots or all(
            str(a.get_object().get("/Subtype")) not in ("/Highlight", "/Text") for a in annots)

    # …but the imported block exists, with the exported color intact.
    kids = guest.get(f"/api/blocks/{page['id']}/children").json()["children"]
    hl = [b for b in kids if b["properties"].get("highlight_id")]
    assert len(hl) == 1
    assert hl[0]["properties"]["color"] == "rgba(170, 235, 170, 0.65)"

    # Re-running finds nothing left to import or strip.
    r = guest.post("/api/import/pdf-annotations",
                   json={"block_id": page["id"], "doc_id": doc_id, "strip": True})
    assert r.json() == {"ok": True, "found": 0, "imported": 0, "stripped": 0}


def test_export_pdf_endpoint_rejects_pageless(guest):
    page = make_page(guest, "No PDF here")
    r = guest.get(f"/api/pages/{page['id']}/export-pdf")
    assert r.status_code == 400

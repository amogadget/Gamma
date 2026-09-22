"""Handwriting (gamma/ink.py, routers/ink.py): the stroke-file codec and
its limits, the upload endpoint, the /Ink round trip through the annotated
PDF export and the embedded-annotation importer, and the Markdown / notes-PDF
renderings of an ink block."""

import io
import json
import zipfile

import pytest
from conftest import make_page

from gamma import ink as inkmod

PAGE_W, PAGE_H = 612, 792


def _samples(n=5, x0=100.0, y0=200.0):
    return [{"x": x0 + 10 * i, "y": y0 + 3 * i, "p": 0.2 + 0.15 * i, "t": 16 * i} for i in range(n)]


def _ink(page=1, strokes=None, **space):
    strokes = strokes if strokes is not None else [{
        "id": "s1", "tool": "pen", "color": "#1f1f1f", "size": 2, "opacity": 1, "pen": True,
        "t0": 1757760000000, "ch": "xypt", "pts": inkmod.encode_points(_samples(), "xypt"),
    }]
    return {"format": "gamma-ink", "version": 1,
            "space": {"kind": "pdf-page", "page": page, "width": PAGE_W, "height": PAGE_H, **space},
            "strokes": strokes}


def _blank_pdf(pages=1):
    from PyPDF2 import PdfWriter
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=PAGE_W, height=PAGE_H)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


# --- codec ------------------------------------------------------------------------

def test_codec_round_trips_and_delta_encodes():
    ink = inkmod.parse_ink(_ink())
    stroke = ink.strokes[0]
    # deltas after the first sample: x steps of 10 pt = 1000 hundredths
    assert stroke.pts[:4] == [10000, 20000, 200, 0]
    assert stroke.pts[4:8] == [1000, 300, 350, 16]
    decoded = inkmod.decode_stroke(stroke)
    assert [(round(s["x"], 2), round(s["y"], 2), s["t"]) for s in decoded] == \
        [(100 + 10 * i, 200 + 3 * i, 16 * i) for i in range(5)]
    assert decoded[1]["p"] == pytest.approx(0.35)
    # widths follow pressure for a real pen, stay flat for a highlighter
    assert inkmod.stroke_width(stroke, 1.0) > stroke.size > inkmod.stroke_width(stroke, 0.0)
    hl = stroke.model_copy(update={"tool": "highlighter"})
    assert inkmod.stroke_width(hl, 0.1) == inkmod.stroke_width(hl, 0.9) == hl.size


def test_bounding_box_and_pdf_position():
    ink = inkmod.parse_ink(_ink())
    x0, y0, x1, y1 = inkmod.bounding_box(ink)
    assert x0 < 100 and x1 > 140 and y0 < 200 and y1 > 212   # half the width around the samples
    pos = inkmod.pdf_position(ink)
    assert pos["pageNumber"] == 1
    r = pos["boundingRect"]
    assert (r["width"], r["height"], r["pageNumber"]) == (PAGE_W, PAGE_H, 1)
    assert inkmod.bounding_box(inkmod.parse_ink(_ink(strokes=[]))) is None


def test_monoline_preserves_samples_and_constant_width_in_exports(guest):
    legacy = inkmod.parse_ink(_ink())
    assert b'"brush"' not in inkmod.dumps(legacy)
    data = _ink()
    data["strokes"][0]["brush"] = "monoline"
    r = guest.post("/api/upload-ink", json=data)
    assert r.status_code == 200, r.text
    stored = guest.get(r.json()["url"])
    ink = inkmod.parse_ink(stored.content)
    assert ink.strokes[0].brush == "monoline"
    assert inkmod.decode_stroke(ink.strokes[0]) == inkmod.decode_stroke(legacy.strokes[0])
    assert {w for _, _, w in inkmod.stroke_polyline(ink.strokes[0])} == {2}
    # Both SVG export and the notes PDF keep a uniform 2pt stroke despite
    # varying pressure, while the native JSON retains those pressure samples.
    svg = inkmod.to_svg(ink)
    assert svg.count('stroke-width="2"') == 4
    ops = inkmod.pdf_path_ops(ink, lambda x, y: (x, PAGE_H - y))
    assert ops.count(b"2.00 w") == 4
    invalid = _ink()
    invalid["strokes"][0].update(tool="highlighter", brush="monoline")
    assert guest.post("/api/upload-ink", json=invalid).status_code == 400


@pytest.mark.parametrize("mutate, message", [
    (lambda d: d.__setitem__("format", "other"), "format"),
    (lambda d: d["space"].pop("page"), "page"),
    (lambda d: d["strokes"][0].__setitem__("ch", "xx"), "channel"),
    (lambda d: d["strokes"][0].__setitem__("pts", [1, 2, 3]), "multiple"),
    (lambda d: d["strokes"][0].__setitem__("color", "red"), "color"),
    (lambda d: d["strokes"].append(dict(d["strokes"][0])), "duplicate"),
    (lambda d: d["strokes"][0].__setitem__("extra", 1), "extra"),
])
def test_schema_rejects_bad_files(mutate, message):
    data = _ink()
    mutate(data)
    with pytest.raises(inkmod.InkError) as e:
        inkmod.parse_ink(data)
    assert message.lower() in str(e.value).lower()


def test_budgets(monkeypatch):
    monkeypatch.setattr(inkmod, "MAX_SAMPLES", 8)
    with pytest.raises(inkmod.InkError):
        inkmod.parse_ink(_ink(strokes=[{"id": "a", "ch": "xy", "pts": [0] * 10}, {"id": "b", "ch": "xy", "pts": [0] * 10}]))
    monkeypatch.setattr(inkmod, "MAX_BYTES", 10)
    with pytest.raises(inkmod.InkError):
        inkmod.parse_ink(json.dumps(_ink()).encode())


def test_svg_and_pdf_ops_render_every_stroke():
    ink = inkmod.parse_ink(_ink(strokes=[
        {"id": "a", "ch": "xyp", "pts": inkmod.encode_points(_samples(), "xyp")},
        {"id": "b", "tool": "highlighter", "color": "rgba(255, 226, 143, 0.65)", "size": 8, "opacity": 0.5,
         "ch": "xy", "pts": inkmod.encode_points(_samples(3, 300, 300), "xy")},
    ]))
    svg = inkmod.to_svg(ink)
    assert svg.startswith("<svg") and svg.count("<path") == 5   # 4 pen segments + 1 highlighter path
    assert "multiply" in svg and 'stroke="rgb(255,226,143)"' in svg
    ops = inkmod.pdf_path_ops(ink, lambda x, y: (x, PAGE_H - y))
    # 4 pen segments each stroked alone + the highlighter's one polyline
    assert ops.count(b" l S") == 5 and ops.count(b" m ") == 5 and ops.startswith(b"q 1 J 1 j")


# --- upload endpoint ----------------------------------------------------------------

def test_upload_ink_stores_canonically_and_serves(guest):
    data = _ink()
    r = guest.post("/api/upload-ink", json=data)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"].endswith(".ink") and body["strokes"] == 1 and body["already_existed"] is False
    assert body["pdf_position"]["pageNumber"] == 1
    # same strokes, other key order → same file
    again = guest.post("/api/upload-ink", json=json.loads(json.dumps(data))).json()
    assert again["url"] == body["url"] and again["already_existed"] is True
    served = guest.get(body["url"])
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("application/json")
    assert inkmod.parse_ink(served.content).strokes[0].id == "s1"


def test_upload_ink_rejects_bad_files(guest):
    r = guest.post("/api/upload-ink", json={"format": "gamma-ink", "version": 1, "space": {"width": 1, "height": 1}})
    assert r.status_code == 400 and "page" in r.json()["detail"]
    r = guest.post("/api/upload-ink", content=b"not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 400


def test_orphan_sweep_keeps_referenced_ink(guest):
    from gamma.db import ws_uploads_dir
    from gamma.workspaces import default_workspace
    url = guest.post("/api/upload-ink", json=_ink(strokes=[{"id": "keep", "ch": "xy", "pts": [100, 100]}])).json()["url"]
    page = make_page(guest, "Ink page")
    r = guest.post(f"/api/pages/{page['id']}/ops", json={"client": "t", "ops": [
        {"op": "insert", "id": "inkblk1", "parent": page["id"], "content": "caption",
         "props": {"ink_url": url, "pdf_page": 1}},
    ]})
    assert r.status_code == 200, r.text
    # deleting an unrelated block sweeps orphans (grace is 0 in tests): the referenced file stays
    r = guest.post(f"/api/pages/{page['id']}/ops", json={"client": "t", "ops": [
        {"op": "insert", "id": "inkblk2", "parent": page["id"], "content": "x", "props": {}},
        {"op": "delete", "id": "inkblk2"},
    ]})
    assert r.status_code == 200, r.text
    uploads = ws_uploads_dir(default_workspace("guest"))
    assert (uploads / url.rsplit("/", 1)[1]).is_file()
    # dropping the block frees the file
    r = guest.post(f"/api/pages/{page['id']}/ops", json={"client": "t", "ops": [{"op": "delete", "id": "inkblk1"}]})
    assert r.status_code == 200, r.text
    assert not (uploads / url.rsplit("/", 1)[1]).is_file()


# --- PDF interchange ------------------------------------------------------------------

def test_annotated_pdf_writes_ink_and_importer_reads_it_back():
    from PyPDF2 import PdfReader
    from gamma.pdf_export import annotate_pdf
    from gamma.routers.imports import _extract_pdf_annotations

    ink = inkmod.parse_ink(_ink(strokes=[
        {"id": "a", "ch": "xypt", "pts": inkmod.encode_points(_samples(), "xypt"), "t0": 5},
        {"id": "b", "color": "#ff0000", "ch": "xy", "pts": inkmod.encode_points(_samples(3, 300, 300), "xy")},
    ]))
    out, written = annotate_pdf(_blank_pdf(), [], author="tester", ink=[{"ink": ink, "note": "my ink", "id": "blk"}])
    assert written == 2   # two looks → two /Ink annotations
    reader = PdfReader(io.BytesIO(out))
    annots = [a.get_object() for a in reader.pages[0]["/Annots"]]
    assert [str(a["/Subtype"]) for a in annots] == ["/Ink", "/Ink"]
    first = annots[0]
    assert str(first["/Contents"]) == "my ink" and "/GammaInk" in first and str(first["/NM"]).startswith("Zotero-")
    # /InkList is in PDF user space: y flipped, first sample (100, 200) → (100, 592)
    path = [float(v) for v in first["/InkList"][0]]
    assert path[:2] == pytest.approx([100.0, PAGE_H - 200.0])

    found = _extract_pdf_annotations(reader)
    assert len(found) == 2 and all(f["kind"] == "ink" for f in found)
    back = found[0]["ink"]
    assert back.strokes[0].ch == "xypt" and back.strokes[0].t0 == 5   # the private key kept pressure + time
    assert found[0]["content"] == "my ink" and found[0]["position"]["pageNumber"] == 1


def test_importer_reads_foreign_ink_without_private_key():
    from PyPDF2 import PdfReader, PdfWriter
    from PyPDF2.generic import ArrayObject, DictionaryObject, FloatObject, NameObject
    from gamma.routers.imports import _extract_pdf_annotations

    w = PdfWriter()
    w.add_blank_page(width=PAGE_W, height=PAGE_H)
    annot = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Ink"),
        NameObject("/Rect"): ArrayObject(FloatObject(v) for v in (10, 10, 60, 60)),
        NameObject("/InkList"): ArrayObject([ArrayObject(FloatObject(v) for v in (10, 10, 30, 40, 60, 60))]),
        NameObject("/BS"): DictionaryObject({NameObject("/W"): FloatObject(3)}),
        NameObject("/C"): ArrayObject(FloatObject(v) for v in (0, 0, 1)),
    })
    w.add_annotation(page_number=0, annotation=annot)
    buf = io.BytesIO()
    w.write(buf)
    found = _extract_pdf_annotations(PdfReader(io.BytesIO(buf.getvalue())))
    assert len(found) == 1
    ink = found[0]["ink"]
    s = ink.strokes[0]
    assert s.size == 3 and s.color == "#0000ff" and s.pen is False
    pts = inkmod.decode_stroke(s)
    assert (pts[0]["x"], pts[0]["y"]) == (10, PAGE_H - 10) and pts[-1]["x"] == 60


def test_import_endpoint_creates_ink_blocks(guest):
    from gamma.pdf_export import annotate_pdf
    ink = inkmod.parse_ink(_ink())
    pdf, _ = annotate_pdf(_blank_pdf(), [], ink=[{"ink": ink, "note": "note", "id": "b"}])
    r = guest.post("/api/uploads", files={"file": ("ink.pdf", io.BytesIO(pdf), "application/pdf")})
    assert r.status_code == 200, r.text
    doc_id = r.json()["doc_id"]
    page = guest.post(f"/api/blocks/by-doc/{doc_id}", json={"default_title": "Ink import"}).json()
    r = guest.post("/api/import/pdf-annotations", json={"block_id": page["id"], "doc_id": doc_id, "strip": True})
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1 and r.json()["stripped"] == 1
    children = guest.get(f"/api/blocks/{page['id']}/children").json()["children"]
    props = children[0]["properties"]
    assert props["ink_url"].endswith(".ink") and props["pdf_page"] == 1 and props["ink_strokes"] == 1
    assert props["annot_stripped"] is True and children[0]["content"] == "note"
    assert guest.get(props["ink_url"]).status_code == 200
    # idempotent
    assert guest.post("/api/import/pdf-annotations", json={"block_id": page["id"], "doc_id": doc_id}).json()["imported"] == 0


# --- other exports --------------------------------------------------------------------

def _page_with_ink(guest, title="Ink export"):
    url = guest.post("/api/upload-ink", json=_ink(page=2)).json()["url"]
    page = make_page(guest, title)
    r = guest.put(f"/api/blocks/{page['id']}/children", json={"blocks": [
        {"id": f"ink-{page['id']}", "content": "a derivation", "children": [], "properties": {
            "ink_url": url, "pdf_page": 2, "ink_strokes": 1}},
    ]})
    assert r.status_code == 200, r.text
    return page, url


def test_markdown_export_bundles_an_svg_picture(guest):
    page, url = _page_with_ink(guest)
    r = guest.get(f"/api/pages/{page['id']}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/zip")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    stem = url.rsplit("/", 1)[1][:-4]
    md = z.read([n for n in z.namelist() if n.endswith(".md")][0]).decode()
    assert f"- ![Handwriting (p.2)](assets/{stem}.svg)" in md and "  a derivation" in md
    assert z.read(f"assets/{stem}.svg").startswith(b"<svg")


def test_notes_pdf_draws_the_strokes(guest):
    page, _ = _page_with_ink(guest, "Ink notes pdf")
    r = guest.get(f"/api/pages/{page['id']}/export?mode=notes-pdf")
    assert r.status_code == 200, r.text
    from PyPDF2 import PdfReader
    reader = PdfReader(io.BytesIO(r.content))
    stream = b"".join(p.get_contents().get_data() for p in reader.pages)
    assert b"1 J 1 j" in stream and stream.count(b" l S") == 4
    assert "handwriting, p. 2" in reader.pages[0].extract_text()

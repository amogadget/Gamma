"""Markdown export: the readable flavour, the .md-vs-.zip decision, folder
export, and the Logseq file-graph export (hls page + EDN + area images)."""

import io
import zipfile

from conftest import make_page

from gamma.markdown_export import build_tree, collect_and_rewrite, render_readable, slugify


def _put_children(guest, page_id, tree):
    r = guest.put(f"/api/blocks/{page_id}/children", json={"blocks": tree})
    assert r.status_code == 200, r.text


def _highlight(hid, quote, note="", page=1, color="rgba(255, 226, 143, 0.65)", children=None):
    return {
        "id": hid,
        "content": note,
        "children": children or [],
        "properties": {
            "highlight_id": hid,
            "quote": quote,
            "pdf_page": page,
            "color": color,
            "pdf_position": {"pageNumber": page, "boundingRect": {}, "rects": []},
        },
    }


def test_readable_export_is_bare_md(guest):
    page = make_page(guest, "Readable page")
    _put_children(
        guest,
        page["id"],
        [
            {
                "id": "a",
                "content": "top note",
                "properties": {},
                "children": [
                    _highlight("h1", "an important quote", note="my comment", page=3),
                ],
            },
        ],
    )
    r = guest.get(f"/api/pages/{page['id']}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/markdown")
    body = r.text
    assert "# Readable page" in body
    assert "- top note" in body
    assert "> an important quote" in body
    assert "`p.3`" in body
    assert "my comment" in body


def test_export_with_asset_returns_zip(guest):
    # A real uploaded PDF so the export must bundle it.
    up = guest.post("/api/uploads", files={"file": ("p.pdf", b"%PDF-1.4 minimal", "application/pdf")})
    assert up.status_code == 200, up.text
    src = up.json()["source_url"]
    page = make_page(guest, "Paper", properties={"doc_id": up.json()["doc_id"], "source_url": src})
    _put_children(guest, page["id"], [_highlight("h", "quote", page=1)])

    r = guest.get(f"/api/pages/{page['id']}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert any(n.endswith(".md") for n in names)
    assert any(n.startswith("assets/") and n.endswith(".pdf") for n in names)
    md = next(z.read(n).decode() for n in names if n.endswith(".md"))
    assert "assets/" in md and "/api/uploads/" not in md


def test_export_pdf_opt_out_stays_bare_md(guest):
    up = guest.post("/api/uploads", files={"file": ("q.pdf", b"%PDF-1.4 tiny", "application/pdf")})
    page = make_page(guest, "No bundle", properties={"source_url": up.json()["source_url"]})
    r = guest.get(f"/api/pages/{page['id']}/export", params={"pdf": 0})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert "/api/uploads/" in r.text  # link left absolute, not bundled


def _switch_page(guest):
    """A page with a highlight that carries a note, plus a free note."""
    page = make_page(guest, "Switches")
    _put_children(guest, page["id"], [
        _highlight("sh1", "the quoted passage", note="what I thought", page=2),
        {"id": "sfree", "content": "a free-standing note", "properties": {}, "children": []},
    ])
    return page


def test_export_switches_drop_highlights_or_notes(guest):
    """The export dialog's two switches: highlights are the quoted passages,
    notes are your own writing — a highlight block holds one of each."""
    page = _switch_page(guest)
    both = guest.get(f"/api/pages/{page['id']}/export").text
    assert "> the quoted passage" in both and "what I thought" in both
    assert "a free-standing note" in both

    no_hl = guest.get(f"/api/pages/{page['id']}/export", params={"highlights": 0}).text
    assert "the quoted passage" not in no_hl and "`p.2`" not in no_hl
    # the note under the highlight survives, as a plain bullet
    assert "- what I thought" in no_hl and "a free-standing note" in no_hl

    no_notes = guest.get(f"/api/pages/{page['id']}/export", params={"notes": 0}).text
    assert "> the quoted passage" in no_notes and "`p.2`" in no_notes
    assert "what I thought" not in no_notes and "a free-standing note" not in no_notes

    neither = guest.get(f"/api/pages/{page['id']}/export", params={"highlights": 0, "notes": 0}).text
    assert "# Switches" in neither  # title + front-matter always stay
    assert "quoted passage" not in neither and "free-standing note" not in neither


def test_folder_export_zips_matching_pages(guest):
    make_page(guest, "In folder A", properties={"folder": "research/optics"})
    make_page(guest, "In subfolder", properties={"folder": "research/optics/lasers"})
    make_page(guest, "Elsewhere", properties={"folder": "cooking"})
    r = guest.get("/api/folders/export", params={"name": "research/optics"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    mds = [n for n in names if n.endswith(".md")]
    assert len(mds) == 2  # the folder page + the subfolder page, not "cooking"


def _blank_pdf_bytes():
    from PyPDF2 import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _positioned(hid, quote, page=1, area=False, note=""):
    rect = {"x1": 50.0, "y1": 60.0, "x2": 250.0, "y2": 160.0, "width": 800.0, "height": 1035.0}
    pos = {"pageNumber": page, "boundingRect": rect, "rects": [rect]}
    if area:
        pos["area"] = True
    return {
        "id": hid,
        "content": note,
        "children": [],
        "properties": {
            "highlight_id": hid,
            "quote": quote,
            "pdf_page": page,
            "color": "rgba(170, 235, 170, 0.65)",
            "pdf_position": pos,
        },
    }


def test_logseq_graph_export(guest):
    up = guest.post("/api/uploads", files={"file": ("g.pdf", _blank_pdf_bytes(), "application/pdf")})
    assert up.status_code == 200, up.text
    page = make_page(
        guest, "Graph paper", properties={"doc_id": up.json()["doc_id"], "source_url": up.json()["source_url"]}
    )
    _put_children(
        guest,
        page["id"],
        [
            _positioned("th", "a text quote", note="my thought"),
            _positioned("ah", "", area=True),
            {"id": "free", "content": "a free note", "properties": {}, "children": []},
        ],
    )

    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "logseq-graph"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())

    assert "logseq/config.edn" in names
    page_md_name = next(n for n in names if n.startswith("pages/") and "hls__" not in n)
    stem = page_md_name[len("pages/") : -len(".md")]
    assert f"pages/hls__{stem}.md" in names
    assert f"assets/{stem}.pdf" in names
    assert f"assets/{stem}.edn" in names

    from gamma.logseq_graph_export import hl_uuid

    text_uuid, area_uuid = str(hl_uuid("th")), str(hl_uuid("ah"))

    page_md = z.read(page_md_name).decode()
    assert f"(({text_uuid}))" in page_md
    assert "my thought" in page_md
    assert "a free note" in page_md
    assert f"../assets/{stem}.pdf" in page_md

    hls_md = z.read(f"pages/hls__{stem}.md").decode()
    assert f"file-path:: ../assets/{stem}.pdf" in hls_md
    assert "ls-type:: annotation" in hls_md
    assert f"id:: {text_uuid}" in hls_md
    assert "hl-color:: green" in hls_md
    assert "hl-type:: area" in hls_md and "hl-stamp::" in hls_md

    edn = z.read(f"assets/{stem}.edn").decode()
    assert ":highlights" in edn and ":bounding" in edn
    assert f'#uuid "{text_uuid}"' in edn
    assert '"a text quote"' in edn

    # The area highlight's crop got rendered as a real PNG under assets/<stem>/.
    pngs = [n for n in names if n.startswith(f"assets/{stem}/") and area_uuid in n]
    assert pngs, names
    assert z.read(pngs[0]).startswith(b"\x89PNG")

    # Round-trip the Logseq EDN back through Gamma's own importer parser.
    from gamma.logseq_import import parse_edn

    parsed = parse_edn(edn)
    assert len(parsed["highlights"]) == 2
    assert parsed["highlights"][0]["position"]["bounding"]["x1"] == 50.0


def test_logseq_graph_export_without_pdf(guest):
    page = make_page(guest, "No pdf page")
    _put_children(guest, page["id"], [_highlight("nopdf-h", "kept quote", note="note text")])
    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "logseq-graph"})
    assert r.status_code == 200, r.text
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert "logseq/config.edn" in names
    assert not any("hls__" in n for n in names)
    md = z.read(next(n for n in names if n.startswith("pages/"))).decode()
    # No asset to ref into — the quote stays inline so the notes still read.
    assert "kept quote" in md and "note text" in md


def test_missing_page_404(guest):
    r = guest.get("/api/pages/does-not-exist/export")
    assert r.status_code == 404


def test_slugify_and_rewrite_units():
    assert slugify("a/b:c*?", "xyz123") == "abc-xyz123"
    assert slugify("", "id") == "Untitled-id"
    md, assets = collect_and_rewrite("see /api/uploads/abc123.pdf here")
    assert "assets/abc123.pdf" in md and assets == {"abc123.pdf"}
    md2, assets2 = collect_and_rewrite("/api/uploads/abc123.pdf", include_pdf=False)
    assert "/api/uploads/abc123.pdf" in md2 and assets2 == set()


def test_build_tree_orders_children():
    rows = [
        ("p", "root", "a0", "Page", "{}", "t", "t"),
        ("c2", "p", "a2", "second", "{}", "t", "t"),
        ("c1", "p", "a1", "first", "{}", "t", "t"),
    ]
    page = build_tree(rows, "p")
    assert [c["content"] for c in page["children"]] == ["first", "second"]
    assert "# Page" in render_readable(page)

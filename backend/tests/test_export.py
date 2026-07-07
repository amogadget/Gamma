"""Markdown export: both flavours, the .md-vs-.zip decision, folder export, and
a round-trip of the logseq flavour back through the Logseq importer."""

import io
import zipfile

from conftest import make_page

from gamma.logseq_import import md_to_ordered_blocks, parse_logseq_md
from gamma.markdown_export import build_tree, collect_and_rewrite, render_page, slugify


def _put_children(guest, page_id, tree):
    r = guest.put(f"/api/blocks/{page_id}/children", json={"blocks": tree})
    assert r.status_code == 200, r.text


def _highlight(hid, quote, note="", page=1, color="rgba(255, 226, 143, 0.65)", children=None):
    return {
        "id": hid, "content": note, "children": children or [],
        "properties": {
            "highlight_id": hid, "quote": quote, "pdf_page": page, "color": color,
            "pdf_position": {"pageNumber": page, "boundingRect": {}, "rects": []},
        },
    }


def test_readable_export_is_bare_md(guest):
    page = make_page(guest, "Readable page")
    _put_children(guest, page["id"], [
        {"id": "a", "content": "top note", "properties": {}, "children": [
            _highlight("h1", "an important quote", note="my comment", page=3),
        ]},
    ])
    r = guest.get(f"/api/pages/{page['id']}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/markdown")
    body = r.text
    assert "# Readable page" in body
    assert "- top note" in body
    assert "> an important quote" in body
    assert "`p.3`" in body
    assert "my comment" in body


def test_logseq_flavour_roundtrips_through_importer(guest):
    page = make_page(guest, "Roundtrip page")
    _put_children(guest, page["id"], [
        _highlight("hh", "the quoted text", note="the note", page=5),
        {"id": "nn", "content": "a free note", "properties": {}, "children": []},
    ])
    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "logseq"})
    assert r.status_code == 200, r.text
    md = r.text
    assert "ls-type:: annotation" in md
    assert "id:: hh" in md
    assert "hl-page:: 5" in md

    # Re-parse with the real importer and confirm content survives.
    ordered, _ = md_to_ordered_blocks(parse_logseq_md(md), edn_by_quote={}, edn_by_uuid={})
    highlights = [b for b in ordered if '"highlight_id"' in b["properties"]]
    assert any("the quoted text" in b["properties"] for b in highlights)
    assert any(b["content"] == "the note" for b in highlights)
    assert any(b["content"] == "a free note" for b in ordered)


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


def test_missing_page_404(guest):
    r = guest.get("/api/pages/does-not-exist/export")
    assert r.status_code == 404


def test_slugify_and_rewrite_units():
    assert slugify('a/b:c*?', "xyz123") == "abc-xyz123"
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
    assert "# Page" in render_page(page)

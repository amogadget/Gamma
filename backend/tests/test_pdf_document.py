"""Notes typeset as their own PDF: markdown parsing, the document renderer,
and the ``notes-pdf`` export mode end to end."""

import io

from conftest import make_page

from gamma.note_markup import MATH, TEXT
from gamma.pdf_document import PAGE_H, chunks, inline, render_document
from gamma.pdf_typeset import BOLD, ITALIC, LINK, MARK, MONO, STRIKE


def _page(title="Notes", properties=None, children=()):
    return {"id": "pg", "content": title, "properties": properties or {},
            "children": list(children)}


def _block(bid, content, properties=None, children=()):
    return {"id": bid, "content": content, "properties": properties or {},
            "children": list(children)}


def _highlight(bid, quote, note="", page=3, children=()):
    rect = {"x1": 50.0, "y1": 60.0, "x2": 250.0, "y2": 160.0, "width": 800.0, "height": 1035.0}
    return _block(bid, note, {
        "highlight_id": bid, "quote": quote, "pdf_page": page,
        "color": "rgba(170, 235, 170, 0.65)",
        "pdf_position": {"pageNumber": page, "boundingRect": rect, "rects": [rect]},
    }, children)


def _text(pdf_bytes, page=1):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        return doc[page - 1].get_textpage().get_text_bounded()
    finally:
        doc.close()


def _object_kinds(pdf_bytes, page=1):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        return [o.type for o in doc[page - 1].get_objects(max_depth=1)]
    finally:
        doc.close()


def _blank_png(width, height):
    from gamma.logseq_graph_export import _encode_png

    return _encode_png(width, height, [bytes([200, 210, 220]) * width for _ in range(height)])


# --- markdown parsing --------------------------------------------------------

def test_inline_carries_the_style_of_each_construct():
    spans = inline("plain **bold** *it* `code` ~~gone~~ ==mark== [lab](https://e.dev) $x^2$")
    by_text = {p: st for k, p, _lv, st in spans if k == TEXT}
    assert by_text["bold"].bits == BOLD
    assert by_text["it"].bits == ITALIC
    assert by_text["code"].bits == MONO
    assert by_text["gone"].bits == STRIKE
    assert by_text["mark"].bits == MARK
    assert by_text["lab"].bits == LINK and by_text["lab"].href == "https://e.dev"
    # Inline math stays LaTeX for the typesetter, never printed as source.
    assert [p for k, p, _lv, _st in spans if k == MATH] == ["x^2"]


def test_inline_nests_and_leaves_bare_urls_clickable():
    spans = inline("**bold with *both* inside** see https://gamma.dev/x")
    both = next(st for k, p, _lv, st in spans if p == "both")
    assert both.bits == BOLD | ITALIC
    url = next(st for k, p, _lv, st in spans if p.startswith("https://"))
    assert url.bits == LINK and url.href == "https://gamma.dev/x"


def test_chunks_split_block_markdown_by_construct():
    got = chunks("## Heading\n"
                 "- one\n"
                 "- [x] done\n"
                 "> quoted\n"
                 "\n"
                 "```\ncode()\n```\n"
                 "$$E = mc^2$$\n"
                 "---\n"
                 "![shot](/api/uploads/ab12.png)")
    def flag(c):
        for key in ("heading", "bullet", "todo", "quote"):
            if key in c:
                return c[key]
        return None

    kinds = [(c["kind"], flag(c)) for c in got]
    assert kinds == [
        ("text", 2),            # ## heading
        ("text", ""),           # bullet (a dot)
        ("text", True),         # ticked todo
        ("text", True),         # quote line
        ("gap", None),
        ("code", None),
        ("math", None),
        ("rule", None),
        ("image", None),
    ]
    assert got[5]["lines"] == ["code()"]
    assert got[6]["tex"] == "E = mc^2"
    assert got[8]["src"] == "/api/uploads/ab12.png"


def test_callout_header_becomes_a_bold_quote_line():
    got = chunks("> [!warning] Careful\n> the body")
    assert got[0]["quote"] and got[0]["spans"][0][1] == "Careful"
    assert got[0]["spans"][0][3].bits == BOLD


# --- the renderer ------------------------------------------------------------

def test_render_document_writes_title_notes_and_quotes():
    pdf = render_document([_page("Cavity QED notes",
                                 {"meta": {"authors": ["Ada L."], "year": 2031}},
                                 [_block("b1", "# Overview\nplain **note** text"),
                                  _highlight("h1", "the quoted passage", "my comment", page=7)])])
    text = _text(pdf)
    assert "Cavity QED notes" in text and "Ada L." in text
    assert "Overview" in text and "plain note text" in text
    assert "the quoted passage" in text and "p. 7" in text and "my comment" in text
    # Markdown markers are rendered, never printed.
    assert "**" not in text and "#" not in text


def test_render_document_needs_no_pdf_and_paginates():
    """The point of the format: a note page has no paper, and a long one still
    comes out as a document rather than one overflowing sheet."""
    long_block = _block("b1", "paragraph text " * 60)
    pdf = render_document([_page("Long note", None, [long_block] * 12)])
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf)
    try:
        assert len(doc) > 1
        heights = {round(float(doc[i].get_size()[1])) for i in range(len(doc))}
    finally:
        doc.close()
    assert heights == {round(PAGE_H)}
    assert "paragraph text" in _text(pdf, 2)


def test_render_document_switches_drop_highlights_or_notes():
    page = _page("Switches", None, [
        _highlight("h1", "quoted passage", "writing under the highlight"),
        _block("b2", "free-standing note"),
    ])
    both = _text(render_document([page]))
    assert "quoted passage" in both and "writing under the highlight" in both

    no_highlights = _text(render_document([page], highlights=False))
    assert "quoted passage" not in no_highlights
    # Dropping highlights keeps the writing that hung off them.
    assert "writing under the highlight" in no_highlights

    no_notes = _text(render_document([page], notes=False))
    assert "quoted passage" in no_notes
    assert "writing under the highlight" not in no_notes and "free-standing note" not in no_notes
    assert "Switches" in no_notes          # the title always stays


def test_render_document_starts_each_page_on_a_fresh_sheet():
    pdf = render_document([_page("First", None, [_block("a", "alpha note")]),
                           _page("Second", None, [_block("b", "beta note")])])
    assert "First" in _text(pdf, 1) and "beta note" not in _text(pdf, 1)
    assert "Second" in _text(pdf, 2) and "alpha note" not in _text(pdf, 2)


def test_links_become_real_pdf_annotations():
    from PyPDF2 import PdfReader

    pdf = render_document([_page("Links", None, [
        _block("b1", "see [the paper](https://arxiv.org/abs/2401.00001) for more")])])
    annots = PdfReader(io.BytesIO(pdf)).pages[0].get("/Annots") or []
    targets = [str(a.get_object()["/A"]["/URI"]) for a in annots]
    assert "https://arxiv.org/abs/2401.00001" in targets
    assert "the paper" in _text(pdf) and "arxiv.org" not in _text(pdf)


def test_page_titles_and_headings_become_bookmarks():
    from PyPDF2 import PdfReader

    pdf = render_document([_page("Paper one", None, [_block("b1", "## A section")])])
    outline = PdfReader(io.BytesIO(pdf)).outline
    titles = [o["/Title"] for o in outline if isinstance(o, dict)]
    nested = [o["/Title"] for group in outline if isinstance(group, list)
              for o in group if isinstance(o, dict)]
    assert titles == ["Paper one"] and nested == ["A section"]


def test_math_and_cjk_are_drawn_as_vector_paths(guest):
    """Same guarantee the note boxes give: nothing shows LaTeX source, and CJK
    doesn't depend on the viewer having an Asian font."""
    from gamma import vector_text

    pdf = render_document([_page("Math", None, [
        _block("b1", r"inline $\alpha_j$ then"),
        _block("b2", r"$$\frac{\sum_i x_i^2}{n}$$"),
        _block("b3", "Bayes 公式是: ok"),
    ])])
    text = _text(pdf)
    assert "\\alpha" not in text and "\\frac" not in text and "$$" not in text
    assert "Bayes" in text and "inline" in text
    if vector_text.cjk_font() is not None:
        assert not any("一" <= c <= "鿿" for c in text)
    assert _object_kinds(pdf).count(2) >= 10, "math should be typeset as vector paths"


def test_pasted_images_are_embedded(guest):
    from gamma.db import user_uploads_dir

    up = guest.post("/api/upload-image",
                    files={"file": ("shot.png", _blank_png(24, 16), "image/png")})
    assert up.status_code == 200, up.text
    src = up.json()["url"]
    pdf = render_document([_page("With a picture", None, [_block("b1", f"look:\n![shot]({src})")])],
                          uploads_dir=user_uploads_dir("guest"))
    assert 3 in _object_kinds(pdf), "the pasted image should be drawn as a page image"
    assert src not in _text(pdf)


def test_unresolvable_image_falls_back_to_its_alt_text():
    pdf = render_document([_page("Missing", None,
                                 [_block("b1", "![the figure](/api/uploads/deadbeef.png)")])])
    assert "the figure" in _text(pdf)


# --- the export endpoints ----------------------------------------------------

def test_export_notes_pdf_endpoint_on_a_note_page(guest):
    page = make_page(guest, "Note page, no PDF")
    r = guest.put(f"/api/blocks/{page['id']}/children", json={"blocks": [
        {"id": "npd1", "content": "# Section\nsome **written** notes",
         "properties": {}, "children": [
             {"id": "npd2", "content": "a nested detail", "properties": {}, "children": []}]},
    ]})
    assert r.status_code == 200, r.text

    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdf"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert ".pdf" in r.headers["content-disposition"]
    assert r.content[:4] == b"%PDF"
    text = _text(r.content)
    assert "Note page, no PDF" in text and "Section" in text
    assert "some written notes" in text and "a nested detail" in text


def test_export_notes_pdf_switches(guest):
    page = make_page(guest, "Switch page")
    r = guest.put(f"/api/blocks/{page['id']}/children", json={"blocks": [
        dict(_highlight("nps1", "a quoted passage", "my own writing"), children=[]),
    ]})
    assert r.status_code == 200, r.text

    off = guest.get(f"/api/pages/{page['id']}/export",
                    params={"mode": "notes-pdf", "notes": 0})
    assert off.status_code == 200
    text = _text(off.content)
    assert "a quoted passage" in text and "my own writing" not in text


def test_folder_notes_pdf_export_is_one_document(guest):
    make_page(guest, "Folder page one", properties={"folder": "notesdoc"})
    make_page(guest, "Folder page two", properties={"folder": "notesdoc/sub"})
    r = guest.get("/api/folders/export", params={"name": "notesdoc", "mode": "notes-pdf"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    titles = _text(r.content, 1) + _text(r.content, 2)
    assert "Folder page one" in titles and "Folder page two" in titles


def test_unknown_export_mode_is_rejected(guest):
    page = make_page(guest, "Mode check")
    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdff"})
    assert r.status_code == 400


def test_oversized_notes_pdf_is_refused_not_streamed(guest, monkeypatch):
    """Fork addition: typeset math is emitted as vector paths at every
    occurrence, so a folder of formula-heavy papers can grow past any sane
    response size. Refuse with an actionable 413 instead of building and
    streaming it."""
    from gamma.routers import export as export_mod

    page = make_page(guest, "Huge notes")
    monkeypatch.setattr(export_mod, "_NOTES_PDF_MAX_BYTES", 512)
    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdf"})
    assert r.status_code == 413
    assert "too large" in r.json()["detail"]


def test_notes_pdf_render_failure_is_a_400_not_a_500(guest, monkeypatch):
    """A malformed block must not surface as a traceback."""
    from gamma.routers import export as export_mod

    page = make_page(guest, "Broken notes")

    def boom(*a, **kw):
        raise ValueError("bad glyph")

    monkeypatch.setattr(export_mod, "render_document", boom)
    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdf"})
    assert r.status_code == 400
    assert "could not build the PDF" in r.json()["detail"]

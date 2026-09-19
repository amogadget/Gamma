"""Notes typeset as their own PDF: markdown parsing, the document renderer,
and the ``notes-pdf`` export mode end to end."""

import io

from conftest import make_page, require_math_renderer, workspace_of

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


def test_chunks_parse_a_gfm_table():
    got = chunks("| Name | Value |\n| :--- | ---: |\n| alpha | 1 |\n| beta | 2 |")
    assert [c["kind"] for c in got] == ["table"]
    table = got[0]
    assert table["aligns"] == ["left", "right"]
    assert len(table["rows"]) == 3
    assert table["rows"][0][0][0][1] == "Name" and table["rows"][0][0][0][3].bits == BOLD
    assert table["rows"][1][0][0][1] == "alpha"


def test_pipes_without_a_delimiter_row_stay_prose():
    got = chunks("a | b | c\nplain line")
    assert all(c["kind"] == "text" for c in got)


def test_image_width_suffix_is_parsed_not_printed():
    got = chunks("![shot](/api/uploads/ab12.png){:width 240}")
    imgs = [c for c in got if c["kind"] == "image"]
    assert imgs and imgs[0]["px_w"] == 240
    assert not any("width" in str(c.get("spans", "")) for c in got if c["kind"] == "text")


def test_obsidian_pipe_width_is_parsed_and_kept_out_of_the_alt():
    got = chunks("![my caption|240](/api/uploads/ab12.png) and ![plain](/api/uploads/cd34.png)")
    imgs = [c for c in got if c["kind"] == "image"]
    assert imgs[0]["px_w"] == 240 and imgs[0]["alt"] == "my caption"
    assert imgs[1]["px_w"] is None and imgs[1]["alt"] == "plain"


def test_embed_becomes_its_own_chunk():
    got = chunks("before ![[abc-123]] after")
    kinds = [c["kind"] for c in got]
    assert kinds == ["text", "embed", "text"]
    assert got[1]["id"] == "abc-123"


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


def test_math_and_cjk_are_selectable_type3_text(guest):
    """Same guarantee the note boxes give: nothing shows LaTeX source, and CJK
    doesn't depend on the viewer having an Asian font. The glyph outlines go
    in as Type 3 fonts, so the equation is real text — its characters come
    back out of the extractor through the ToUnicode map."""
    from gamma import vector_text

    pdf = render_document([_page("Math", None, [
        _block("b1", r"inline $\alpha_j$ then"),
        _block("b2", r"$$\frac{\sum_i x_i^2}{n}$$"),
        _block("b3", "Bayes 公式是: ok"),
    ])])
    text = _text(pdf)
    assert "\\alpha" not in text and "\\frac" not in text and "$$" not in text
    assert "Bayes" in text and "inline" in text
    require_math_renderer()
    assert "α" in text and "∑" in text, "math glyphs should extract as text"
    assert b"/Type3" in pdf
    # The title rule and the fraction bar are the only paths left on the page.
    kinds = _object_kinds(pdf)
    assert kinds.count(2) <= 3 and kinds.count(1) >= 10
    if vector_text.cjk_font() is not None:
        assert "公式" in text


def test_type3_fonts_hold_each_glyph_once_and_map_back_to_unicode():
    """One glyph program per distinct glyph — a repeated x is stored once —
    with widths, an encoding and a ToUnicode CMap that all agree."""
    from PyPDF2 import PdfReader

    require_math_renderer()
    pdf = render_document([_page("Glyphs", None, [_block("b1", r"$x + x + x$ and $\alpha$")])])
    reader = PdfReader(io.BytesIO(pdf))
    fonts = [f.get_object() for f in reader.pages[0]["/Resources"]["/Font"].values()]
    type3 = [f for f in fonts if f.get("/Subtype") == "/Type3"]
    assert len(type3) == 1
    font = type3[0]
    procs = font["/CharProcs"]
    assert len(procs) == len(font["/Widths"]) == font["/LastChar"] == 3   # x, +, α
    assert [float(v) for v in font["/FontMatrix"]] == [0.001, 0, 0, 0.001, 0, 0]
    assert len(font["/Encoding"]["/Differences"]) == 4                    # start code + 3 names
    cmap = font["/ToUnicode"].get_object().get_data().decode()
    assert "<0078>" in cmap and "<002B>" in cmap and "<03B1>" in cmap
    proc = procs["/g1"].get_object().get_data()
    assert proc.split(b"\n")[0].endswith(b" d1") and proc.endswith(b"f")
    assert _text(pdf).count("x") == 3


def test_pasted_images_are_embedded(guest):
    from gamma.db import ws_uploads_dir

    up = guest.post("/api/upload-image",
                    files={"file": ("shot.png", _blank_png(24, 16), "image/png")})
    assert up.status_code == 200, up.text
    src = up.json()["url"]
    pdf = render_document([_page("With a picture", None, [_block("b1", f"look:\n![shot]({src})")])],
                          uploads_dir=ws_uploads_dir(workspace_of("guest")))
    assert 3 in _object_kinds(pdf), "the pasted image should be drawn as a page image"
    assert src not in _text(pdf)


def test_unresolvable_image_falls_back_to_its_alt_text():
    pdf = render_document([_page("Missing", None,
                                 [_block("b1", "![the figure](/api/uploads/deadbeef.png)")])])
    assert "the figure" in _text(pdf)


def test_tables_render_as_a_grid_without_pipe_source():
    pdf = render_document([_page("Table", None, [
        _block("b1", "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| a much longer cell that wraps | 2 |")])])
    text = _text(pdf)
    assert "Name" in text and "alpha" in text and "longer cell" in text
    assert "|" not in text and "---" not in text


def test_long_tables_break_pages_and_repeat_the_header():
    rows = "\n".join(f"| row {n} | value {n} |" for n in range(120))
    pdf = render_document([_page("Long table", None, [
        _block("b1", f"| Col A | Col B |\n| --- | --- |\n{rows}")])])
    assert "row 3" in _text(pdf, 1)
    assert "Col A" in _text(pdf, 2), "the header should repeat on the next page"


def test_refs_and_embeds_resolve_through_the_resolver():
    targets = {
        "src-1": {"content": "the synced note body\nsecond line", "page_title": "Origin page"},
        "ref-1": {"content": "referenced first line\nmore", "page_title": "Origin page"},
    }
    pdf = render_document([_page("Embeds", None, [
        _block("b1", "see [[ref-1]] and:\n![[src-1]]")])],
        resolve_ref=targets.get)
    text = _text(pdf)
    assert "referenced first line" in text and "more" not in text
    assert "the synced note body" in text and "second line" in text
    assert "from Origin page" in text
    assert "src-1" not in text and "ref-1" not in text


def test_nested_embeds_degrade_to_references():
    targets = {
        "outer": {"content": "outer body ![[inner]]", "page_title": "P"},
        "inner": {"content": "inner body", "page_title": "P"},
    }
    pdf = render_document([_page("Nested", None, [_block("b1", "![[outer]]")])],
                          resolve_ref=targets.get)
    text = _text(pdf)
    assert "outer body" in text
    # The inner embed renders as a reference label, not its full card.
    assert "inner body" in text and "from P" in text


def test_unresolved_embed_keeps_the_reference_look():
    pdf = render_document([_page("Missing embed", None, [_block("b1", "![[gone-404]]")])])
    assert "gone-404" in _text(pdf)


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


def test_export_notes_pdf_resolves_cross_page_embeds(guest):
    source = make_page(guest, "Source page")
    r = guest.put(f"/api/blocks/{source['id']}/children", json={"blocks": [
        {"id": "emb-src", "content": "the shared finding", "properties": {}, "children": []}]})
    assert r.status_code == 200, r.text
    target = make_page(guest, "Target page")
    r = guest.put(f"/api/blocks/{target['id']}/children", json={"blocks": [
        {"id": "emb-use", "content": "context: ![[emb-src]] and a ref [[emb-src]]",
         "properties": {}, "children": []}]})
    assert r.status_code == 200, r.text

    r = guest.get(f"/api/pages/{target['id']}/export", params={"mode": "notes-pdf"})
    assert r.status_code == 200, r.text
    text = _text(r.content)
    assert "the shared finding" in text and "from Source page" in text
    assert "emb-src" not in text


def test_unknown_export_mode_is_rejected(guest):
    page = make_page(guest, "Mode check")
    r = guest.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdff"})
    assert r.status_code == 400

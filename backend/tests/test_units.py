"""Pure-function units: DOI candidate extraction, BibTeX building, FTS query
quoting, image validation, PDF annotation extraction."""

import io

from gamma.routers.metadata import _find_doi_candidates, _build_bibtex
from gamma.block_index import fts_query
from gamma.routers.ai import _parse_images


def test_doi_candidates_handle_glued_suffix():
    # PDF text extraction glues the next word onto the DOI
    text = "Letters https://doi.org/10.1038/s41567-019-0478-8Physics Department, Penn State"
    cands = _find_doi_candidates("", text)
    assert cands[0] == "10.1038/s41567-019-0478-8Physics"
    assert "10.1038/s41567-019-0478-8" in cands


def test_doi_candidates_keep_uppercase_suffixes():
    # Legitimate letter-bearing DOIs must not be truncated away entirely
    cands = _find_doi_candidates("https://doi.org/10.1103/PhysRevLett.56.2797", "")
    assert cands[0] == "10.1103/PhysRevLett.56.2797"


def test_build_bibtex_arxiv():
    bib = _build_bibtex({
        "title": "A Paper", "authors": ["Ada Lovelace", "Alan Turing"],
        "year": "2019", "venue": "", "arxiv_id": "1810.11086", "doi": "",
    })
    assert bib.startswith("@article{lovelace2019,")
    assert "eprint = {1810.11086}" in bib
    assert "Ada Lovelace and Alan Turing" in bib


def test_fts_query_quotes_and_prefixes():
    assert fts_query("atom imaging") == '"atom" "imaging"*'
    assert fts_query('say "hi"') == '"say" """hi"""*'  # embedded quotes doubled
    assert fts_query("  ") == ""
    # Queries are normalized like the index: "3,000" and "3000" are the same
    assert fts_query("3,000") == fts_query("3000") == '"3000"*'


def test_normalize_text():
    from gamma.textnorm import normalize_text
    assert normalize_text("a 3,000-qubit array") == "a 3000-qubit array"
    assert normalize_text("the sys-\ntem works") == "the system works"  # line-break hyphenation
    assert normalize_text("eﬃcient  ﬁne") == "efficient fine"          # ligatures fold
    assert normalize_text("well-known") == "well-known"                 # real hyphens survive
    assert normalize_text("") == ""


def test_fuzzy_pattern_separator_tolerance():
    from gamma.textnorm import fuzzy_pattern
    assert fuzzy_pattern("3000").search("a coherent 3,000-qubit system")
    assert fuzzy_pattern("3000 qubit").search("a 3,000-qubit system")   # space matches hyphen
    assert fuzzy_pattern("3,000-qubit").search("3000 qubit")            # and the other way
    assert fuzzy_pattern("Qubit").search("QUBIT")                       # case-insensitive default
    assert not fuzzy_pattern("qubit", case=True).search("QUBIT")
    assert not fuzzy_pattern("fine", whole=True).search("refined")
    assert fuzzy_pattern("(", regex=True) is None                       # invalid regex reported
    assert fuzzy_pattern("   ") is None


def test_parse_images_validates():
    good = "data:image/png;base64,iVBORw0KGgo="
    bad = ["data:text/html;base64,PGI+", "not a data url", good]
    parsed = _parse_images(bad)
    assert parsed == [("image/png", "iVBORw0KGgo=")]


def test_parse_files_validates():
    from gamma.routers.ai import _parse_files
    good = {"name": "paper.pdf", "data": "data:application/pdf;base64,JVBERi0="}
    junk = [
        {"name": "x.png", "data": "data:image/png;base64,iVBORw0KGgo="},  # wrong type
        {"name": "no-data"},
        "not a dict",
        good,
    ]
    assert _parse_files(junk) == ["JVBERi0="]


def test_extract_pdf_annotations_resolves_indirects():
    from PyPDF2 import PdfWriter, PdfReader
    from PyPDF2.generic import (ArrayObject, DictionaryObject, FloatObject,
                                NameObject, TextStringObject)
    from gamma.routers.imports import _extract_pdf_annotations

    w = PdfWriter()
    w.add_blank_page(width=612, height=792)
    annot = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Highlight"),
        NameObject("/Rect"): ArrayObject([FloatObject(v) for v in (100, 700, 300, 720)]),
        NameObject("/QuadPoints"): ArrayObject([FloatObject(v) for v in (100, 720, 300, 720, 100, 700, 300, 700)]),
        NameObject("/Contents"): TextStringObject("a note"),
        NameObject("/C"): ArrayObject([FloatObject(1), FloatObject(0.9), FloatObject(0.3)]),
    })
    w.add_annotation(page_number=0, annotation=annot)
    buf = io.BytesIO()
    w.write(buf)
    buf.seek(0)

    found = _extract_pdf_annotations(PdfReader(buf))
    assert len(found) == 1
    a = found[0]
    assert a["content"] == "a note"
    assert a["page"] == 1
    # y flipped to top-left origin: 792 - 720 = 72
    assert abs(a["position"]["boundingRect"]["y1"] - 72.0) < 0.01
    assert a["color"].startswith("rgba(255, 229,")


# --- selection-centered chat context (gamma/ai_context.py) -------------------

def _fake_pdf(monkeypatch, pages, toc=()):
    from gamma import ai_context
    monkeypatch.setattr(ai_context, "pdf_path", lambda u, d: "fake.pdf")
    monkeypatch.setattr(ai_context, "extract_pages", lambda src: pages)
    monkeypatch.setattr(ai_context, "outline", lambda src: list(toc))


def _select(text, page=0, box=None):
    return {"text": text, "page": page, "box": box}


def test_selection_context_centers_on_the_selected_passage(monkeypatch):
    from gamma import ai_context

    pages = [f"(page {i}) " + f"filler{i} " * 30 for i in range(1, 8)]
    pages[2] = "(page 3)\n" + "filler3 filler3\n" * 150
    pages[3] = "(page 4) The index is defined as the ratio of the drive amplitudes."
    pages[4] = "(page 5) The modulation index was 0.7 at 1013 nm. " + "detail " * 30
    _fake_pdf(monkeypatch, pages)

    ctx, located = ai_context.selection_context(
        "u", "d" * 24, [_select("The modulation index was 0.7 at 1013 nm.")], 4000)
    assert "Start of the document (for grounding):" in ctx and "(page 1)" in ctx
    assert "Text around the selected passage (PDF page 5)" in ctx
    assert "modulation index was 0.7" in ctx
    # The window opens BEFORE the passage — here on the previous page, where
    # the quantity it names is defined.
    assert "defined as the ratio" in ctx and "[PDF page 3; continued]" in ctx
    assert located == [{"page": 5, "section": "", "found": True, "crop": False}]

    # Ligature/whitespace differences between the viewer and the extractor
    # don't break the locate — matching is on normalized text.
    ctx, _ = ai_context.selection_context("u", "d" * 24, [_select("modulation   index was 0.7")], 4000)
    assert "PDF page 5" in ctx

    # Several passages each get a window.
    ctx, located = ai_context.selection_context(
        "u", "d" * 24, [_select("filler2 filler2 filler2"), _select("The modulation index was 0.7")], 6000)
    assert "PDF page 2" in ctx and "PDF page 5" in ctx
    assert [w["page"] for w in located] == [2, 5]

    # Unlocatable selections (rewritten text, too short) with no page from
    # the viewer → no text, caller falls back to the head-of-document context.
    ctx, located = ai_context.selection_context("u", "d" * 24, [_select("not in the paper at all")], 4000)
    assert ctx is None and located[0]["page"] == 0
    assert ai_context.selection_context("u", "d" * 24, [_select("short")], 4000)[0] is None

    # ...but the viewer's page places a passage whose text isn't found (a
    # formula's glyph soup) — by its box, not found.
    ctx, located = ai_context.selection_context(
        "u", "d" * 24, [_select("∑ ψ̂ ⊗ 𝒪", page=6, box=(0.1, 0.5, 0.9, 0.6))], 4000)
    assert "PDF page 6" in ctx and located[0] == {"page": 6, "section": "", "found": False, "crop": False}


def test_selection_context_prefers_the_viewers_page(monkeypatch):
    from gamma import ai_context

    phrase = "we find that the fidelity is limited by scattering"
    pages = [f"intro {phrase}. " + "a " * 50, "middle " * 50, f"later {phrase}. " + "b " * 50]
    _fake_pdf(monkeypatch, pages)
    _, located = ai_context.selection_context("u", "d" * 24, [_select(phrase, page=3)], 4000)
    assert located[0]["page"] == 3
    _, located = ai_context.selection_context("u", "d" * 24, [_select(phrase)], 4000)
    assert located[0]["page"] == 1


def test_selection_context_finds_page_seam_matches(monkeypatch):
    from gamma import ai_context

    pages = ["intro " * 20 + "the qubit was measured non-",
             "destructively with high fidelity. " + "tail " * 20]
    _fake_pdf(monkeypatch, pages)
    ctx, located = ai_context.selection_context(
        "u", "d" * 24, [_select("the qubit was measured nondestructively with high")], 4000)
    assert ctx and "(PDF page 1)" in ctx and located[0]["page"] == 1


def test_selection_section_from_outline_and_headings(monkeypatch):
    from gamma import ai_context

    pages = ["A Paper Title\nAbstract\nWe study things.\n1 Introduction\nIntro text here.",
             "2 Methods\nWe trap atoms and image them for readout.\n2.1 Noise model\nThe noise is dephasing dominated."
             "\n2.2 Readout\nFluorescence is collected by a lens."]
    # The PDF's own outline wins: the path down to the passage, the lone
    # top-level entry (the document title) and figure bookmarks left out.
    toc = [(0, "A Paper Title", 1), (1, "Introduction", 1), (1, "Methods", 2),
           (2, "Noise model", 2), (2, "Readout", 2), (1, "Fig. 1 Setup", 2)]
    _fake_pdf(monkeypatch, pages, toc)
    ctx, located = ai_context.selection_context(
        "u", "d" * 24, [_select("The noise is dephasing dominated")], 4000)
    # ("readout" in the prose above the passage is not the Readout heading.)
    assert located[0]["section"] == "Methods › Noise model"
    assert 'section "Methods › Noise model"' in ctx
    _, located = ai_context.selection_context("u", "d" * 24, [_select("Intro text here")], 4000)
    assert located[0]["section"] == "Introduction"

    # No outline: the nearest heading-shaped line before the passage.
    _fake_pdf(monkeypatch, pages)
    _, located = ai_context.selection_context(
        "u", "d" * 24, [_select("Fluorescence is collected by a lens")], 4000)
    assert located[0]["section"] == "2.2 Readout"
    _, located = ai_context.selection_context("u", "d" * 24, [_select("We trap atoms")], 4000)
    assert located[0]["section"] == "2 Methods"


def test_heading_lines_skip_body_text_lookalikes():
    from gamma.ai_context import _heading_line

    for line in ("3.2 Attention", "II. EXPERIMENTAL SETUP", "A. Projection-operator formalism",
                 "Methods", "REFERENCES", "Appendix B: Imaging parameters"):
        assert _heading_line(line), line
    for line in ("852 nm", "5. Aharonov, D. & Ben-Or, M. Fault-tolerant quantum computation",
                 "1 Linear regression 8", "21 SEPTEMBER 2007", "3 high-power lasers",
                 "This is a sentence in the methods."):
        assert not _heading_line(line), line


def test_text_unreliable_flags_formulas_not_prose():
    from gamma.ai_context import text_unreliable

    assert not text_unreliable("The modulation index was 0.7 at 1013 nm, as shown in Fig. 2.")
    assert not text_unreliable("the Rabi frequency Ω was calibrated before each run of the experiment")
    assert text_unreliable("H = ∑ i ω i σ z i + g ( a † σ − + h . c . )")
    assert text_unreliable("x i j = y")
    assert text_unreliable(" = 3")
    assert text_unreliable("   ")


def test_request_selections_reads_both_shapes():
    from types import SimpleNamespace
    from gamma.ai_context import request_selections

    old = SimpleNamespace(selection="first passage\n\n---\n\nsecond passage", selections=[])
    assert [p["text"] for p in request_selections(old)] == ["first passage", "second passage"]
    assert all(p["page"] == 0 and p["box"] is None for p in request_selections(old))
    new = SimpleNamespace(selection="ignored", selections=[
        {"text": " a passage ", "page": 3, "box": [0.1, 0.2, 0.9, 0.3]},
        {"text": "bad box", "page": 2, "box": [0.5, 0.5, 0.4, 0.6]},
        {"text": "no page", "page": "7", "box": [0.1, 0.1, 0.2, 0.2]},
        {"text": ""}, "not a dict"])
    assert request_selections(new) == [
        {"text": "a passage", "page": 3, "box": (0.1, 0.2, 0.9, 0.3)},
        {"text": "bad box", "page": 2, "box": None},
        {"text": "no page", "page": 0, "box": None}]


def test_final_prompt_labels_passages():
    from types import SimpleNamespace
    from gamma.ai_context import final_prompt

    payload = SimpleNamespace(prompt="explain", selection="", note_passages=[],
                              selections=[{"text": "H = ∑ ω", "page": 4, "box": [0, 0, 1, 1]}])
    assert "Selected passage (PDF page 4):" in final_prompt(payload)
    text = final_prompt(payload, [{"page": 4, "section": "Methods › Noise", "found": False, "crop": True}])
    assert 'Selected passage (PDF page 4; section "Methods › Noise"; a picture' in text
    assert '"""\nH = ∑ ω\n"""' in text


def test_selection_crops_render_unreliable_regions(monkeypatch):
    from gamma import ai_context

    rendered = []

    def render(src, page_no, max_side, box=None):
        rendered.append((page_no, box))
        return (b"img", "image/png", 10, 10), 5

    monkeypatch.setattr(ai_context, "pdf_path", lambda u, d: "fake.pdf")
    monkeypatch.setattr(ai_context, "render_page", render)
    passages = [
        {"text": "plain prose that was found in the text", "page": 2, "box": (0.1, 0.1, 0.9, 0.2)},
        {"text": "H = ∑ ω σ", "page": 3, "box": (0.45, 0.5, 0.55, 0.52)},
        {"text": "text not in the extraction", "page": 4, "box": (0.1, 0.1, 0.9, 0.2)},
        {"text": "H = ∑ ω σ", "page": 0, "box": None},
    ]
    located = [{"page": p["page"], "section": "", "found": i != 2, "crop": False}
               for i, p in enumerate(passages)]
    images = ai_context.selection_crops("u", "d" * 24, passages, located)
    assert images == [("image/png", "aW1n"), ("image/png", "aW1n")]
    assert [w["crop"] for w in located] == [False, True, True, False]
    # A tiny box (one symbol) is grown to a readable strip of its line.
    page_no, (x0, y0, x1, y1) = rendered[0]
    assert page_no == 3 and x1 - x0 >= 0.3 and y1 - y0 >= 0.05

"""Pure-function units: DOI candidate extraction, BibTeX building, FTS query
quoting, image validation, PDF annotation extraction."""

import io

from gamma.routers.metadata import _find_doi_candidates, _build_bibtex
from gamma.routers.search import _fts_query
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
    assert _fts_query("atom imaging") == '"atom" "imaging"*'
    assert _fts_query('say "hi"') == '"say" """hi"""*'  # embedded quotes doubled
    assert _fts_query("  ") == ""


def test_parse_images_validates():
    good = "data:image/png;base64,iVBORw0KGgo="
    bad = ["data:text/html;base64,PGI+", "not a data url", good]
    parsed = _parse_images(bad)
    assert parsed == [("image/png", "iVBORw0KGgo=")]


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

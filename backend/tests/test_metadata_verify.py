"""Metadata lookup robustness: registry records found via the PDF *text* are
only trusted when their title actually appears in the text (the first DOI on
page 1 can belong to a cited paper), a Crossref bibliographic search rescues
publisher PDFs without a page-1 identifier, and AI-extracted output is
verified — fabricated identifiers are dropped instead of stored.
"""

from conftest import make_page

from gamma.routers import metadata
from gamma.routers.metadata import (
    _find_doi_candidates,
    _pick_crossref_match,
    _title_in_text,
    _verify_ai_meta,
    _years_compatible,
)

REAL_TITLE = "Emergence of room-temperature ferroelectricity at reduced dimensions"
PAGE_TEXT = (
    "SCIENCE | REPORTS\n"
    "FERROELECTRICITY\n"
    "Emergence of room-temperature ferroelec-\ntricity at reduced dimensions\n"
    "D. Lee, H. Lu, Y. Gu, S.-Y. Choi\n"
    "Building on earlier work [1] doi:10.1000/cited123 we study thin films.\n"
    "More text follows here. DOI: 10.1000/real456 is printed in the footer.\n"
)

REAL_META = {
    "title": REAL_TITLE, "authors": ["D. Lee", "H. Lu"], "year": "2015",
    "venue": "Science", "volume": "349", "pages": "1314-1317",
    "doi": "10.1000/real456", "arxiv_id": "", "source": "doi",
}
CITED_META = {
    "title": "Some Other Cited Paper About Films", "authors": ["A. Nother"],
    "year": "2011", "venue": "Journal B", "volume": "1", "pages": "1-4",
    "doi": "10.1000/cited123", "arxiv_id": "", "source": "doi",
}


def _paper_page(guest, text, monkeypatch, ai_enabled=False):
    page = make_page(guest, "paper.pdf", properties={"doc_id": "d" * 24})
    monkeypatch.setattr(metadata, "_pdf_excerpt", lambda u, d, limit: (text, None, len(text)))
    monkeypatch.setattr(metadata, "_ensure_indexed", lambda u, d: True)
    monkeypatch.setattr(metadata, "ai_runtime", lambda u: {"enabled": ai_enabled})
    return page


# --- pure helpers ------------------------------------------------------------

def test_doi_candidates_finds_every_doi_in_reading_order():
    cands = _find_doi_candidates("", PAGE_TEXT)
    assert cands.index("10.1000/cited123") < cands.index("10.1000/real456")


def test_title_in_text_survives_extraction_artifacts():
    # Line-break hyphenation, case, and punctuation drift don't break the match
    assert _title_in_text(REAL_TITLE, PAGE_TEXT)
    assert _title_in_text("EMERGENCE of Room-Temperature Ferroelectricity at reduced dimensions!", PAGE_TEXT)
    assert not _title_in_text("A Completely Different Paper Title", PAGE_TEXT)
    assert not _title_in_text("Errata", "Errata for volume 12")  # too short to be distinctive


def test_years_compatible():
    assert _years_compatible("2015", "2016")      # preprint/publication skew
    assert _years_compatible("", "2015")          # unknown year never rejects
    assert not _years_compatible("2015", "2019")


def test_pick_crossref_match_requires_strong_evidence():
    assert _pick_crossref_match([REAL_META], PAGE_TEXT) == REAL_META      # title in text
    assert _pick_crossref_match([CITED_META], PAGE_TEXT) is None          # title not in text
    ai_meta = {"title": REAL_TITLE, "year": "2015"}
    assert _pick_crossref_match([REAL_META], "", ai_meta) == REAL_META    # ≈identical AI title
    assert _pick_crossref_match([CITED_META], "", ai_meta) is None
    wrong_year = dict(REAL_META, year="2019")
    assert _pick_crossref_match([wrong_year], "", ai_meta) is None


# --- _verify_ai_meta ---------------------------------------------------------

def test_verify_drops_fabricated_identifiers(monkeypatch):
    monkeypatch.setattr(metadata, "_fetch_arxiv", lambda i: None)
    monkeypatch.setattr(metadata, "_fetch_doi", lambda d: (None, ""))
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    ai = {"title": "Ferroelectricity paper", "authors": ["X"], "year": "2015",
          "venue": "Science", "volume": "348", "pages": "1235-1239",
          "doi": "10.1126/science.fake999", "arxiv_id": "", "source": "ai"}
    meta, bib = _verify_ai_meta(ai, "text without that doi", "")
    assert meta["doi"] == ""      # resolves nowhere, not in the PDF → dropped
    assert meta["source"] == "ai"


def test_verify_keeps_unresolvable_doi_that_is_in_the_pdf(monkeypatch):
    # doi.org may just be down — a DOI that literally occurs in the text stays
    monkeypatch.setattr(metadata, "_fetch_doi", lambda d: (None, ""))
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    ai = {"title": "T " * 10, "authors": [], "year": "", "venue": "", "volume": "",
          "pages": "", "doi": "10.1000/real456", "arxiv_id": "", "source": "ai"}
    meta, _ = _verify_ai_meta(ai, PAGE_TEXT, "")
    assert meta["doi"] == "10.1000/real456"


def test_verify_upgrades_via_resolvable_doi(monkeypatch):
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (REAL_META, "@article{x}") if d == "10.1000/real456" else (None, ""))
    ai = {"title": "Wrong Title", "authors": ["Wrong Author"], "year": "2013",
          "venue": "", "volume": "", "pages": "", "doi": "10.1000/real456",
          "arxiv_id": "", "source": "ai"}
    meta, bib = _verify_ai_meta(ai, "", "")
    assert meta == REAL_META and bib == "@article{x}"


def test_verify_upgrades_via_crossref_title_search(monkeypatch):
    monkeypatch.setattr(metadata, "_fetch_arxiv", lambda i: None)
    monkeypatch.setattr(metadata, "_fetch_doi", lambda d: (None, ""))
    crossref_hit = dict(REAL_META, source="crossref")
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [crossref_hit])
    ai = {"title": REAL_TITLE, "authors": ["D Lee"], "year": "2015", "venue": "",
          "volume": "", "pages": "", "doi": "", "arxiv_id": "", "source": "ai"}
    meta, _ = _verify_ai_meta(ai, "", "")
    assert meta["source"] == "crossref" and meta["doi"] == "10.1000/real456"


def test_ai_extract_reports_document_kind(monkeypatch):
    monkeypatch.setattr(metadata, "_resolve_model", lambda rt, m: "m")
    monkeypatch.setattr(metadata, "_call_ai",
                        lambda *a, **kw: '{"title": "QM Lecture 5", "kind": "notes"}')
    assert metadata._ai_extract_meta("text", "", "", {"enabled": True})["kind"] == "notes"
    # Unknown kinds fall back to "paper" — the safe (warned) default
    monkeypatch.setattr(metadata, "_call_ai",
                        lambda *a, **kw: '{"title": "T", "kind": "mixtape"}')
    assert metadata._ai_extract_meta("text", "", "", {"enabled": True})["kind"] == "paper"


def test_course_notes_keep_their_kind(guest, monkeypatch):
    """A DOI-less lecture-notes PDF: the AI classifies it as notes; the record
    stays source "ai" with kind "notes" (the UI shows no red warning for it)
    and the status endpoint reports the kind."""
    page = _paper_page(guest, "Lecture 5: perturbation theory. Problem set due Friday.",
                       monkeypatch, ai_enabled=True)
    monkeypatch.setattr(metadata, "_resolve_model", lambda rt, m: "m")
    monkeypatch.setattr(metadata, "_call_ai",
                        lambda *a, **kw: '{"title": "Lecture 5: perturbation theory", '
                                         '"authors": ["Prof X"], "kind": "notes"}')
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    monkeypatch.setattr(metadata, "_fetch_doi", lambda d: (None, ""))
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "ai"
    assert r.json()["meta"]["kind"] == "notes"
    st = guest.get("/api/metadata/status").json()["papers"]
    entry = next(p for p in st if p["id"] == page["id"])
    assert entry["meta_source"] == "ai" and entry["meta_kind"] == "notes"


# --- the full fetch chain ----------------------------------------------------

def test_cited_doi_on_page_one_is_not_trusted(guest, monkeypatch):
    """The first DOI in the text belongs to a citation; the paper's own DOI is
    further down. The candidate whose registrar title appears in the text wins."""
    page = _paper_page(guest, PAGE_TEXT, monkeypatch)
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: {"10.1000/cited123": (CITED_META, "@article{cited}"),
                                   "10.1000/real456": (REAL_META, "@article{real}")}.get(d, (None, "")))
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["doi"] == "10.1000/real456"


def test_unconfirmed_doi_still_beats_nothing(guest, monkeypatch):
    """Only a cited paper's DOI resolves and nothing confirms — the resolved
    record is still kept (old fallback behavior) rather than failing."""
    text = "An intro citing earlier work doi:10.1000/cited123 and nothing else."
    page = _paper_page(guest, text, monkeypatch)
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (CITED_META, "@x") if d == "10.1000/cited123" else (None, ""))
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["title"] == CITED_META["title"]


def test_crossref_head_search_rescues_paper_without_identifiers(guest, monkeypatch):
    """Publisher PDF with no DOI/arXiv id in the head: the Crossref
    bibliographic search on the text head finds the record, accepted because
    its exact title is in the PDF — no AI involved."""
    text = PAGE_TEXT.replace("doi:10.1000/cited123", "").replace("DOI: 10.1000/real456", "")
    page = _paper_page(guest, text, monkeypatch)
    queries = []

    def fake_search(q, rows=5):
        queries.append(q)
        return [dict(REAL_META, source="crossref")]
    monkeypatch.setattr(metadata, "_crossref_search", fake_search)
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (REAL_META, "@article{real}") if d == "10.1000/real456" else (None, ""))
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["title"] == REAL_TITLE
    assert body["source"] == "doi"
    assert queries and "emergence of room temperature" in queries[0]


def test_arxiv_id_from_text_needs_title_match(guest, monkeypatch):
    """An arXiv id found in the *text* whose record title isn't in the PDF is
    not trusted outright — a text-confirmed DOI further down wins."""
    text = ("See also arXiv:2601.99999 for related work.\n" + PAGE_TEXT)
    page = _paper_page(guest, text, monkeypatch)
    other = {"title": "A Related But Different Preprint Entirely", "authors": ["Z"],
             "year": "2026", "venue": "arXiv:2601.99999", "volume": "", "pages": "",
             "doi": "", "arxiv_id": "2601.99999", "source": "arxiv"}
    monkeypatch.setattr(metadata, "_fetch_arxiv", lambda i: other)
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (REAL_META, "@article{real}") if d == "10.1000/real456" else (None, ""))
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["title"] == REAL_TITLE


ZENO_TITLE = "Deterministic generation of multiparticle entanglement by quantum Zeno dynamics"
ZENO_META = {
    "title": ZENO_TITLE, "authors": ["Giovanni Barontini", "Jakob Reichel"],
    "year": "2015", "venue": "Science", "volume": "349", "pages": "1317-1321",
    "doi": "10.1000/zeno754", "arxiv_id": "", "source": "doi",
}


def test_issue_clipped_pdf_finds_trailer_doi(guest, monkeypatch):
    """The real-world Science failure: page 1 is the *previous* article's tail
    (its trailer DOI included), this paper's title sits deep in the head, and
    its own DOI is printed only in the end-of-article trailer on the last
    page. The last-page scan + title confirmation must find the right record."""
    head = ("references of the previous article " * 150
            + " 10.1000/cited123 end of previous article trailer\n"
            + "QUANTUM OPTICS\nDeterministic generation of\nmultiparticle "
            + "entanglement by\nquantum Zeno dynamics\nGiovanni Barontini\n"
            + "abstract and body text " * 100)
    tail = "last page text, article ends here. 10.1000/zeno754 more trailer."
    page = make_page(guest, "paper.pdf", properties={"doc_id": "d" * 24})

    def fake_excerpt(u, d, limit, offset=0, start_page=1, with_pages=False):
        if start_page > 1:
            return (tail, None, len(tail))
        return (head, len(head), len(head))  # truncated: more pages follow
    monkeypatch.setattr(metadata, "_pdf_excerpt", fake_excerpt)
    monkeypatch.setattr(metadata, "_pdf_path", lambda u, d: "fake.pdf")
    monkeypatch.setattr(metadata, "_page_count", lambda p: 6)
    monkeypatch.setattr(metadata, "_ensure_indexed", lambda u, d: True)
    monkeypatch.setattr(metadata, "ai_runtime", lambda u: {"enabled": False})
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: {"10.1000/cited123": (CITED_META, "@article{cited}"),
                                   "10.1000/zeno754": (ZENO_META, "@article{zeno}")}.get(d, (None, "")))
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["doi"] == "10.1000/zeno754"
    assert r.json()["meta"]["title"] == ZENO_TITLE


def test_page_title_feeds_crossref_query(guest, monkeypatch):
    """A page titled with the paper name (renamed by hand, or a title-like
    filename) becomes the first Crossref query when no identifier confirms."""
    text = "junk from another article " * 80 + ZENO_TITLE + " abstract follows " * 50
    page = make_page(guest, ZENO_TITLE, properties={"doc_id": "d" * 24})
    monkeypatch.setattr(metadata, "_pdf_excerpt", lambda u, d, limit: (text, None, len(text)))
    monkeypatch.setattr(metadata, "_ensure_indexed", lambda u, d: True)
    monkeypatch.setattr(metadata, "ai_runtime", lambda u: {"enabled": False})
    queries = []

    def fake_search(q, rows=5):
        queries.append(q)
        return [dict(ZENO_META, source="crossref")] if q == ZENO_TITLE else []
    monkeypatch.setattr(metadata, "_crossref_search", fake_search)
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (ZENO_META, "@article{zeno}") if d == "10.1000/zeno754" else (None, ""))
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert queries[0] == ZENO_TITLE
    assert r.json()["meta"]["doi"] == "10.1000/zeno754"


def test_title_match_reaches_past_6000_chars():
    """Titles that start beyond the old 6000-char window still confirm."""
    text = "x " * 3500 + ZENO_TITLE + " and then the abstract."
    assert _title_in_text(ZENO_TITLE, text)


def test_detector_doi_hint_is_trusted(guest, monkeypatch):
    """The extension's /api/clip forwards the DOI it read off the publisher
    page's meta tags — trusted like a URL-derived id, no title match needed
    (the text here contains neither the DOI nor the title)."""
    page = _paper_page(guest, "scanned garbage with no identifiers at all", monkeypatch)
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (ZENO_META, "@article{zeno}") if d == "10.1000/zeno754" else (None, ""))
    out = metadata.fetch_page_metadata("guest", page["id"], doi="10.1000/zeno754")
    assert out["meta"]["title"] == ZENO_TITLE
    assert out["source"] == "doi"


def test_web_url_supplies_trusted_doi(guest, monkeypatch):
    """The publisher page a clip came from (web_url) is scanned for
    identifiers too, with URL-level trust."""
    page = make_page(guest, "p", properties={
        "doc_id": "d" * 24, "web_url": "https://doi.org/10.1000/zeno754"})
    monkeypatch.setattr(metadata, "_pdf_excerpt",
                        lambda u, d, limit: ("no identifiers here", None, 19))
    monkeypatch.setattr(metadata, "_ensure_indexed", lambda u, d: True)
    monkeypatch.setattr(metadata, "ai_runtime", lambda u: {"enabled": False})
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (ZENO_META, "@article{zeno}") if d == "10.1000/zeno754" else (None, ""))
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["doi"] == "10.1000/zeno754"


def test_arxiv_id_from_source_url_is_trusted(guest, monkeypatch):
    """URL-derived ids stay authoritative even when the text is garbage (a
    scanned PDF must not lose its arXiv record to a failed title match)."""
    page = make_page(guest, "paper", properties={
        "source_url": "https://arxiv.org/abs/2601.00001"})
    meta = {"title": "Scanned Preprint", "authors": ["A"], "year": "2026",
            "venue": "arXiv:2601.00001", "volume": "", "pages": "", "doi": "",
            "arxiv_id": "2601.00001", "source": "arxiv"}
    monkeypatch.setattr(metadata, "_fetch_arxiv", lambda i: meta)
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "arxiv"

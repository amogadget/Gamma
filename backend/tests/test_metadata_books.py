"""Books and provenance: ISBNs printed in the PDF resolve through the book
registries, an AI-read book title/author is confirmed against them, every
stored record carries ``meta.unverified``, and the slide citation is generated
together with the metadata instead of on first share.
"""

from conftest import make_page
from test_metadata_verify import CITED_META, _paper_page

from gamma.routers import metadata
from gamma.routers.metadata import (
    _build_bibtex,
    _find_isbns,
    _isbn_valid,
    _pick_book_match,
    _record_in_text,
)

BOOK_TEXT = (
    "L A S E R S\n\nAnthony E. Siegman\nProfessor of Electrical Engineering\n"
    "Stanford University\n\nUniversity Science Books\n"
    "Copyright 1986 by University Science Books\n"
    "ISBN 0-935702-11-3\nPrinted in the United States of America\n"
)

OL_HIT = {
    "title": "Lasers", "authors": ["Anthony E. Siegman"], "year": "1986",
    "venue": "", "volume": "", "pages": "", "doi": "", "arxiv_id": "",
    "publisher": "University Science Books", "isbn": "",
    "isbns": ["0935702113", "9780935702118"], "years": ["1986", "1990"],
    "kind": "book", "source": "openlibrary",
}
OTHER_BOOK = dict(OL_HIT, title="Laser Physics", authors=["Peter W. Milonni"], isbns=[], years=["2010"])


# --- pure helpers ------------------------------------------------------------

def test_isbn_checksums():
    assert _isbn_valid("0935702113")        # ISBN-10 (Siegman, Lasers)
    assert _isbn_valid("9780935702118")     # its ISBN-13
    assert _isbn_valid("080442957X")        # X check digit
    assert not _isbn_valid("0935702114")
    assert not _isbn_valid("12345")


def test_find_isbns_only_labelled_and_valid():
    assert _find_isbns(BOOK_TEXT) == ["0935702113"]
    # Hyphen/space styles, ISBN-13 label, glued trailing number (extraction
    # artifact) — and an unlabelled digit run is not an ISBN
    assert _find_isbns("ISBN-13: 978 0 935702 11 8 1986 printing") == ["9780935702118"]
    assert _find_isbns("ISBN 0-935702-11-3\n1986") == ["0935702113"]
    assert _find_isbns("call 0935702113 today") == []
    assert _find_isbns("ISBN 0-935702-11-4") == []  # bad checksum


def test_record_in_text_accepts_short_title_with_author():
    assert _record_in_text(OL_HIT, BOOK_TEXT)                 # letter-spaced "L A S E R S" + "siegman"
    assert _record_in_text(OL_HIT, "This book on lasers, by A. E. Siegman, covers…")
    assert not _record_in_text(OTHER_BOOK, BOOK_TEXT)         # no "laser physics"
    assert not _record_in_text(dict(OL_HIT, authors=["X Y"]), BOOK_TEXT)  # title alone isn't enough


def test_pick_book_match_needs_title_and_author_agreement():
    ai = {"title": "Lasers", "authors": ["A. E. Siegman"], "year": "1986"}
    rec = _pick_book_match([OTHER_BOOK, OL_HIT], "", ai_meta=ai)
    assert rec["title"] == "Lasers" and rec["publisher"] == "University Science Books"
    assert "isbns" not in rec and "years" not in rec
    assert rec["isbn"] == ""  # no ISBN printed in the (empty) text → none adopted
    # An edition ISBN is adopted only when the PDF prints it; the AI-read
    # year (the edition in hand) wins over the registry's first-publish year
    rec = _pick_book_match([OL_HIT], BOOK_TEXT, ai_meta=dict(ai, year="1990"))
    assert rec["isbn"] == "0935702113" and rec["year"] == "1990"
    # Same title, different author → no match
    assert _pick_book_match([OL_HIT], "", ai_meta=dict(ai, authors=["Milonni"])) is None
    # Without AI, the text has to carry title + author
    assert _pick_book_match([OTHER_BOOK, OL_HIT], BOOK_TEXT)["title"] == "Lasers"
    assert _pick_book_match([OTHER_BOOK], BOOK_TEXT) is None


def test_book_bibtex():
    bib = _build_bibtex(dict(OL_HIT, isbn="0935702113"))
    assert bib.startswith("@book{siegman1986,")
    assert "publisher = {University Science Books}" in bib and "isbn = {0935702113}" in bib
    assert "journal" not in bib


# --- the fetch chain ---------------------------------------------------------

def test_isbn_in_pdf_resolves_a_book(guest, monkeypatch):
    page = _paper_page(guest, BOOK_TEXT, monkeypatch)
    looked_up = []

    def fake_isbn(isbn):
        looked_up.append(isbn)
        rec = {k: v for k, v in OL_HIT.items() if k not in ("isbns", "years")}
        return dict(rec, isbn=isbn, source="isbn")
    monkeypatch.setattr(metadata, "_fetch_isbn", fake_isbn)
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert looked_up == ["0935702113"]
    assert body["source"] == "isbn" and body["meta"]["kind"] == "book"
    assert body["meta"]["unverified"] is False       # title + author are in the text
    assert body["bibtex"].startswith("@book{")
    assert body["ppt_cite"] == ""                    # AI off → no citation, no error


def test_isbn_of_another_book_is_only_a_fallback(guest, monkeypatch):
    # The ISBN resolves to a book whose title isn't in this text (a cited
    # work, or a wrong hit) — kept, but flagged
    text = "A reader citing ref. [12], ISBN 0-935702-11-3, in passing."
    page = _paper_page(guest, text, monkeypatch)
    monkeypatch.setattr(metadata, "_fetch_isbn",
                        lambda i: {k: v for k, v in OTHER_BOOK.items() if k not in ("isbns", "years")})
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["title"] == "Laser Physics"
    assert r.json()["meta"]["unverified"] is True


def test_ai_read_book_is_confirmed_by_the_registries(guest, monkeypatch):
    """An old textbook with no ISBN: the AI reads title + author, the book
    search confirms them, and the stored record is the registry's."""
    text = BOOK_TEXT.replace("ISBN 0-935702-11-3\n", "")
    page = _paper_page(guest, text, monkeypatch, ai_enabled=True)
    monkeypatch.setattr(metadata, "_resolve_model", lambda rt, m: "m")
    calls = []

    def fake_ai(messages, system, model, rt, **kw):
        calls.append(system)
        if "Siegman, _Lasers_" in system:  # the citation prompt (its book example)
            return "Siegman, _Lasers_ (University Science Books, 1986)"
        return ('{"title": "Lasers", "authors": ["Anthony E. Siegman"], "year": "1986", '
                '"publisher": "University Science Books", "kind": "book"}')
    monkeypatch.setattr(metadata, "_call_ai", fake_ai)
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    searched = []

    def fake_search(title, author=""):
        searched.append((title, author))
        return [dict(OTHER_BOOK), dict(OL_HIT)]
    monkeypatch.setattr(metadata, "_book_search", fake_search)
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert searched == [("Lasers", "Anthony E. Siegman")]
    assert body["source"] == "openlibrary"
    assert body["meta"]["unverified"] is False
    assert body["meta"]["publisher"] == "University Science Books"
    assert body["bibtex"].startswith("@book{siegman1986")
    # The slide citation came with the fetch and is cached on the page
    assert body["ppt_cite"] == "Siegman, _Lasers_ (University Science Books, 1986)"
    assert len(calls) == 2
    r = guest.post("/api/metadata/cite", json={"block_id": page["id"]})
    assert r.json() == {"citation": body["ppt_cite"], "cached": True}
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.json()["cached"] and r.json()["ppt_cite"] == body["ppt_cite"]


def test_unconfirmed_ai_paper_is_flagged_but_notes_are_not(guest, monkeypatch):
    page = _paper_page(guest, "Some lecture text about lasers.", monkeypatch, ai_enabled=True)
    monkeypatch.setattr(metadata, "_resolve_model", lambda rt, m: "m")
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    monkeypatch.setattr(metadata, "_book_search", lambda t, a="": [])
    monkeypatch.setattr(metadata, "_call_ai",
                        lambda *a, **kw: '{"title": "A Study Of Lasers In Cavities", "authors": ["Q"], "kind": "paper"}')
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.json()["meta"]["unverified"] is True
    monkeypatch.setattr(metadata, "_call_ai",
                        lambda *a, **kw: '{"title": "Lecture 5: Lasers", "authors": ["Q"], "kind": "notes"}')
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"], "force": True})
    assert r.json()["meta"]["kind"] == "notes" and r.json()["meta"]["unverified"] is False


def test_unconfirmed_doi_fallback_is_flagged(guest, monkeypatch):
    text = "An intro citing earlier work doi:10.1000/cited123 and nothing else."
    page = _paper_page(guest, text, monkeypatch)
    monkeypatch.setattr(metadata, "_fetch_doi",
                        lambda d: (dict(CITED_META), "@x") if d == "10.1000/cited123" else (None, ""))
    monkeypatch.setattr(metadata, "_crossref_search", lambda q, rows=5: [])
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["unverified"] is True
    # …and the library status table sees the flag
    status = guest.get("/api/metadata/status").json()["papers"]
    row = next(p for p in status if p["id"] == page["id"])
    assert row["meta_source"] == "doi" and row["meta_unverified"] is True


def test_hand_edit_keeps_book_kind_and_clears_the_flag(guest):
    page = make_page(guest, "Lasers", properties={
        "meta": dict(OL_HIT, isbn="0935702113", unverified=True), "bibtex": "@book{x}"})
    r = guest.post("/api/metadata/update", json={"block_id": page["id"], "meta": {
        "title": "Lasers", "authors": "Anthony E. Siegman", "year": "1986",
        "publisher": "University Science Books", "isbn": "0-935702-11-3"}})
    assert r.status_code == 200, r.text
    meta = r.json()["meta"]
    assert meta["kind"] == "book" and meta["isbn"] == "0935702113" and "unverified" not in meta
    assert r.json()["bibtex"].startswith("@book{siegman1986")
    row = next(p for p in guest.get("/api/metadata/status").json()["papers"] if p["id"] == page["id"])
    assert row["meta_unverified"] is None  # client falls back to the source rule → manual, not flagged

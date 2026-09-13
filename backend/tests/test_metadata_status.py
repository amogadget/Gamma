"""GET /api/metadata/status — the Settings pane's library-wide health list."""

import sqlite3

from conftest import make_page, workspace_of
from gamma.db import ws_db_path
from gamma.textnorm import INDEX_VERSION


def _paper(r, block_id):
    return next(p for p in r.json()["papers"] if p["id"] == block_id)


def test_status_lists_papers_not_notes(guest):
    with_meta = make_page(guest, "Has meta", properties={
        "doc_id": "a" * 24,
        "meta": {"title": "Proper Title", "source": "arxiv"},
    })
    failed = make_page(guest, "Lookup failed", properties={
        "source_url": "https://example.org/x.pdf",
        "meta_error": {"at": "2026-01-01T00:00:00Z", "detail": "no arXiv id, DOI, or AI match"},
    })
    note = make_page(guest, "Plain note page")
    cited = make_page(guest, "Notes on a paper I don't own", properties={
        "meta": {"title": "Remote Paper", "doi": "10.1/remote"},
    })

    r = guest.get("/api/metadata/status")
    assert r.status_code == 200
    ids = [p["id"] for p in r.json()["papers"]]
    assert with_meta["id"] in ids and failed["id"] in ids
    assert note["id"] not in ids
    # metadata without an attachment still lists (it can cite), with no file
    assert cited["id"] in ids
    p3 = _paper(r, cited["id"])
    assert p3["has_file"] is False and p3["doc_id"] == "" and p3["has_meta"] is True
    assert p3["title"] == "Remote Paper" and p3["text_chars"] is None

    p1 = _paper(r, with_meta["id"])
    assert p1["has_meta"] is True
    assert p1["meta_source"] == "arxiv"
    assert p1["title"] == "Proper Title"  # metadata title wins over block content
    assert p1["text_chars"] is None       # never indexed → unknown

    p2 = _paper(r, failed["id"])
    assert p2["has_meta"] is False
    assert "no arXiv id" in p2["meta_error"]


def test_status_reads_index_state(guest):
    doc = "b" * 24
    page = make_page(guest, "Indexed paper", properties={"doc_id": doc})
    with sqlite3.connect(ws_db_path(workspace_of("guest"), "data.db")) as conn:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS pdf_fts USING fts5(doc_id UNINDEXED, page UNINDEXED, content)")
        conn.execute("CREATE TABLE IF NOT EXISTS pdf_fts_docs (doc_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, pages INTEGER, ver INTEGER NOT NULL DEFAULT 0)")
        conn.execute("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, 1, ?)", (doc, "hello " * 20))
        conn.execute("INSERT INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) VALUES (?, 'now', 1, ?)", (doc, INDEX_VERSION))
        conn.commit()

    r = guest.get("/api/metadata/status")
    p = _paper(r, page["id"])
    assert p["indexed"] is True
    assert p["index_stale"] is False
    assert p["text_chars"] == len("hello " * 20)

    # Bumped extraction version → the doc reads as stale, not indexed.
    with sqlite3.connect(ws_db_path(workspace_of("guest"), "data.db")) as conn:
        conn.execute("UPDATE pdf_fts_docs SET ver = ver - 1 WHERE doc_id = ?", (doc,))
        conn.commit()
    r = guest.get("/api/metadata/status")
    p = _paper(r, page["id"])
    assert p["indexed"] is False
    assert p["index_stale"] is True

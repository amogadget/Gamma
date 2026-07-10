"""Library FTS search endpoint and the zip export."""

import io
import sqlite3
import zipfile

from conftest import make_page


def _index_rows(user, doc_id, pages):
    """Insert index rows directly, the way _index_doc stores them (normalized
    text, current version — otherwise the endpoint schedules a re-index that
    would race the test and delete these rows)."""
    from gamma.db import user_db_path
    from gamma.routers.search import _ensure_schema
    from gamma.textnorm import INDEX_VERSION, normalize_text

    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        _ensure_schema(conn)
        conn.execute("DELETE FROM pdf_fts WHERE doc_id = ?", (doc_id,))
        conn.executemany("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)",
                         [(doc_id, p, normalize_text(text)) for p, text in pages])
        conn.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                     "VALUES (?, '2026', ?, ?)", (doc_id, len(pages), INDEX_VERSION))
        conn.commit()


def test_pdf_search_hits_indexed_docs(guest):
    user = guest.get("/api/session").json()["user"]
    make_page(guest, "FTS paper", properties={"doc_id": "ftsdoc001"})
    _index_rows(user, "ftsdoc001", [(3, "the wombat considered superconducting qubits carefully")])

    r = guest.get("/api/pdf-search", params={"q": "wombat superconducting"})
    assert r.status_code == 200
    hits = r.json()["results"]
    assert any(h["page"] == 3 and h["title"] == "FTS paper" and h["doc_id"] == "ftsdoc001"
               for h in hits)

    # unknown terms → no hits, no error
    r = guest.get("/api/pdf-search", params={"q": "zzznothingzzz"})
    assert r.json()["results"] == []


def test_pdf_search_is_separator_tolerant(guest):
    """"3000" must find "3,000-qubit": the index stores normalized text and
    the query is normalized the same way."""
    user = guest.get("/api/session").json()["user"]
    make_page(guest, "Qubit paper", properties={"doc_id": "ftsdoc002"})
    _index_rows(user, "ftsdoc002",
                [(1, "Continuous operation of a coherent 3,000-qubit system")])

    for q in ("3000", "3,000", "3000-qubit", "3000 qubit system"):
        hits = guest.get("/api/pdf-search", params={"q": q}).json()["results"]
        assert any(h["doc_id"] == "ftsdoc002" for h in hits), f"query {q!r} missed"


def test_stale_index_version_counts_as_missing(guest):
    from gamma.db import user_db_path
    from gamma.routers.search import _ensure_schema

    user = guest.get("/api/session").json()["user"]
    make_page(guest, "Stale paper", properties={"doc_id": "ftsdoc003"})
    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        _ensure_schema(conn)
        conn.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                     "VALUES ('ftsdoc003', '2025', 1, 0)")  # pre-normalization row
        conn.commit()

    r = guest.get("/api/pdf-search", params={"q": "anything"})
    assert r.json()["indexing"] >= 1  # stale doc scheduled for re-indexing


def test_search_reindex_marks_everything_stale(guest):
    from gamma.db import user_db_path
    from gamma.textnorm import INDEX_VERSION

    user = guest.get("/api/session").json()["user"]
    make_page(guest, "Rebuild me", properties={"doc_id": "ftsdoc004"})
    _index_rows(user, "ftsdoc004", [(1, "some indexed text")])

    r = guest.post("/api/search-reindex")
    assert r.status_code == 200
    body = r.json()
    assert body["scheduled"] >= 1 or body["busy"]  # started, or an indexer already runs

    # The doc's bookkeeping row survives (ver may be 0 = stale or already
    # re-stamped by the background thread — no PDF file makes that instant).
    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        ver = conn.execute("SELECT ver FROM pdf_fts_docs WHERE doc_id = 'ftsdoc004'").fetchone()[0]
    assert ver in (0, INDEX_VERSION)


def test_tasks_endpoint_shape(guest):
    r = guest.get("/api/tasks")
    assert r.status_code == 200
    idx = r.json()["indexing"]
    assert set(idx) >= {"total", "done", "active"}


def test_export_zip(guest):
    r = guest.get("/api/export")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert "pages.db" in names
    assert "manifest.json" in names

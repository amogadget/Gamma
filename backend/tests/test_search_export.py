"""Library FTS search endpoint and the zip export."""

import io
import sqlite3
import zipfile

from conftest import make_page


def test_pdf_search_hits_indexed_docs(guest):
    from gamma.db import user_db_path
    from gamma.routers.search import _ensure_schema

    user = guest.get("/api/session").json()["user"]
    make_page(guest, "FTS paper", properties={"doc_id": "ftsdoc001"})
    # Index rows directly (extraction itself is covered by unit tests)
    with sqlite3.connect(user_db_path(user, "data.db")) as conn:
        _ensure_schema(conn)
        conn.execute("DELETE FROM pdf_fts WHERE doc_id = 'ftsdoc001'")
        conn.execute("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)",
                     ("ftsdoc001", 3, "the wombat considered superconducting qubits carefully"))
        conn.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages) VALUES (?, '2026', 1)",
                     ("ftsdoc001",))
        conn.commit()

    r = guest.get("/api/pdf-search", params={"q": "wombat superconducting"})
    assert r.status_code == 200
    hits = r.json()["results"]
    assert any(h["page"] == 3 and h["title"] == "FTS paper" for h in hits)

    # unknown terms → no hits, no error
    r = guest.get("/api/pdf-search", params={"q": "zzznothingzzz"})
    assert r.json()["results"] == []


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

"""GET /api/search — one query over the notes index (block_fts, gamma/
block_index.py) and the PDF index (pdf_fts): result shape, ordering, folder
scope, and the lazy per-page rebuild that follows every kind of block write."""

import sqlite3

from conftest import login, make_page, make_user, workspace_of
from gamma.db import ws_db_path
from gamma.textnorm import INDEX_VERSION, normalize_text


def _index_pdf(user, doc_id, pages):
    from gamma.pdf_index import ensure_schema

    with sqlite3.connect(ws_db_path(workspace_of(user), "data.db")) as conn:
        ensure_schema(conn)
        conn.execute("DELETE FROM pdf_fts WHERE doc_id = ?", (doc_id,))
        conn.executemany("INSERT INTO pdf_fts (doc_id, page, content) VALUES (?, ?, ?)",
                         [(doc_id, p, normalize_text(text)) for p, text in pages])
        conn.execute("INSERT OR REPLACE INTO pdf_fts_docs (doc_id, indexed_at, pages, ver) "
                     "VALUES (?, '2026', ?, ?)", (doc_id, len(pages), INDEX_VERSION))
        conn.commit()


def _block(c, parent, content, props=None):
    r = c.post("/api/blocks", json={"parent_id": parent, "content": content, "properties": props or {}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _search(c, q, **params):
    r = c.get("/api/search", params={"q": q, **params})
    assert r.status_code == 200, r.text
    return r.json()


def _meta(user, page_id):
    with sqlite3.connect(ws_db_path(workspace_of(user), "data.db")) as conn:
        return conn.execute("SELECT updated_at, ver FROM block_fts_meta WHERE page_id = ?",
                            (page_id,)).fetchone()


def test_search_mixes_notes_and_pdf_hits():
    make_user("searcher", "pw")
    c = login("searcher", "pw")
    paper = make_page(c, "Wombat paper", properties={"doc_id": "srchdoc001", "folder": "zoo"})
    _index_pdf("searcher", "srchdoc001", [(4, "the wombat considered superconducting qubits")])
    notes = make_page(c, "Field notes", properties={"folder": "zoo/trips"})
    top = _block(c, notes["id"], "saw a wombat at dusk")
    nested = _block(c, top, "the wombat was digging")
    hl = _block(c, paper["id"], "wombat highlight note",
                {"highlight_id": "h1", "quote": "unrelated quoted passage"})

    body = _search(c, "wombat")
    assert body["indexing"] == 0
    results = body["results"]
    sources = [r["source"] for r in results]
    assert sources == ["notes"] * 3 + ["pdf"]  # notes first, then PDF text
    by_block = {r["block_id"]: r for r in results if r["source"] == "notes"}
    assert set(by_block) == {top, nested, hl}  # highlights are notes too
    assert by_block[nested]["page_id"] == notes["id"] and by_block[nested]["title"] == "Field notes"
    assert "wombat" in by_block[nested]["snippet"]
    assert by_block[hl]["page_id"] == paper["id"] and "unrelated" not in by_block[hl]["snippet"]
    assert set(by_block[top]) == {"source", "block_id", "page_id", "title", "snippet"}
    pdf = results[-1]
    assert pdf == {"source": "pdf", "block_id": paper["id"], "page_id": paper["id"],
                   "doc_id": "srchdoc001", "title": "Wombat paper", "page": 4,
                   "snippet": pdf["snippet"]}
    assert "superconducting" in pdf["snippet"]
    # Page titles are not part of the notes index (root blocks are not indexed).
    assert all(r["block_id"] != notes["id"] for r in _search(c, "field")["results"])

    # Normalization: the query goes through the same rules as the index.
    _block(c, notes["id"], "a coherent 3,000-qubit system")
    assert any(r["source"] == "notes" for r in _search(c, "3000 qubit")["results"])

    # limit caps each source separately.
    body = _search(c, "wombat", limit=1)
    assert [r["source"] for r in body["results"]] == ["notes", "pdf"]

    # Empty / malformed queries are empty results, never errors.
    assert _search(c, "")["results"] == []
    assert _search(c, '"')["results"] == []


def test_search_folder_scope():
    c = login("searcher", "pw")
    all_hits = _search(c, "wombat")["results"]
    assert {r["source"] for r in all_hits} == {"notes", "pdf"}
    trips = _search(c, "wombat", scope="zoo/trips")["results"]
    assert trips and all(r["title"] == "Field notes" for r in trips)
    zoo = _search(c, "wombat", scope="zoo")["results"]  # a folder includes its subfolders
    assert {r["title"] for r in zoo} == {"Field notes", "Wombat paper"}
    assert _search(c, "wombat", scope="elsewhere")["results"] == []


def test_dirty_page_reindex_follows_every_write():
    """Each block writer leaves the page stale for the next search — edits,
    creates, deletes, subtree replacement, cross-page moves, and the page
    root's own updated_at (the editor's autosave) — and only that page is
    rebuilt."""
    c = login("searcher", "pw")
    page = make_page(c, "Dirty page")
    other = make_page(c, "Other page")
    a = _block(c, page["id"], "alpha lorem")
    b = _block(c, other["id"], "beta lorem")
    assert {r["block_id"] for r in _search(c, "lorem")["results"]} == {a, b}
    stamp_other = _meta("searcher", other["id"])
    assert stamp_other and stamp_other[1] == INDEX_VERSION

    # PUT /blocks/{id}: the old text is gone, the new one found.
    assert c.put(f"/api/blocks/{a}", json={"content": "gamma ipsum"}).status_code == 200
    # Stale, not yet rebuilt: the op stamped the page root past the fingerprint.
    assert _meta("searcher", page["id"])[0] != c.get(f"/api/blocks/{page['id']}").json()["updated_at"]
    assert [r["block_id"] for r in _search(c, "gamma ipsum")["results"]] == [a]
    assert a not in {r["block_id"] for r in _search(c, "alpha")["results"]}
    assert _meta("searcher", page["id"]) is not None
    assert _meta("searcher", other["id"]) == stamp_other  # untouched page: no rebuild

    # PUT /blocks/{id}/children (autosave): whole subtree replaced.
    r = c.put(f"/api/blocks/{page['id']}/children",
              json={"blocks": [{"content": "delta one", "children": [{"content": "delta two"}]}]})
    assert r.status_code == 200
    hits = _search(c, "delta")["results"]
    assert len(hits) == 2 and all(h["page_id"] == page["id"] for h in hits)
    assert _search(c, "gamma ipsum")["results"] == []
    child = next(h["block_id"] for h in hits if "two" in h["snippet"])

    # DELETE /blocks/{id} of a nested block.
    assert c.delete(f"/api/blocks/{child}").status_code == 200
    assert [h["snippet"] for h in _search(c, "delta")["results"]] == ["delta one"]

    # POST /blocks/{id}/reorder across pages: the block re-keys to its new page.
    assert c.post(f"/api/blocks/{b}/reorder", json={"parent_id": page["id"]}).status_code == 200
    (hit,) = _search(c, "beta")["results"]
    assert hit["block_id"] == b and hit["page_id"] == page["id"] and hit["title"] == "Dirty page"

    # Deleting a page prunes its rows.
    assert c.delete(f"/api/blocks/{page['id']}").status_code == 200
    assert _search(c, "delta")["results"] == [] and _search(c, "beta")["results"] == []
    assert _meta("searcher", page["id"]) is None

    # A stale index version rebuilds lazily too (what search-reindex stamps).
    from gamma.block_index import mark_all_dirty
    mark_all_dirty(workspace_of("searcher"))
    assert _meta("searcher", other["id"])[1] == 0
    assert _search(c, "lorem")["results"] == []  # other's only block moved away
    assert _meta("searcher", other["id"])[1] == INDEX_VERSION


def test_pdf_search_and_block_search_unchanged():
    """The predecessors the frontend still uses keep their shapes."""
    c = login("searcher", "pw")
    r = c.get("/api/pdf-search", params={"q": "wombat"})
    assert r.status_code == 200
    (hit,) = [h for h in r.json()["results"] if h["doc_id"] == "srchdoc001"]
    assert hit["page"] == 4 and "source" not in hit
    r = c.get("/api/block-search", params={"q": "wombat"})
    assert r.status_code == 200 and r.json()["blocks"]

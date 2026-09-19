"""POST /api/metadata/update — hand-edited paper metadata."""

from conftest import make_page


def test_update_saves_meta_and_rebuilds_bibtex(guest):
    page = make_page(guest, "Manual meta page")
    r = guest.post("/api/metadata/update", json={
        "block_id": page["id"],
        "meta": {
            "title": "A Hand-Entered Title",
            "authors": "Ada Lovelace, Charles Babbage",
            "venue": "Journal of Testing",
            "year": "2026",
            "volume": "7",
            "pages": "1-10",
            "doi": "10.1234/test.5678",
            "arxiv_id": "",
        },
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["meta"]["title"] == "A Hand-Entered Title"
    assert data["meta"]["authors"] == ["Ada Lovelace", "Charles Babbage"]
    assert data["meta"]["source"] == "manual"
    assert "lovelace2026" in data["bibtex"]
    assert "Journal of Testing" in data["bibtex"]

    # persisted on the block, and a cached fetch returns the edited values
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200
    assert r.json()["cached"] is True
    assert r.json()["meta"]["title"] == "A Hand-Entered Title"


def test_update_invalidates_cached_citation(guest):
    page = make_page(guest, "Cite invalidation page",
                     properties={"meta": {"title": "Old"}, "ppt_cite": "Old cite"})
    r = guest.post("/api/metadata/update", json={
        "block_id": page["id"],
        "meta": {"title": "New title", "authors": [], "year": "2026"},
    })
    assert r.status_code == 200
    r = guest.get(f"/api/blocks/{page['id']}")
    props = r.json()["properties"]
    assert props["meta"]["title"] == "New title"
    assert "ppt_cite" not in props


def test_update_all_blank_clears_meta(guest):
    page = make_page(guest, "Clear meta page",
                     properties={"meta": {"title": "Old"}, "bibtex": "@article{x}"})
    r = guest.post("/api/metadata/update", json={"block_id": page["id"], "meta": {}})
    assert r.status_code == 200
    assert r.json()["meta"] is None
    r = guest.get(f"/api/blocks/{page['id']}")
    props = r.json()["properties"]
    assert "meta" not in props
    assert "bibtex" not in props


def test_update_missing_page_404(guest):
    r = guest.post("/api/metadata/update", json={"block_id": "nope", "meta": {"title": "x"}})
    assert r.status_code == 404


def test_fetch_kicks_search_indexing_for_the_paper(guest, monkeypatch):
    """Setting a paper up (metadata fetch) starts indexing its PDF in the
    background, so search and the AI document map don't wait for the first
    search to notice it."""
    import gamma.routers.search as search_mod
    kicked = []
    monkeypatch.setattr(search_mod, "_index_missing_async",
                        lambda user, doc_ids: kicked.append(list(doc_ids)) or True)
    doc_id = "f" * 24
    page = make_page(guest, "Paper without a file yet", {"doc_id": doc_id})
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 404  # no file, no ids, no AI — but the kick happened
    assert kicked == [[doc_id]]
    # A notes page (no doc_id) has nothing to index.
    note = make_page(guest, "Just notes")
    guest.post("/api/metadata/fetch", json={"block_id": note["id"]})
    assert kicked == [[doc_id]]


def test_failed_fetch_is_negative_cached_and_cleared_by_update(guest):
    # No doc_id / source_url and AI unconfigured — the lookup finds nothing.
    page = make_page(guest, "No meta anywhere")
    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 404
    props = guest.get(f"/api/blocks/{page['id']}").json()["properties"]
    assert props["meta_error"]["at"]  # marker clients use to skip auto-retry

    # Hand-editing the metadata settles the failure: the marker is removed.
    r = guest.post("/api/metadata/update", json={
        "block_id": page["id"], "meta": {"title": "Filled by hand", "year": "2026"},
    })
    assert r.status_code == 200
    props = guest.get(f"/api/blocks/{page['id']}").json()["properties"]
    assert "meta_error" not in props
    assert props["meta"]["title"] == "Filled by hand"

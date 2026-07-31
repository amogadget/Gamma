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

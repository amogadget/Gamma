"""Metadata writes must not clobber properties changed while a lookup runs.

Lookups take seconds to minutes; labelling the page in the meantime merges
into the same properties blob via PUT /api/blocks/{id}. The metadata endpoints
therefore write a delta, not the snapshot they read before the lookup.
"""

import json
import sqlite3

import pytest
from conftest import make_page


def _label(user, block_id, value):
    """What PUT /api/blocks/{id} does: merge one key into the properties."""
    from gamma.db import user_db_path

    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        row = conn.execute(
            "SELECT properties FROM unified_blocks WHERE id = ?", (block_id,)
        ).fetchone()
        props = json.loads(row[0] or "{}")
        props["category"] = value
        conn.execute("UPDATE unified_blocks SET properties = ? WHERE id = ?",
                     (json.dumps(props), block_id))
        conn.commit()


@pytest.fixture
def label_during_lookup(monkeypatch):
    """Label the page from inside the arXiv call — i.e. after metadata_fetch
    has read the properties but before it writes them back."""
    from gamma.routers import metadata

    def arm(block_id, result):
        def fake_fetch_arxiv(arxiv_id):
            _label("guest", block_id, "quantum")
            return result
        monkeypatch.setattr(metadata, "_fetch_arxiv", fake_fetch_arxiv)
    return arm


ARXIV_META = {
    "title": "Fetched Title", "authors": ["Ada Lovelace"], "year": "2026",
    "venue": "arXiv:2601.00001", "volume": "", "pages": "",
    "doi": "", "arxiv_id": "2601.00001", "source": "arxiv",
}


def test_label_set_during_fetch_survives(guest, label_during_lookup):
    page = make_page(guest, "Racy page",
                     properties={"source_url": "https://arxiv.org/abs/2601.00001"})
    label_during_lookup(page["id"], ARXIV_META)

    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    props = guest.get(f"/api/blocks/{page['id']}").json()["properties"]
    assert props["meta"]["title"] == "Fetched Title"
    assert props["category"] == "quantum"          # not clobbered
    assert props["source_url"]                     # nor is anything else


def test_label_set_during_failed_fetch_survives(guest, label_during_lookup):
    """The negative-cache write is the same read-modify-write hazard."""
    page = make_page(guest, "Racy failing page",
                     properties={"source_url": "https://arxiv.org/abs/2601.00002"})
    label_during_lookup(page["id"], None)  # lookup finds nothing, AI unconfigured

    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"]})
    assert r.status_code == 404
    props = guest.get(f"/api/blocks/{page['id']}").json()["properties"]
    assert props["meta_error"]["at"]
    assert props["category"] == "quantum"


def test_fetch_clears_stale_markers(guest, label_during_lookup):
    page = make_page(guest, "Refetched page", properties={
        "source_url": "https://arxiv.org/abs/2601.00003",
        "meta_error": {"at": "2026-01-01T00:00:00Z", "detail": "old failure"},
        "ppt_cite": "stale citation",
        "folder": "reading",
    })
    label_during_lookup(page["id"], ARXIV_META)

    r = guest.post("/api/metadata/fetch", json={"block_id": page["id"], "force": True})
    assert r.status_code == 200, r.text
    props = guest.get(f"/api/blocks/{page['id']}").json()["properties"]
    assert "meta_error" not in props
    assert "ppt_cite" not in props
    assert props["category"] == "quantum"
    assert props["folder"] == "reading"


def test_label_set_during_cite_survives(guest, monkeypatch):
    from gamma.routers import metadata

    page = make_page(guest, "Cited page",
                     properties={"meta": {"title": "T"}, "bibtex": "@article{t}"})
    monkeypatch.setattr(metadata, "require_ai_runtime", lambda user: {"enabled": True})
    monkeypatch.setattr(metadata, "_resolve_model", lambda rt, model: "m")

    def fake_call_ai(messages, system, model, rt, **kw):
        _label("guest", page["id"], "cited")
        return "Lovelace et al., 2026"
    monkeypatch.setattr(metadata, "_call_ai", fake_call_ai)

    r = guest.post("/api/metadata/cite", json={"block_id": page["id"]})
    assert r.status_code == 200, r.text
    props = guest.get(f"/api/blocks/{page['id']}").json()["properties"]
    assert props["ppt_cite"] == "Lovelace et al., 2026"
    assert props["category"] == "cited"


def test_save_props_missing_page_404s(guest):
    from gamma.routers.metadata import _save_props
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        _save_props("guest", "no-such-block", {"meta": {}})
    assert e.value.status_code == 404

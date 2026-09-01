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


# --- automatic-title compare-and-swap -----------------------------------------
# An upload names the page after the file and marks that title `auto_title`.
# A metadata lookup may replace it, but only while the marker still matches —
# so a rename the user made during the lookup always wins.


def test_uploaded_filename_is_auto_replaced_by_metadata(guest, monkeypatch):
    from gamma.routers import metadata

    created = guest.post("/api/blocks/by-doc/filetitle1", json={
        "default_title": "original-paper.pdf",
        "original_filename": "original-paper.pdf",
        "source_url": "https://arxiv.org/abs/2601.00001",
    }).json()
    assert created["content"] == "original-paper.pdf"
    assert created["properties"]["auto_title"] == "original-paper.pdf"

    monkeypatch.setattr(metadata, "_fetch_arxiv", lambda _arxiv_id: ARXIV_META)
    r = guest.post("/api/metadata/fetch", json={"block_id": created["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["title_updated"] is True
    assert r.json()["page_title"] == "Fetched Title"
    saved = guest.get(f"/api/blocks/{created['id']}").json()
    assert saved["content"] == "Fetched Title"
    # The marker is consumed, so a second lookup cannot rename again.
    assert "auto_title" not in saved["properties"]


def test_uploaded_pdf_title_uses_filename_leaf_only(guest):
    """A directory picker may leak a relative path into the multipart filename;
    neither separator style belongs in a page title."""
    created = guest.post("/api/blocks/by-doc/filetitlepath", json={
        "default_title": "papers/readout/original-paper.pdf",
        "original_filename": "papers\\readout\\original-paper.pdf",
        "source_url": "/api/uploads/filetitlepath.pdf",
    }).json()
    assert created["content"] == "original-paper.pdf"
    assert created["properties"]["original_filename"] == "original-paper.pdf"
    assert created["properties"]["auto_title"] == "original-paper.pdf"


def test_rename_during_metadata_fetch_wins(guest, monkeypatch):
    """The race this CAS exists for: the user renames the page while a slow
    lookup is in flight. Their title must survive."""
    from gamma.db import user_db_path
    from gamma.routers import metadata

    created = guest.post("/api/blocks/by-doc/filetitle2", json={
        "default_title": "slow-paper.pdf",
        "original_filename": "slow-paper.pdf",
        "source_url": "https://arxiv.org/abs/2601.00001",
    }).json()

    def fetch_after_rename(_arxiv_id):
        # Same transaction effect as an explicit PUT /blocks/{id}: write the
        # user's title and clear the automatic-title marker.
        with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
            row = conn.execute(
                "SELECT properties FROM unified_blocks WHERE id=?", (created["id"],)
            ).fetchone()
            props = json.loads(row[0])
            props.pop("auto_title", None)
            conn.execute(
                "UPDATE unified_blocks SET content=?, properties=? WHERE id=?",
                ("My deliberate title", json.dumps(props), created["id"]),
            )
            conn.commit()
        return ARXIV_META

    monkeypatch.setattr(metadata, "_fetch_arxiv", fetch_after_rename)
    r = guest.post("/api/metadata/fetch", json={"block_id": created["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["title_updated"] is False
    saved = guest.get(f"/api/blocks/{created['id']}").json()
    # The rename stands, and the metadata itself still landed.
    assert saved["content"] == "My deliberate title"
    assert saved["properties"]["meta"]["title"] == "Fetched Title"


def test_explicit_rename_via_api_clears_the_marker(guest):
    """PUT /blocks/{id} with a content write is user intent: it must drop
    auto_title so no later lookup can overwrite the new title."""
    created = guest.post("/api/blocks/by-doc/filetitle3", json={
        "default_title": "renamed-paper.pdf",
        "original_filename": "renamed-paper.pdf",
    }).json()
    assert created["properties"]["auto_title"] == "renamed-paper.pdf"

    r = guest.put(f"/api/blocks/{created['id']}", json={"content": "Hand-picked title"})
    assert r.status_code == 200, r.text
    saved = guest.get(f"/api/blocks/{created['id']}").json()
    assert saved["content"] == "Hand-picked title"
    assert "auto_title" not in saved["properties"]


def test_property_only_update_keeps_the_marker(guest):
    """Labelling a page is not a rename — the marker must survive so metadata
    can still supply a real title."""
    created = guest.post("/api/blocks/by-doc/filetitle4", json={
        "default_title": "labelled-paper.pdf",
        "original_filename": "labelled-paper.pdf",
    }).json()

    r = guest.put(f"/api/blocks/{created['id']}", json={"properties": {"category": "quantum"}})
    assert r.status_code == 200, r.text
    saved = guest.get(f"/api/blocks/{created['id']}").json()
    assert saved["properties"]["category"] == "quantum"
    assert saved["properties"]["auto_title"] == "labelled-paper.pdf"


def test_legacy_pdf_notes_title_is_still_eligible(guest, monkeypatch):
    """Pages created before auto_title existed carry the old generated prefix;
    metadata may still name them."""
    from gamma.db import user_db_path
    from gamma.routers import metadata

    created = guest.post("/api/blocks/by-doc/filetitle5", json={
        "default_title": "PDF Notes - abc123.pdf",
        "source_url": "https://arxiv.org/abs/2601.00001",
    }).json()
    # Simulate a pre-marker page: strip auto_title, keep the legacy title.
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        row = conn.execute("SELECT properties FROM unified_blocks WHERE id=?",
                           (created["id"],)).fetchone()
        props = json.loads(row[0])
        props.pop("auto_title", None)
        conn.execute("UPDATE unified_blocks SET properties=? WHERE id=?",
                     (json.dumps(props), created["id"]))
        conn.commit()

    monkeypatch.setattr(metadata, "_fetch_arxiv", lambda _a: ARXIV_META)
    r = guest.post("/api/metadata/fetch", json={"block_id": created["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["title_updated"] is True
    assert guest.get(f"/api/blocks/{created['id']}").json()["content"] == "Fetched Title"


def test_user_titled_page_without_marker_is_never_renamed(guest, monkeypatch):
    """No marker and no legacy prefix means the title is the user's. Metadata
    must leave it alone even though it has a better one."""
    from gamma.db import user_db_path
    from gamma.routers import metadata

    created = guest.post("/api/blocks/by-doc/filetitle6", json={
        "default_title": "whatever.pdf",
        "source_url": "https://arxiv.org/abs/2601.00001",
    }).json()
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        row = conn.execute("SELECT properties FROM unified_blocks WHERE id=?",
                           (created["id"],)).fetchone()
        props = json.loads(row[0])
        props.pop("auto_title", None)
        conn.execute("UPDATE unified_blocks SET content=?, properties=? WHERE id=?",
                     ("A Title I Chose", json.dumps(props), created["id"]))
        conn.commit()

    monkeypatch.setattr(metadata, "_fetch_arxiv", lambda _a: ARXIV_META)
    r = guest.post("/api/metadata/fetch", json={"block_id": created["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["title_updated"] is False
    assert guest.get(f"/api/blocks/{created['id']}").json()["content"] == "A Title I Chose"

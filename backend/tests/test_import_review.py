"""The shared upload/review/selection/commit contract and its isolation boundary."""
import io
import zipfile

import pytest

from conftest import login, make_page, make_user, workspace_of
from test_zotero_import import RDF, _annotated_pdf


def archive(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for path, content in files.items():
            zf.writestr(path, content)
    return buf.getvalue()


def review(client, data, source, name="review.zip", **options):
    result = client.post("/api/import/review", data={"source": source, **options},
                        files={"file": (name, data, "application/zip")})
    assert result.status_code == 200, result.text
    return result.json()


def commit(client, plan, ids):
    return client.post(f"/api/import/review/{plan['review_id']}", json={"selected": ids})


def rows(ws):
    from gamma.db import connect_pages_db
    with connect_pages_db(ws) as conn:
        return conn.execute("SELECT * FROM unified_blocks ORDER BY id").fetchall()


def uploads(ws):
    from gamma.db import ws_uploads_dir
    return {p.name for p in ws_uploads_dir(ws).glob("*")}


def test_zotero_selection_upload_once_and_commit_retry(guest):
    ws = workspace_of("guest")
    before, before_files = rows(ws), uploads(ws)
    rdf = RDF.replace("s41586-000-00000-0", "selected-zotero")
    plan = review(guest, archive({"library.rdf": rdf, "files/3/unique.pdf": _annotated_pdf(b"Selected Zotero paper")}), "zotero")
    assert rows(ws) == before and uploads(ws) == before_files
    paper = next(p for p in plan["pages"] if p["kind"] == "pdf")
    assert any(p["missing"] for p in plan["pages"])
    result = commit(guest, plan, paper["selection_ids"])
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["items"] == 1 and data["pages_created"] == 1
    assert all(w["title"] != "Proximal Policy Optimization" for w in data["warnings"])
    assert commit(guest, plan, paper["selection_ids"]).json() == data
    assert commit(guest, plan, []).status_code == 409


def test_empty_selection_and_bad_ids_do_not_import(guest):
    ws = workspace_of("guest")
    before, before_files = rows(ws), uploads(ws)
    plan = review(guest, archive({"one.md": "# Empty selection\nhello"}), "markdown-zip")
    assert commit(guest, plan, ["not-a-page"]).status_code == 400
    result = commit(guest, plan, [])
    assert result.status_code == 200 and result.json()["pages_created"] == 0
    assert rows(ws) == before and uploads(ws) == before_files


def test_markdown_selection_preserves_links_and_only_stores_selected_assets(guest):
    ws = workspace_of("guest")
    before, before_files = rows(ws), uploads(ws)
    data = archive({"vault/.obsidian/app.json": "{}", "vault/One.md": "# One\n[[Two]]\n![image](one.png)\n![missing](gone.png)",
                    "vault/Two.md": "# Two\n![image](two.png)", "vault/one.png": b"one-picture", "vault/two.png": b"two-picture"})
    plan = review(guest, data, "markdown-zip", folder="Selected notes")
    assert rows(ws) == before and uploads(ws) == before_files
    page = next(p for p in plan["pages"] if p["title"] == "One")
    assert page["missing"] and page["folders"] == ["Selected notes"]
    result = commit(guest, plan, page["selection_ids"])
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["pages_created"] == 1 and data["assets_stored"] == 1
    assert len(uploads(ws) - before_files) == 1
    assert any("Two" in w["reason"] for w in data["warnings"])
    children = guest.get(f"/api/blocks/{data['pages'][0]['id']}/children").json()["children"]
    assert any("[[Two]]" in child["content"] for child in children)


def test_single_markdown_uses_same_review_contract(guest):
    plan = review(guest, b"---\ntitle: Single reviewed note\nfolder: child\n---\nContent", "markdown-file", name="note.md", folder="Parent")
    assert len(plan["pages"]) == 1
    page = plan["pages"][0]
    assert page["title"] == "Single reviewed note" and page["folders"] == ["Parent/child"]
    assert commit(guest, plan, page["selection_ids"]).json()["pages_created"] == 1


def test_markdown_repeat_review_shows_existing_destination(accounts):
    owner = accounts["review-owner"]
    content = b"# Repeat review note\nKeep the existing destination."
    first = review(owner, content, "markdown-file", name="repeat.md", folder="Original folder")
    created = commit(owner, first, first["pages"][0]["selection_ids"]).json()["pages"][0]
    result = owner.put(f"/api/blocks/{created['id']}", json={"content": "Renamed in library"})
    assert result.status_code == 200
    repeated = review(owner, content, "markdown-file", name="repeat.md", folder="Different folder")
    page = repeated["pages"][0]
    assert page["title"] == "Renamed in library" and page["folders"] == ["Original folder"]
    assert page["action"] == "skip" and repeated["pages_created"] == 0
    imported = commit(owner, repeated, page["selection_ids"]).json()
    assert imported["pages_created"] == 0 and imported["pages_skipped"] == 1
    assert imported["pages"][0]["id"] == created["id"]


@pytest.fixture(scope="module")
def accounts(client):
    for name in ("review-owner", "review-other", "review-donor"):
        make_user(name, "test-password")
    return {name: login(name, "test-password") for name in ("review-owner", "review-other", "review-donor")}


def test_staged_upload_is_bound_to_user_and_workspace_and_cancelled(accounts):
    owner, other = accounts["review-owner"], accounts["review-other"]
    plan = review(owner, archive({"one.md": "# Private staged note"}), "markdown-zip")
    ids = plan["pages"][0]["selection_ids"]
    assert commit(other, plan, ids).status_code == 404
    assert other.delete(f"/api/import/review/{plan['review_id']}").status_code == 404
    other_ws = owner.post("/api/workspaces", json={"name": "Another review destination"}).json()["id"]
    wrong_destination = owner.post(f"/api/import/review/{plan['review_id']}", json={"selected": ids},
                                   headers={"X-Gamma-Workspace": other_ws})
    assert wrong_destination.status_code == 404
    from gamma import import_staging
    path, _ = import_staging.get(plan["review_id"], "review-owner", workspace_of("review-owner"))
    assert path.exists()
    with import_staging.claim(plan["review_id"], "review-owner", workspace_of("review-owner")):
        assert commit(owner, plan, ids).status_code == 409
    assert owner.delete(f"/api/import/review/{plan['review_id']}").status_code == 200
    assert not path.exists()
    assert commit(owner, plan, ids).status_code == 404


def test_gamma_selection_keeps_page_dependencies_and_excludes_other_pages(accounts):
    donor, receiver = accounts["review-donor"], accounts["review-owner"]
    a_pdf = donor.post("/api/uploads", files={"file": ("a.pdf", _annotated_pdf(b"Selected Gamma PDF"), "application/pdf")}).json()
    b_pdf = donor.post("/api/uploads", files={"file": ("b.pdf", _annotated_pdf(b"Unselected Gamma PDF"), "application/pdf")}).json()
    a = make_page(donor, "Chosen Gamma page", {"doc_id": a_pdf["doc_id"], "source_url": a_pdf["source_url"], "folder": "Research/Chosen"})
    b = make_page(donor, "Excluded Gamma page", {"doc_id": b_pdf["doc_id"], "source_url": b_pdf["source_url"]})
    child = donor.post("/api/blocks", json={"parent_id": a["id"], "content": f"Chosen child note [[{b['id']}]]"}).json()
    donor.put(f"/api/chats/{a['id']}", json={"messages": [{"role": "user", "content": "chosen chat"}]})
    donor.put(f"/api/chats/{b['id']}", json={"messages": [{"role": "user", "content": "excluded chat"}]})
    ws = workspace_of("review-owner")
    before, before_files = rows(ws), uploads(ws)
    plan = review(receiver, donor.get("/api/export").content, "gamma")
    assert rows(ws) == before and uploads(ws) == before_files
    chosen = next(p for p in plan["pages"] if p["title"] == "Chosen Gamma page")
    assert chosen["folders"] == ["Research/Chosen"]
    result = commit(receiver, plan, chosen["selection_ids"])
    assert result.status_code == 200, result.text
    assert result.json()["pages_added"] == 1 and result.json()["chats_added"] == 1
    assert any("unselected" in w["reason"] for w in result.json()["warnings"])
    assert receiver.get(f"/api/blocks/{child['id']}").status_code == 200
    assert receiver.get(f"/api/blocks/{b['id']}").status_code == 404
    assert f"{a_pdf['doc_id']}.pdf" in uploads(ws) and f"{b_pdf['doc_id']}.pdf" not in uploads(ws)
    assert receiver.put(f"/api/blocks/{a['id']}", json={"content": "Renamed Gamma page"}).status_code == 200
    repeated = review(receiver, donor.get("/api/export").content, "gamma")
    existing = next(p for p in repeated["pages"] if p["selection_ids"] == chosen["selection_ids"])
    assert existing["title"] == "Renamed Gamma page" and existing["action"] == "skip"


def test_guest_cannot_use_review_to_bypass_backup_restriction(guest, accounts):
    data = accounts["review-donor"].get("/api/export").content
    result = guest.post("/api/import/review", data={"source": "gamma"}, files={"file": ("backup.zip", data)})
    assert result.status_code == 403

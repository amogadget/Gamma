"""Stage-1 page endpoints (routers/pages.py): create a page, attach / detach a
PDF, generic file uploads + serving, and the root listing's text preview."""

import io

import pytest
from fastapi.testclient import TestClient

from conftest import login, make_page, make_user, workspace_of
from gamma.db import ws_uploads_dir

PDF_BYTES = b"%PDF-1.4 pages test\n" + b"z" * 2000


def _upload_pdf(client, data=PDF_BYTES):
    r = client.post("/api/uploads", files={"file": ("paper.pdf", io.BytesIO(data), "application/pdf")})
    assert r.status_code == 200, r.text
    return r.json()["doc_id"]


# --- POST /api/pages -------------------------------------------------------------

def test_create_page_defaults_and_folder(guest):
    r = guest.post("/api/pages", json={})
    assert r.status_code == 200, r.text
    page = r.json()
    assert page["parent_id"] == "root" and page["content"] == "Untitled" and page["properties"] == {}

    r = guest.post("/api/pages", json={"title": "  Reading list ", "folder": " a / b "})
    page = r.json()
    assert page["content"] == "Reading list" and page["properties"] == {"folder": "a/b"}
    # it is a real root page: listed at root, no attachment
    ids = [b["id"] for b in guest.get("/api/blocks/root/children").json()["children"]]
    assert page["id"] in ids


def test_create_page_needs_a_session():
    from gamma.app import app
    assert TestClient(app).post("/api/pages", json={"title": "x"}).status_code == 401


# --- attachment --------------------------------------------------------------------

def test_attach_stored_pdf_sets_attachment_and_automatic_title(guest):
    doc_id = _upload_pdf(guest, PDF_BYTES + b"a")
    page = guest.post("/api/pages", json={}).json()
    r = guest.post(f"/api/pages/{page['id']}/attachment",
                   json={"doc_id": doc_id, "original_filename": "dir/My Paper.pdf"})
    assert r.status_code == 200, r.text
    body = r.json()
    props = body["properties"]
    assert props["doc_id"] == doc_id
    assert props["source_url"] == f"/api/uploads/{doc_id}.pdf"
    assert props["original_filename"] == "My Paper.pdf"
    # "Untitled" was automatic → the file name, marked for the metadata worker
    assert body["content"] == "My Paper.pdf" and props["auto_title"] == "My Paper.pdf"
    assert guest.get(f"/api/blocks/{page['id']}").json()["content"] == "My Paper.pdf"
    # the by-attachment lookup now finds this page
    assert guest.get(f"/api/blocks/by-doc/{doc_id}").json()["id"] == page["id"]


def test_attach_keeps_a_user_title(guest):
    doc_id = _upload_pdf(guest, PDF_BYTES + b"b")
    page = guest.post("/api/pages", json={"title": "My own title"}).json()
    body = guest.post(f"/api/pages/{page['id']}/attachment", json={"doc_id": doc_id}).json()
    assert body["content"] == "My own title" and "auto_title" not in body["properties"]


def test_attach_by_url_only_is_lazy(guest):
    """A URL-opened PDF: the client hashes the URL into doc_id, nothing is
    stored yet (the proxy fetches on open) — attach must not demand a file."""
    import hashlib
    url = "https://example.org/papers/lazy%20one.pdf"
    doc_id = hashlib.sha256(url.encode()).hexdigest()[:24]  # what the client's getDocIdForUrl yields
    page = guest.post("/api/pages", json={}).json()
    r = guest.post(f"/api/pages/{page['id']}/attachment", json={"doc_id": doc_id, "source_url": url})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["properties"]["doc_id"] == doc_id
    assert body["properties"]["source_url"] == url
    assert body["content"] == "lazy one.pdf"  # URL tail while the title is automatic

    page2 = guest.post("/api/pages", json={}).json()
    r = guest.post(f"/api/pages/{page2['id']}/attachment", json={"source_url": "https://example.org/x.pdf"})
    assert r.status_code == 200 and "doc_id" not in r.json()["properties"]


def test_attach_validation(guest):
    page = guest.post("/api/pages", json={}).json()
    assert guest.post(f"/api/pages/{page['id']}/attachment", json={}).status_code == 400
    assert guest.post(f"/api/pages/{page['id']}/attachment", json={"doc_id": "../etc"}).status_code == 400
    assert guest.post("/api/pages/nope/attachment", json={"doc_id": "a" * 24}).status_code == 404
    child = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "note"}).json()
    assert guest.post(f"/api/pages/{child['id']}/attachment", json={"doc_id": "a" * 24}).status_code == 400


def test_second_attach_is_a_conflict(guest):
    doc_id = _upload_pdf(guest, PDF_BYTES + b"c")
    page = guest.post("/api/pages", json={}).json()
    assert guest.post(f"/api/pages/{page['id']}/attachment", json={"doc_id": doc_id}).status_code == 200
    r = guest.post(f"/api/pages/{page['id']}/attachment", json={"doc_id": "e" * 24})
    assert r.status_code == 409 and r.json()["detail"] == "page already has an attachment"


def test_attach_a_doc_another_page_owns_names_that_page(guest):
    doc_id = _upload_pdf(guest, PDF_BYTES + b"d")
    owner = guest.post(f"/api/blocks/by-doc/{doc_id}", json={"default_title": "Owner"}).json()
    page = guest.post("/api/pages", json={}).json()
    r = guest.post(f"/api/pages/{page['id']}/attachment", json={"doc_id": doc_id})
    assert r.status_code == 409, r.text
    assert r.json() == {"detail": "attachment belongs to another page", "page_id": owner["id"]}
    # the page stayed text-only
    assert "doc_id" not in guest.get(f"/api/blocks/{page['id']}").json()["properties"]


def test_detach_clears_attachment_and_sweeps_the_file(guest):
    doc_id = _upload_pdf(guest, PDF_BYTES + b"e")
    page = guest.post("/api/pages", json={"title": "Detach me"}).json()
    guest.post(f"/api/pages/{page['id']}/attachment", json={"doc_id": doc_id, "original_filename": "x.pdf"})
    # a highlight child keeps its anchor
    hl = guest.post("/api/blocks", json={
        "parent_id": page["id"], "content": "quoted",
        "properties": {"highlight_id": "h1", "pdf_position": {"page": 1}}}).json()
    assert (ws_uploads_dir(workspace_of("guest")) / f"{doc_id}.pdf").is_file()

    r = guest.delete(f"/api/pages/{page['id']}/attachment")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] and f"{doc_id}.pdf" in body["removed_uploads"]
    assert not (ws_uploads_dir(workspace_of("guest")) / f"{doc_id}.pdf").exists()
    props = body["block"]["properties"]
    assert not any(k in props for k in ("doc_id", "source_url", "original_filename"))
    assert guest.get(f"/api/blocks/{hl['id']}").json()["properties"]["pdf_position"] == {"page": 1}
    assert guest.get(f"/api/blocks/by-doc/{doc_id}").status_code == 404
    # nothing left to detach
    assert guest.delete(f"/api/pages/{page['id']}/attachment").status_code == 404


def test_detach_keeps_a_file_another_page_still_uses(guest):
    doc_id = _upload_pdf(guest, PDF_BYTES + b"f")
    keeper = guest.post("/api/pages", json={"title": "Keeper"}).json()
    guest.post(f"/api/pages/{keeper['id']}/attachment", json={"doc_id": doc_id})
    other = guest.post("/api/pages", json={"title": "Other"}).json()
    # a chip reference (not an attachment) on another page also counts
    guest.post("/api/blocks", json={"parent_id": other["id"], "content": f"[paper](/api/uploads/{doc_id}.pdf)"})
    r = guest.delete(f"/api/pages/{keeper['id']}/attachment")
    assert r.status_code == 200 and r.json()["removed_uploads"] == []
    assert (ws_uploads_dir(workspace_of("guest")) / f"{doc_id}.pdf").is_file()


@pytest.fixture
def bob_page():
    make_user("pages_bob", "pw")
    bob = login("pages_bob", "pw")
    page = make_page(bob, "Bob's page")
    r = bob.post(f"/api/share/{page['id']}", json={"audience": "users", "role": "edit"})
    assert r.status_code == 200, r.text
    return bob, page, r.json()["token"]


def test_share_token_never_attaches(bob_page, guest):
    """Attachment is a page property: the owner's only. Anonymous with an edit
    share → 401; a guest (or any other account) with the token → the page is
    not in THEIR library (404), the token is ignored for this write."""
    from gamma.app import app
    bob, page, token = bob_page
    anon = TestClient(app)
    r = anon.post(f"/api/pages/{page['id']}/attachment", params={"share": token}, json={"doc_id": "a" * 24})
    assert r.status_code == 401
    r = guest.post(f"/api/pages/{page['id']}/attachment", params={"share": token}, json={"doc_id": "a" * 24})
    assert r.status_code == 404
    make_user("pages_carol", "pw")
    carol = login("pages_carol", "pw")
    r = carol.post(f"/api/pages/{page['id']}/attachment", params={"share": token}, json={"doc_id": "a" * 24})
    assert r.status_code == 404
    assert "doc_id" not in bob.get(f"/api/blocks/{page['id']}").json()["properties"]
    assert anon.post("/api/pages", params={"share": token}, json={"title": "x"}).status_code == 401


# --- generic file uploads --------------------------------------------------------------

def _upload_file(client, name, data, ctype="application/octet-stream"):
    return client.post("/api/upload-file", files={"file": (name, io.BytesIO(data), ctype)})


def test_upload_file_takes_anything_but_executables(guest):
    r = _upload_file(guest, "notes.docx", b"PK\x03\x04docx-ish")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"].startswith("/api/uploads/") and body["url"].endswith(".docx")
    assert body["name"] == "notes.docx" and body["size"] == len(b"PK\x03\x04docx-ish")
    assert body["already_existed"] is False
    assert _upload_file(guest, "notes.docx", b"PK\x03\x04docx-ish").json()["already_existed"] is True
    # extension is normalized from the display name (case, leaked directories)
    r = _upload_file(guest, "C:\\stuff\\Data.CSV", b"a,b\n1,2\n")
    assert r.status_code == 200 and r.json()["url"].endswith(".csv") and r.json()["name"] == "Data.CSV"
    # images route through the image path (extension from the declared type)
    r = _upload_file(guest, "shot", b"\x89PNG fake", "image/png")
    assert r.status_code == 200 and r.json()["url"].endswith(".png")
    # lab files: unknown extensions are fine (served as octet-stream downloads),
    # a compound suffix keeps its last part, no extension becomes .bin
    for name, ext in (("sim.nb", ".nb"), ("run.sh", ".sh"), ("fit.mat", ".mat"), ("pkg.tar.gz", ".gz"),
                      ("Makefile", ".bin"), ("weird.a-b", ".bin")):
        r = _upload_file(guest, name, b"whatever " + name.encode())
        assert r.status_code == 200 and r.json()["url"].endswith(ext) and r.json()["name"] == name, name
    r = guest.get(_upload_file(guest, "fit.mat", b"whatever fit.mat").json()["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment;")
    # executables are the one refusal
    for name in ("run.exe", "lib.dll", "setup.msi", "go.bat", "x.ps1", "Run.EXE"):
        r = _upload_file(guest, name, b"whatever")
        assert r.status_code == 400 and "executable" in r.json()["detail"], name
    assert _upload_file(guest, "fake.pdf", b"not a pdf").status_code == 400


def test_pdf_file_block_promotes_to_a_document_page(guest):
    """A PDF dropped into a block (upload-file) is stored under the hash the
    PDF ingest uses, so by-doc on that hash opens it as a document page
    without a second upload; by-docs reports which hashes have pages."""
    data = PDF_BYTES + b"file-block"
    up = _upload_file(guest, "Supplement.pdf", data, "application/pdf").json()
    doc_id = up["url"].rsplit("/", 1)[-1][:-4]
    assert up["url"] == f"/api/uploads/{doc_id}.pdf"
    assert guest.get(f"/api/blocks/by-doc/{doc_id}").status_code == 404
    other = _upload_pdf(guest, PDF_BYTES + b"other")
    r = guest.post("/api/pages/by-docs", json={"doc_ids": [doc_id, other, "", "nope"]})
    assert r.status_code == 200 and r.json() == {"pages": {}}
    # promote: same hash, no re-upload, filed in the asking page's folder
    r = guest.post(f"/api/blocks/by-doc/{doc_id}", json={
        "default_title": "", "source_url": up["url"], "original_filename": "Supplement.pdf",
        "folder": "Projects/Rydberg"})
    assert r.status_code == 200, r.text
    page = r.json()
    assert page["parent_id"] == "root" and page["content"] == "Supplement.pdf"
    assert page["properties"]["doc_id"] == doc_id and page["properties"]["folder"] == "Projects/Rydberg"
    assert page["properties"]["auto_title"] == "Supplement.pdf"
    # a second promotion finds the page; the folder of an existing page is left alone
    again = guest.post(f"/api/blocks/by-doc/{doc_id}", json={"default_title": "", "folder": "Elsewhere"}).json()
    assert again["id"] == page["id"] and again["properties"]["folder"] == "Projects/Rydberg"
    r = guest.post("/api/pages/by-docs", json={"doc_ids": [doc_id, other]})
    assert r.json() == {"pages": {doc_id: {"id": page["id"], "title": "Supplement.pdf"}}}
    # the same file referenced by a file block AND carried by a page survives either going away
    ref = guest.post("/api/blocks", json={"parent_id": page["id"], "content": f"[Supplement.pdf]({up['url']})"}).json()
    removed = guest.delete(f"/api/blocks/{ref['id']}").json()["removed_uploads"]
    assert f"{doc_id}.pdf" not in removed and f"{other}.pdf" in removed  # the never-attached one was the orphan
    assert (ws_uploads_dir(workspace_of("guest")) / f"{doc_id}.pdf").exists()


def test_uploaded_files_are_served_with_the_right_headers(guest):
    docx = _upload_file(guest, "report.docx", b"PK\x03\x04report").json()["url"]
    r = guest.get(docx)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.wordprocessingml")
    assert r.headers["content-disposition"].startswith("attachment;")
    assert r.headers["x-content-type-options"] == "nosniff"

    md = _upload_file(guest, "readme.md", b"# hi\n").json()["url"]
    r = guest.get(md)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert "content-disposition" not in r.headers  # inline

    html = _upload_file(guest, "page.html", b"<script>alert(1)</script>").json()["url"]
    r = guest.get(html)
    assert r.status_code == 200 and r.headers["content-disposition"].startswith("attachment;")
    assert "sandbox" in r.headers["content-security-policy"]

    stem = docx.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    assert guest.get(f"/api/uploads/{stem}.exe").status_code == 400


def test_file_chips_keep_files_alive_and_shares_can_read_them(bob_page):
    from gamma.app import app
    bob, page, token = bob_page
    url = _upload_file(bob, "data.json", b'{"k": 1}').json()["url"]
    filename = url.rsplit("/", 1)[-1]
    # unreferenced → the next sweep (a block delete) removes it
    stray = bob.post("/api/blocks", json={"parent_id": page["id"], "content": "stray"}).json()
    assert filename in bob.delete(f"/api/blocks/{stray['id']}").json()["removed_uploads"]
    url = _upload_file(bob, "data.json", b'{"k": 1}').json()["url"]
    chip = bob.post("/api/blocks", json={"parent_id": page["id"], "content": f"[data.json]({url})"}).json()
    stray = bob.post("/api/blocks", json={"parent_id": page["id"], "content": "stray"}).json()
    assert bob.delete(f"/api/blocks/{stray['id']}").json()["removed_uploads"] == []
    # a share of the page reads the referenced file; the unreferenced one is refused
    anon = TestClient(app)
    make_user("pages_dave", "pw")
    dave = login("pages_dave", "pw")
    assert dave.get(url, params={"share": token}).status_code == 200
    other = _upload_file(bob, "secret.csv", b"x,y\n").json()["url"]
    assert dave.get(other, params={"share": token}).status_code == 403
    assert anon.get(url, params={"share": token}).status_code == 401  # audience: users
    bob.delete(f"/api/blocks/{chip['id']}")


def test_markdown_file_block_promotes_to_a_note_page(guest):
    """A .md dropped into a block is a file; POST /pages/from-file turns the
    stored upload into a note page (same importer as /import/markdown),
    once — by-docs then reports the page for the file's hash. Editing the
    page never touches the file."""
    md = b"---\ntitle: Squeezing notes\n---\n# Setup\n\n- first point\n  - nested\n- second point\n"
    up = _upload_file(guest, "Qubit controlled squeezing (2).md", md, "text/markdown").json()
    filename = up["url"].rsplit("/", 1)[-1]
    stem = filename[:-3]
    assert guest.post("/api/pages/by-docs", json={"doc_ids": [stem]}).json() == {"pages": {}}
    r = guest.post("/api/pages/from-file", json={"filename": filename, "folder": "Projects/Rydberg",
                                                 "original": "Qubit controlled squeezing (2).md"})
    assert r.status_code == 200, r.text
    body = r.json()
    page = body["page"]
    assert body["created"] is True and body["imported"] == 4
    assert page["parent_id"] == "root" and page["content"] == "Squeezing notes"
    assert page["properties"]["folder"] == "Projects/Rydberg"
    assert page["properties"]["markdown_import"] == stem and "doc_id" not in page["properties"]
    tree = guest.get(f"/api/blocks/{page['id']}/subtree").json()["block"]["children"]
    assert [b["content"] for b in tree] == ["# Setup", "- first point", "- second point"] or tree[0]["content"].startswith("#")
    # the lookup now names the page, and a second promotion returns it unchanged
    assert guest.post("/api/pages/by-docs", json={"doc_ids": [stem]}).json() == {"pages": {stem: {"id": page["id"], "title": "Squeezing notes"}}}
    again = guest.post("/api/pages/from-file", json={"filename": filename, "folder": "Elsewhere"}).json()
    assert again["created"] is False and again["page"]["id"] == page["id"]
    # editing the page leaves the stored file byte-identical
    guest.put(f"/api/blocks/{tree[0]['id']}", json={"content": "changed"})
    assert guest.get(up["url"]).content == md
    # only stored markdown names qualify
    assert guest.post("/api/pages/from-file", json={"filename": "notes.md"}).status_code == 400
    assert guest.post("/api/pages/from-file", json={"filename": f"{stem}.pdf"}).status_code == 400
    assert guest.post("/api/pages/from-file", json={"filename": "a" * 24 + ".md"}).status_code == 404
    # a title-less file is named after the chip's display name, minus the extension
    up2 = _upload_file(guest, "Plain notes.md", b"just text\n", "text/markdown").json()
    made = guest.post("/api/pages/from-file", json={"filename": up2["url"].rsplit("/", 1)[-1], "original": "Plain notes.md"}).json()
    assert made["page"]["content"] == "Plain notes"


# --- root listing preview ---------------------------------------------------------------

def test_root_listing_carries_a_text_preview(guest):
    empty = make_page(guest, "Empty page")
    page = make_page(guest, "Preview page")
    tree = [
        {"id": "pv1", "content": "First   line\nof notes", "properties": {}, "children": [
            {"id": "pv1a", "content": "nested (not in preview)", "properties": {}, "children": []},
        ]},
        {"id": "pv2", "content": "a highlight", "properties": {"highlight_id": "h", "pdf_position": {}}, "children": []},
        {"id": "pv3", "content": "", "properties": {}, "children": []},
        {"id": "pv4", "content": "Second", "properties": {}, "children": []},
        {"id": "pv5", "content": "x" * 300, "properties": {}, "children": []},
        {"id": "pv6", "content": "never reached", "properties": {}, "children": []},
    ]
    assert guest.put(f"/api/blocks/{page['id']}/children", json={"blocks": tree}).status_code == 200
    by_id = {b["id"]: b for b in guest.get("/api/blocks/root/children").json()["children"]}
    assert by_id[empty["id"]]["preview"] == ""
    preview = by_id[page["id"]]["preview"]
    assert preview.startswith("First line of notes · Second · xxx")
    assert len(preview) == 240 and "highlight" not in preview and "nested" not in preview
    # only the root listing carries previews
    kids = guest.get(f"/api/blocks/{page['id']}/children").json()["children"]
    assert all("preview" not in k for k in kids)


def test_orphan_cleanup_spares_fresh_uploads(guest, monkeypatch):
    """A file is stored BEFORE the page/block referencing it is written; an
    autosave of another page in that window must not sweep it."""
    from gamma import storage
    from gamma.db import ws_uploads_dir
    monkeypatch.setattr(storage, "UPLOAD_GRACE_S", 15 * 60)
    up = guest.post("/api/uploads", files={"file": ("fresh.pdf", io.BytesIO(PDF_BYTES + b"fresh"), "application/pdf")}).json()
    path = ws_uploads_dir(workspace_of("guest")) / f"{up['doc_id']}.pdf"
    assert path.is_file()
    stray = guest.post("/api/blocks", json={"parent_id": "root", "content": "stray"}).json()
    assert guest.delete(f"/api/blocks/{stray['id']}").json()["removed_uploads"] == []
    assert path.is_file()
    monkeypatch.setattr(storage, "UPLOAD_GRACE_S", 0)
    guest.delete(f"/api/blocks/{guest.post('/api/blocks', json={'parent_id': 'root', 'content': 'x'}).json()['id']}")
    assert not path.exists()

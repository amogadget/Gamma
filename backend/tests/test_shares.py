"""Share links are keyed by page, not by PDF — with per-share permissions.

Every page is a root block; a paper's PDF is just a doc_id/source_url on it.
Shares follow the block model: a token names one page (in one workspace) and
confines reads (and edit writes) to that page's subtree and assets — so note
pages without any PDF share exactly like papers. Rows minted by the old
doc-keyed model were re-keyed once by the schema migration
(tests/test_migrations.py covers it).

Permissions: audience (anyone / signed-in users / a list of usernames) gates
who may open the link; role (view / edit) says what they may do. Editing is
scoped to the page's block tree and needs a signed-in editor.
"""


import pytest
from fastapi.testclient import TestClient

from conftest import login, make_user, make_page


@pytest.fixture(scope="module")
def bob():
    make_user("bob_share", "bobpw1234567")
    return login("bob_share", "bobpw1234567")


@pytest.fixture
def anon():
    from gamma.app import app
    return TestClient(app)  # no cookies


def _child(client, parent_id, content):
    r = client.post("/api/blocks", json={"parent_id": parent_id, "content": content})
    assert r.status_code == 200, r.text
    return r.json()


def test_note_page_without_pdf_is_shareable(bob, anon):
    page = make_page(bob, "Plain notes")            # no doc_id, no source_url
    note = _child(bob, page["id"], "a private thought")
    other = make_page(bob, "Another note page")

    r = bob.post(f"/api/share/{page['id']}")
    assert r.status_code == 200, r.text
    token = r.json()["token"]

    resolved = anon.get(f"/api/share/{token}")
    assert resolved.status_code == 200
    assert resolved.json()["page_id"] == page["id"]
    assert resolved.json()["doc_id"] == ""
    assert resolved.json()["username"] == "bob_share"

    q = {"share": token}
    assert anon.get(f"/api/blocks/{page['id']}", params=q).status_code == 200
    assert anon.get(f"/api/blocks/{page['id']}/children", params=q).status_code == 200
    assert anon.get(f"/api/blocks/{note['id']}", params=q).status_code == 200
    tree = anon.get(f"/api/blocks/{page['id']}/subtree", params=q).json()["block"]
    assert [c["content"] for c in tree["children"]] == ["a private thought"]
    # the read-only export path works for a note page too
    assert anon.get(f"/api/pages/{page['id']}/export", params=q).status_code == 200

    # nothing beyond the page
    assert anon.get(f"/api/blocks/{other['id']}", params=q).status_code == 403
    assert anon.get(f"/api/blocks/{other['id']}/children", params=q).status_code == 403
    assert anon.get("/api/blocks/root/children", params=q).status_code == 403
    assert anon.get(f"/api/pages/{other['id']}/export", params=q).status_code == 403
    # and no token at all is still a 401
    assert anon.get(f"/api/blocks/{page['id']}").status_code == 401


def test_only_page_roots_can_be_shared(bob):
    page = make_page(bob, "Root only")
    child = _child(bob, page["id"], "child block")
    assert bob.post(f"/api/share/{child['id']}").status_code == 400
    assert bob.post("/api/share/does_not_exist").status_code == 404


def test_share_token_is_stable_per_page(bob):
    page = make_page(bob, "Stable link")
    t1 = bob.post(f"/api/share/{page['id']}").json()["token"]
    t2 = bob.post(f"/api/share/{page['id']}").json()["token"]
    assert t1 == t2
    other = make_page(bob, "Different page")
    assert bob.post(f"/api/share/{other['id']}").json()["token"] != t1


def test_share_requires_a_session(anon, bob):
    page = make_page(bob, "No anon sharing")
    assert anon.post(f"/api/share/{page['id']}").status_code == 401


def test_share_reads_only_assets_its_page_references(bob, anon):
    png = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    up = bob.post("/api/upload-image", files={"file": ("a.png", png, "image/png")})
    assert up.status_code == 200, up.text
    url = up.json()["url"]

    with_img = make_page(bob, "Has the image")
    _child(bob, with_img["id"], f"look: ![fig]({url})")
    without = make_page(bob, "No image here")

    t_with = bob.post(f"/api/share/{with_img['id']}").json()["token"]
    t_without = bob.post(f"/api/share/{without['id']}").json()["token"]
    assert anon.get(url, params={"share": t_with}).status_code == 200
    assert anon.get(url, params={"share": t_without}).status_code == 403
    assert anon.get(url).status_code == 401


def test_upload_share_refusals_match_the_other_read_endpoints(bob, carol, anon):
    """A wrong or unknown share token on an asset gets auth._share_denied's
    statuses like every other read endpoint: 403 for a signed-in visitor,
    401 for an anonymous one (signing in could help)."""
    png = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    url = bob.post("/api/upload-image", files={"file": ("b.png", png, "image/png")}).json()["url"]
    page = make_page(bob, "Without the image")
    token = bob.post(f"/api/share/{page['id']}").json()["token"]
    assert carol.get(url, params={"share": token}).status_code == 403     # not this page's asset
    assert carol.get(url, params={"share": "no-such-token"}).status_code == 403
    assert anon.get(url, params={"share": "no-such-token"}).status_code == 401
    assert carol.get(url).status_code == 404                               # her own uploads: absent


def test_pdf_proxy_only_serves_the_pages_own_source(bob, anon):
    paper = make_page(bob, "Remote paper",
                      properties={"doc_id": "remote_doc", "source_url": "https://example.com/paper.pdf"})
    notes = make_page(bob, "Just notes")
    t_paper = bob.post(f"/api/share/{paper['id']}").json()["token"]
    t_notes = bob.post(f"/api/share/{notes['id']}").json()["token"]
    other = {"source_url": "https://example.com/other.pdf"}
    assert anon.get("/api/pdf", params={**other, "share": t_paper}).status_code == 403
    assert anon.get("/api/pdf", params={**other, "share": t_notes}).status_code == 403
    assert anon.get("/api/pdf", params={"source_url": "https://example.com/paper.pdf",
                                         "share": t_notes}).status_code == 403


# --- permissions: who may open, what they may do -----------------------------

@pytest.fixture(scope="module")
def carol():
    make_user("carol_share", "carolpw123456")
    return login("carol_share", "carolpw123456")


@pytest.fixture(scope="module")
def dave():
    make_user("dave_share", "davepw1234567")
    return login("dave_share", "davepw1234567")


def _share(owner, page_id, **settings):
    r = owner.post(f"/api/share/{page_id}")
    assert r.status_code == 200, r.text
    if settings:
        r = owner.put(f"/api/share-settings/{page_id}", json=settings)
        assert r.status_code == 200, r.text
    return r.json()


def test_share_settings_roundtrip(bob, carol, anon):
    page = make_page(bob, "Settings page")
    assert bob.get(f"/api/share-settings/{page['id']}").json()["token"] is None

    created = bob.post(f"/api/share/{page['id']}").json()
    assert (created["audience"], created["role"], created["users"]) == ("anyone", "view", [])
    token = created["token"]
    assert bob.get(f"/api/share-settings/{page['id']}").json()["token"] == token

    # editing needs a signed-in audience
    r = bob.put(f"/api/share-settings/{page['id']}", json={"role": "edit"})
    assert r.status_code == 400 and "signed-in" in r.json()["detail"]
    r = bob.put(f"/api/share-settings/{page['id']}", json={"audience": "users", "role": "edit"})
    assert r.status_code == 200 and r.json()["role"] == "edit"
    assert r.json()["token"] == token  # the link itself never changes
    # unknown names are refused; the owner and duplicates are dropped
    r = bob.put(f"/api/share-settings/{page['id']}", json={"audience": "list", "users": ["nobody_here"]})
    assert r.status_code == 400 and "nobody_here" in r.json()["detail"]
    r = bob.put(f"/api/share-settings/{page['id']}",
                json={"audience": "list", "users": [" carol_share ", "bob_share", "carol_share"]})
    assert r.status_code == 200 and r.json()["users"] == [{"name": "carol_share", "role": "view"}]
    assert bob.put(f"/api/share-settings/{page['id']}",
                   json={"users": [{"name": "carol_share", "role": "owner"}]}).status_code == 400
    assert bob.put(f"/api/share-settings/{page['id']}", json={"audience": "everyone"}).status_code == 400
    assert bob.put(f"/api/share-settings/{page['id']}", json={"role": "admin"}).status_code == 400
    # only the owner manages the share
    assert carol.get(f"/api/share-settings/{page['id']}").status_code == 404
    assert carol.put(f"/api/share-settings/{page['id']}", json={"role": "view"}).status_code == 404
    assert anon.put(f"/api/share-settings/{page['id']}", json={"role": "view"}).status_code == 401

    # stop sharing kills the token; sharing again mints a new one
    assert bob.delete(f"/api/share-settings/{page['id']}").json()["removed"] == 1
    assert anon.get(f"/api/share/{token}").status_code == 404
    assert bob.get(f"/api/share-settings/{page['id']}").json()["token"] is None
    assert bob.post(f"/api/share/{page['id']}").json()["token"] != token


def test_signed_in_visitor_reads_the_owners_page(bob, carol):
    """A ?share= token decides WHOSE data is read — a signed-in visitor sees
    the owner's page, not a lookup in their own library."""
    page = make_page(bob, "Bob's public page")
    token = _share(bob, page["id"])["token"]
    r = carol.get(f"/api/blocks/{page['id']}", params={"share": token})
    assert r.status_code == 200 and r.json()["content"] == "Bob's public page"
    # ...and still only that page
    other = make_page(bob, "Bob's other page")
    assert carol.get(f"/api/blocks/{other['id']}", params={"share": token}).status_code == 403
    # an unknown token never falls back to the visitor's own account
    assert carol.get(f"/api/blocks/{page['id']}", params={"share": "bogus-token"}).status_code == 403


def test_users_audience_needs_a_real_account(bob, carol, guest, anon):
    page = make_page(bob, "Members only")
    token = _share(bob, page["id"], audience="users")["token"]
    assert anon.get(f"/api/share/{token}").status_code == 401
    assert anon.get(f"/api/blocks/{page['id']}", params={"share": token}).status_code == 401
    assert guest.get(f"/api/share/{token}").status_code == 401
    r = carol.get(f"/api/share/{token}")
    assert r.status_code == 200
    assert (r.json()["can_edit"], r.json()["viewer"]) == (False, "carol_share")
    assert carol.get(f"/api/blocks/{page['id']}/subtree", params={"share": token}).status_code == 200
    # the owner always gets in — and may edit
    assert bob.get(f"/api/share/{token}").json()["can_edit"] is True


def test_list_audience_admits_only_named_users(bob, carol, dave, anon):
    page = make_page(bob, "For Carol")
    token = _share(bob, page["id"], audience="list", users=["carol_share"])["token"]
    assert carol.get(f"/api/share/{token}").status_code == 200
    assert carol.get(f"/api/blocks/{page['id']}", params={"share": token}).status_code == 200
    r = dave.get(f"/api/share/{token}")
    assert r.status_code == 403 and "specific people" in r.json()["detail"]
    assert dave.get(f"/api/blocks/{page['id']}", params={"share": token}).status_code == 403
    assert anon.get(f"/api/share/{token}").status_code == 401


def test_invited_people_get_in_with_their_own_role(bob, carol, dave, anon):
    """Invitations are additive to general access: an invited person opens the
    page whatever the audience is, with the role on their invitation."""
    page = make_page(bob, "Invite-only draft")
    token = _share(bob, page["id"], audience="anyone",
                   users=[{"name": "carol_share", "role": "edit"}])["token"]
    assert carol.get(f"/api/share/{token}").json()["can_edit"] is True
    assert dave.get(f"/api/share/{token}").json()["can_edit"] is False   # general access: view
    assert anon.get(f"/api/share/{token}").json()["can_edit"] is False
    # closing general access keeps the invitation working
    bob.put(f"/api/share-settings/{page['id']}", json={"audience": "list"})
    assert carol.get(f"/api/share/{token}").json()["can_edit"] is True
    assert carol.put(f"/api/blocks/{page['id']}/children", params={"share": token},
                     json={"blocks": [{"id": "inv1", "content": "hi", "properties": {}, "children": []}]}).status_code == 200
    assert dave.get(f"/api/share/{token}").status_code == 403
    # an invited person's role can be lowered
    bob.put(f"/api/share-settings/{page['id']}", json={"users": [{"name": "carol_share", "role": "view"}]})
    assert carol.get(f"/api/share/{token}").json()["can_edit"] is False
    assert carol.put(f"/api/blocks/{page['id']}/children", params={"share": token},
                     json={"blocks": []}).status_code == 403


def test_view_role_never_writes(bob, carol, anon):
    page = make_page(bob, "Look, don't touch")
    token = _share(bob, page["id"], audience="users")["token"]  # role view
    q = {"share": token}
    r = carol.put(f"/api/blocks/{page['id']}/children", params=q, json={"blocks": []})
    assert r.status_code == 403 and "view-only" in r.json()["detail"]
    assert carol.post("/api/blocks", params=q, json={"parent_id": page["id"], "content": "x"}).status_code == 403
    assert carol.put(f"/api/blocks/{page['id']}", params=q, json={"content": "renamed"}).status_code == 403
    # anonymous viewers of an "anyone" link can't write either (their grant
    # is valid but view-only, hence 403 rather than a sign-in 401)
    _share(bob, page["id"], audience="anyone")
    assert anon.put(f"/api/blocks/{page['id']}/children", params=q, json={"blocks": []}).status_code == 403
    assert bob.get(f"/api/blocks/{page['id']}").json()["content"] == "Look, don't touch"


def test_edit_role_writes_inside_the_page_only(bob, carol, dave):
    page = make_page(bob, "Shared draft", properties={"doc_id": "draft_doc"})
    keep = _child(bob, page["id"], "owner's line")
    other = make_page(bob, "Bob's private page")
    token = _share(bob, page["id"], audience="list",
                   users=[{"name": "carol_share", "role": "edit"}])["token"]
    q = {"share": token}

    # the editor autosaves the whole tree (what the frontend does)
    tree = [{"id": keep["id"], "content": "owner's line, edited", "properties": {}, "children": []},
            {"id": "carolblk1", "content": "carol's addition", "properties": {}, "children": []}]
    r = carol.put(f"/api/blocks/{page['id']}/children", params=q, json={"blocks": tree})
    assert r.status_code == 200, r.text
    got = bob.get(f"/api/blocks/{page['id']}/subtree").json()["block"]["children"]
    assert [c["content"] for c in got] == ["owner's line, edited", "carol's addition"]

    # single-block writes inside the page
    r = carol.post("/api/blocks", params=q, json={"parent_id": page["id"], "content": "one more"})
    assert r.status_code == 200, r.text
    new_id = r.json()["id"]
    assert carol.put(f"/api/blocks/{new_id}", params=q, json={"content": "one more, fixed"}).status_code == 200
    assert carol.post(f"/api/blocks/{new_id}/reorder", params=q,
                      json={"parent_id": keep["id"], "before": None, "after": None}).status_code == 200
    assert carol.delete(f"/api/blocks/{new_id}", params=q).status_code == 200
    # renaming the page is a content write — allowed; its properties are not
    assert carol.put(f"/api/blocks/{page['id']}", params=q, json={"content": "Shared draft (v2)"}).status_code == 200
    r = carol.put(f"/api/blocks/{page['id']}", params=q, json={"properties": {"source_url": "https://evil/x.pdf"}})
    assert r.status_code == 403
    assert bob.get(f"/api/blocks/{page['id']}").json()["properties"]["doc_id"] == "draft_doc"

    # nothing outside the page, and never the page itself
    assert carol.delete(f"/api/blocks/{page['id']}", params=q).status_code == 403
    assert carol.post("/api/blocks", params=q, json={"parent_id": "root", "content": "new page"}).status_code == 403
    assert carol.post("/api/blocks", params=q, json={"parent_id": other["id"], "content": "x"}).status_code == 403
    assert carol.put(f"/api/blocks/{other['id']}/children", params=q, json={"blocks": []}).status_code == 403
    assert carol.put(f"/api/blocks/{other['id']}", params=q, json={"content": "x"}).status_code == 403
    assert carol.post(f"/api/blocks/{keep['id']}/reorder", params=q,
                      json={"parent_id": other["id"], "before": None, "after": None}).status_code == 403
    assert carol.post(f"/api/blocks/{keep['id']}/reorder", params=q,
                      json={"parent_id": "root", "before": None, "after": None}).status_code == 403
    assert bob.get(f"/api/blocks/{other['id']}").json()["content"] == "Bob's private page"
    # someone not on the list gets nothing, even with the edit link
    assert dave.put(f"/api/blocks/{page['id']}/children", params=q, json={"blocks": tree}).status_code == 403
    # and without the token the editor's own account is untouched by all this
    assert carol.get(f"/api/blocks/{page['id']}").status_code == 404


def test_share_editor_images_land_in_the_owners_uploads(bob, carol):
    page = make_page(bob, "Draft with figure")
    token = _share(bob, page["id"], audience="users", role="edit")["token"]
    png = b"\x89PNG\r\n\x1a\n" + b"\x01" * 80
    r = carol.post("/api/upload-image", params={"share": token}, files={"file": ("f.png", png, "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert bob.get(url).status_code == 200          # it is bob's file now
    assert carol.get(url).status_code == 404        # not in carol's own uploads
    # view-only links can't upload
    _share(bob, page["id"], role="view")
    r = carol.post("/api/upload-image", params={"share": token}, files={"file": ("g.png", png, "image/png")})
    assert r.status_code == 403


def test_share_reads_are_cors_open_and_importable(bob, anon):
    """Another Gamma imports a shared page browser-side: resolve the token,
    fetch the page as a Gamma export, merge the zip into its own library. Share
    GETs answer Access-Control-Allow-Origin: * for that; nothing else does."""
    page = make_page(bob, "Shared across Gammas")
    _child(bob, page["id"], "carried along")
    token = bob.post(f"/api/share/{page['id']}").json()["token"]

    resolved = anon.get(f"/api/share/{token}")
    assert resolved.status_code == 200
    assert resolved.headers.get("access-control-allow-origin") == "*"
    assert resolved.json()["viewer"] == ""
    assert resolved.json()["viewer_is_guest"] is False

    zipped = anon.get(f"/api/pages/{page['id']}/export", params={"mode": "gamma", "share": token})
    assert zipped.status_code == 200, zipped.text
    assert zipped.headers.get("access-control-allow-origin") == "*"

    # Writes and non-share reads keep the same-origin default.
    assert "access-control-allow-origin" not in bob.get("/api/blocks/root/children").headers
    assert "access-control-allow-origin" not in bob.post(f"/api/share/{page['id']}").headers

    make_user("dana_share", "danapw1234567")
    dana = login("dana_share", "danapw1234567")
    r = dana.post("/api/import-data?mode=merge",
                   files={"file": ("shared-page.zip", zipped.content, "application/zip")})
    assert r.status_code == 200, r.text
    assert r.json()["pages_added"] == 1
    # Same block ids, so the link's page id opens straight in dana's library.
    got = dana.get(f"/api/blocks/{page['id']}/subtree").json()["block"]
    assert got["content"] == "Shared across Gammas"
    assert [c["content"] for c in got["children"]] == ["carried along"]

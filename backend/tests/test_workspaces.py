"""Workspaces: accounts and libraries are separate things. Every account has
a personal workspace; more can be created and shared with other accounts
under a role (owner / editor / viewer). A request picks its workspace with
?ws= or the X-Gamma-Workspace header, else lands in the personal one."""

import pytest
from fastapi.testclient import TestClient

from conftest import login, make_page, make_user, workspace_of


@pytest.fixture(scope="module")
def ann():
    make_user("ws_ann", "annpw12345")
    return login("ws_ann", "annpw12345")


@pytest.fixture(scope="module")
def ben():
    make_user("ws_ben", "benpw12345")
    return login("ws_ben", "benpw12345")


@pytest.fixture(scope="module")
def cid():
    make_user("ws_cid", "cidpw12345")
    return login("ws_cid", "cidpw12345")


@pytest.fixture(scope="module")
def boss():
    make_user("ws_boss", "bosspw12345", is_admin=1)
    return login("ws_boss", "bosspw12345")


@pytest.fixture(scope="module")
def lab(ann, ben, cid):
    """A shared workspace: ann owns it, ben edits, cid views."""
    r = ann.post("/api/workspaces", json={"name": "Rydberg lab"})
    assert r.status_code == 200, r.text
    ws = r.json()
    assert ws["role"] == "owner" and ws["personal"] is False
    assert ann.put(f"/api/workspaces/{ws['id']}/members/ws_ben", json={"role": "editor"}).status_code == 200
    assert ann.put(f"/api/workspaces/{ws['id']}/members/ws_cid", json={"role": "viewer"}).status_code == 200
    return ws["id"]


def _in(ws):
    return {"X-Gamma-Workspace": ws}


def test_session_lists_workspaces(ann, lab):
    s = ann.get("/api/session").json()
    assert s["default_workspace"] == workspace_of("ws_ann")
    mine = {w["id"]: w for w in s["workspaces"]}
    assert mine[s["default_workspace"]]["personal"] is True and mine[s["default_workspace"]]["role"] == "owner"
    assert mine[lab]["name"] == "Rydberg lab" and mine[lab]["members"] == 3
    assert s["workspaces"][0]["personal"] is True  # personal first


def test_requests_land_in_the_personal_workspace_by_default(ann, lab):
    page = make_page(ann, "Personal note")
    assert page["id"] in [b["id"] for b in ann.get("/api/blocks/root/children").json()["children"]]
    # the shared workspace has its own, separate library
    r = ann.get("/api/blocks/root/children", headers=_in(lab))
    assert r.status_code == 200 and page["id"] not in [b["id"] for b in r.json()["children"]]
    # ?ws= and the header are equivalent; ?ws= wins when both are given
    assert ann.get(f"/api/blocks/{page['id']}", params={"ws": lab}).status_code == 404
    assert ann.get(f"/api/blocks/{page['id']}", params={"ws": workspace_of("ws_ann")}, headers=_in(lab)).status_code == 200


def test_non_members_and_viewers(ann, ben, cid, lab):
    other = make_user("ws_dan", "danpw12345")  # not a member
    dan = login("ws_dan", "danpw12345")
    assert dan.get("/api/blocks/root/children", headers=_in(lab)).status_code == 403
    assert dan.get(f"/api/workspaces/{lab}").status_code == 404  # existence not revealed
    assert dan.post("/api/blocks", json={"parent_id": "root", "content": "x"}, headers=_in(lab)).status_code == 403
    assert dan.get("/api/session").json()["default_workspace"] == other

    page = ann.post("/api/blocks", json={"parent_id": "root", "content": "Lab page"}, headers=_in(lab)).json()
    # editor writes, viewer reads only
    r = ben.post("/api/blocks", json={"parent_id": page["id"], "content": "ben's note"}, headers=_in(lab))
    assert r.status_code == 200, r.text
    assert cid.get(f"/api/blocks/{page['id']}/subtree", headers=_in(lab)).status_code == 200
    assert cid.post("/api/blocks", json={"parent_id": page["id"], "content": "no"}, headers=_in(lab)).status_code == 403
    assert cid.post(f"/api/pages/{page['id']}/ops", headers=_in(lab), json={
        "client": "c", "ops": [{"op": "set", "id": page["id"], "content": "renamed"}]}).status_code == 403
    assert cid.put(f"/api/blocks/{page['id']}", json={"content": "renamed"}, headers=_in(lab)).status_code == 403
    assert cid.post("/api/pages", json={"title": "x"}, headers=_in(lab)).status_code == 403
    assert cid.post("/api/uploads", files={"file": ("a.pdf", b"%PDF-1.4 x", "application/pdf")},
                    headers=_in(lab)).status_code == 403
    # an editor's op carries their own name
    r = ben.post(f"/api/pages/{page['id']}/ops", headers=_in(lab), json={
        "client": "c", "ops": [{"op": "set", "id": page["id"], "content": "Lab page!"}]})
    assert r.status_code == 200, r.text
    log = ann.get(f"/api/pages/{page['id']}/ops", params={"since": 0}, headers=_in(lab)).json()
    assert log["batches"][-1]["actor"] == "ws_ben"


def test_owner_only_management_and_rails(ann, ben, cid, lab):
    assert ben.put(f"/api/workspaces/{lab}", json={"name": "Mine now"}).status_code == 403
    assert ben.put(f"/api/workspaces/{lab}/members/ws_cid", json={"role": "editor"}).status_code == 403
    assert ben.delete(f"/api/workspaces/{lab}").status_code == 403
    assert ann.put(f"/api/workspaces/{lab}", json={"name": "  Rydberg   lab  "}).json()["name"] == "Rydberg lab"
    assert ann.put(f"/api/workspaces/{lab}", json={"name": "   "}).status_code == 400
    # bad roles, unknown accounts, the guest, the last owner
    assert ann.put(f"/api/workspaces/{lab}/members/ws_cid", json={"role": "king"}).status_code == 400
    assert ann.put(f"/api/workspaces/{lab}/members/nobody-here", json={"role": "viewer"}).status_code == 400
    assert ann.put(f"/api/workspaces/{lab}/members/guest", json={"role": "viewer"}).status_code == 400
    assert ann.put(f"/api/workspaces/{lab}/members/ws_ann", json={"role": "editor"}).status_code == 400
    assert ann.delete(f"/api/workspaces/{lab}/members/ws_ann").status_code == 400
    # a second owner can be named, then the first may step down
    assert ann.put(f"/api/workspaces/{lab}/members/ws_ben", json={"role": "owner"}).status_code == 200
    assert ann.put(f"/api/workspaces/{lab}/members/ws_ann", json={"role": "editor"}).status_code == 200
    assert ben.put(f"/api/workspaces/{lab}/members/ws_ann", json={"role": "owner"}).status_code == 200
    assert ann.put(f"/api/workspaces/{lab}/members/ws_ben", json={"role": "editor"}).status_code == 200
    # members leave themselves; nobody leaves their personal workspace
    assert cid.delete(f"/api/workspaces/{lab}/members/ws_cid").json()["left"] is True
    assert cid.get("/api/blocks/root/children", headers=_in(lab)).status_code == 403
    assert ann.put(f"/api/workspaces/{lab}/members/ws_cid", json={"role": "viewer"}).status_code == 200
    mine = workspace_of("ws_ann")
    assert ann.delete(f"/api/workspaces/{mine}/members/ws_ann").status_code == 400
    assert ann.delete(f"/api/workspaces/{mine}").status_code == 400
    # the member list is what the owner set
    members = {m["username"]: m["role"] for m in ann.get(f"/api/workspaces/{lab}").json()["members"]}
    assert members == {"ws_ann": "owner", "ws_ben": "editor", "ws_cid": "viewer"}


def test_guest_cannot_create_or_join(guest):
    assert guest.post("/api/workspaces", json={"name": "x"}).status_code == 403
    s = guest.get("/api/session").json()
    assert len(s["workspaces"]) == 1 and s["workspaces"][0]["personal"]


def test_find_page_across_my_workspaces(ann, lab):
    page = ann.post("/api/blocks", json={"parent_id": "root", "content": "Deep link"}, headers=_in(lab)).json()
    assert ann.get(f"/api/workspaces/find-page/{page['id']}").json()["workspace_id"] == lab
    assert ann.get("/api/workspaces/find-page/nope").status_code == 404


def test_shares_are_keyed_by_workspace(ann, ben, cid, lab):
    """A share link names the page's workspace: it opens that workspace's
    page for outsiders, and workspace members keep their own role on top."""
    from gamma.app import app
    page = ann.post("/api/blocks", json={"parent_id": "root", "content": "Shared lab page"}, headers=_in(lab)).json()
    # an editor may share, a viewer may not
    assert cid.post(f"/api/share/{page['id']}", headers=_in(lab)).status_code == 403
    r = ben.post(f"/api/share/{page['id']}", json={"audience": "users", "role": "view"}, headers=_in(lab))
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    assert r.json()["created_by"] == "ws_ben"
    # the same page id does not exist in ben's personal workspace — sharing there is a 404
    assert ben.post(f"/api/share/{page['id']}").status_code == 404

    anon = TestClient(app)
    assert anon.get(f"/api/share/{token}").status_code == 401  # signed-in users only
    dan = login("ws_dan", "danpw12345")  # not a member: gets the share's view role
    info = dan.get(f"/api/share/{token}").json()
    assert info["workspace_id"] == lab and info["can_edit"] is False and info["username"] == "ws_ben"
    assert dan.get(f"/api/blocks/{page['id']}", params={"share": token}).status_code == 200
    assert dan.put(f"/api/blocks/{page['id']}", json={"content": "x"}, params={"share": token}).status_code == 403
    # a workspace editor opening the link keeps editing; a viewer stays a viewer
    assert ben.get(f"/api/share/{token}").json()["can_edit"] is True
    assert cid.get(f"/api/share/{token}").json()["can_edit"] is False
    # inviting the outsider as an editor lets them write inside the page only
    assert ben.put(f"/api/share-settings/{page['id']}", json={"users": [{"name": "ws_dan", "role": "edit"}]},
                   headers=_in(lab)).status_code == 200
    r = dan.post("/api/blocks", json={"parent_id": page["id"], "content": "dan was here"}, params={"share": token})
    assert r.status_code == 200, r.text
    assert dan.get("/api/blocks/root/children", params={"share": token}).status_code == 403
    # the websocket admits the share (viewer) and the member (editor) alike
    with dan.websocket_connect(f"/api/ws/page/{page['id']}?share={token}&client=d1") as sock:
        assert sock.receive_json()["t"] == "hello"
    with ben.websocket_connect(f"/api/ws/page/{page['id']}?ws={lab}&client=b1") as sock:
        hello = sock.receive_json()
        assert hello["t"] == "hello"
    with cid.websocket_connect(f"/api/ws/page/{page['id']}?ws={lab}&client=c1") as sock:
        hello = sock.receive_json()
        assert hello["t"] == "hello"
    # ben, not a member of ann's personal workspace, cannot reach the page there
    assert ben.get(f"/api/blocks/{page['id']}", params={"ws": workspace_of("ws_ann")}).status_code == 403


def test_prefs_follow_account_and_workspace(ann, lab):
    mine = workspace_of("ws_ann")
    assert ann.put("/api/prefs/open-tabs", json={"value": ["p1"]}, headers=_in(mine)).status_code == 200
    assert ann.put("/api/prefs/open-tabs", json={"value": ["lab1"]}, headers=_in(lab)).status_code == 200
    assert ann.get("/api/prefs/open-tabs", headers=_in(mine)).json()["value"] == ["p1"]
    assert ann.get("/api/prefs/open-tabs", headers=_in(lab)).json()["value"] == ["lab1"]
    # appearance and the AI provider choice are account-wide
    assert ann.put("/api/prefs/appearance", json={"value": {"theme": "dark", "pdfDark": False}}, headers=_in(lab)).status_code == 200
    assert ann.get("/api/prefs/appearance", headers=_in(mine)).json()["value"]["theme"] == "dark"


def test_only_personal_workspaces_count_as_usage(boss, ann, ben, lab):
    """An account's usage is its personal workspace's uploads, nothing else;
    a shared workspace has its own optional quota that admins set."""
    from gamma import server_settings
    q = ann.get("/api/quota", headers=_in(lab)).json()
    assert q["account"] == "" and q["quota_mb"] == 0 and "workspace_bytes" in q
    assert ann.get("/api/quota").json()["account"] == "ws_ann"
    ann_before = ann.get("/api/quota").json()["used_bytes"]
    ben_before = ben.get("/api/quota").json()["used_bytes"]
    r = ben.post("/api/uploads", files={"file": ("b.pdf", b"%PDF-1.4 lab upload bytes", "application/pdf")},
                 headers=_in(lab))
    assert r.status_code == 200, r.text
    assert ann.get("/api/quota").json()["used_bytes"] == ann_before
    assert ben.get("/api/quota").json()["used_bytes"] == ben_before == server_settings.usage_bytes("ws_ben")
    assert ann.get("/api/quota", headers=_in(lab)).json()["workspace_bytes"] > 0
    # the workspace's own quota: admin-only, 0/null = unlimited, enforced on upload
    assert ann.put(f"/api/workspaces/{lab}", json={"quota_mb": 1}).status_code == 403
    r = boss.put(f"/api/workspaces/{lab}", json={"quota_mb": 1})
    assert r.status_code == 200 and r.json()["quota_mb"] == 1 and r.json()["quota"]["quota_mb"] == 1
    big = b"%PDF-1.4 " + b"x" * (2 * 1024 * 1024)
    assert ben.post("/api/uploads", files={"file": ("big.pdf", big, "application/pdf")},
                    headers=_in(lab)).status_code == 507
    assert ben.post("/api/uploads", files={"file": ("big.pdf", big, "application/pdf")}).status_code == 200
    assert boss.put(f"/api/workspaces/{lab}", json={"quota_mb": 0}).json()["quota_mb"] is None
    mine = workspace_of("ws_ann")
    assert boss.put(f"/api/workspaces/{mine}", json={"quota_mb": 5}).status_code == 400  # personal: account quota


def test_accounts_directory(ann, guest):
    """The invite / owner pickers list every non-guest account."""
    names = [a["username"] for a in ann.get("/api/accounts").json()["accounts"]]
    assert "ws_ann" in names and "ws_ben" in names and "guest" not in names
    assert guest.get("/api/accounts").status_code == 403


def test_admin_manages_every_workspace_without_membership(boss, ann, ben, lab):
    listing = boss.get("/api/admin/workspaces").json()
    mine = next(w for w in listing["workspaces"] if w["id"] == lab)
    assert mine["personal"] == "" and mine["access"] == "private"
    assert {m["username"] for m in mine["members"]} == {"ws_ann", "ws_ben", "ws_cid"}
    assert next(w for w in listing["workspaces"] if w["id"] == workspace_of("ws_ann"))["personal"] == "ws_ann"
    # the admin is no member: it inspects and manages, but reads no pages
    r = boss.get(f"/api/workspaces/{lab}")
    assert r.status_code == 200 and r.json()["role"] is None and r.json()["quota"]["account"] == ""
    assert boss.get("/api/blocks/root/children", headers=_in(lab)).status_code == 403
    assert boss.put(f"/api/workspaces/{lab}", json={"name": "Rydberg lab"}).status_code == 200
    assert boss.put(f"/api/workspaces/{lab}/members/ws_boss", json={"role": "owner"}).status_code == 200
    assert boss.get("/api/blocks/root/children", headers=_in(lab)).status_code == 200
    assert boss.delete(f"/api/workspaces/{lab}/members/ws_boss").status_code == 200
    # users listing carries the personal workspace id
    users = {u["username"]: u for u in boss.get("/api/admin/users").json()["users"]}
    assert users["ws_ann"]["default_workspace"] == workspace_of("ws_ann")


def test_admin_creates_a_workspace_for_someone_and_hands_out_ownership(boss, ann, ben):
    # only admins name an owner or an access setting
    assert ann.post("/api/workspaces", json={"name": "x", "owner": "ws_ben"}).status_code == 403
    assert ann.post("/api/workspaces", json={"name": "x", "access": "public"}).status_code == 403
    assert boss.post("/api/workspaces", json={"name": "x", "owner": "nobody"}).status_code == 400
    assert boss.post("/api/workspaces", json={"name": "x", "owner": "guest"}).status_code == 400
    r = boss.post("/api/workspaces", json={"name": "Ann's course", "owner": "ws_ann"})
    assert r.status_code == 200, r.text
    ws = r.json()
    assert ws["created_by"] == "ws_boss" and ws["role"] is None and ws["access"] == "private"
    assert [m["username"] for m in ws["members"]] == ["ws_ann"] and ws["members"][0]["added_by"] == "ws_boss"
    assert ann.get(f"/api/workspaces/{ws['id']}").json()["role"] == "owner"
    # ownership is handed on through the owner role, by the admin
    assert boss.put(f"/api/workspaces/{ws['id']}/members/ws_ben", json={"role": "owner"}).status_code == 200
    assert boss.put(f"/api/workspaces/{ws['id']}/members/ws_ann", json={"role": "editor"}).status_code == 200
    members = {m["username"]: m["role"] for m in ben.get(f"/api/workspaces/{ws['id']}").json()["members"]}
    assert members == {"ws_ben": "owner", "ws_ann": "editor"}
    assert boss.delete(f"/api/workspaces/{ws['id']}").status_code == 200


def test_public_workspaces(boss, ann, ben, guest):
    """A public workspace is open to every signed-in account at its public
    role, with no join step; explicit members keep their own role."""
    r = boss.post("/api/workspaces", json={"name": "Reading room", "access": "public", "public_role": "viewer"})
    assert r.status_code == 200, r.text
    room = r.json()["id"]
    assert r.json()["access"] == "public" and r.json()["role"] == "owner"
    dan = login("ws_dan", "danpw12345")  # no membership anywhere near it
    listed = {w["id"]: w for w in dan.get("/api/session").json()["workspaces"]}
    assert listed[room]["role"] == "viewer" and listed[room]["access"] == "public" and listed[room]["members"] == 1
    page = boss.post("/api/blocks", json={"parent_id": "root", "content": "Open page"}, headers=_in(room)).json()
    assert dan.get(f"/api/blocks/{page['id']}", headers=_in(room)).status_code == 200
    assert dan.post("/api/blocks", json={"parent_id": page["id"], "content": "no"}, headers=_in(room)).status_code == 403
    assert dan.get(f"/api/workspaces/{room}").json()["role"] == "viewer"
    # public access is not a membership: nothing to leave, no owner powers
    assert dan.delete(f"/api/workspaces/{room}/members/ws_dan").status_code == 400
    assert dan.put(f"/api/workspaces/{room}", json={"name": "Mine"}).status_code == 403
    # the guest sees nothing of it
    assert guest.get(f"/api/blocks/{page['id']}", headers=_in(room)).status_code == 403
    assert room not in [w["id"] for w in guest.get("/api/session").json()["workspaces"]]
    # public editors write; an explicit member's role wins over the public one
    assert boss.put(f"/api/workspaces/{room}", json={"public_role": "editor"}).json()["public_role"] == "editor"
    assert dan.post("/api/blocks", json={"parent_id": page["id"], "content": "dan"}, headers=_in(room)).status_code == 200
    assert boss.put(f"/api/workspaces/{room}/members/ws_ann", json={"role": "viewer"}).status_code == 200
    assert ann.post("/api/blocks", json={"parent_id": page["id"], "content": "ann"}, headers=_in(room)).status_code == 403
    assert ann.get(f"/api/workspaces/{room}").json()["role"] == "viewer"
    # only admins set access; a personal workspace stays private
    assert ann.put(f"/api/workspaces/{room}", json={"access": "private"}).status_code == 403
    assert boss.put(f"/api/workspaces/{workspace_of('ws_ann')}", json={"access": "public"}).status_code == 400
    assert boss.put(f"/api/workspaces/{room}", json={"access": "club"}).status_code == 400
    # back to private: dan is out, ann (a member) stays
    assert boss.put(f"/api/workspaces/{room}", json={"access": "private"}).json()["access"] == "private"
    assert dan.get(f"/api/blocks/{page['id']}", headers=_in(room)).status_code == 403
    assert room not in [w["id"] for w in dan.get("/api/session").json()["workspaces"]]
    assert ann.get(f"/api/blocks/{page['id']}", headers=_in(room)).status_code == 200
    assert boss.delete(f"/api/workspaces/{room}").status_code == 200


def test_export_and_restore_are_per_workspace(ann, ben, cid, lab):
    import io, json, zipfile
    page = ann.post("/api/blocks", json={"parent_id": "root", "content": "Backup me"}, headers=_in(lab)).json()
    r = cid.get("/api/export", params={"uploads": 0}, headers=_in(lab))  # any member may export
    assert r.status_code == 200
    manifest = json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("manifest.json"))
    assert manifest["workspace"] == lab and manifest["exported_by"] == "ws_cid" and manifest["user"] == "ws_ann"
    # restore (replace) is owner-only; merge needs an editor
    files = {"file": ("b.zip", r.content, "application/zip")}
    assert ben.post("/api/import-data", files=files, headers=_in(lab)).status_code == 403
    assert cid.post("/api/import-data?mode=merge", files=files, headers=_in(lab)).status_code == 403
    r2 = ben.post("/api/import-data?mode=merge", files=files, headers=_in(lab))
    assert r2.status_code == 200 and r2.json()["workspace"] == lab and r2.json()["pages_skipped"] >= 1
    # the same backup merged into ben's personal workspace lands there, not in the lab
    r3 = ben.post("/api/import-data?mode=merge", files=files)
    assert r3.status_code == 200 and r3.json()["pages_added"] >= 1
    assert ben.get(f"/api/blocks/{page['id']}").status_code == 200


def test_deleting_an_account_keeps_workspaces_with_other_owners(boss):
    make_user("ws_eve", "evepw12345")
    make_user("ws_fay", "faypw12345")
    eve, fay = login("ws_eve", "evepw12345"), login("ws_fay", "faypw12345")
    solo = eve.post("/api/workspaces", json={"name": "Eve solo"}).json()["id"]
    duo = eve.post("/api/workspaces", json={"name": "Eve+Fay"}).json()["id"]
    assert eve.put(f"/api/workspaces/{duo}/members/ws_fay", json={"role": "owner"}).status_code == 200
    personal = workspace_of("ws_eve")
    r = boss.delete("/api/admin/users/ws_eve")
    assert r.status_code == 200, r.text
    assert sorted(r.json()["deleted_workspaces"]) == sorted([personal, solo])
    from gamma import workspaces
    assert workspaces.get(duo) and workspaces.role_of(duo, "ws_fay") == "owner"
    assert workspaces.get(solo) is None and workspaces.get(personal) is None
    assert fay.get("/api/blocks/root/children", headers=_in(duo)).status_code == 200

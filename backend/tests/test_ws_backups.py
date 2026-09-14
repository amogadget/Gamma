"""Per-workspace backups (/api/workspaces/{ws}/backups*, gamma/ws_backup.py):
take a snapshot, list, download, restore in place (replace / merge), delete;
who may do what; the cap; snapshots go with the workspace. Plus /export-all
(every personal workspace of an account in one zip) and /workspaces/mine."""

import io
import json
import zipfile

import pytest

from conftest import login, make_page, make_user, workspace_of


@pytest.fixture(scope="module")
def owner():
    make_user("bk_owner", "bkownerpw1")
    return login("bk_owner", "bkownerpw1")


@pytest.fixture(scope="module")
def other():
    make_user("bk_other", "bkotherpw1")
    return login("bk_other", "bkotherpw1")


@pytest.fixture(scope="module")
def boss():
    make_user("bk_boss", "bkbosspw1", is_admin=1)
    return login("bk_boss", "bkbosspw1")


def _in(ws):
    return {"X-Gamma-Workspace": ws}


def test_snapshot_round_trip(owner, other):
    ws = workspace_of("bk_owner")
    up = owner.post("/api/uploads", files={"file": ("a.pdf", b"%PDF-1.4 snapshot me", "application/pdf")})
    assert up.status_code == 200
    page = make_page(owner, "Before the snapshot", properties={"source_url": up.json()["source_url"]})
    assert owner.get(f"/api/workspaces/{ws}/backups").json() == {"backups": [], "max": 20}

    r = owner.post(f"/api/workspaces/{ws}/backups", json={"label": "before", "uploads": True})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["name"].endswith("-before") and b["uploads"] is True and b["upload_files"] == 1 and b["by"] == "bk_owner"
    small = owner.post(f"/api/workspaces/{ws}/backups", json={"label": "db", "uploads": False}).json()
    assert small["uploads"] is False and small["size_bytes"] < b["size_bytes"]
    listed = owner.get(f"/api/workspaces/{ws}/backups").json()["backups"]
    assert [x["name"] for x in listed] == [small["name"], b["name"]]  # newest first

    # the download is a plain /api/export zip
    z = owner.get(f"/api/workspaces/{ws}/backups/{b['name']}/download")
    assert z.status_code == 200 and z.headers["content-type"].startswith("application/zip")
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["format"] == "gamma-backup-1" and manifest["workspace"] == ws and manifest["label"] == "before"
    assert manifest["kind"] == "personal" and manifest["user"] == "bk_owner"
    assert any(n.startswith("uploads/") for n in zf.namelist())

    # change things, then restore in place: the page comes back, the new one goes
    later = make_page(owner, "After the snapshot")
    assert owner.delete(f"/api/blocks/{page['id']}").status_code == 200
    r = owner.post(f"/api/workspaces/{ws}/backups/{b['name']}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["restored"] == ["pages.db", "data.db"]
    titles = {x["content"] for x in owner.get("/api/blocks/root/children").json()["children"]}
    assert "Before the snapshot" in titles and "After the snapshot" not in titles
    # merge brings a later page back without touching what is there
    later2 = make_page(owner, "Merged back in")
    merge_snap = owner.post(f"/api/workspaces/{ws}/backups", json={"label": "with-merge"}).json()
    assert owner.delete(f"/api/blocks/{later2['id']}").status_code == 200
    r = owner.post(f"/api/workspaces/{ws}/backups/{merge_snap['name']}/restore", params={"mode": "merge"})
    assert r.status_code == 200 and r.json()["pages_added"] == 1
    titles = {x["content"] for x in owner.get("/api/blocks/root/children").json()["children"]}
    assert "Merged back in" in titles and "Before the snapshot" in titles
    assert later["id"] not in [x["id"] for x in owner.get("/api/blocks/root/children").json()["children"]]

    # nobody else sees or touches a personal workspace's snapshots
    assert other.get(f"/api/workspaces/{ws}/backups").status_code == 404
    assert other.post(f"/api/workspaces/{ws}/backups", json={}).status_code == 404
    assert other.get(f"/api/workspaces/{ws}/backups/{b['name']}/download").status_code == 404
    assert other.delete(f"/api/workspaces/{ws}/backups/{b['name']}").status_code == 404
    # bad names and labels
    assert owner.post(f"/api/workspaces/{ws}/backups", json={"label": "no spaces"}).status_code == 400
    assert owner.get(f"/api/workspaces/{ws}/backups/..%2F..%2Fusers.db/download").status_code == 404
    assert owner.delete(f"/api/workspaces/{ws}/backups/20260101-000000-nope").status_code == 404
    assert owner.delete(f"/api/workspaces/{ws}/backups/{b['name']}").status_code == 200
    assert owner.delete(f"/api/workspaces/{ws}/backups/{b['name']}").status_code == 404


def test_cap_and_guest(owner, guest, monkeypatch):
    from gamma import ws_backup
    ws = workspace_of("bk_owner")
    monkeypatch.setattr(ws_backup, "MAX_PER_WORKSPACE", 3)
    have = len(owner.get(f"/api/workspaces/{ws}/backups").json()["backups"])
    for i in range(3 - have):
        assert owner.post(f"/api/workspaces/{ws}/backups", json={"label": f"n{i}", "uploads": False}).status_code == 200
    r = owner.post(f"/api/workspaces/{ws}/backups", json={"label": "one-too-many"})
    assert r.status_code == 400 and "delete one first" in r.json()["detail"]
    gws = workspace_of("guest")
    assert guest.post(f"/api/workspaces/{gws}/backups", json={}).status_code == 403
    assert guest.get(f"/api/workspaces/{gws}/backups").json()["backups"] == []


def test_shared_workspace_roles_and_cleanup(boss, owner, other):
    from gamma import ws_backup
    r = boss.post("/api/workspaces", json={"name": "Snapshot lab", "kind": "shared", "owner": "bk_owner"})
    lab = r.json()["id"]
    assert owner.put(f"/api/workspaces/{lab}/members/bk_other", json={"role": "editor"}).status_code == 200
    make_page(owner, "Lab page", headers=_in(lab)) if False else owner.post(
        "/api/blocks", json={"parent_id": "root", "content": "Lab page"}, headers=_in(lab))
    # an editor lists and downloads, may merge, but neither takes nor replaces nor deletes
    assert other.post(f"/api/workspaces/{lab}/backups", json={}).status_code == 403
    snap = owner.post(f"/api/workspaces/{lab}/backups", json={"label": "lab"}).json()
    assert other.get(f"/api/workspaces/{lab}/backups").json()["backups"][0]["name"] == snap["name"]
    assert other.get(f"/api/workspaces/{lab}/backups/{snap['name']}/download").status_code == 200
    assert other.post(f"/api/workspaces/{lab}/backups/{snap['name']}/restore").status_code == 403
    assert other.post(f"/api/workspaces/{lab}/backups/{snap['name']}/restore", params={"mode": "merge"}).status_code == 200
    assert other.delete(f"/api/workspaces/{lab}/backups/{snap['name']}").status_code == 403
    # admins pass without membership
    assert boss.get(f"/api/workspaces/{lab}/backups").status_code == 200
    assert boss.post(f"/api/workspaces/{lab}/backups", json={"label": "admin"}).status_code == 200
    # the snapshots go with the workspace
    store = ws_backup.store_dir(lab)
    assert store.is_dir() and len(list(store.glob("*.zip"))) == 2
    assert owner.delete(f"/api/workspaces/{lab}").status_code == 200
    assert not store.exists()


def test_export_all_and_mine(owner, other, guest):
    ws = workspace_of("bk_owner")
    play = owner.post("/api/workspaces", json={"name": "Play"}).json()["id"]
    owner.post("/api/blocks", json={"parent_id": "root", "content": "Play page"}, headers=_in(play))
    r = owner.get("/api/export-all", params={"uploads": 0})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/zip")
    bundle = zipfile.ZipFile(io.BytesIO(r.content))
    names = bundle.namelist()
    assert len(names) == 2 and any(n.endswith(f"-{ws}.zip") for n in names) and any(n.endswith(f"-{play}.zip") for n in names)
    inner = zipfile.ZipFile(io.BytesIO(bundle.read(next(n for n in names if n.endswith(f"-{play}.zip")))))
    assert json.loads(inner.read("manifest.json"))["workspace"] == play and "pages.db" in inner.namelist()
    assert not any(n.startswith("uploads/") for n in inner.namelist())
    assert guest.get("/api/export-all").status_code == 403
    # /mine: my workspaces with sizes, and my account's storage
    mine = owner.get("/api/workspaces/mine").json()
    ids = {w["id"]: w for w in mine["workspaces"]}
    assert ids[ws]["used_bytes"] > 0 and ids[play]["used_bytes"] == 0 and ids[ws]["default"] is True
    assert mine["account"]["used_bytes"] == ids[ws]["used_bytes"] + ids[play]["used_bytes"]
    assert "quota_mb" in mine["account"] and "max_upload_mb" in mine["account"]
    assert owner.delete(f"/api/workspaces/{play}").status_code == 200

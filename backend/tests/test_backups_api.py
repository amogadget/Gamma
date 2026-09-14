"""Admin backup endpoints (/api/admin/backups*): list, create (with or
without uploads), download as a zip, delete — admin only, names validated."""

import io
import json
import zipfile

import pytest

from conftest import login, make_user


@pytest.fixture(scope="module")
def admin():
    make_user("bk_admin", "bkadminpw1", is_admin=1)
    return login("bk_admin", "bkadminpw1")


@pytest.fixture(scope="module")
def plain():
    make_user("bk_plain", "bkplainpw1")
    return login("bk_plain", "bkplainpw1")


def test_backups_are_admin_only(plain):
    assert plain.get("/api/admin/backups").status_code == 403
    assert plain.post("/api/admin/backups", json={}).status_code == 403


def test_create_list_download_delete(admin, plain):
    up = plain.post("/api/uploads", files={"file": ("p.pdf", b"%PDF-1.4 backup me", "application/pdf")})
    assert up.status_code == 200
    r = admin.post("/api/admin/backups", json={"label": "nightly", "uploads": True})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["name"].endswith("-nightly") and b["uploads"] is True and b["upload_files"] >= 1
    names = [x["name"] for x in admin.get("/api/admin/backups").json()["backups"]]
    assert b["name"] in names
    z = admin.get(f"/api/admin/backups/{b['name']}/download")
    assert z.status_code == 200 and z.headers["content-type"].startswith("application/zip")
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["label"] == "nightly" and "users.db" in zf.namelist()
    assert any(n.endswith(f"/uploads/{up.json()['doc_id']}.pdf") for n in zf.namelist())
    # a databases-only backup carries no uploads
    small = admin.post("/api/admin/backups", json={"label": "db.only"}).json()
    zf2 = zipfile.ZipFile(io.BytesIO(admin.get(f"/api/admin/backups/{small['name']}/download").content))
    assert not any("/uploads/" in n for n in zf2.namelist())
    assert admin.delete(f"/api/admin/backups/{b['name']}").status_code == 200
    assert admin.delete(f"/api/admin/backups/{b['name']}").status_code == 404
    assert admin.delete(f"/api/admin/backups/{small['name']}").status_code == 200


def test_bad_names_and_labels(admin):
    assert admin.post("/api/admin/backups", json={"label": "no spaces here"}).status_code == 400
    assert admin.get("/api/admin/backups/..%2F..%2Fusers.db/download").status_code == 404
    assert admin.delete("/api/admin/backups/20260101-000000-nope").status_code == 404

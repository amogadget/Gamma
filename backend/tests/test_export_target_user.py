"""Backups of *another* account: /api/export and /api/import-data accept a
?user= target, but only for admins (Settings → Users gives every row a Data
button; everyone else only ever sees their own row)."""

import io
import json
import zipfile

import pytest

from conftest import login as _login, make_page, make_user as _make_user


@pytest.fixture(scope="module")
def root(client):
    _make_user("bkadmin", "bkadminpw", is_admin=1)
    return _login("bkadmin", "bkadminpw")


@pytest.fixture(scope="module")
def alice(client):
    _make_user("bkalice", "bkalicepw")
    c = _login("bkalice", "bkalicepw")
    make_page(c, "Alice paper")
    return c


@pytest.fixture(scope="module")
def bob(client):
    _make_user("bkbob", "bkbobpw")
    c = _login("bkbob", "bkbobpw")
    make_page(c, "Bob original")
    return c


def _titles(c):
    pages = c.get("/api/blocks/root/children").json()
    return [b["content"] for b in pages.get("children", pages.get("blocks", []))]


def test_admin_exports_another_account(root, alice):
    r = root.get("/api/export?user=bkalice")
    assert r.status_code == 200, r.text
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert json.loads(z.read("manifest.json"))["user"] == "bkalice"
    assert "bkalice" in r.headers["content-disposition"]


def test_admin_export_progress_follows_the_target(root):
    r = root.get("/api/export-progress?user=bkalice")
    assert r.status_code == 200 and r.json()["active"] is False


def test_non_admin_cannot_export_another_account(alice):
    assert alice.get("/api/export?user=bkbob").status_code == 403
    assert alice.get("/api/export-progress?user=bkbob").status_code == 403
    # naming yourself is always fine
    assert alice.get("/api/export?user=bkalice").status_code == 200


def test_export_unknown_target_is_404(root):
    assert root.get("/api/export?user=nobody-here").status_code == 404


def test_admin_restores_into_another_account(root, alice, bob):
    backup = alice.get("/api/export")
    assert backup.status_code == 200
    r = root.post("/api/import-data?user=bkbob",
                  files={"file": ("backup.zip", backup.content, "application/zip")})
    assert r.status_code == 200, r.text
    assert "pages.db" in r.json()["restored"]
    # Bob's workspace is now Alice's backup; the admin's own is untouched.
    assert "Alice paper" in _titles(bob) and "Bob original" not in _titles(bob)
    assert "Alice paper" not in _titles(root)


def test_non_admin_cannot_restore_into_another_account(alice, bob):
    backup = alice.get("/api/export")
    r = alice.post("/api/import-data?user=bkbob",
                   files={"file": ("backup.zip", backup.content, "application/zip")})
    assert r.status_code == 403


def test_guest_workspace_refuses_a_restore_even_from_an_admin(root, alice, guest):
    guest_name = guest.get("/api/session").json()["user"]
    backup = alice.get("/api/export")
    r = root.post(f"/api/import-data?user={guest_name}",
                  files={"file": ("backup.zip", backup.content, "application/zip")})
    assert r.status_code == 403

"""Full-backup import: /api/export zips restore into an account, with
validation rails (guests, non-zips, corrupt databases, zip-slip names)."""

import io
import zipfile

import bcrypt
import pytest
from fastapi.testclient import TestClient

from conftest import make_page


def _make_user(username, password):
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, is_admin, created_at) VALUES (?, ?, 0, 0, ?)",
                (username, bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs(username)


def _login(username, password):
    from gamma.app import app
    c = TestClient(app)
    r = c.post("/api/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture(scope="module")
def donor(client):
    _make_user("donor", "donorpw")
    return _login("donor", "donorpw")


@pytest.fixture(scope="module")
def receiver(client):
    _make_user("receiver", "receiverpw")
    return _login("receiver", "receiverpw")


def _import(c, payload: bytes, name="backup.zip"):
    return c.post("/api/import-data", files={"file": (name, payload, "application/zip")})


def test_export_import_roundtrip_into_another_account(donor, receiver):
    up = donor.post("/api/uploads", files={"file": ("d.pdf", b"%PDF-1.4 donor", "application/pdf")})
    assert up.status_code == 200, up.text
    page = make_page(donor, "Donor paper", properties={"source_url": up.json()["source_url"]})
    make_page(receiver, "Receiver original")

    backup = donor.get("/api/export")
    assert backup.status_code == 200

    r = _import(receiver, backup.content)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "pages.db" in d["restored"] and "data.db" in d["restored"]
    assert d["uploads_added"] == 1

    # Receiver's workspace now IS the donor backup: donor page present with
    # its upload, receiver's pre-import page replaced.
    pages = receiver.get("/api/blocks/root/children").json()
    titles = [b["content"] for b in pages.get("children", pages.get("blocks", []))]
    assert "Donor paper" in titles and "Receiver original" not in titles
    got = receiver.get(up.json()["source_url"])
    assert got.status_code == 200 and got.content == b"%PDF-1.4 donor"


def test_guest_cannot_import(guest, donor):
    backup = donor.get("/api/export")
    r = _import(guest, backup.content)
    assert r.status_code == 403


def test_not_a_zip_rejected(receiver):
    r = _import(receiver, b"definitely not a zip")
    assert r.status_code == 400
    assert "zip" in r.json()["detail"]


def test_zip_without_pages_db_rejected(receiver):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("readme.txt", "hello")
    assert _import(receiver, buf.getvalue()).status_code == 400


def test_corrupt_pages_db_rejected_before_touching_data(receiver):
    marker = make_page(receiver, "Survives corrupt import")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("pages.db", b"this is not sqlite")
    assert _import(receiver, buf.getvalue()).status_code == 400
    # live data untouched
    assert receiver.get(f"/api/blocks/{marker['id']}").status_code == 200


def test_nested_or_dotted_upload_names_are_skipped(receiver, donor):
    backup = zipfile.ZipFile(io.BytesIO(donor.get("/api/export").content))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("pages.db", backup.read("pages.db"))
        z.writestr("uploads/../evil.txt", b"zip slip")
        z.writestr("uploads/.hidden", b"dotfile")
        z.writestr("uploads/sub/dir.pdf", b"nested")
    r = _import(receiver, buf.getvalue())
    assert r.status_code == 200, r.text
    assert r.json()["uploads_in_backup"] == 0

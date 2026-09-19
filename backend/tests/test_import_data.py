"""Full-backup import: /api/export zips restore into an account, with
validation rails (guests, non-zips, corrupt databases, zip-slip names)."""

import io
import json
import zipfile

import pytest

from conftest import login as _login, make_page, make_user as _make_user


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


def test_export_progress_side_channel(donor):
    assert donor.get("/api/export").status_code == 200
    p = donor.get("/api/export-progress").json()
    assert p["active"] is False
    assert p["total"] > 0 and p["done"] == p["total"]


def test_export_notes_only_skips_uploads(donor):
    donor.post("/api/uploads", files={"file": ("n.pdf", b"%PDF-1.4 notesonly", "application/pdf")})
    r = donor.get("/api/export", params={"uploads": 0})
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert "pages.db" in names
    assert not any(n.startswith("uploads/") for n in names)
    assert json.loads(z.read("manifest.json"))["uploads"] is False


# --- merge mode: fresh accounts so the replace tests above can't interfere ---

@pytest.fixture(scope="module")
def mdonor(client):
    _make_user("mdonor", "mdonorpw")
    return _login("mdonor", "mdonorpw")


@pytest.fixture(scope="module")
def mreceiver(client):
    _make_user("mreceiver", "mreceiverpw")
    return _login("mreceiver", "mreceiverpw")


def _root_titles(c):
    return [b["content"] for b in c.get("/api/blocks/root/children").json()["children"]]


def test_merge_adds_missing_pages_and_keeps_existing(mdonor, mreceiver):
    up = mdonor.post("/api/uploads", files={"file": ("m.pdf", b"%PDF-1.4 merge", "application/pdf")})
    assert up.status_code == 200, up.text
    page = make_page(mdonor, "Merge donor paper", properties={"source_url": up.json()["source_url"]})
    child = mdonor.post("/api/blocks", json={"parent_id": page["id"], "content": "donor note"}).json()
    mdonor.put(f"/api/chats/{page['id']}", json={"messages": [{"role": "user", "content": "hi"}]})
    make_page(mreceiver, "Receiver keeps this")

    backup = mdonor.get("/api/export")
    r = mreceiver.post("/api/import-data?mode=merge",
                       files={"file": ("b.zip", backup.content, "application/zip")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["mode"] == "merge" and d["pages_added"] == 1 and d["uploads_added"] == 1

    titles = _root_titles(mreceiver)
    assert "Receiver keeps this" in titles and "Merge donor paper" in titles
    # the whole subtree and the page's chat came along
    assert mreceiver.get(f"/api/blocks/{child['id']}").status_code == 200
    assert mreceiver.get(f"/api/chats/{page['id']}").json()["messages"]
    assert mreceiver.get(up.json()["source_url"]).content == b"%PDF-1.4 merge"


def test_merge_is_idempotent(mdonor, mreceiver):
    before = _root_titles(mreceiver)
    backup = mdonor.get("/api/export")
    r = mreceiver.post("/api/import-data?mode=merge",
                       files={"file": ("b.zip", backup.content, "application/zip")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["pages_added"] == 0 and d["pages_skipped"] >= 1 and d["uploads_added"] == 0
    assert _root_titles(mreceiver) == before


def test_merge_skips_pages_with_same_doc_id(mdonor, mreceiver):
    make_page(mdonor, "Donor copy of paper X", properties={"doc_id": "docx-shared"})
    make_page(mreceiver, "Receiver copy of paper X", properties={"doc_id": "docx-shared"})
    backup = mdonor.get("/api/export")
    r = mreceiver.post("/api/import-data?mode=merge",
                       files={"file": ("b.zip", backup.content, "application/zip")})
    assert r.status_code == 200, r.text
    titles = _root_titles(mreceiver)
    assert "Receiver copy of paper X" in titles
    assert "Donor copy of paper X" not in titles


def test_merge_never_touches_prefs(mdonor, mreceiver):
    from gamma.db import get_pref, set_pref

    set_pref("mdonor", "open-tabs", ["donor-tab"])
    set_pref("mreceiver", "open-tabs", ["receiver-tab"])
    backup = mdonor.get("/api/export")
    r = mreceiver.post("/api/import-data?mode=merge",
                       files={"file": ("b.zip", backup.content, "application/zip")})
    assert r.status_code == 200, r.text
    assert get_pref("mreceiver", "open-tabs")[0] == ["receiver-tab"]

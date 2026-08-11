"""Storage limits: server-wide defaults, per-user quota overrides, enforcement."""

import bcrypt
import pytest
from fastapi.testclient import TestClient


def _pdf_of_mb(mb, filler=b"x"):
    return b"%PDF-1.4 " + filler * (mb * 1024 * 1024)


def _make_user(username, password, is_admin=0):
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, is_admin, created_at) VALUES (?, ?, 0, ?, ?)",
                (username, bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(), is_admin, page_now()),
            )
            conn.commit()
    create_user_dbs(username)


def _login(username, password):
    from gamma.app import app
    c = TestClient(app)
    r = c.post("/api/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return c


def _drop_user(username):
    """Remove the account again — test_admin_users assumes it knows every
    admin in the shared users.db, so this module must not leave one behind."""
    from gamma.db import connect_users_db

    with connect_users_db() as conn:
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()


@pytest.fixture(scope="module")
def sizeadmin(client):
    _make_user("sizeadmin", "sizeadminpw", is_admin=1)
    yield _login("sizeadmin", "sizeadminpw")
    _drop_user("sizeadmin")


@pytest.fixture(scope="module")
def sizeuser(client):
    _make_user("sizeuser", "sizeuserpw", is_admin=0)
    yield _login("sizeuser", "sizeuserpw")
    _drop_user("sizeuser")


@pytest.fixture(autouse=True)
def restore_defaults():
    """Each test starts from stock limits (50 MB per file, no quota, no
    per-user overrides) and empty uploads dirs so order doesn't matter."""
    from gamma.db import connect_users_db, user_uploads_dir
    from gamma.server_settings import (DEFAULT_MAX_UPLOAD_MB, DEFAULT_QUOTA_MB,
                                       set_default_max_upload_mb, set_default_quota_mb)

    def reset():
        set_default_max_upload_mb(DEFAULT_MAX_UPLOAD_MB)
        set_default_quota_mb(DEFAULT_QUOTA_MB)
        with connect_users_db() as conn:
            conn.execute("UPDATE users SET max_upload_mb = NULL, quota_mb = NULL "
                         "WHERE username IN ('sizeadmin', 'sizeuser')")
            conn.commit()
        for username in ("sizeadmin", "sizeuser"):
            uploads = user_uploads_dir(username)
            if uploads.exists():
                for f in uploads.iterdir():
                    if f.is_file():
                        f.unlink()

    reset()
    yield
    reset()


def test_defaults_and_quota_endpoint(sizeadmin, sizeuser):
    r = sizeadmin.get("/api/admin/settings")
    assert r.status_code == 200
    assert r.json()["max_upload_mb"] == 50
    assert r.json()["quota_mb"] == 0  # unlimited
    # any logged-in user reads their effective limits + usage from /api/quota
    q = sizeuser.get("/api/quota").json()
    assert q["max_upload_mb"] == 50 and q["quota_mb"] == 0
    assert isinstance(q["used_bytes"], int)
    # ...and /api/session no longer carries limits (identity only)
    assert "max_upload_mb" not in sizeuser.get("/api/session").json()


def test_admin_only(sizeuser):
    assert sizeuser.get("/api/admin/settings").status_code == 403
    assert sizeuser.put("/api/admin/settings", json={"max_upload_mb": 999}).status_code == 403
    assert sizeuser.put("/api/admin/users/sizeuser", json={"quota_mb": 0}).status_code == 403


def test_default_upload_cap_enforced(sizeadmin, sizeuser):
    r = sizeadmin.put("/api/admin/settings", json={"max_upload_mb": 1})
    assert r.status_code == 200 and r.json()["max_upload_mb"] == 1

    big = _pdf_of_mb(2)
    r = sizeuser.post("/api/uploads", files={"file": ("big.pdf", big, "application/pdf")})
    assert r.status_code == 413
    assert "max 1 MB" in r.json()["detail"]

    sizeadmin.put("/api/admin/settings", json={"max_upload_mb": 5})
    r = sizeuser.post("/api/uploads", files={"file": ("big.pdf", big, "application/pdf")})
    assert r.status_code == 200, r.text


def test_per_user_override_beats_default(sizeadmin, sizeuser):
    # tighten just sizeuser; the server default stays 50
    r = sizeadmin.put("/api/admin/users/sizeuser", json={"max_upload_mb": 1})
    assert r.status_code == 200
    me = next(u for u in r.json()["users"] if u["username"] == "sizeuser")
    assert me["max_upload_mb"] == 1 and "used_bytes" in me

    big = _pdf_of_mb(2, b"o")
    r = sizeuser.post("/api/uploads", files={"file": ("o.pdf", big, "application/pdf")})
    assert r.status_code == 413
    assert sizeuser.get("/api/quota").json()["max_upload_mb"] == 1
    # the admin's own uploads still ride the 50 MB default
    r = sizeadmin.post("/api/uploads", files={"file": ("o.pdf", big, "application/pdf")})
    assert r.status_code == 200, r.text

    # explicit null clears the override back to the default
    r = sizeadmin.put("/api/admin/users/sizeuser", json={"max_upload_mb": None})
    assert r.status_code == 200
    r = sizeuser.post("/api/uploads", files={"file": ("o.pdf", big, "application/pdf")})
    assert r.status_code == 200, r.text


def test_storage_quota_enforced_and_dedup_free(sizeadmin, sizeuser):
    r = sizeadmin.put("/api/admin/users/sizeuser", json={"quota_mb": 3})
    assert r.status_code == 200

    a = _pdf_of_mb(2, b"a")
    r = sizeuser.post("/api/uploads", files={"file": ("a.pdf", a, "application/pdf")})
    assert r.status_code == 200, r.text

    b = _pdf_of_mb(2, b"b")
    r = sizeuser.post("/api/uploads", files={"file": ("b.pdf", b, "application/pdf")})
    assert r.status_code == 507
    assert "storage quota exceeded" in r.json()["detail"]

    # re-uploading already-stored bytes costs nothing, so it stays allowed
    r = sizeuser.post("/api/uploads", files={"file": ("a.pdf", a, "application/pdf")})
    assert r.status_code == 200 and r.json()["already_existed"] is True

    q = sizeuser.get("/api/quota").json()
    assert q["quota_mb"] == 3 and q["used_bytes"] >= 2 * 1024 * 1024


def test_validation(sizeadmin):
    for bad in ({"max_upload_mb": 0}, {"max_upload_mb": 4096}, {"quota_mb": -1}):
        assert sizeadmin.put("/api/admin/settings", json=bad).status_code == 400, bad
        assert sizeadmin.put("/api/admin/users/sizeuser", json=bad).status_code == 400, bad
    # empty update is a no-op, not an error
    r = sizeadmin.put("/api/admin/settings", json={})
    assert r.status_code == 200 and r.json()["max_upload_mb"] == 50


def test_guest_quota_settable_but_not_credentials(sizeadmin, guest_account):
    r = sizeadmin.put("/api/admin/users/guest", json={"quota_mb": 1})
    assert r.status_code == 200, r.text
    g = next(u for u in r.json()["users"] if u["username"] == "guest")
    assert g["quota_mb"] == 1
    assert sizeadmin.put("/api/admin/users/guest", json={"password": "x"}).status_code == 400
    assert sizeadmin.put("/api/admin/users/guest", json={"is_admin": True}).status_code == 400
    sizeadmin.put("/api/admin/users/guest", json={"quota_mb": None})


@pytest.fixture()
def guest_account():
    from gamma.seed import ensure_guest_user
    ensure_guest_user()


def test_corrupt_values_fall_back_to_defaults():
    from gamma.db import connect_users_db
    from gamma.server_settings import user_limits

    with connect_users_db() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('max_upload_mb', 'junk', '')")
        conn.commit()
    limits = user_limits("sizeuser")
    assert limits["max_upload_mb"] == 50 and limits["quota_mb"] == 0

"""Server log buffer: admin-only access, poll cursor, and secret scrubbing."""

import pytest

from conftest import login as _login, make_user as _make_user
from gamma.logbuf import log, scrub, tail


def _drop_user(username):
    """Remove the account again — test_admin_users assumes it knows every
    admin in the shared users.db, so this module must not leave one behind."""
    from gamma.db import connect_users_db

    with connect_users_db() as conn:
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()


@pytest.fixture(scope="module")
def logadmin(client):
    _make_user("logadmin", "logadminpw", is_admin=1)
    yield _login("logadmin", "logadminpw")
    _drop_user("logadmin")


@pytest.fixture(scope="module")
def plainuser(client):
    _make_user("plainuser", "plainpw", is_admin=0)
    yield _login("plainuser", "plainpw")
    _drop_user("plainuser")


def test_scrub_masks_secret_shapes():
    assert "hunter2" not in scrub("login failed: password=hunter2")
    assert "hunter2" not in scrub("config had api_key: hunter2")
    assert "abcdefgh12345678" not in scrub("header Authorization: Bearer abcdefgh12345678")
    assert scrub("rejected key sk-proj-abc123def456") == "rejected key sk-***"
    token43 = "x" * 43  # token_urlsafe(32) length — session/share tokens
    assert token43 not in scrub(f"lookup for {token43} failed")


def test_scrub_keeps_debuggable_ids():
    # Block ids (uuid-hex, 32) and upload names (sha256[:24]) stay readable.
    assert scrub("indexing 0123456789abcdef01234567 failed") == "indexing 0123456789abcdef01234567 failed"
    line = "[http] request=a1b2c3d4 GET /api/blocks status=401 session=alice"
    assert scrub(line) == line


def test_logs_require_admin(client, plainuser):
    assert client.get("/api/admin/logs").status_code == 401  # no session
    assert plainuser.get("/api/admin/logs").status_code == 403  # non-admin


def test_logs_tail_cursor_and_endpoint_scrub(logadmin):
    log.warning("[test] upstream refused token=supersecretvalue")
    r = logadmin.get("/api/admin/logs")
    assert r.status_code == 200
    entries = r.json()["entries"]
    assert entries, "buffer should contain at least the test line"
    line = next(e for e in reversed(entries) if e["msg"].startswith("[test]"))
    assert "supersecretvalue" not in line["msg"]
    assert line["level"] == "WARNING"
    # Poll cursor: nothing new after the newest seq.
    last_seq = entries[-1]["seq"]
    assert logadmin.get(f"/api/admin/logs?after={last_seq}").json()["entries"] == []


def test_seeded_admin_password_never_enters_buffer():
    """seed.py prints the one-time admin password with raw print() on purpose —
    the startup seed ran in this very process, so its line must be absent."""
    assert not any("[startup]   password" in e["msg"] for e in tail(0))

"""The Settings → Server dashboard endpoint: admin-only, the build stamp,
log counts, and the GitHub release check (stubbed — tests never reach the
network)."""

import pytest

from conftest import login as _login, make_user as _make_user
from gamma import version


def _drop_user(username):
    from gamma.db import connect_users_db

    with connect_users_db() as conn:
        conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()


@pytest.fixture(scope="module")
def infoadmin(client):
    _make_user("infoadmin", "infoadminpw", is_admin=1)
    yield _login("infoadmin", "infoadminpw")
    _drop_user("infoadmin")


@pytest.fixture(scope="module")
def infouser(client):
    _make_user("infouser", "infouserpw", is_admin=0)
    yield _login("infouser", "infouserpw")
    _drop_user("infouser")


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.setattr(version, "_cache", {"at": 0.0, "ttl": 0.0, "release": None, "error": ""})


def test_parse_version():
    assert version.parse_version("v1.2.3") == (1, 2, 3)
    assert version.parse_version("0.2") == (0, 2, 0)
    assert version.parse_version("extension-v0.2.0") is None
    assert version.parse_version("") is None


def test_server_info_requires_admin(anon, infouser):
    assert anon.get("/api/admin/server-info").status_code == 401
    assert infouser.get("/api/admin/server-info").status_code == 403


def test_server_info_reports_the_build_and_a_newer_release(infoadmin, monkeypatch):
    monkeypatch.setattr(version, "VERSION", "0.2.1")
    monkeypatch.setattr(version, "COMMIT", "abc1234")
    monkeypatch.setattr(version, "_fetch_latest", lambda: {"version": "0.3.0", "url": "https://example/rel", "published_at": "2026-09-01T00:00:00Z"})
    from gamma.logbuf import log
    log.warning("[test] a warning for the dashboard")
    r = infoadmin.get("/api/admin/server-info")
    assert r.status_code == 200, r.text
    info = r.json()
    assert info["version"] == "0.2.1" and info["commit"] == "abc1234" and info["label"] == "v0.2.1 (abc1234)"
    assert info["latest"]["version"] == "0.3.0" and info["update_available"] is True and info["latest_error"] == ""
    assert info["uptime_seconds"] >= 0 and info["started_at"].endswith("Z")
    assert info["log_counts"]["warning"] >= 1 and set(info["log_counts"]) == {"info", "warning", "error"}
    assert info["schema_version"] >= 7 and info["image"].startswith("ghcr.io/")
    # same or older release: no update
    monkeypatch.setattr(version, "_fetch_latest", lambda: {"version": "0.2.1", "url": "", "published_at": ""})
    assert infoadmin.get("/api/admin/server-info", params={"refresh": 1}).json()["update_available"] is False


def test_server_info_without_a_version_or_network(infoadmin, monkeypatch):
    monkeypatch.setattr(version, "VERSION", "")
    monkeypatch.setattr(version, "COMMIT", "")
    calls = []

    def boom():
        calls.append(1)
        raise OSError("no route to github")
    monkeypatch.setattr(version, "_fetch_latest", boom)
    info = infoadmin.get("/api/admin/server-info").json()
    assert info["label"] == "development build" and info["latest"] is None
    assert "no route to github" in info["latest_error"] and info["update_available"] is None
    # a failed check is cached: the next read does not retry until refresh
    infoadmin.get("/api/admin/server-info")
    assert len(calls) == 1
    infoadmin.get("/api/admin/server-info", params={"refresh": 1})
    assert len(calls) == 2
    # a versioned build with no reachable release: known version, unknown update state
    monkeypatch.setattr(version, "VERSION", "1.0.0")
    info = infoadmin.get("/api/admin/server-info", params={"refresh": 1}).json()
    assert info["label"] == "v1.0.0" and info["update_available"] is None

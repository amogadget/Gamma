"""Desktop-app support: data-dir resolution, port picking, the single-instance
lock, and the loopback auto-session guard.

The guard's negative cases carry the weight here. Auto-session exists so the
desktop app needs no login screen; if it ever fired on a request that did not
come from the machine itself, the planned remote-sharing feature would publish
an unauthenticated library. Each of the three conditions is tested for failing
closed on its own.
"""

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

from gamma import desktop


# --- data dir ----------------------------------------------------------------

def test_data_dir_follows_platform_convention(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert desktop.default_data_dir().as_posix().endswith("Library/Application Support/Gamma")

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(os, "name", "posix")
    monkeypatch.setenv("XDG_DATA_HOME", "/xdg")
    assert desktop.default_data_dir().as_posix() == "/xdg/gamma"
    monkeypatch.delenv("XDG_DATA_HOME")
    assert desktop.default_data_dir().as_posix().endswith(".local/share/gamma")


def test_explicit_data_dir_wins(monkeypatch, tmp_path):
    from gamma import desktop_main

    monkeypatch.setenv("GAMMA_DATA_DIR", str(tmp_path / "elsewhere"))
    assert desktop_main.resolve_data_dir() == tmp_path / "elsewhere"


# --- ports -------------------------------------------------------------------

def test_pick_port_prefers_9001_then_falls_back():
    import socket

    assert desktop.pick_port(desktop.PREFERRED_PORT) or True  # never raises
    # Hold a port, then confirm pick_port refuses to hand out the same one.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", 0))
        taken = held.getsockname()[1]
        held.listen(1)
        assert desktop.port_is_free(taken) is False
        got = desktop.pick_port(taken)
        assert got != taken
        assert desktop.port_is_free(got)


# --- the running-instance record --------------------------------------------

def test_state_roundtrip_and_clear(tmp_path):
    desktop.write_state(tmp_path, 1234)
    st = desktop.read_state(tmp_path)
    assert st["port"] == 1234 and st["pid"] == os.getpid()
    desktop.clear_state(tmp_path)
    assert desktop.read_state(tmp_path) is None


def test_a_stale_record_does_not_block_the_next_launch(tmp_path):
    """A hard reboot or SIGKILL leaves the file behind. If that convinced the
    app an instance was running, it would refuse to start with no way out."""
    desktop.state_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    desktop.state_path(tmp_path).write_text(json.dumps({"port": 9999, "pid": 2 ** 30}))
    assert desktop.running_instance(tmp_path) is None
    assert desktop.read_state(tmp_path) is None, "the stale record should be cleared"


def test_a_live_record_is_reported(tmp_path):
    desktop.write_state(tmp_path, 4321)
    st = desktop.running_instance(tmp_path)
    assert st and st["port"] == 4321


def test_corrupt_record_is_treated_as_absent(tmp_path):
    desktop.state_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    desktop.state_path(tmp_path).write_text("{not json")
    assert desktop.read_state(tmp_path) is None
    assert desktop.running_instance(tmp_path) is None


# --- single instance ---------------------------------------------------------

def test_second_instance_is_refused(tmp_path):
    """Two servers on two ports against one set of SQLite files is the failure
    this prevents."""
    first = desktop.SingleInstance(tmp_path).acquire()
    try:
        desktop.write_state(tmp_path, 5555)
        with pytest.raises(desktop.AlreadyRunning) as exc:
            desktop.SingleInstance(tmp_path).acquire()
        assert exc.value.port == 5555, "the refusal should say where the live one is"
    finally:
        first.release()


def test_lock_is_reusable_after_release(tmp_path):
    with desktop.SingleInstance(tmp_path):
        pass
    with desktop.SingleInstance(tmp_path):
        pass  # a clean quit must not leave the library locked


# --- static resolution -------------------------------------------------------

def test_static_dir_requires_a_real_index(monkeypatch, tmp_path):
    from gamma import static_paths

    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("GAMMA_STATIC_DIR", str(empty))
    # An empty directory must not win, or the app serves a blank page and every
    # /api call falls into the SPA catch-all.
    assert static_paths.resolve_static_dir() != empty.resolve()

    (empty / "index.html").write_text("<html></html>")
    assert static_paths.resolve_static_dir() == empty.resolve()


# --- the auto-session guard --------------------------------------------------
# Built on the real app so the middleware runs, rather than calling the helper
# in isolation.

def _desktop_client(monkeypatch):
    from gamma import config
    from gamma.app import app
    from gamma.seed import ensure_desktop_user

    monkeypatch.setattr(config, "DESKTOP_MODE", True)
    monkeypatch.setattr(config, "DESKTOP_USER", "local")
    ensure_desktop_user("local")
    # TestClient's default peer is the literal "testclient", which is correctly
    # not loopback — so it must be told to look like a local caller.
    return TestClient(app, client=("127.0.0.1", 51234))


def test_desktop_mode_signs_you_in_without_a_cookie(guest, monkeypatch):
    c = _desktop_client(monkeypatch)
    r = c.get("/api/session")
    assert r.status_code == 200
    assert r.json()["user"] == "local"


def test_off_by_default(guest):
    """Without the flag — i.e. every hosted deployment — nothing changes."""
    from gamma.app import app

    r = TestClient(app).get("/api/session")
    assert r.json()["user"] is None


def test_a_non_loopback_peer_gets_nothing(guest, monkeypatch):
    """Someone bound a real interface; a LAN request must still authenticate."""
    _desktop_client(monkeypatch)  # enables desktop mode
    # A TestClient whose peer really is a LAN address.
    from gamma.app import app

    lan = TestClient(app, client=("192.168.1.50", 51234))
    assert lan.get("/api/session").json()["user"] is None
    # …while a loopback peer in the same configuration is signed in.
    local = TestClient(app, client=("127.0.0.1", 51234))
    assert local.get("/api/session").json()["user"] == "local"


def test_proxy_headers_disable_it(guest, monkeypatch):
    """Behind a reverse proxy every peer looks like loopback, which would turn
    the loopback check into a rubber stamp for anyone on the internet."""
    c = _desktop_client(monkeypatch)
    for header in ("x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"):
        r = c.get("/api/session", headers={header: "203.0.113.9"})
        assert r.json()["user"] is None, f"{header} should suppress the auto-session"
    # …and without them, the same client is signed in.
    assert c.get("/api/session").json()["user"] == "local"


def test_a_real_cookie_still_wins(guest, monkeypatch):
    """Signing in as someone else must keep working in desktop mode."""
    import bcrypt

    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'deskother'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("deskother", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("deskother")

    c = _desktop_client(monkeypatch)
    assert c.get("/api/session").json()["user"] == "local"  # auto-session first
    assert c.post("/api/login", json={"username": "deskother", "password": "pw"}).status_code == 200
    assert c.get("/api/session").json()["user"] == "deskother", "the cookie must beat the auto-session"


def test_write_endpoints_work_under_the_auto_session(guest, monkeypatch):
    """Not just /api/session: the session has to be usable for real work."""
    c = _desktop_client(monkeypatch)
    r = c.post("/api/blocks", json={"parent_id": "root", "content": "desktop note"})
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "desktop note"


# --- the account -------------------------------------------------------------

def test_desktop_user_is_idempotent_and_has_no_usable_password(guest):
    from gamma.db import connect_users_db
    from gamma.seed import ensure_desktop_user

    assert ensure_desktop_user("local") == "local"
    assert ensure_desktop_user("local") == "local"  # no duplicate row, no error
    with connect_users_db() as conn:
        rows = conn.execute(
            "SELECT password_hash, is_admin, is_guest FROM users WHERE username = 'local'"
        ).fetchall()
    assert len(rows) == 1
    pwhash, is_admin, is_guest = rows[0]
    # A bcrypt hash of a random secret, not "" — if remote sharing is ever
    # enabled the guard refuses the auto-session, and this account must not
    # then be a password-less way in.
    assert pwhash.startswith("$2") and len(pwhash) > 50
    assert is_admin == 1 and is_guest == 0


# --- content types -----------------------------------------------------------

def test_module_scripts_are_served_as_javascript(tmp_path, monkeypatch):
    """A module script served as text/plain is refused by Chromium.

    Python's mimetypes answers text/plain for `.mjs` on Windows, where the
    mapping comes from the registry rather than a table. In the desktop app
    that silently downgraded pdf.js to its main-thread fake worker: pages
    rendered, no text was extracted, and selection, highlighting and in-PDF
    search all stopped working. Caught on a Windows CI runner, not here.
    """
    import mimetypes

    from gamma import app as app_module, config

    (tmp_path / "index.html").write_text("<html></html>")
    (tmp_path / "pdf.worker.min.mjs").write_text("export default 1;\n")

    mimetypes.init()  # so the patch below lands on the live table
    monkeypatch.setitem(mimetypes.types_map, ".mjs", "text/plain")  # what Windows says
    monkeypatch.setattr(config, "STATIC_DIR", str(tmp_path))

    client = TestClient(app_module.create_app())
    r = client.get("/pdf.worker.min.mjs")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript"), r.headers["content-type"]

"""Admin user-management API: privilege gating, CRUD, and lockout rails."""

import bcrypt
import pytest
from fastapi.testclient import TestClient


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


@pytest.fixture(scope="module")
def boss(client):
    """A TestClient logged in as an admin-privileged user."""
    _make_user("boss", "bosspw", is_admin=1)
    return _login("boss", "bosspw")


def test_admin_is_a_privilege_not_a_name(boss):
    s = boss.get("/api/session").json()
    assert s["user"] == "boss" and s["is_admin"] is True


def test_startup_seeds_first_admin_once(boss):
    """The empty test instance seeded an 'admin' account with a RANDOM
    password at app startup; once any account exists the seed is a strict
    no-op (no backdoor on upgrades)."""
    from gamma.app import app
    from gamma.seed import ensure_admin_seed

    users = {u["username"]: u for u in boss.get("/api/admin/users").json()["users"]}
    assert users["admin"]["is_admin"] is True
    # no guessable fixed default
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "admin", "password": "admin123"}).status_code == 401
    assert ensure_admin_seed() is None  # accounts exist → never seeds again


def test_seed_password_is_random_and_works(tmp_path):
    """On a genuinely fresh data dir, the seed's returned/printed password
    actually logs in and is not the old fixed default. (Subprocess: config
    reads GAMMA_DATA_DIR at import, so a fresh dir needs a fresh process.)"""
    import os
    import subprocess
    import sys
    from pathlib import Path

    code = (
        "from gamma.seed import ensure_admin_seed\n"
        "import bcrypt\n"
        "from gamma.db import connect_users_db\n"
        "user, pw = ensure_admin_seed()\n"
        "with connect_users_db() as c:\n"
        "    h = c.execute(\"SELECT password_hash FROM users WHERE username = ?\", (user,)).fetchone()[0]\n"
        "print('PW:' + pw)\n"
        "print('MATCH' if bcrypt.checkpw(pw.encode(), h.encode()) else 'MISMATCH')\n"
    )
    env = {**os.environ, "GAMMA_DATA_DIR": str(tmp_path)}
    env.pop("GAMMA_ADMIN_USER", None)
    env.pop("GAMMA_ADMIN_PASSWORD", None)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                         env=env, cwd=str(Path(__file__).resolve().parent.parent)).stdout
    assert "MATCH" in out, out
    pw = next(l for l in out.splitlines() if l.startswith("PW:"))[3:]
    assert pw != "admin123" and len(pw) >= 12
    # ...and the console output actually shows it (that's the only place it exists)
    assert f"password: {pw}" in out


def test_non_admins_are_locked_out(client):
    _make_user("pleb", "plebpw")
    pleb = _login("pleb", "plebpw")
    assert pleb.get("/api/session").json()["is_admin"] is False
    assert pleb.get("/api/admin/users").status_code == 403
    assert pleb.post("/api/admin/users", json={"username": "x", "password": "y"}).status_code == 403
    # A guest session of its own (not the shared `guest` fixture — that would
    # log the session-scoped client in before test_auth asserts it is anonymous)
    from gamma.app import app
    g = TestClient(app)
    assert g.post("/api/login-guest").status_code == 200
    assert g.get("/api/admin/users").status_code == 403
    assert TestClient(app).get("/api/admin/users").status_code == 401


def test_create_list_and_login(boss):
    r = boss.post("/api/admin/users", json={"username": "newbie", "password": "npw"})
    assert r.status_code == 200, r.text
    users = {u["username"]: u for u in r.json()["users"]}
    assert "newbie" in users and users["newbie"]["is_admin"] is False
    _login("newbie", "npw")  # account actually works
    # duplicate + bad names rejected
    assert boss.post("/api/admin/users", json={"username": "newbie", "password": "x"}).status_code == 409
    assert boss.post("/api/admin/users", json={"username": "bad name", "password": "x"}).status_code == 400
    assert boss.post("/api/admin/users", json={"username": "nopw", "password": ""}).status_code == 400


def test_set_password(boss):
    r = boss.put("/api/admin/users/newbie", json={"password": "rotated"})
    assert r.status_code == 200
    from gamma.app import app
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "newbie", "password": "npw"}).status_code == 401
    _login("newbie", "rotated")


def test_grant_and_revoke_admin(boss):
    r = boss.put("/api/admin/users/newbie", json={"is_admin": True})
    assert {u["username"]: u["is_admin"] for u in r.json()["users"]}["newbie"] is True
    # the new admin can use the API too
    newbie = _login("newbie", "rotated")
    assert newbie.get("/api/admin/users").status_code == 200
    r = boss.put("/api/admin/users/newbie", json={"is_admin": False})
    assert {u["username"]: u["is_admin"] for u in r.json()["users"]}["newbie"] is False


def test_lockout_rails(boss):
    # the startup-seeded 'admin' also holds the privilege — demote it so boss
    # is the last admin, then the rails must hold
    assert boss.put("/api/admin/users/admin", json={"is_admin": False}).status_code == 200
    assert boss.put("/api/admin/users/boss", json={"is_admin": False}).status_code == 400
    assert boss.delete("/api/admin/users/boss").status_code == 400  # also self-delete
    # guest is untouchable
    assert boss.put("/api/admin/users/guest", json={"password": "x"}).status_code == 400
    assert boss.delete("/api/admin/users/guest").status_code == 400
    assert boss.delete("/api/admin/users/ghost-user").status_code == 404


def test_rename_user_via_gui(boss):
    from gamma.app import app
    from gamma.config import USERS_DIR

    boss.post("/api/admin/users", json={"username": "rene", "password": "rpw"})
    r = boss.post("/api/admin/users/rene/rename", json={"new_username": "renata"})
    assert r.status_code == 200, r.text
    names = [u["username"] for u in r.json()["users"]]
    assert "renata" in names and "rene" not in names
    assert (USERS_DIR / "renata" / "pages.db").exists()
    assert not (USERS_DIR / "rene").exists()
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "rene", "password": "rpw"}).status_code == 401
    _login("renata", "rpw")
    # collisions / guest / bad names / ghosts rejected
    assert boss.post("/api/admin/users/renata/rename", json={"new_username": "boss"}).status_code == 409
    assert boss.post("/api/admin/users/guest/rename", json={"new_username": "g2"}).status_code == 400
    assert boss.post("/api/admin/users/renata/rename", json={"new_username": "bad name"}).status_code == 400
    assert boss.post("/api/admin/users/ghost/rename", json={"new_username": "x"}).status_code == 404


def test_self_rename_keeps_the_session_working(boss):
    r = boss.post("/api/admin/users/boss/rename", json={"new_username": "bigboss"})
    assert r.status_code == 200, r.text
    s = boss.get("/api/session").json()  # same cookie, no re-login
    assert s["user"] == "bigboss" and s["is_admin"] is True


def test_seed_hints_but_never_backdoors_an_adminless_instance(boss, capsys):
    """Accounts exist but nobody has the privilege (upgraded instance) — the
    seed must NOT create an admin/admin123 login; it only prints a hint."""
    from gamma.db import connect_users_db
    from gamma.seed import ensure_admin_seed

    with connect_users_db() as conn:
        conn.execute("UPDATE users SET is_admin = 0")
        conn.commit()
    try:
        assert ensure_admin_seed() is None
        assert "set-admin" in capsys.readouterr().out
        with connect_users_db() as conn:
            assert conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1").fetchone()[0] == 0
    finally:  # restore for the tests below
        with connect_users_db() as conn:
            conn.execute("UPDATE users SET is_admin = 1 WHERE username = 'bigboss'")
            conn.commit()


def test_delete_user_removes_account_and_data(boss):
    from gamma.config import USERS_DIR
    assert (USERS_DIR / "newbie" / "pages.db").exists()
    r = boss.delete("/api/admin/users/newbie")
    assert r.status_code == 200, r.text
    assert "newbie" not in [u["username"] for u in r.json()["users"]]
    from gamma.app import app
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "newbie", "password": "rotated"}).status_code == 401
    if not r.json()["warning"]:  # Windows file locks may defer the dir removal
        assert not (USERS_DIR / "newbie").exists()

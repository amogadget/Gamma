"""The grants behind the portal's Devices page: races between a refresh and
a revoke, code replay, sign-out-everywhere, the refresh retry window and
reuse detection, one grant per device, last activity, and the page."""

import sqlite3
import threading
import time
from contextlib import closing

from conftest import register, verify
from test_oidc import CALLBACK, pkce, signed_in_code

from gammacloud import config, db


def sign_in(client, **extra):
    """A desktop sign-in from the verified, signed-in browser; the tokens."""
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    r = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                    "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def exchange(client, code, verifier):
    return client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                       "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier})


def refresh(client, token):
    return client.post("/token", data={"grant_type": "refresh_token", "refresh_token": token,
                                       "client_id": config.DESKTOP_CLIENT_ID})


def devices(client):
    return client.get("/api/devices").json()["devices"]


def alice(client):
    register(client)
    verify(client)


def write_lock():
    """Another writer holding cloud.db, like a slow request would."""
    lock = sqlite3.connect(str(config.DB_PATH), isolation_level=None, timeout=5)
    lock.execute("BEGIN IMMEDIATE")
    return lock


def in_thread(fn):
    box = []
    t = threading.Thread(target=lambda: box.append(fn()))
    t.start()
    return t, box


# --- races --------------------------------------------------------------------

def test_revoke_during_a_refresh_leaves_no_live_token(client):
    alice(client)
    tokens = sign_in(client)
    grant = devices(client)[0]["id"]
    lock = write_lock()
    t, box = in_thread(lambda: refresh(client, tokens["refresh_token"]))
    time.sleep(0.4)
    # what POST /api/devices/{id}/revoke does, landing while the refresh waits
    lock.execute("UPDATE grants SET revoked_at = ?, refresh_hash = NULL WHERE id = ?", (db.now(), grant))
    lock.execute("DELETE FROM access_tokens WHERE grant_id = ?", (grant,))
    lock.execute("COMMIT")
    lock.close()
    t.join()
    assert box[0].status_code == 400 and box[0].json()["error"] == "invalid_grant"
    with closing(db.connect()) as conn:
        assert conn.execute("SELECT COUNT(*) FROM access_tokens WHERE grant_id = ?", (grant,)).fetchone()[0] == 0


def test_a_waiting_token_request_does_not_stall_the_server(client):
    alice(client)
    tokens = sign_in(client)
    lock = write_lock()
    t, box = in_thread(lambda: refresh(client, tokens["refresh_token"]))
    time.sleep(0.3)
    started = time.monotonic()
    assert client.get("/api/health").status_code == 200
    elapsed = time.monotonic() - started
    lock.execute("COMMIT")
    lock.close()
    t.join()
    assert elapsed < 1, f"/api/health waited {elapsed:.1f} s behind /token"
    assert box[0].status_code == 200


# --- replay and sign-out-everywhere -------------------------------------------

def test_replaying_one_code_revokes_only_its_own_grant(client):
    alice(client)
    va, ca = pkce()
    vb, cb = pkce()
    code_a, code_b = signed_in_code(client, ca), signed_in_code(client, cb)
    a = exchange(client, code_a, va).json()
    b = exchange(client, code_b, vb).json()
    r = exchange(client, code_a, va)
    assert r.status_code == 400 and r.json()["error_description"] == "code already used"
    assert refresh(client, a["refresh_token"]).status_code == 400   # the replayed code's grant is gone
    assert refresh(client, b["refresh_token"]).status_code == 200   # the other laptop is untouched


def test_sign_out_everywhere_voids_codes_not_yet_exchanged(client):
    alice(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    client.post("/api/devices/revoke-all", json={})
    r = exchange(client, code, verifier)
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant"
    assert devices(client) == []


# --- the refresh retry window and reuse detection -----------------------------

def age_history(seconds):
    """Pretend every rotated-away refresh token was replaced ``seconds`` ago."""
    with closing(db.connect()) as conn:
        conn.execute("UPDATE refresh_history SET replaced_at = ?", (db.after(-seconds),))
        conn.commit()


def test_a_lost_refresh_answer_can_be_retried(client):
    alice(client)
    tokens = sign_in(client)
    lost = refresh(client, tokens["refresh_token"]).json()           # the answer never arrives
    retry = refresh(client, tokens["refresh_token"])
    assert retry.status_code == 200
    assert refresh(client, retry.json()["refresh_token"]).status_code == 200
    assert client.get("/userinfo", headers={"Authorization": "Bearer " + lost["access_token"]}).status_code == 401
    assert len(devices(client)) == 1


def test_reusing_an_old_refresh_token_signs_the_device_out(client):
    alice(client)
    tokens = sign_in(client)
    fresh = refresh(client, tokens["refresh_token"]).json()
    age_history(config.REFRESH_REUSE_GRACE + 5)
    r = refresh(client, tokens["refresh_token"])                      # someone else held the old key
    assert r.status_code == 400 and "already used" in r.json()["error_description"]
    assert refresh(client, fresh["refresh_token"]).status_code == 400  # so the device is signed out
    assert devices(client) == []
    with closing(db.connect()) as conn:
        events = [r["event"] for r in conn.execute("SELECT event FROM audit ORDER BY id")]
    assert "grant.reuse" in events


def test_revoking_with_an_old_refresh_token_revokes_the_grant(client):
    alice(client)
    tokens = sign_in(client)
    refresh(client, tokens["refresh_token"])
    client.post("/revoke", data={"token": tokens["refresh_token"], "client_id": config.DESKTOP_CLIENT_ID})
    assert devices(client) == []


# --- one grant per device -----------------------------------------------------

def test_a_device_signing_in_again_replaces_its_grant(client):
    alice(client)
    first = sign_in(client, device_id="install-0001-abcd", device_name="Tim's ThinkPad")
    second = sign_in(client, device_id="install-0001-abcd", device_name="Tim's ThinkPad")
    sign_in(client, device_id="install-0002-efgh", device_name="Office\x00 PC\n")
    assert refresh(client, first["refresh_token"]).status_code == 400
    assert refresh(client, second["refresh_token"]).status_code == 200
    names = sorted(d["device_name"] for d in devices(client))
    assert names == ["Office PC", "Tim's ThinkPad"]
    # a malformed id is dropped, not refused: nothing is replaced by it
    sign_in(client, device_id="../bad id")
    sign_in(client, device_id="../bad id")
    assert len(devices(client)) == 4


def test_last_activity_follows_the_access_token(client):
    alice(client)
    tokens = sign_in(client)
    with closing(db.connect()) as conn:
        conn.execute("UPDATE grants SET last_used_at = ?", (db.after(-3 * 86400),))
        conn.commit()
    client.get("/userinfo", headers={"Authorization": "Bearer " + tokens["access_token"]})
    assert devices(client)[0]["last_used_at"] > db.after(-60)


def test_the_devices_page(client):
    alice(client)
    sign_in(client, device_id="install-0001-abcd", device_name="Tim's <ThinkPad>")
    page = client.get("/devices").text
    assert "Tim&#x27;s &lt;ThinkPad&gt;" in page and "<ThinkPad>" not in page
    assert "Gamma apps" in page and "Browsers" in page and "This browser" in page
    assert "aria-label='Sign out Tim&#x27;s &lt;ThinkPad&gt;'" in page
    assert "<time datetime=" in page


# --- browsers -----------------------------------------------------------------

def test_signing_one_browser_out(client):
    alice(client)
    other = client.__class__(client.app, base_url="http://testserver")
    other.post("/api/login", json={"login": "alice", "password": "correct horse battery"})
    browsers = client.get("/api/devices").json()["browsers"]
    assert [b["current"] for b in browsers].count(True) == 1 and len(browsers) == 2
    theirs = next(b for b in browsers if not b["current"])
    assert client.post(f"/api/sessions/{theirs['id']}/revoke", json={}).status_code == 200
    assert other.get("/api/me").status_code == 401
    assert client.get("/api/me").status_code == 200
    assert client.post("/api/sessions/not-an-id/revoke", json={}).status_code == 404


# --- the server under load, the origin check, the client address, the audit ---

def test_a_busy_database_is_a_503_not_a_500(client, monkeypatch):
    alice(client)
    tokens = sign_in(client)
    monkeypatch.setattr(db, "BUSY_TIMEOUT", 0.2)
    lock = write_lock()
    try:
        r = refresh(client, tokens["refresh_token"])
        assert r.status_code == 503 and r.json()["error"] == "temporarily_unavailable"
        r = client.post("/api/devices/revoke-all", json={})
        assert r.status_code == 503 and r.headers["retry-after"]
    finally:
        lock.execute("ROLLBACK")
        lock.close()
    assert refresh(client, tokens["refresh_token"]).status_code == 200  # nothing was spent


def test_state_changes_come_from_the_portal_pages(client):
    alice(client)
    for headers in ({"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "cross-site"},
                    {"Origin": "https://alice.gammapdf.com"}):
        assert client.post("/api/devices/revoke-all", headers=headers).status_code == 403, headers
    assert client.post("/api/devices/revoke-all", headers={"Sec-Fetch-Site": "same-origin"}).status_code == 200
    assert client.post("/api/devices/revoke-all", headers={"Origin": "http://testserver"}).status_code == 200
    # the OAuth endpoints are called by Gamma servers, from anywhere
    r = client.post("/token", data={"grant_type": "refresh_token", "refresh_token": "x",
                                    "client_id": config.DESKTOP_CLIENT_ID}, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 400


def test_the_client_address_is_cloudflares_not_the_forwarded_header(client):
    alice(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier},
                headers={"CF-Connecting-IP": "198.51.100.7", "X-Forwarded-For": "6.6.6.6"})
    sign_in(client, device_id="install-0002-efgh")
    ips = {d["ip"] for d in devices(client)}
    assert ips == {"198.51.100.7", "testclient"}


def test_a_device_sign_out_is_in_the_accounts_audit(client):
    alice(client)
    sign_in(client)
    grant = devices(client)[0]["id"]
    client.post(f"/api/devices/{grant}/revoke", json={})
    client.post(f"/api/devices/{grant}/revoke", json={})               # again: nothing to record
    with closing(db.connect()) as conn:
        rows = conn.execute("SELECT account_id FROM audit WHERE event = 'grant.revoke'").fetchall()
    assert len(rows) == 1 and rows[0]["account_id"]


# --- the overview's checklist, sign-in round trip, the upgrade ----------------

def test_the_app_step_stays_done_after_signing_everything_out(client):
    alice(client)
    assert "Install the desktop app" in client.get("/").text
    sign_in(client)
    client.post("/api/devices/revoke-all", json={})
    page = client.get("/").text
    assert "Get started" not in page and "No Gamma app is signed in right now" in page


def test_pages_send_a_signed_out_browser_back_after_sign_in(client):
    alice(client)
    client.post("/api/logout")
    r = client.get("/devices", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/login?next=%2Fdevices"
    assert '"/devices"' in client.get("/login?next=/devices").text
    assert '"//evil.example"' not in client.get("/login?next=//evil.example").text


def test_upgrade_to_devices(client):
    alice(client)
    sign_in(client)
    with closing(db.connect()) as conn:
        for table, column in (("grants", "device_id"), ("grants", "device_name"), ("oauth_codes", "grant_id"),
                              ("oauth_codes", "access_hash"), ("accounts", "app_signed_in_at")):
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        conn.execute("DROP TABLE refresh_history")
        conn.execute("PRAGMA user_version = 2")
        conn.commit()
    assert db.ensure_current() == ["devices"]
    assert db.ensure_current() == []
    with closing(db.connect()) as conn:
        assert conn.execute("SELECT app_signed_in_at FROM accounts").fetchone()[0]  # from the audit
        assert conn.execute("SELECT device_id FROM grants").fetchone()[0] == ""
    assert len(devices(client)) == 1

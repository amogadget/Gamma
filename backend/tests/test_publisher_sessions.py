"""Publisher credentials stay private to an account and exact HTTPS host."""

import time
from urllib.request import Request

import pytest

from conftest import login, make_user, make_page
from gamma import publisher_sessions as sessions
from gamma.db import connect_users_db
from gamma.net_guard import guarded_urlopen
from test_net_guard import transport  # noqa: F401 -- fake urllib transport fixture

HOST = "journals.aps.org"
SECRET = "private-publisher-session"
COOKIE = {"name": "access", "value": SECRET, "domain": ".aps.org",
          "hostOnly": False, "path": "/"}


@pytest.fixture
def accounts(client):
    for name in ("pub_alice", "pub_bob"):
        make_user(name, "publisher-password")
        with connect_users_db() as conn:
            conn.execute("DELETE FROM publisher_sessions WHERE username=?", (name,))
            conn.commit()
    return login("pub_alice", "publisher-password"), login("pub_bob", "publisher-password")


def connect(client, cookies=None, host=HOST, **kwargs):
    return client.post("/api/publisher-sessions", json={
        "host": host, "cookies": [COOKIE] if cookies is None else cookies,
    }, headers={"x-forwarded-proto": "https", **kwargs})


def cookie_header(username, url):
    token = sessions.current_user.set(username)
    try:
        jar = sessions.cookie_jar()
    finally:
        sessions.current_user.reset(token)
    req = Request(url)
    jar.add_cookie_header(req)
    return req.get_header("Cookie")


def test_connect_encrypted_private_and_disconnect(accounts):
    alice, bob = accounts
    assert connect(alice).status_code == 200
    result = alice.get("/api/publisher-sessions")
    assert result.json()["sessions"][0]["host"] == HOST
    assert SECRET not in result.text and "encrypted" not in result.text
    assert bob.get("/api/publisher-sessions").json()["sessions"] == []
    with connect_users_db() as conn:
        encrypted = conn.execute("SELECT encrypted FROM publisher_sessions WHERE username='pub_alice'").fetchone()[0]
    assert SECRET not in encrypted
    assert cookie_header("pub_alice", f"https://{HOST}/paper.pdf") == "access=" + SECRET
    assert cookie_header("pub_bob", f"https://{HOST}/paper.pdf") is None
    assert cookie_header(None, f"https://{HOST}/paper.pdf") is None
    # Another user's disconnect cannot remove Alice's connection.
    assert bob.delete(f"/api/publisher-sessions/{HOST}").status_code == 200
    assert cookie_header("pub_alice", f"https://{HOST}/paper.pdf")
    assert alice.delete(f"/api/publisher-sessions/{HOST}").status_code == 200
    assert cookie_header("pub_alice", f"https://{HOST}/paper.pdf") is None


def test_no_guest_anonymous_share_or_plain_http_import(accounts, guest, anon):
    alice, _ = accounts
    assert connect(anon).status_code == 401
    assert connect(guest).status_code == 403
    assert alice.post("/api/publisher-sessions", json={"host": HOST, "cookies": [COOKIE]}).status_code == 400
    assert alice.post("/api/publisher-sessions?share=anything", json={"host": HOST, "cookies": [COOKIE]}).status_code == 403
    assert connect(alice, **{"x-gamma-user": "pub_bob"}).status_code == 409


@pytest.mark.parametrize("cookie", [
    {**COOKIE, "domain": ".org"},
    {**COOKIE, "domain": ".stanford.edu"},
    {**COOKIE, "domain": "login.aps.org", "hostOnly": True},
    {**COOKIE, "name": "bad\r\nCookie"},
    {**COOKIE, "value": SECRET + "\r\nCookie: leak"},
    {**COOKIE, "partitionKey": {"topLevelSite": "https://aps.org"}},
    {**COOKIE, "expirationDate": time.time() - 10},
])
def test_reject_bad_cookie_without_echoing_value(accounts, cookie):
    response = connect(accounts[0], [cookie])
    assert response.status_code == 400
    assert SECRET not in response.text


def test_cookie_scope_and_expiry(accounts, monkeypatch):
    alice, _ = accounts
    now = time.time()
    assert connect(alice, [{**COOKIE, "path": "/prl/"}]).status_code == 200
    assert cookie_header("pub_alice", f"https://{HOST}/prl/pdf/a")
    for url in (f"http://{HOST}/prl/pdf/a", "https://link.aps.org/prl/pdf/a",
                f"https://evil.{HOST}/prl/pdf/a", f"https://{HOST}.evil.org/prl/pdf/a",
                f"https://{HOST}/other/pdf/a"):
        assert cookie_header("pub_alice", url) is None
    monkeypatch.setattr(sessions.time, "time", lambda: now + sessions.SESSION_AGE + 10)
    assert cookie_header("pub_alice", f"https://{HOST}/prl/pdf/a") is None
    assert alice.get("/api/publisher-sessions").json()["sessions"] == []


def test_connected_cookies_in_pdf_flow_but_not_share(accounts, transport):
    alice, bob = accounts
    routes, seen = transport
    start = "https://doi.org/10.1103/session-test"
    pdf = f"https://{HOST}/prl/pdf/10.1103/session-test"
    routes[start] = (302, {"Location": pdf}, b"")
    routes[pdf] = (200, {"Content-Type": "application/pdf"}, b"%PDF-1.4 test")
    assert connect(alice).status_code == 200
    response = alice.post("/api/resolve-pdf", json={"source_url": start, "allow_oa": False})
    assert response.status_code == 200, response.text
    assert seen == [(start, None), (pdf, "access=" + SECRET)]
    seen.clear()
    response = alice.get("/api/pdf", params={"source_url": pdf})
    assert response.content.startswith(b"%PDF")
    assert response.headers["cache-control"] == "private, no-store"
    assert seen == [(pdf, "access=" + SECRET)]
    seen.clear()
    bob.get("/api/pdf", params={"source_url": pdf})
    assert seen == [(pdf, None)]
    seen.clear()
    page = make_page(alice, "Session paper", properties={"source_url": pdf, "doc_id": "publisher-test"})
    share = alice.post(f"/api/share/{page['id']}").json()["token"]
    alice.get("/api/pdf", params={"source_url": pdf, "share": share})
    assert seen == [(pdf, None)]


def test_connected_cookie_does_not_follow_external_redirect(accounts, transport):
    routes, seen = transport
    start, target = f"https://{HOST}/paper.pdf", "https://other.example/stolen"
    routes[start] = (302, {"Location": target}, b"")
    routes[target] = (200, {}, b"done")
    connect(accounts[0])
    token = sessions.current_user.set("pub_alice")
    try:
        with guarded_urlopen(start) as response:
            response.read()
    finally:
        sessions.current_user.reset(token)
    assert seen == [(start, "access=" + SECRET), (target, None)]


def test_reimport_replaces_cookie_snapshot_and_caps_lifetime(accounts):
    alice, _ = accounts
    connect(alice)
    result = connect(alice, [{**COOKIE, "value": "replacement", "expirationDate": time.time() + 10**8}])
    assert result.status_code == 200
    assert result.json()["expires_at"] <= time.time() + sessions.MAX_AGE
    assert cookie_header("pub_alice", f"https://{HOST}/") == "access=replacement"


def test_corrupt_ciphertext_does_not_break_pdf_fetch(accounts):
    connect(accounts[0])
    with connect_users_db() as conn:
        conn.execute("UPDATE publisher_sessions SET encrypted='broken' WHERE username='pub_alice'")
        conn.commit()
    assert cookie_header("pub_alice", f"https://{HOST}/") is None


def test_sibling_connections_keep_separate_credentials(accounts):
    alice, _ = accounts
    connect(alice)
    assert connect(alice, [{**COOKIE, "value": "sibling"}], host="link.aps.org").status_code == 200
    assert cookie_header("pub_alice", f"https://{HOST}/") == "access=" + SECRET
    assert cookie_header("pub_alice", "https://link.aps.org/") == "access=sibling"


def test_delete_account_removes_connections(accounts):
    alice, _ = accounts
    connect(alice)
    make_user("pub_admin", "publisher-password", is_admin=1)
    admin = login("pub_admin", "publisher-password")
    response = admin.delete("/api/admin/users/pub_alice")
    assert response.status_code == 200, response.text
    with connect_users_db() as conn:
        assert conn.execute("SELECT host FROM publisher_sessions WHERE username='pub_alice'").fetchall() == []


def test_import_rejects_plain_text_and_oversized_payload(accounts):
    alice, _ = accounts
    headers = {"x-forwarded-proto": "https"}
    assert alice.post("/api/publisher-sessions", content="{}", headers=headers).status_code == 415
    headers["content-type"] = "application/json"
    assert alice.post("/api/publisher-sessions", content="x" * (256 * 1024 + 1), headers=headers).status_code == 413

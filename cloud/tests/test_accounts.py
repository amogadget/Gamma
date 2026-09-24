from conftest import invite, last_link, make_admin, register, verify

from fastapi.testclient import TestClient

from gammacloud import accounts, config, mail, ratelimit


def test_register_verify_login_flow(client):
    account = register(client)
    assert account["username"] == "alice" and account["email_verified"] is False and account["plan"] == "free"
    assert mail.outbox[-1]["to"] == "alice@example.org"
    sent = mail.outbox[-1]
    token = last_link("/verify")
    assert f'href="http://testserver/verify?token={token}"' in sent["html"] and "Hi alice," in sent["html"]
    # registering signs the browser in
    me = client.get("/api/me").json()
    assert me["account"]["username"] == "alice" and me["auth"] == "session"
    verify(client)
    client.post("/api/logout")
    assert client.get("/api/me").status_code == 401
    r = client.post("/api/login", json={"login": "ALICE@example.org", "password": "correct horse battery"})
    assert r.status_code == 200 and r.json()["account"]["email_verified"] is True
    r = client.post("/api/login", json={"login": "alice", "password": "nope"})
    assert r.status_code == 401


def test_invite_required_and_consumed(client):
    r = client.post("/api/register", json={"email": "a@example.org", "username": "aaa", "password": "correct horse battery"})
    assert r.status_code == 403
    code = invite(uses=1, plan="plus")
    a = register(client, "aaa", code=code)
    assert a["plan"] == "plus"
    r = client.post("/api/register", json={"email": "b@example.org", "username": "bbb", "password": "correct horse battery",
                                           "invite": code})
    assert r.status_code == 403


def test_open_and_closed_registration(client):
    config.REGISTRATION = "open"
    r = client.post("/api/register", json={"email": "a@example.org", "username": "aaa", "password": "correct horse battery"})
    assert r.status_code == 201
    config.REGISTRATION = "closed"
    r = client.post("/api/register", json={"email": "b@example.org", "username": "bbb", "password": "correct horse battery"})
    assert r.status_code == 403


def test_validation_and_uniqueness(client):
    code = invite(uses=10)
    bad = [({"username": "ab"}, "username"), ({"username": "Admin"}, "reserved"), ({"username": "-x-"}, "username"),
           ({"email": "not-an-email"}, "e-mail"), ({"password": "short"}, "password")]
    for override, word in bad:
        body = {"email": "x@example.org", "username": "xyz", "password": "correct horse battery", "invite": code, **override}
        r = client.post("/api/register", json=body)
        assert r.status_code == 400, override
        assert word.lower() in r.json()["detail"].lower()
    # a username is 3 to 32 characters: one and two are refused, three accepted
    assert not accounts.USERNAME_RE.match("a") and not accounts.USERNAME_RE.match("ab")
    assert accounts.USERNAME_RE.match("abc")
    ratelimit.clear()  # rejected attempts count against the per-IP limit
    register(client, "alice", code=code)
    r = client.post("/api/register", json={"email": "alice@example.org", "username": "other", "password": "correct horse battery",
                                           "invite": code})
    assert r.status_code == 409
    r = client.post("/api/register", json={"email": "other@example.org", "username": "alice", "password": "correct horse battery",
                                           "invite": code})
    assert r.status_code == 409


def test_verify_link_is_single_use_and_resendable(client):
    register(client)
    token = last_link("/verify")
    assert client.post("/api/verify", json={"token": token}).status_code == 200
    assert client.post("/api/verify", json={"token": token}).status_code == 400
    assert client.post("/api/verify/resend", json={}).json()["already"] is True


def test_resend_voids_previous_link(client):
    register(client)
    first = last_link("/verify")
    client.post("/api/verify/resend", json={})
    second = last_link("/verify")
    assert first != second
    assert client.post("/api/verify", json={"token": first}).status_code == 400
    assert client.post("/api/verify", json={"token": second}).status_code == 200


def test_password_reset(client):
    register(client)
    client.post("/api/logout")
    n = len(mail.outbox)
    r = client.post("/api/reset/request", json={"email": "nobody@example.org"})
    assert r.status_code == 200 and len(mail.outbox) == n  # same answer, no mail
    r = client.post("/api/reset/request", json={"email": "alice@example.org"})
    assert r.status_code == 200 and len(mail.outbox) == n + 1
    token = last_link("/reset/confirm")
    r = client.post("/api/reset/confirm", json={"token": token, "password": "new password here"})
    assert r.status_code == 200
    assert r.json()["account"]["email_verified"] is True  # the mail reached them
    assert client.post("/api/reset/confirm", json={"token": token, "password": "again again again"}).status_code == 400
    client.post("/api/logout")
    assert client.post("/api/login", json={"login": "alice", "password": "correct horse battery"}).status_code == 401
    assert client.post("/api/login", json={"login": "alice", "password": "new password here"}).status_code == 200


def test_change_password_signs_other_sessions_out(client):
    register(client)
    other = client.cookies.get("gc_session")
    r = client.post("/api/me/password", json={"current": "wrong", "new": "another password"})
    assert r.status_code == 403
    r = client.post("/api/me/password", json={"current": "correct horse battery", "new": "another password"})
    assert r.status_code == 200
    assert client.get("/api/me").status_code == 200  # this browser got a fresh cookie
    client.cookies.set("gc_session", other)
    assert client.get("/api/me").status_code == 401


def test_change_email(client):
    register(client)
    verify(client)
    r = client.post("/api/email/change", json={"new_email": "alice@new.example", "password": "correct horse battery"})
    assert r.status_code == 200
    assert mail.outbox[-1]["to"] == "alice@new.example"
    token = last_link("/email/confirm")
    r = client.post("/api/email/confirm", json={"token": token})
    assert r.status_code == 200 and r.json()["email"] == "alice@new.example"
    assert mail.outbox[-1]["to"] == "alice@example.org"  # the old address is told
    assert client.get("/api/me").json()["account"]["email"] == "alice@new.example"


def test_change_username(client):
    register(client)
    r = client.post("/api/me/username", json={"username": "Alice-2", "password": "wrong"})
    assert r.status_code == 403
    r = client.post("/api/me/username", json={"username": "Alice-2", "password": "correct horse battery"})
    assert r.status_code == 200 and r.json()["account"]["username"] == "alice-2"
    assert client.post("/api/me/username", json={"username": "admin", "password": "correct horse battery"}).status_code == 400
    client.post("/api/logout")
    assert client.post("/api/login", json={"login": "alice-2", "password": "correct horse battery"}).status_code == 200
    with TestClient(client.app, base_url="http://testserver") as other:
        register(other, "bob")
        r = other.post("/api/me/username", json={"username": "alice-2", "password": "correct horse battery"})
        assert r.status_code == 409


def test_delete_self(client):
    register(client)
    assert client.post("/api/me/delete", json={"password": "wrong"}).status_code == 403
    assert client.post("/api/me/delete", json={"password": "correct horse battery"}).status_code == 200
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/login", json={"login": "alice", "password": "correct horse battery"}).status_code == 401
    # username and e-mail stay reserved through the grace period
    r = client.post("/api/register", json={"email": "alice@example.org", "username": "alice2", "password": "correct horse battery",
                                           "invite": invite()})
    assert r.status_code == 409


def test_login_rate_limit(client):
    register(client)
    client.post("/api/logout")
    for _ in range(10):
        assert client.post("/api/login", json={"login": "alice", "password": "wrong"}).status_code == 401
    r = client.post("/api/login", json={"login": "alice", "password": "correct horse battery"})
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_pages_render(client):
    for path in ("/login", "/register", "/reset", "/verify?token=x", "/reset/confirm?token=x", "/email/confirm?token=x"):
        r = client.get(path)
        assert r.status_code == 200 and "Gamma Cloud" in r.text, path
    assert client.get("/", follow_redirects=False).status_code == 302
    for path in ("/settings", "/devices", "/admin"):
        assert client.get(path, follow_redirects=False).status_code == 302, path
    register(client)
    r = client.get("/")
    assert r.status_code == 200 and "alice" in r.text and "not confirmed" in r.text
    assert client.get("/login", follow_redirects=False).status_code == 302
    assert "Change username" in client.get("/settings").text
    assert "No Gamma app is signed in" in client.get("/devices").text  # nothing to sign out yet
    assert client.get("/admin").status_code == 404
    make_admin("alice")
    r = client.get("/admin")
    assert r.status_code == 200 and "Audit log" in r.text


def test_admin_flag_in_me(client):
    register(client)
    make_admin("alice")
    assert client.get("/api/me").json()["account"]["is_admin"] is True


def test_mail_failure(client, monkeypatch):
    def boom(*a, **k):
        raise mail.MailError("domain not verified")
    monkeypatch.setattr(mail, "send", boom)
    # the account is made anyway (the mail goes out after the commit); the Overview offers the resend
    r = client.post("/api/register", json={"email": "z@example.org", "username": "zed", "password": "correct horse battery",
                                           "invite": invite()})
    assert r.status_code == 201 and r.json()["mailed"] is False
    r = client.post("/api/verify/resend")
    assert r.status_code == 503 and "could not send" in r.json()["detail"].lower()
    r = client.post("/api/reset/request", json={"email": "z@example.org"})
    assert r.status_code in (200, 503)


def test_health_and_config(client):
    assert client.get("/api/health").json() == {"ok": True}
    cfg = client.get("/api/config").json()
    assert cfg["registration"] == "invite" and cfg["issuer"] == "http://testserver"

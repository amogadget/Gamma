"""Sign in with Google / GitHub: the round trip (with the provider's side
stubbed), one-tap with a real RS256 token, linking, signup, settings."""

import sqlite3
import time
from contextlib import closing
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from conftest import invite, register, verify
from cryptography.hazmat.primitives.asymmetric import rsa
from test_oidc import CALLBACK, authorize_params, pkce, request_id_from

from gammacloud import config, db, identities, providers
from gammacloud.providers import Identity


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    for key, value in (("GOOGLE_CLIENT_ID", "gid.apps.googleusercontent.com"), ("GOOGLE_CLIENT_SECRET", "gsecret"),
                       ("GITHUB_CLIENT_ID", "ghid"), ("GITHUB_CLIENT_SECRET", "ghsecret"), ("GOOGLE_ONE_TAP", True)):
        monkeypatch.setattr(config, key, value)


@pytest.fixture
def provider_says(monkeypatch):
    """Make the provider answer the code exchange with this identity."""
    said = {}

    def fake(provider, code, *, verifier, nonce):
        assert code == "the-code" and verifier and nonce
        return said["identity"]

    monkeypatch.setattr(providers, "fetch_identity", fake)
    return lambda ident: said.update(identity=ident)


def round_trip(client, provider="github", **start):
    """Start at the button, come back from the provider; returns the callback response."""
    r = client.post(f"/api/oauth/{provider}/start", json=start)
    assert r.status_code == 200, r.text
    q = parse_qs(urlsplit(r.json()["url"]).query)
    assert q["code_challenge_method"] == ["S256"] and q["redirect_uri"] == [f"http://testserver/oauth/{provider}/callback"]
    return client.get(f"/oauth/{provider}/callback", params={"code": "the-code", "state": q["state"][0]},
                      follow_redirects=False)


def gh(email="new@example.org", subject="42", login="New-Person", trusted=True):
    return Identity("github", subject, email, trusted, "New Person", login)


def test_buttons_only_when_configured(client, monkeypatch):
    r = client.get("/login")
    assert 'data-provider=google' in r.text and 'data-provider=github' in r.text and "or continue with" in r.text
    assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin" and "gc_tap" in r.cookies
    assert 'data-provider=github' in client.get("/register").text
    monkeypatch.setattr(config, "GITHUB_CLIENT_SECRET", "")
    monkeypatch.setattr(config, "GOOGLE_CLIENT_ID", "")
    r = client.get("/login")
    assert "data-provider=" not in r.text and "or continue with" not in r.text and "social({" not in r.text
    assert client.post("/api/oauth/github/start", json={}).status_code == 404


def test_new_person_signs_up(client, provider_says):
    provider_says(gh())
    r = round_trip(client)
    assert r.status_code == 302 and r.headers["location"] == "/signup/finish"
    page = client.get("/signup/finish").text
    assert "new@example.org" in page and "value='new-person'" in page and "Invite code" in page
    r = client.post("/api/oauth/signup", json={"username": "new-person"})
    assert r.status_code == 403  # invite mode
    r = client.post("/api/oauth/signup", json={"username": "new-person", "invite": invite(plan="plus")})
    assert r.status_code == 201 and r.json()["redirect"] == "/"
    me = client.get("/api/me").json()["account"]
    assert me["username"] == "new-person" and me["email_verified"] and not me["has_password"] and me["plan"] == "plus"
    assert me["display_name"] == "New Person"
    # the form is spent; the password login refuses an account without one
    assert client.post("/api/oauth/signup", json={"username": "other", "invite": invite()}).status_code == 400
    assert client.post("/api/login", json={"login": "new-person", "password": ""}).status_code == 401
    # next time the same GitHub account signs straight in, whatever its address says now
    client.post("/api/logout")
    provider_says(gh(email="changed@example.org"))
    r = round_trip(client)
    assert r.headers["location"] == "/" and client.get("/api/me").json()["account"]["username"] == "new-person"


def test_state_must_match_the_browser(client, provider_says):
    provider_says(gh())
    client.post("/api/oauth/github/start", json={})
    r = client.get("/oauth/github/callback", params={"code": "the-code", "state": "forged"})
    assert r.status_code == 400 and "expired" in r.text
    # and the state is single use
    r = client.post("/api/oauth/github/start", json={})
    state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
    assert client.get("/oauth/github/callback", params={"code": "the-code", "state": state},
                      follow_redirects=False).status_code == 302
    assert client.get("/oauth/github/callback", params={"code": "the-code", "state": state}).status_code == 400


def test_cancel_at_provider_returns(client):
    r = client.post("/api/oauth/github/start", json={})
    state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
    r = client.get("/oauth/github/callback", params={"error": "access_denied", "state": state}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/login"


def test_trusted_address_links_existing_account(client, provider_says):
    register(client, "alice")
    verify(client)
    client.post("/api/logout")
    provider_says(Identity("google", "g-1", "alice@example.org", True, "Alice", "alice"))
    r = round_trip(client, "google")
    assert r.headers["location"] == "/"
    me = client.get("/api/me").json()["account"]
    assert me["username"] == "alice" and me["has_password"]
    assert "Connected as alice@example.org" in client.get("/settings").text


def test_untrusted_address_does_not_link(client, provider_says):
    register(client, "alice")
    verify(client)
    client.post("/api/logout")
    provider_says(Identity("google", "g-1", "alice@example.org", False))
    r = round_trip(client, "google")
    assert r.status_code == 409 and "connect Google under Settings" in r.text
    assert client.get("/api/me").status_code == 401


def test_unverified_account_is_claimed(client, provider_says):
    """Whoever registered the address without confirming it loses the password."""
    register(client, "squatter", email="victim@example.org")
    client.post("/api/logout")
    provider_says(gh(email="victim@example.org"))
    assert round_trip(client).headers["location"] == "/"
    me = client.get("/api/me").json()["account"]
    assert me["username"] == "squatter" and me["email_verified"] and not me["has_password"]
    assert client.post("/api/login", json={"login": "squatter", "password": "correct horse battery"}).status_code == 401


def test_closed_registration_refuses_new_identity(client, provider_says):
    config.REGISTRATION = "closed"
    provider_says(gh())
    r = round_trip(client)
    assert r.status_code == 403 and "registration is closed" in r.text


def test_gamma_server_sign_in_finishes_on_the_server(client, provider_says):
    _, challenge = pkce()
    page = client.get("/authorize", params=authorize_params(challenge)).text
    assert "data-provider=google" in page
    rid = request_id_from(page)
    provider_says(gh())
    r = round_trip(client, request_id=rid)
    assert r.headers["location"] == "/signup/finish"
    r = client.post("/api/oauth/signup", json={"username": "newbie", "invite": invite()})
    redirect = r.json()["redirect"]
    assert redirect.startswith(CALLBACK + "?") and parse_qs(urlsplit(redirect).query)["state"] == ["st-1"]
    # a known identity goes straight through
    client.post("/api/logout")
    rid = request_id_from(client.get("/authorize", params=authorize_params(challenge)).text)
    assert round_trip(client, request_id=rid).headers["location"].startswith(CALLBACK + "?code=")


def test_next_stays_on_this_site(client, provider_says):
    register(client, "alice")
    verify(client)
    client.post("/api/logout")
    provider_says(gh(email="alice@example.org"))
    assert round_trip(client, next="//evil.example/x").headers["location"] == "/"
    client.post("/api/logout")
    assert round_trip(client, next="/devices").headers["location"] == "/devices"


# --- one tap ------------------------------------------------------------------

@pytest.fixture
def google_key(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(providers, "_google_key", lambda token: key.public_key())

    def sign(nonce, **claims):
        now = int(time.time())
        body = {"iss": "https://accounts.google.com", "aud": config.GOOGLE_CLIENT_ID, "sub": "g-7", "iat": now,
                "exp": now + 600, "nonce": nonce, "email": "tapper@gmail.com", "email_verified": True, "name": "Tap",
                **claims}
        return jwt.encode(body, key, algorithm="RS256", headers={"kid": "k1"})
    return sign


def test_one_tap(client, google_key):
    client.get("/login")
    nonce = identities.derive(client.cookies["gc_tap"], "one-tap")
    assert nonce in client.get("/login").text  # the same cookie, the same nonce
    r = client.post("/api/oauth/google/one-tap", json={"credential": google_key("someone-elses")})
    assert r.status_code == 400
    r = client.post("/api/oauth/google/one-tap", json={"credential": google_key(nonce, aud="other-client")})
    assert r.status_code == 400
    r = client.post("/api/oauth/google/one-tap", json={"credential": google_key(nonce)})
    assert r.status_code == 200 and r.json()["redirect"] == "/signup/finish"
    assert "value='tapper'" in client.get("/signup/finish").text


def test_google_trust_rules(google_key):
    ident = providers.google_identity(google_key("n"), "n")
    assert ident.email == "tapper@gmail.com" and ident.email_trusted
    assert not providers.google_identity(google_key("n", email="a@outlook.com"), "n").email_trusted
    assert providers.google_identity(google_key("n", email="a@uni.edu", hd="uni.edu"), "n").email_trusted
    assert providers.google_identity(google_key("n", email_verified=False), "n").email == ""


def test_github_primary_verified_address():
    user = {"id": 5, "login": "octo", "name": None}
    ident = providers.github_identity(user, [{"email": "Old@x.org", "verified": True, "primary": False},
                                             {"email": "Main@x.org", "verified": True, "primary": True}])
    assert ident.email == "main@x.org" and ident.subject == "5" and ident.handle == "octo"
    assert providers.github_identity(user, [{"email": "a@x.org", "verified": False, "primary": True}]).email == ""


# --- settings -----------------------------------------------------------------

def test_connect_and_disconnect(client, provider_says):
    register(client, "alice")
    verify(client)
    provider_says(gh(email="someone-else@example.org"))
    r = round_trip(client, link=True)
    assert r.headers["location"] == "/settings?connected=github"
    assert "Connected as someone-else@example.org" in client.get("/settings").text
    # one GitHub account signs in to one Gamma Cloud account
    client.post("/api/logout")
    register(client, "bob")
    r = round_trip(client, link=True)
    assert r.status_code == 409
    client.post("/api/logout")
    client.post("/api/login", json={"login": "alice", "password": "correct horse battery"})
    assert client.post("/api/me/identities/github/unlink").json()["ok"]
    assert client.post("/api/me/identities/github/unlink").status_code == 404


def test_account_without_password(client, provider_says):
    provider_says(gh())
    round_trip(client)
    client.post("/api/oauth/signup", json={"username": "newbie", "invite": invite()})
    page = client.get("/settings").text
    assert "Set password" in page and "Current password" not in page
    # the only way in cannot be removed; the session confirms changes
    assert client.post("/api/me/identities/github/unlink").status_code == 400
    assert client.post("/api/me/username", json={"username": "newbie2"}).status_code == 200
    r = client.post("/api/me/password", json={"new": "a fine new password"})
    assert r.status_code == 200
    assert client.post("/api/me/username", json={"username": "newbie3"}).status_code == 403
    assert client.post("/api/me/identities/github/unlink").json()["ok"]
    client.post("/api/logout")
    assert client.post("/api/login", json={"login": "newbie2", "password": "a fine new password"}).status_code == 200


def test_delete_frees_the_identity(client, provider_says):
    provider_says(gh())
    round_trip(client)
    client.post("/api/oauth/signup", json={"username": "newbie", "invite": invite()})
    assert client.post("/api/me/delete", json={}).status_code == 200
    with closing(db.connect()) as conn:
        assert conn.execute("SELECT COUNT(*) FROM identities").fetchone()[0] == 0


def test_upgrade_adds_external_logins():
    with closing(db.connect()) as conn:
        conn.execute("DROP TABLE external_logins")
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
    assert db.ensure_current() == ["external_logins", "devices"]
    with closing(sqlite3.connect(str(config.DB_PATH))) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'external_logins'").fetchone()

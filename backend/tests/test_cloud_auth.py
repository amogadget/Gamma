"""Sign in with Gamma Cloud (gamma/cloud_auth.py): the OIDC client against
a fake account server that signs real Ed25519 ID tokens, the identity
policies (refuse / claim / provision), linking a signed-in account, the
admin subject, the settings API and the CLI helpers."""

import base64
import hashlib
import json
import time
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from conftest import login, make_user
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi.testclient import TestClient

from gamma import cloud_auth
from gamma.db import connect_users_db

ISSUER = "https://account.test"


class FakeAccountServer:
    """Answers the three HTTP calls the client makes: discovery, JWKS and
    the token endpoint. ``person`` is who the next sign-in is."""

    def __init__(self):
        self.key = ed25519.Ed25519PrivateKey.generate()
        self.kid = "k1"
        self.person = {"sub": "sub-alice", "handle": "alice", "email": "alice@example.org", "email_verified": True,
                       "name": "Alice", "plan": "free"}
        self.token_calls = []
        self.aud = None  # override the audience of the next ID token
        self.refresh = "rt-1"

    def jwk(self):
        raw = self.key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return {"kty": "OKP", "crv": "Ed25519", "x": base64.urlsafe_b64encode(raw).rstrip(b"=").decode(),
                "kid": self.kid, "alg": "EdDSA", "use": "sig"}

    def id_token(self, client_id, nonce):
        now = int(time.time())
        claims = {"iss": ISSUER, "aud": self.aud or client_id, "iat": now, "exp": now + 600, "nonce": nonce,
                  **self.person}
        return jwt.encode(claims, self.key, algorithm="EdDSA", headers={"kid": self.kid})

    def http(self, url, data=None, headers=None):
        if url == ISSUER + "/.well-known/openid-configuration":
            return {"issuer": ISSUER, "authorization_endpoint": ISSUER + "/authorize", "token_endpoint": ISSUER + "/token",
                    "jwks_uri": ISSUER + "/jwks"}
        if url == ISSUER + "/jwks":
            return {"keys": [self.jwk()]}
        if url == ISSUER + "/token":
            form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
            self.token_calls.append(form)
            code = json.loads(base64.urlsafe_b64decode(form["code"] + "==").decode())
            challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).rstrip(b"=").decode()
            if challenge != code["challenge"] or form["redirect_uri"] != code["redirect_uri"]:
                raise cloud_auth.CloudAuthError("pkce or redirect mismatch")
            out = {"access_token": "at", "token_type": "Bearer", "id_token": self.id_token(form["client_id"], code["nonce"])}
            if "offline_access" in code["scope"]:
                out["refresh_token"] = self.refresh
            return out
        raise AssertionError(f"unexpected url {url}")


@pytest.fixture
def cloud(monkeypatch):
    fake = FakeAccountServer()
    monkeypatch.setattr(cloud_auth, "_http", fake.http)
    monkeypatch.setenv("GAMMA_CLOUD_ISSUER", ISSUER)
    monkeypatch.delenv("GAMMA_CLOUD_CLIENT_ID", raising=False)
    monkeypatch.delenv("GAMMA_CLOUD_CLIENT_SECRET", raising=False)
    monkeypatch.setenv("GAMMA_CLOUD_POLICY", "refuse")
    monkeypatch.delenv("GAMMA_CLOUD_ADMIN_SUBJECT", raising=False)
    cloud_auth._discovery_cache.clear()
    cloud_auth._jwks_cache.clear()
    yield fake
    with connect_users_db() as conn:
        conn.execute("DELETE FROM identities")
        conn.commit()


def browser():
    from gamma.app import app
    return TestClient(app)


def start(c, **params):
    """GET /start; returns the authorize params the browser was sent with."""
    r = c.get("/api/auth/cloud/start", params=params, follow_redirects=False)
    assert r.status_code == 302, r.text
    url = urlsplit(r.headers["location"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == ISSUER + "/authorize"
    return {k: v[0] for k, v in parse_qs(url.query).items()}


def callback(c, auth, fake=None, **extra):
    """The account server sends the browser back: the "code" carries what the
    fake token endpoint needs to check PKCE."""
    code = base64.urlsafe_b64encode(json.dumps({"challenge": auth["code_challenge"], "nonce": auth.get("nonce", ""),
                                                "redirect_uri": auth["redirect_uri"], "scope": auth["scope"]}).encode()).decode().rstrip("=")
    return c.get("/api/auth/cloud/callback", params={"code": code, "state": auth["state"], **extra}, follow_redirects=False)


def error_of(r):
    assert r.status_code == 302
    return parse_qs(urlsplit(r.headers["location"]).query).get("cloud_error", [""])[0]


def test_server_config_and_start(cloud):
    c = browser()
    assert c.get("/api/server-config").json()["cloud"] == {"enabled": True, "issuer": ISSUER}
    auth = start(c, next="/?page=abc")
    assert auth["client_id"] == "gamma-desktop" and auth["code_challenge_method"] == "S256"
    assert auth["redirect_uri"] == "http://testserver/api/auth/cloud/callback"
    assert "offline_access" in auth["scope"] and len(auth["code_challenge"]) == 43


def test_refuse_policy(cloud):
    c = browser()
    r = callback(c, start(c))
    assert "not linked" in error_of(r)
    assert c.get("/api/session").json()["user"] is None


def test_provision_policy_creates_account(cloud, monkeypatch):
    monkeypatch.setenv("GAMMA_CLOUD_POLICY", "provision")
    c = browser()
    r = callback(c, start(c, next="/?page=abc"))
    assert r.status_code == 302 and r.headers["location"] == "/?page=abc"
    s = c.get("/api/session").json()
    assert s["user"] == "alice" and s["is_admin"] is False and s["default_workspace"]
    status = c.get("/api/auth/cloud/status").json()["identity"]
    assert status["handle"] == "alice" and status["plan"] == "free" and status["offline"] is True
    # only the cloud can sign this account in
    r = c.post("/api/login", json={"username": "alice", "password": ""})
    assert r.status_code == 401
    assert c.post("/api/auth/cloud/unlink").status_code == 400  # would lock it out
    # a second sign-in finds the identity, whatever the policy says
    monkeypatch.setenv("GAMMA_CLOUD_POLICY", "refuse")
    c2 = browser()
    assert callback(c2, start(c2)).headers["location"] == "/"
    assert c2.get("/api/session").json()["user"] == "alice"
    assert cloud_auth.refresh_token_of("alice") == "rt-1"


def test_claim_policy_links_existing_username(cloud, monkeypatch):
    make_user("bob", "pw-bob-123")
    cloud.person.update({"sub": "sub-bob", "handle": "bob", "email": "bob@example.org"})
    c = browser()
    assert "not linked" in error_of(callback(c, start(c)))
    monkeypatch.setenv("GAMMA_CLOUD_POLICY", "claim")
    r = callback(c, start(c))
    assert r.headers["location"] == "/"
    assert c.get("/api/session").json()["user"] == "bob"
    # bob has a password, so unlinking is allowed and signs the identity off
    assert c.post("/api/auth/cloud/unlink").json()["ok"] is True
    assert c.get("/api/auth/cloud/status").json()["identity"] is None
    # a different cloud account with the same handle cannot claim a linked or taken name
    r = callback(c, start(c))
    assert r.headers["location"] == "/"  # bob re-claims (unlinked, claim policy)
    cloud.person["sub"] = "sub-other-bob"
    assert "belongs to someone else" in error_of(callback(browser(), start(browser())))


def test_link_signed_in_account(cloud):
    make_user("carol", "pw-carol-123")
    c = login("carol", "pw-carol-123")
    cloud.person.update({"sub": "sub-carol", "handle": "carol-cloud", "email": "carol@example.org"})
    auth = start(c, link="1")
    r = callback(c, auth)
    assert r.headers["location"] == "/"
    status = c.get("/api/auth/cloud/status").json()["identity"]
    assert status["handle"] == "carol-cloud"
    # the same cloud account cannot be linked to a second local account
    make_user("dave", "pw-dave-123")
    d = login("dave", "pw-dave-123")
    assert "already linked" in error_of(callback(d, start(d, link="1")))
    # and carol cannot link a second cloud account
    cloud.person["sub"] = "sub-carol-2"
    assert "Unlink it first" in error_of(callback(c, start(c, link="1")))
    # linking needs a session
    assert browser().get("/api/auth/cloud/start", params={"link": "1"}, follow_redirects=False).status_code == 401


def test_admin_subject_provisions_admin(cloud, monkeypatch):
    monkeypatch.setenv("GAMMA_CLOUD_ADMIN_SUBJECT", "sub-owner")
    cloud.person.update({"sub": "sub-owner", "handle": "owner", "email": "owner@example.org"})
    c = browser()
    assert callback(c, start(c)).headers["location"] == "/"
    s = c.get("/api/session").json()
    assert s["user"] == "owner" and s["is_admin"] is True


def test_token_checks(cloud, monkeypatch):
    monkeypatch.setenv("GAMMA_CLOUD_POLICY", "provision")
    cloud.person.update({"sub": "sub-gwen", "handle": "gwen", "email": "gwen@example.org"})
    c = browser()
    cloud.person["email_verified"] = False
    assert "Confirm your e-mail" in error_of(callback(c, start(c)))
    cloud.person["email_verified"] = True
    cloud.aud = "someone-else"
    assert "not valid" in error_of(callback(c, start(c)))
    cloud.aud = None
    # a state is single use
    auth = start(c)
    assert callback(c, auth).headers["location"] == "/"
    assert "expired or was already used" in error_of(callback(browser(), auth))
    # the account server saying no
    r = c.get("/api/auth/cloud/callback", params={"error": "access_denied", "state": "x"}, follow_redirects=False)
    assert error_of(r) == "Sign-in cancelled."


def test_disabled_without_issuer(monkeypatch):
    monkeypatch.delenv("GAMMA_CLOUD_ISSUER", raising=False)
    c = browser()
    assert c.get("/api/server-config").json()["cloud"]["enabled"] is False
    assert c.get("/api/auth/cloud/start", follow_redirects=False).status_code == 503


def test_admin_settings_roundtrip(monkeypatch):
    monkeypatch.delenv("GAMMA_CLOUD_ISSUER", raising=False)
    make_user("root", "pw-root-123", is_admin=1)
    c = login("root", "pw-root-123")
    r = c.put("/api/admin/settings", json={"cloud_issuer": "https://account.example", "cloud_client_id": "gc_abc",
                                           "cloud_client_secret": "shh", "cloud_policy": "claim"})
    assert r.status_code == 200, r.text
    cfg = r.json()["cloud"]
    assert cfg == {"issuer": "https://account.example", "client_id": "gc_abc", "policy": "claim", "has_secret": True,
                   "enabled": True, "source": "saved"}
    assert cloud_auth.client_secret() == "shh"
    assert "shh" not in json.dumps(c.get("/api/admin/settings").json())
    assert c.put("/api/admin/settings", json={"cloud_policy": "anything"}).status_code == 400
    assert c.put("/api/admin/settings", json={"cloud_issuer": "http://not-https.example"}).status_code == 400
    r = c.put("/api/admin/settings", json={"cloud_issuer": "", "cloud_client_secret": ""})
    assert r.json()["cloud"]["enabled"] is False and r.json()["cloud"]["has_secret"] is False
    monkeypatch.setenv("GAMMA_CLOUD_ISSUER", ISSUER)
    assert c.get("/api/admin/settings").json()["cloud"]["source"] == "environment"
    assert c.put("/api/admin/settings", json={"cloud_policy": "claim"}).status_code == 400


def test_rename_and_delete_follow_identities(cloud, monkeypatch):
    monkeypatch.setenv("GAMMA_CLOUD_POLICY", "provision")
    cloud.person.update({"sub": "sub-erin", "handle": "erin", "email": "erin@example.org"})
    c = browser()
    callback(c, start(c))
    make_user("root", "pw-root-123", is_admin=1)
    admin = login("root", "pw-root-123")
    assert admin.post("/api/admin/users/erin/rename", json={"new_username": "erin2"}).status_code == 200
    assert cloud_auth.status_of("erin2")["handle"] == "erin"
    assert admin.delete("/api/admin/users/erin2").status_code == 200
    with connect_users_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM identities WHERE username = 'erin2'").fetchone()[0] == 0


def test_cli_link_and_unlink(cloud, capsys):
    import manage
    make_user("frank", "pw-frank-123")
    manage.link_identity("frank", "sub-frank", "frank", "frank@example.org")
    manage.list_identities()
    assert "frank" in capsys.readouterr().out
    assert cloud_auth.status_of("frank")["handle"] == "frank"
    manage.unlink_identity("frank")
    assert cloud_auth.status_of("frank") is None

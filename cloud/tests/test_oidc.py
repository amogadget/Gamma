import base64
import hashlib
import secrets
from contextlib import closing
from urllib.parse import parse_qs, urlsplit

import jwt
from conftest import register, verify

from gammacloud import config, db, oidc

CALLBACK = "http://127.0.0.1:9001/api/auth/cloud/callback"


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def authorize_params(challenge, client_id=None, redirect=CALLBACK, scope="openid email profile offline_access", **extra):
    return {"response_type": "code", "client_id": client_id or config.DESKTOP_CLIENT_ID, "redirect_uri": redirect,
            "scope": scope, "state": "st-1", "nonce": "n-1", "code_challenge": challenge,
            "code_challenge_method": "S256", **extra}


def request_id_from(html):
    """The pending request id the authorize page embeds."""
    marker = "request_id: \""
    i = html.index(marker) + len(marker)
    return html[i:html.index('"', i)]


def signed_in_code(client, challenge, **kw):
    """Authorize as the (verified) signed-in browser; returns the code."""
    r = client.get("/authorize", params=authorize_params(challenge, **kw))
    assert r.status_code == 200 and "Continue" in r.text
    rid = request_id_from(r.text)
    r = client.post("/authorize/continue", json={"request_id": rid})
    assert r.status_code == 200, r.text
    redirect = r.json()["redirect"]
    assert redirect.startswith(CALLBACK + "?")
    q = parse_qs(urlsplit(redirect).query)
    assert q["state"] == ["st-1"]
    return q["code"][0]


def decode(token, client_id=None):
    with closing(db.connect()) as conn:
        jwks = jwt.PyJWKSet.from_dict(oidc.jwks(conn))
    header = jwt.get_unverified_header(token)
    key = next(k for k in jwks.keys if k.key_id == header["kid"])
    return jwt.decode(token, key.key, algorithms=["EdDSA"], audience=client_id or config.DESKTOP_CLIENT_ID,
                      issuer="http://testserver")


def test_discovery_and_jwks(client):
    d = client.get("/.well-known/openid-configuration").json()
    assert d["issuer"] == "http://testserver" and d["token_endpoint"] == "http://testserver/token"
    assert d["code_challenge_methods_supported"] == ["S256"]
    keys = client.get("/jwks").json()["keys"]
    assert len(keys) == 1 and keys[0]["kty"] == "OKP" and keys[0]["crv"] == "Ed25519"


def test_full_desktop_flow(client):
    register(client)
    verify(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    r = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                    "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier})
    assert r.status_code == 200, r.text
    tokens = r.json()
    assert tokens["token_type"] == "Bearer" and "refresh_token" in tokens
    claims = decode(tokens["id_token"])
    assert claims["handle"] == "alice" and claims["email"] == "alice@example.org" and claims["email_verified"] is True
    assert claims["plan"] == "free" and claims["nonce"] == "n-1" and claims["name"] == "alice"
    # userinfo and /api/me with the access token
    headers = {"Authorization": "Bearer " + tokens["access_token"]}
    assert client.get("/userinfo", headers=headers).json()["sub"] == claims["sub"]
    me = client.get("/api/me", headers=headers).json()
    assert me["account"]["handle"] == "alice" and me["auth"] == "token" and "devices" not in me
    # the grant shows as a device in the portal
    devices = client.get("/api/devices").json()["devices"]
    assert len(devices) == 1 and devices[0]["kind"] == "desktop"
    # a code is single use, and the replay revokes the grant
    r = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                    "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier})
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant"
    r = client.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                                    "client_id": config.DESKTOP_CLIENT_ID})
    assert r.status_code == 400
    assert client.get("/api/me", headers=headers).status_code == 401


def test_refresh_rotates(client):
    register(client)
    verify(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    tokens = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                         "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier}).json()
    r = client.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                                    "client_id": config.DESKTOP_CLIENT_ID})
    assert r.status_code == 200, r.text
    fresh = r.json()
    assert fresh["refresh_token"] != tokens["refresh_token"] and "id_token" in fresh
    assert decode(fresh["id_token"])["handle"] == "alice"
    # the old refresh token and the old access token are dead
    r = client.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                                    "client_id": config.DESKTOP_CLIENT_ID})
    assert r.status_code == 400
    assert client.get("/userinfo", headers={"Authorization": "Bearer " + tokens["access_token"]}).status_code == 401
    assert client.get("/userinfo", headers={"Authorization": "Bearer " + fresh["access_token"]}).status_code == 200
    # revoking from the portal kills it
    grant = client.get("/api/devices").json()["devices"][0]["id"]
    client.post(f"/api/devices/{grant}/revoke", json={})
    r = client.post("/token", data={"grant_type": "refresh_token", "refresh_token": fresh["refresh_token"],
                                    "client_id": config.DESKTOP_CLIENT_ID})
    assert r.status_code == 400


def test_pkce_and_redirect_checks(client):
    register(client)
    verify(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    other, _ = pkce()
    r = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                    "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": other})
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant"
    # bad redirect URIs are shown, never followed
    for uri in ("http://evil.example/api/auth/cloud/callback", "http://127.0.0.1:9001/other", "https://127.0.0.1/api/auth/cloud/callback"):
        r = client.get("/authorize", params=authorize_params(challenge, redirect=uri))
        assert r.status_code == 400, uri
    # a missing challenge redirects back with an error
    params = authorize_params(challenge)
    del params["code_challenge"]
    r = client.get("/authorize", params=params, follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlsplit(r.headers["location"]).query)
    assert q["error"] == ["invalid_request"] and q["state"] == ["st-1"]


def test_unverified_account_is_refused(client):
    register(client)
    _, challenge = pkce()
    r = client.get("/authorize", params=authorize_params(challenge))
    assert r.status_code == 200 and "Confirm your e-mail first" in r.text
    # signing in on the authorize page with an unverified account also stops there
    client.post("/api/logout")
    r = client.get("/authorize", params=authorize_params(challenge))
    rid = request_id_from(r.text)
    r = client.post("/authorize/login", json={"request_id": rid, "login": "alice", "password": "correct horse battery"})
    assert r.status_code == 200 and r.json().get("verify_needed") is True
    r = client.post("/authorize/continue", json={"request_id": rid})
    assert r.status_code == 403


def test_login_on_authorize_page(client):
    register(client)
    verify(client)
    client.post("/api/logout")
    verifier, challenge = pkce()
    r = client.get("/authorize", params=authorize_params(challenge))
    assert "Sign in to Gamma desktop app" in r.text
    rid = request_id_from(r.text)
    r = client.post("/authorize/login", json={"request_id": rid, "login": "alice", "password": "wrong"})
    assert r.status_code == 401
    r = client.post("/authorize/login", json={"request_id": rid, "login": "alice", "password": "correct horse battery"})
    assert r.status_code == 200
    code = parse_qs(urlsplit(r.json()["redirect"]).query)["code"][0]
    r = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                    "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier})
    assert r.status_code == 200
    # the request is gone once used
    assert client.post("/authorize/continue", json={"request_id": rid}).status_code == 400
    # and the portal is signed in now
    assert client.get("/api/me").status_code == 200


def test_cancel(client):
    register(client)
    verify(client)
    _, challenge = pkce()
    r = client.get("/authorize", params=authorize_params(challenge))
    rid = request_id_from(r.text)
    r = client.post("/authorize/cancel", json={"request_id": rid})
    q = parse_qs(urlsplit(r.json()["redirect"]).query)
    assert q["error"] == ["access_denied"] and q["state"] == ["st-1"]


def test_confidential_client(client):
    register(client)
    verify(client)
    with closing(db.connect()) as conn:
        client_id, secret = oidc.create_client(conn, name="Alice's server", kind="container",
                                               redirect_uris=["https://alice.gammapdf.com/api/auth/cloud/callback"])
        conn.commit()
    verifier, challenge = pkce()
    # offline_access is refused for a container
    r = client.get("/authorize", params=authorize_params(challenge, client_id=client_id,
                                                        redirect="https://alice.gammapdf.com/api/auth/cloud/callback"),
                   follow_redirects=False)
    assert r.status_code == 302 and "invalid_scope" in r.headers["location"]
    r = client.get("/authorize", params=authorize_params(challenge, client_id=client_id, scope="openid email",
                                                        redirect="https://alice.gammapdf.com/api/auth/cloud/callback"))
    assert "Sign in to Alice&#x27;s server" in r.text
    rid = request_id_from(r.text)
    redirect = client.post("/authorize/continue", json={"request_id": rid}).json()["redirect"]
    code = parse_qs(urlsplit(redirect).query)["code"][0]
    form = {"grant_type": "authorization_code", "code": code, "code_verifier": verifier,
            "redirect_uri": "https://alice.gammapdf.com/api/auth/cloud/callback"}
    r = client.post("/token", data={**form, "client_id": client_id})
    assert r.status_code == 401 and r.json()["error"] == "invalid_client"
    basic = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    r = client.post("/token", data=form, headers={"Authorization": "Basic " + basic})
    assert r.status_code == 200, r.text
    tokens = r.json()
    assert "refresh_token" not in tokens
    claims = decode(tokens["id_token"], client_id)
    assert claims["aud"] == client_id and claims["email"] == "alice@example.org" and "name" not in claims
    # revoke the access token
    r = client.post("/revoke", data={"token": tokens["access_token"], "client_id": client_id, "client_secret": secret})
    assert r.status_code == 200
    assert client.get("/userinfo", headers={"Authorization": "Bearer " + tokens["access_token"]}).status_code == 401


def test_key_rotation_keeps_old_tokens_valid(client):
    register(client)
    verify(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    tokens = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                         "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier}).json()
    with closing(db.connect()) as conn:
        oidc.rotate_key(conn)
        conn.commit()
    assert len(client.get("/jwks").json()["keys"]) == 2
    assert decode(tokens["id_token"])["handle"] == "alice"
    fresh = client.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                                        "client_id": config.DESKTOP_CLIENT_ID}).json()
    assert jwt.get_unverified_header(fresh["id_token"])["kid"] != jwt.get_unverified_header(tokens["id_token"])["kid"]


def test_password_change_revokes_grants(client):
    register(client)
    verify(client)
    verifier, challenge = pkce()
    code = signed_in_code(client, challenge)
    tokens = client.post("/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                                         "client_id": config.DESKTOP_CLIENT_ID, "code_verifier": verifier}).json()
    client.post("/api/me/password", json={"current": "correct horse battery", "new": "another password"})
    r = client.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                                    "client_id": config.DESKTOP_CLIENT_ID})
    assert r.status_code == 400

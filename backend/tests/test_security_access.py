"""Regression tests for the access-control and SSRF hardening.

These lock in three fixes:
  1. The old ?user= query param no longer grants unauthenticated read/write of
     another account — a share link must carry its scoped token instead.
  2. The PDF proxy / resolver refuse file:// and internal/loopback/metadata
     hosts (SSRF), via gamma.net_guard.
  3. Usernames and doc ids are validated before they become filesystem paths.
"""

import pytest

from gamma.net_guard import BlockedUrlError, validate_public_url
from conftest import login, make_user, make_page


@pytest.fixture(scope="module")
def alice():
    make_user("alice_sec", "alicepw12345")
    return login("alice_sec", "alicepw12345")


# --- 1. ?user= is no longer an auth bypass ---------------------------------

def test_user_param_does_not_grant_reads(client, alice):
    """An unauthenticated client naming the owner with ?user= is refused."""
    page = make_page(alice, "Alice secret", properties={"doc_id": "secdoc_a"})
    from fastapi.testclient import TestClient
    from gamma.app import app
    anon = TestClient(app)  # no cookies

    assert anon.get("/api/blocks/root/children", params={"user": "alice_sec"}).status_code == 401
    assert anon.get(f"/api/blocks/{page['id']}/subtree", params={"user": "alice_sec"}).status_code == 401
    assert anon.get("/api/blocks/by-doc/secdoc_a", params={"user": "alice_sec"}).status_code == 401
    assert anon.get(f"/api/pages/{page['id']}/export", params={"user": "alice_sec"}).status_code == 401


def test_user_param_does_not_grant_writes(client, alice):
    from fastapi.testclient import TestClient
    from gamma.app import app
    anon = TestClient(app)
    r = anon.post("/api/blocks/by-doc/injected_doc", params={"user": "alice_sec"},
                  json={"default_title": "HACK"})
    assert r.status_code == 401


# --- share token is scoped to its one document ------------------------------

def test_share_token_reads_only_its_document(client, alice):
    from fastapi.testclient import TestClient
    from gamma.app import app

    shared = make_page(alice, "Shared paper", properties={"doc_id": "shared_doc"})
    other = make_page(alice, "Other private", properties={"doc_id": "other_doc"})
    token = alice.post("/api/share/shared_doc").json()["token"]

    anon = TestClient(app)
    # the shared document is reachable
    assert anon.get("/api/blocks/by-doc/shared_doc", params={"share": token}).status_code == 200
    assert anon.get(f"/api/blocks/{shared['id']}/subtree", params={"share": token}).status_code == 200
    # everything else is not
    assert anon.get("/api/blocks/by-doc/other_doc", params={"share": token}).status_code == 403
    assert anon.get(f"/api/blocks/{other['id']}/subtree", params={"share": token}).status_code == 403
    assert anon.get("/api/blocks/root/children", params={"share": token}).status_code == 403
    assert anon.get(f"/api/blocks/{shared['id']}/backlinks", params={"share": token}).status_code == 403


# --- 2. SSRF guard ----------------------------------------------------------

@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "file:///C:/Windows/win.ini",
    "http://127.0.0.1/x",
    "http://localhost/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
    "ftp://example.com/x",
    "gopher://example.com/x",
])
def test_net_guard_blocks_dangerous_urls(url):
    with pytest.raises(BlockedUrlError):
        validate_public_url(url)


def test_proxy_refuses_file_scheme(guest):
    r = guest.get("/api/pdf", params={"source_url": "file:///C:/Windows/win.ini"})
    assert r.status_code == 400
    assert "scheme" in r.json()["detail"]


def test_proxy_refuses_loopback(guest):
    r = guest.get("/api/pdf", params={"source_url": "http://127.0.0.1:9/x"})
    assert r.status_code == 400
    assert "internal address" in r.json()["detail"]


# --- 3. identifier validation ----------------------------------------------

def test_doc_id_path_traversal_rejected(alice):
    page = make_page(alice, "traversal",
                     properties={"doc_id": "../../guest/uploads/deadbeef"})
    r = alice.get(f"/api/pages/{page['id']}/export-pdf")
    assert r.status_code == 400
    assert "invalid document id" in r.json()["detail"]


def test_safe_username_rejects_traversal():
    from gamma.db import safe_username
    for bad in ("..", ".", "a/b", "a\\b", "", "x" * 65):
        with pytest.raises(ValueError):
            safe_username(bad)
    assert safe_username("guest") == "guest"
    assert safe_username("a.b-c_d") == "a.b-c_d"


def test_safe_doc_id_rejects_traversal():
    from gamma.db import safe_doc_id
    for bad in ("..", ".", "a/b", "a\\b", ""):
        with pytest.raises(ValueError):
            safe_doc_id(bad)
    assert safe_doc_id("e2e4c5cdf215c8ab6bb6c249") == "e2e4c5cdf215c8ab6bb6c249"

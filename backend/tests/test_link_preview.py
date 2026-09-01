"""GET /api/link-preview: title extraction, auth, SSRF containment, caching.

The endpoint fetches a user-supplied URL server-side, so it is the same class of
surface as /api/resolve-pdf and must stay behind the net guard. Upstream shipped
it without tests; these pin the parts that would be dangerous or annoying to get
wrong.
"""

import pytest
from fastapi.testclient import TestClient


class _Resp:
    """Minimal urlopen stand-in: headers + a capped read()."""

    def __init__(self, body: bytes, ctype: str = "text/html; charset=utf-8"):
        self._body = body
        self.headers = {"Content-Type": ctype}

    def read(self, n=None):
        return self._body[:n] if n else self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture(autouse=True)
def _clear_cache():
    from gamma.routers import links

    links._cache.clear()
    yield
    links._cache.clear()


def test_link_preview_requires_auth():
    from gamma.app import app

    c = TestClient(app)
    r = c.get("/api/link-preview", params={"url": "https://example.com/"})
    assert r.status_code == 401


def test_rejects_non_http_schemes(guest):
    for url in ("file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "data:text/html,x"):
        r = guest.get("/api/link-preview", params={"url": url})
        assert r.status_code == 400, url


def test_rejects_url_without_host(guest):
    assert guest.get("/api/link-preview", params={"url": "http:///nohost"}).status_code == 400


def test_extracts_og_title_first(guest, monkeypatch):
    from gamma.routers import links

    body = (b'<html><head><meta property="og:title" content="The OG Title">'
            b"<title>Fallback Title</title></head></html>")
    monkeypatch.setattr(links, "guarded_urlopen", lambda req, timeout=0: _Resp(body))
    r = guest.get("/api/link-preview", params={"url": "https://example.com/a"})
    assert r.status_code == 200
    assert r.json() == {"url": "https://example.com/a", "host": "example.com", "title": "The OG Title"}


def test_falls_back_to_title_tag_and_collapses_whitespace(guest, monkeypatch):
    from gamma.routers import links

    monkeypatch.setattr(links, "guarded_urlopen",
                        lambda req, timeout=0: _Resp(b"<title>  A   spaced\n title </title>"))
    r = guest.get("/api/link-preview", params={"url": "https://example.com/b"})
    assert r.json()["title"] == "A spaced title"


def test_unescapes_entities(guest, monkeypatch):
    from gamma.routers import links

    monkeypatch.setattr(links, "guarded_urlopen",
                        lambda req, timeout=0: _Resp(b"<title>Caf&eacute; &amp; Bar</title>"))
    assert guest.get("/api/link-preview", params={"url": "https://example.com/c"}).json()["title"] \
        == "Café & Bar"


def test_github_boilerplate_is_trimmed(guest, monkeypatch):
    from gamma.routers import links

    monkeypatch.setattr(links, "guarded_urlopen",
                        lambda req, timeout=0: _Resp(b"<title>GitHub - owner/repo: a description</title>"))
    r = guest.get("/api/link-preview", params={"url": "https://github.com/owner/repo"})
    assert r.json()["title"] == "owner/repo: a description"

    links._cache.clear()
    monkeypatch.setattr(links, "guarded_urlopen",
                        lambda req, timeout=0: _Resp(b"<title>Fix it \xc2\xb7 Issue #1 \xc2\xb7 owner/repo \xc2\xb7 GitHub</title>"))
    r = guest.get("/api/link-preview", params={"url": "https://github.com/owner/repo/issues/1"})
    assert r.json()["title"] == "Fix it · Issue #1 · owner/repo"


def test_non_html_content_type_yields_no_title(guest, monkeypatch):
    from gamma.routers import links

    monkeypatch.setattr(links, "guarded_urlopen",
                        lambda req, timeout=0: _Resp(b"%PDF-1.4 ...", ctype="application/pdf"))
    r = guest.get("/api/link-preview", params={"url": "https://example.com/paper.pdf"})
    assert r.status_code == 200
    assert r.json()["title"] is None
    assert r.json()["host"] == "example.com"


def test_blocked_url_degrades_to_host_only(guest, monkeypatch):
    """An SSRF-guard rejection must not 500 — the chip still shows the host."""
    from gamma.net_guard import BlockedUrlError
    from gamma.routers import links

    def blocked(req, timeout=0):
        raise BlockedUrlError("blocked: private address")

    monkeypatch.setattr(links, "guarded_urlopen", blocked)
    r = guest.get("/api/link-preview", params={"url": "http://169.254.169.254/latest/meta-data/"})
    assert r.status_code == 200
    assert r.json() == {"url": "http://169.254.169.254/latest/meta-data/",
                        "host": "169.254.169.254", "title": None}


def test_network_error_degrades_too(guest, monkeypatch):
    from gamma.routers import links

    def boom(req, timeout=0):
        raise OSError("connection refused")

    monkeypatch.setattr(links, "guarded_urlopen", boom)
    r = guest.get("/api/link-preview", params={"url": "https://unreachable.example/"})
    assert r.status_code == 200 and r.json()["title"] is None


def test_fetch_goes_through_the_ssrf_guard(guest, monkeypatch):
    """Regression guard: the module must not reach for a bare urlopen."""
    import inspect

    from gamma.routers import links

    src = inspect.getsource(links)
    assert "guarded_urlopen" in src
    # no unguarded call: every urlopen reference is the guarded one
    assert "urllib.request.urlopen" not in src


def test_result_is_cached_so_a_second_render_costs_nothing(guest, monkeypatch):
    from gamma.routers import links

    calls = {"n": 0}

    def once(req, timeout=0):
        calls["n"] += 1
        return _Resp(b"<title>Cached Page</title>")

    monkeypatch.setattr(links, "guarded_urlopen", once)
    url = "https://example.com/cached"
    a = guest.get("/api/link-preview", params={"url": url}).json()
    b = guest.get("/api/link-preview", params={"url": url}).json()
    assert a == b == {"url": url, "host": "example.com", "title": "Cached Page"}
    assert calls["n"] == 1


def test_cache_is_bounded(guest, monkeypatch):
    from gamma.routers import links

    monkeypatch.setattr(links, "guarded_urlopen", lambda req, timeout=0: _Resp(b"<title>x</title>"))
    monkeypatch.setattr(links, "_CACHE_MAX", 5)
    for i in range(12):
        guest.get("/api/link-preview", params={"url": f"https://example.com/{i}"})
    assert len(links._cache) <= 5


def test_only_the_first_chunk_is_read(guest, monkeypatch):
    """A hostile page must not stream unbounded bytes into memory."""
    from gamma.routers import links

    seen = {}

    class Big(_Resp):
        def read(self, n=None):
            seen["n"] = n
            return b"<title>Big</title>" + b"x" * 10_000_000

    monkeypatch.setattr(links, "guarded_urlopen", lambda req, timeout=0: Big(b""))
    r = guest.get("/api/link-preview", params={"url": "https://example.com/big"})
    assert r.status_code == 200
    assert seen["n"] == links._MAX_READ


def test_title_length_is_capped(guest, monkeypatch):
    from gamma.routers import links

    monkeypatch.setattr(links, "guarded_urlopen",
                        lambda req, timeout=0: _Resp(b"<title>" + b"T" * 900 + b"</title>"))
    assert len(guest.get("/api/link-preview", params={"url": "https://example.com/long"}).json()["title"]) == 300

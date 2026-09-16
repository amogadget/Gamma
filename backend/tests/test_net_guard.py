"""Exercise real urllib cookie/redirect handling with a fake HTTPS transport."""

import io
import socket
from email.message import Message
from urllib.request import HTTPSHandler, ProxyHandler, build_opener
from urllib.response import addinfourl

import pytest

from gamma import net_guard


@pytest.fixture
def transport(monkeypatch):
    routes = {}
    seen = []

    class FakeHTTPS(HTTPSHandler):
        def https_open(self, req):
            seen.append((req.full_url, req.get_header("Cookie")))
            status, headers, body = routes[req.full_url]
            message = Message()
            for key, value in headers.items():
                message[key] = value
            response = addinfourl(io.BytesIO(body), message, req.full_url, status)
            response.msg = "Found" if status == 302 else "OK"
            return response

    monkeypatch.setattr(net_guard, "build_opener", lambda *handlers: build_opener(
        ProxyHandler({}), *handlers, FakeHTTPS()))
    # Fake public DNS only; private redirect targets must still be refused.
    monkeypatch.setattr(net_guard.socket, "getaddrinfo", lambda host, port, **kw: [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
         ("127.0.0.1" if host == "127.0.0.1" else "8.8.8.8", port))])
    return routes, seen


def test_publisher_cookie_survives_redirect_but_not_next_fetch(transport):
    routes, seen = transport
    start = "https://publisher.example/paper.pdf"
    target = "https://publisher.example/authenticated.pdf"
    routes[start] = (302, {
        "Location": target, "Set-Cookie": "access=institution; Path=/; Secure",
    }, b"")
    routes[target] = (200, {"Content-Type": "application/pdf"}, b"%PDF-1.4")

    with net_guard.guarded_urlopen(start) as response:
        assert response.read() == b"%PDF-1.4"
    assert seen == [(start, None), (target, "access=institution")]

    # A separate request (possibly another user) must start without cookies.
    with net_guard.guarded_urlopen(target) as response:
        response.read()
    assert seen[-1] == (target, None)


def test_publisher_cookie_is_not_forwarded_to_unrelated_host(transport):
    routes, seen = transport
    start = "https://publisher.example/paper.pdf"
    target = "https://other.example/paper.pdf"
    routes[start] = (302, {
        "Location": target, "Set-Cookie": "access=institution; Path=/; Secure",
    }, b"")
    routes[target] = (200, {}, b"%PDF-1.4")
    with net_guard.guarded_urlopen(start) as response:
        response.read()
    assert seen == [(start, None), (target, None)]


@pytest.mark.parametrize("target", ["https://127.0.0.1/secret", "file:///secret"])
def test_cookie_redirect_still_validates_destination(transport, target):
    routes, seen = transport
    start = "https://publisher.example/paper.pdf"
    routes[start] = (302, {
        "Location": target, "Set-Cookie": "access=institution; Path=/; Secure",
    }, b"")
    # urllib rejects non-HTTP redirects before our handler; the guard rejects
    # private HTTP(S) targets. Both must fail before another transport call.
    from urllib.error import URLError
    with pytest.raises(URLError):
        net_guard.guarded_urlopen(start)
    assert seen == [(start, None)]

"""Outbound-fetch safety: block SSRF to internal/loopback/metadata hosts and
non-HTTP schemes.

Every server-side fetch of a user-supplied URL (the PDF proxy, PDF resolution,
the AI PDF re-download) must go through :func:`guarded_urlopen` so an attacker
can't turn the server into a request forwarder for ``file://`` reads,
``http://127.0.0.1`` / ``169.254.169.254`` probes, or reaching private-network
services the box can see but the internet can't.

Note on DNS rebinding: we resolve the host and reject internal addresses before
connecting, and we re-validate on every redirect, but a hostname that resolves
public here and private at connect time is a residual risk. Pair this with an
egress firewall for defense in depth.
"""

import ipaddress
import socket
import urllib.parse
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, build_opener

_ALLOWED_SCHEMES = ("http", "https")


class BlockedUrlError(URLError):
    """Raised when a URL is refused by the SSRF guard (subclass of URLError so
    existing ``except URLError`` handlers surface it as a clean 400)."""

    def __init__(self, reason: str):
        super().__init__(reason)


def _ip_is_blocked(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local      # 169.254/16 — cloud metadata lives here
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        or (addr.version == 6 and addr.ipv4_mapped is not None and _ip_is_blocked(str(addr.ipv4_mapped)))
    )


def validate_public_url(url: str) -> str:
    """Return the URL unchanged if it is an http(s) URL whose host resolves only
    to public addresses; otherwise raise BlockedUrlError."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        raise BlockedUrlError(f"blocked URL scheme: {parsed.scheme or '(none)'}")
    host = parsed.hostname
    if not host:
        raise BlockedUrlError("URL has no host")
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise BlockedUrlError(f"cannot resolve host: {host}")
    if not infos:
        raise BlockedUrlError(f"cannot resolve host: {host}")
    for info in infos:
        ip = info[4][0]
        try:
            if _ip_is_blocked(ip):
                raise BlockedUrlError(f"blocked internal address for {host}: {ip}")
        except ValueError:
            raise BlockedUrlError(f"unparseable address for {host}: {ip}")
    return url


class _GuardedRedirectHandler(HTTPRedirectHandler):
    """Re-validate every redirect target so a public URL can't 302 to an
    internal one."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = build_opener(_GuardedRedirectHandler)


def guarded_urlopen(req, timeout=30):
    """Drop-in for urllib.request.urlopen that validates the URL (and every
    redirect) against the SSRF guard first. ``req`` may be a str or a Request."""
    url = req.full_url if hasattr(req, "full_url") else req
    validate_public_url(url)
    return _opener.open(req, timeout=timeout)

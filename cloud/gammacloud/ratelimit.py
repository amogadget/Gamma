"""A tiny in-process rate limiter for the abuse-prone endpoints (register,
login, reset, token). Fixed-window counters in a dict — resets on restart.
The first line of defence is Cloudflare's rate rules in front of the
server; this one stops trivial guessing from a single host."""

import time
from collections import defaultdict

from fastapi import HTTPException, Request

_buckets: dict[str, list] = defaultdict(lambda: [0.0, 0])


def client_ip(request: Request) -> str:
    """Cloudflare's ``CF-Connecting-IP`` (Cloudflare sets it and replaces any
    a client sends), else the connection's peer. ``X-Forwarded-For`` is never
    read here: its first hop is whatever the client wrote, and behind Caddy
    it is only Cloudflare's own address. The origin must be reachable
    through Cloudflare alone for the header to be trusted
    (cloud/deploy/README.md)."""
    return request.headers.get("cf-connecting-ip", "").strip() or (request.client.host if request.client else "?")


def ip_of(request: Request | None) -> str:
    """The client address as stored on a session or grant row."""
    return client_ip(request)[:64] if request is not None else ""


def agent_of(request: Request | None) -> str:
    return request.headers.get("user-agent", "")[:200] if request is not None else ""


_MAX_KEYS = 50000


def check(key: str, max_hits: int, window_seconds: int) -> None:
    now = time.monotonic()
    if len(_buckets) > _MAX_KEYS:
        # Keys are per IP and per e-mail, so a scan can grow the dict: drop
        # every window that is over (an hour is the longest one used).
        for k in [k for k, b in _buckets.items() if now - b[0] >= 3600]:
            del _buckets[k]
    bucket = _buckets[key]
    if now - bucket[0] >= window_seconds:
        bucket[0], bucket[1] = now, 0
    bucket[1] += 1
    if bucket[1] > max_hits:
        retry = max(1, int(window_seconds - (now - bucket[0])))
        raise HTTPException(status_code=429, detail="Too many attempts. Wait a bit and try again.",
                            headers={"Retry-After": str(retry)})


def reset(key: str) -> None:
    _buckets.pop(key, None)


def clear() -> None:
    """Tests."""
    _buckets.clear()

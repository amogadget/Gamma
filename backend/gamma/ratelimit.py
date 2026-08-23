"""A tiny in-process rate limiter for abuse-prone unauthenticated endpoints
(login, guest login). Fixed-window counters in a dict — no external store,
resets on restart, GIL-safe for the read-modify-write we do here.

Not a substitute for an edge/WAF rate limit on a large public deployment, but it
stops trivial online password guessing and guest-session floods from a single
host.
"""

import time
from collections import defaultdict

from fastapi import HTTPException, Request

# key -> (window_start_monotonic, count)
_buckets: dict[str, list] = defaultdict(lambda: [0.0, 0])


def client_ip(request: Request) -> str:
    """Best-effort client address. Trusts the first X-Forwarded-For hop when
    present (set it only from a proxy you control), else the socket peer."""
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


def check(key: str, max_hits: int, window_seconds: int) -> None:
    """Count one hit for `key`; raise 429 once it exceeds `max_hits` within the
    current window. Windows are fixed and start on the first hit."""
    now = time.monotonic()
    bucket = _buckets[key]
    if now - bucket[0] >= window_seconds:
        bucket[0], bucket[1] = now, 0
    bucket[1] += 1
    if bucket[1] > max_hits:
        retry = max(1, int(window_seconds - (now - bucket[0])))
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Wait a bit and try again.",
            headers={"Retry-After": str(retry)},
        )


def reset(key: str) -> None:
    """Clear a key's counter — call on a successful login so a legitimate user
    who mistyped a few times isn't locked out by their own success."""
    _buckets.pop(key, None)

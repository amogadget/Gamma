"""In-memory server log behind Settings → Diagnostics → "Server log".

Everything the backend logs through the shared `log` logger (plus uvicorn's
error/traceback logger) is scrubbed for secret-shaped substrings and kept in a
bounded ring buffer; admins read it via GET /api/admin/logs. Console output is
unchanged — the buffer is a debugging window, not an audit trail, and holds
nothing across restarts.

Scrubbing happens at insert time so a secret never sits in the buffer or
crosses the wire. The one deliberate exception lives in seed.py: the one-time
seeded admin password is a raw print() and must never be routed through here.
"""

import logging
import re
import sys
import threading
import time
from collections import deque

log = logging.getLogger("gamma")

_MAX_ENTRIES = 2000
_buf = deque(maxlen=_MAX_ENTRIES)
_lock = threading.Lock()
_seq = 0

_SCRUB_RULES = (
    # Bearer/sk- first: the key=value rule below would otherwise consume the
    # word "Bearer" in "Authorization: Bearer <token>" and leave the token.
    (re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/-]{8,}={0,2}"), "Bearer ***"),
    # OpenAI/Anthropic-style keys (sk-, sk-proj-, sk-ant-…)
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"), "sk-***"),
    # key=value / key: value shapes (query strings, exception messages that
    # echo request bodies or headers)
    (re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)[^\s&'\"]+"),
     r"\1\2***"),
    # Long urlsafe-base64 runs: session/share tokens are token_urlsafe(32) →
    # 43 chars. The 40+ threshold spares block ids and sha256[:24] upload
    # names, which are worth keeping readable in a debugging log.
    (re.compile(r"\b[A-Za-z0-9_-]{40,}\b"), "***"),
)


def scrub(text: str) -> str:
    for pattern, repl in _SCRUB_RULES:
        text = pattern.sub(repl, text)
    return text


class _BufferHandler(logging.Handler):
    def emit(self, record):
        try:
            msg = scrub(self.format(record))
        except Exception:
            return
        global _seq
        with _lock:
            _seq += 1
            _buf.append({"seq": _seq, "t": time.time(), "level": record.levelname, "msg": msg})


def tail(after: int = 0) -> list:
    """Entries with seq > after, oldest first (the poll cursor for the UI)."""
    with _lock:
        return [e for e in _buf if e["seq"] > after]


def setup_logging():
    """Wire the gamma logger to the console (same look as the old print()s)
    and the ring buffer, and capture uvicorn's error/traceback lines too.
    Idempotent: uvicorn --reload re-imports the app module.

    uvicorn.access is deliberately NOT captured — its lines include full query
    strings (?share=… tokens); the middleware's [http] line covers requests
    with path-only URLs.
    """
    if any(isinstance(h, _BufferHandler) for h in log.handlers):
        return
    buffer_handler = _BufferHandler()
    buffer_handler.setFormatter(logging.Formatter("%(message)s"))  # + traceback when exc_info is set
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(logging.Formatter("%(message)s"))
    log.setLevel(logging.INFO)
    log.propagate = False
    log.addHandler(console)
    log.addHandler(buffer_handler)
    uvicorn_error = logging.getLogger("uvicorn.error")  # keeps its own console handlers
    if not any(isinstance(h, _BufferHandler) for h in uvicorn_error.handlers):
        uvicorn_error.addHandler(buffer_handler)

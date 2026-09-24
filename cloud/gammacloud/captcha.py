"""Cloudflare Turnstile on register and reset. Off (always passes) until
``GAMMA_CLOUD_TURNSTILE_SECRET`` is set, so a local run and the tests need
no widget."""

import json
import urllib.parse
import urllib.request

from . import config
from .log import log

VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def verify(token: str | None, ip: str) -> bool:
    if not config.TURNSTILE_SECRET:
        return True
    if not token:
        return False
    data = urllib.parse.urlencode({"secret": config.TURNSTILE_SECRET, "response": token, "remoteip": ip}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(VERIFY_URL, data=data), timeout=10) as resp:
            return bool(json.load(resp).get("success"))
    except (OSError, ValueError) as e:
        log.warning("turnstile verify failed: %s", e)
        return False

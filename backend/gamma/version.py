"""Which build this server is, and whether a newer release exists.

The build is stamped through the environment: ``GAMMA_VERSION`` (the release
version, set by the Docker build from the release tag and by the desktop shell
from its own package version) and ``GAMMA_COMMIT`` (the git sha the Docker
image was built from). A checkout run by hand has neither and reports itself
as a development build.

The latest release comes from the GitHub Releases API (the desktop workflow
publishes ``v<version>`` and dispatches the matching Docker tag — see
docs/dev/github_actions.md), fetched on demand by the admin dashboard through
the SSRF guard and cached in memory. A Docker container cannot update itself:
the dashboard only says that a newer image exists and how to pull it.
"""

import json
import os
import platform
import re
import sys
import threading
import time
from datetime import datetime, timezone
from urllib.request import Request

from . import db
from .logbuf import counts as log_counts
from .net_guard import guarded_urlopen

VERSION = os.environ.get("GAMMA_VERSION", "").strip().lstrip("v")
UPDATE_CHECK = os.environ.get("GAMMA_UPDATE_CHECK", "").strip().lower() not in ("0", "off", "false", "no")
COMMIT = os.environ.get("GAMMA_COMMIT", "").strip()[:12]
STARTED_AT = datetime.now(timezone.utc)

REPO = "tim4431/Gamma"
RELEASES_API = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{REPO}/releases/latest"
IMAGE = "ghcr.io/tim4431/gamma"

_CACHE_OK_SECONDS = 6 * 3600
_CACHE_FAIL_SECONDS = 10 * 60
_cache = {"at": 0.0, "ttl": 0.0, "release": None, "error": ""}
_lock = threading.Lock()


def label() -> str:
    """One line for the startup log and the dashboard tile."""
    if VERSION:
        return f"v{VERSION}" + (f" ({COMMIT})" if COMMIT else "")
    return "development build" + (f" ({COMMIT})" if COMMIT else "")


def parse_version(text) -> tuple | None:
    """``v1.2.3`` / ``1.2.3`` → ``(1, 2, 3)``; None for anything else."""
    m = re.fullmatch(r"v?(\d+)\.(\d+)(?:\.(\d+))?", str(text or "").strip())
    return (int(m[1]), int(m[2]), int(m[3] or 0)) if m else None


def _fetch_latest() -> dict:
    """The newest release: ``{version, url, published_at}``. Raises on any
    trouble (network, a tag that is not a version)."""
    req = Request(RELEASES_API, headers={"Accept": "application/vnd.github+json", "User-Agent": "gamma-server"})
    with guarded_urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read(200_000).decode("utf-8"))
    tag = str(data.get("tag_name") or "")
    if not parse_version(tag):
        raise ValueError(f"unexpected release tag {tag!r}")
    return {"version": tag.lstrip("v"), "url": data.get("html_url") or RELEASES_PAGE,
            "published_at": data.get("published_at") or ""}


def latest_release(refresh: bool = False) -> tuple[dict | None, str]:
    """``(release, error)`` from the cache, fetched when stale or on
    ``refresh``. A failed fetch is remembered briefly so a dashboard left
    open does not hammer GitHub."""
    if not UPDATE_CHECK:
        return None, "the update check is switched off (GAMMA_UPDATE_CHECK)"
    with _lock:
        fresh = time.monotonic() - _cache["at"] < _cache["ttl"]
        if fresh and not refresh:
            return _cache["release"], _cache["error"]
        try:
            release, error, ttl = _fetch_latest(), "", _CACHE_OK_SECONDS
        except Exception as exc:  # noqa: BLE001 — any failure is just "could not check"
            release, error, ttl = _cache["release"], f"{type(exc).__name__}: {exc}"[:200], _CACHE_FAIL_SECONDS
        _cache.update({"at": time.monotonic(), "ttl": ttl, "release": release, "error": error})
        return release, error


def server_info(refresh: bool = False) -> dict:
    """Everything the admin dashboard shows: the build, uptime, log counts,
    the latest release and whether it is newer. ``update_available`` is
    None when this build carries no version to compare."""
    release, error = latest_release(refresh=refresh)
    mine, theirs = parse_version(VERSION), parse_version(release["version"]) if release else None
    return {
        "version": VERSION, "commit": COMMIT, "label": label(),
        "started_at": STARTED_AT.isoformat().replace("+00:00", "Z"),
        "uptime_seconds": int((datetime.now(timezone.utc) - STARTED_AT).total_seconds()),
        "python": platform.python_version(), "platform": f"{platform.system()} {platform.machine()}".strip(),
        "schema_version": db.SCHEMA_VERSION,
        "log_counts": log_counts(),
        "latest": release, "latest_error": error,
        "update_available": (theirs > mine) if (mine and theirs) else None,
        "image": IMAGE, "releases_url": RELEASES_PAGE,
        "frozen": bool(getattr(sys, "frozen", False)),
    }

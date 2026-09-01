"""Link previews (/api/link-preview): fetch a webpage's title server-side so
the frontend can render Notion-style link chips. Goes through the SSRF guard
like every other fetch of a user-supplied URL; results are cached in-process."""

import html
import re
import threading
import time
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException, Request

from ..auth import require_user
from ..net_guard import BlockedUrlError, guarded_urlopen

router = APIRouter(prefix="/api", tags=["links"])

_CACHE_TTL = 24 * 3600
_CACHE_MAX = 500
_MAX_READ = 131072  # titles live in the first chunk; don't stream whole pages
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()

_TITLE_RES = [
    re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']', re.I),
    re.compile(r"<title[^>]*>([^<]+)</title>", re.I),
]
# GitHub page titles carry boilerplate ("GitHub - owner/repo: desc", "· Issue
# #N · owner/repo · GitHub"); trim it so chips stay short.
_GITHUB_TRIMS = [
    (re.compile(r"^GitHub - "), ""),
    (re.compile(r" · GitHub$"), ""),
]


def _extract_title(text: str) -> str | None:
    for pattern in _TITLE_RES:
        m = pattern.search(text)
        if m:
            title = html.unescape(m.group(1)).strip()
            title = re.sub(r"\s+", " ", title)
            if title:
                return title[:300]
    return None


@router.get("/link-preview")
def link_preview(request: Request, url: str):
    require_user(request)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="not an http(s) URL")

    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]

    data = {"url": url, "host": parsed.hostname, "title": None}
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; Gamma link preview)",
            "Accept": "text/html,application/xhtml+xml",
        })
        with guarded_urlopen(req, timeout=8) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if "html" in ctype or "xml" in ctype:
                raw = resp.read(_MAX_READ)
                title = _extract_title(raw.decode("utf-8", "ignore"))
                if title and parsed.hostname.endswith("github.com"):
                    for pattern, repl in _GITHUB_TRIMS:
                        title = pattern.sub(repl, title)
                data["title"] = title
    except (BlockedUrlError, OSError, ValueError):
        pass  # unreachable/blocked pages still get a host-only chip

    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            oldest = min(_cache, key=lambda k: _cache[k][0])
            del _cache[oldest]
        _cache[url] = (now + _CACHE_TTL, data)
    return data

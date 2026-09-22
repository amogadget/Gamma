"""The agent's web reach: scholarly search and reading a document that is
not in the library (``search_papers`` / ``fetch_paper`` in ``ai_tools.py``).

Nothing here writes to a workspace. ``search_papers`` asks the keyless
registries the metadata lookup already uses (Crossref, arXiv — a bare DOI /
arXiv id is resolved directly). ``fetch_document`` turns a DOI, arXiv id or
URL into text: the PDF behind it through the resolver the extension and
"open a link" use (``routers.pdf.resolve_source`` — arXiv abs pages,
publisher ``citation_pdf_url`` tags, Unpaywall open-access fallback, the SSRF
guard), extracted page by page; when no PDF is reachable and the source is a
web page, its readable text instead. Fetched documents live in a small
in-memory cache so the model can read a long paper in successive windows
without re-downloading it — nothing is stored on disk and a restart forgets
everything.
"""

import html
import re
import threading
from urllib.parse import quote
from urllib.error import HTTPError, URLError
from urllib.request import Request as URLRequest

from fastapi import HTTPException

from .logbuf import log
from .net_guard import guarded_urlopen
from .pdf_text import extract_pages

SEARCH_LIMIT_DEFAULT = 8
SEARCH_LIMIT_MAX = 20
FETCH_MAX_BYTES = 40_000_000    # a PDF larger than this is refused, not read
HTML_MAX_BYTES = 2_000_000      # of a web page, before tag stripping
# The document cache: entries and total extracted chars kept in memory.
_CACHE_MAX_DOCS = 24
_CACHE_MAX_CHARS = 30_000_000

_DOI_RE = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)$", re.I)
_ARXIV_RE = re.compile(
    r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:\s*)?"
    r"([0-9]{4}\.[0-9]{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?/[0-9]{7})(?:v\d+)?(?:\.pdf)?$", re.I)

_cache: dict = {}        # resolved url → {"url", "kind", "title", "pages": [str]}
_aliases: dict = {}      # source string as given → resolved url
_cache_lock = threading.Lock()


class FetchError(Exception):
    """A document could not be fetched; the message is for the model."""


# ---------------------------------------------------------------- search

def identifier(text: str) -> tuple[str, str]:
    """``("doi", id)`` / ``("arxiv", id)`` when ``text`` is a bare or URL-form
    identifier, else ``("", "")``."""
    text = (text or "").strip().rstrip(".,;")
    m = _ARXIV_RE.match(text)
    if m:
        return "arxiv", m.group(1)
    m = _DOI_RE.match(text)
    if m:
        return "doi", m.group(1)
    return "", ""


def search_papers(query: str, limit: int = SEARCH_LIMIT_DEFAULT) -> list[dict]:
    """Records for a free-text query (Crossref and arXiv, interleaved in
    their own relevance order, duplicates by DOI / arXiv id / title
    dropped), or the one record of an identifier query."""
    # Local import: keep gamma.* module load free of the routers package.
    from .routers import metadata as registry

    limit = max(1, min(int(limit or SEARCH_LIMIT_DEFAULT), SEARCH_LIMIT_MAX))
    kind, ident = identifier(query)
    if kind == "arxiv":
        rec = registry._fetch_arxiv(ident)
        return [rec] if rec else []
    if kind == "doi":
        rec, _ = registry._fetch_doi(ident, with_bibtex=False)
        return [rec] if rec else []
    crossref = registry._crossref_search(query, rows=limit)
    arxiv = registry._arxiv_search(query, rows=limit)
    out: list[dict] = []
    seen: set = set()
    for a, b in zip(crossref + [None] * len(arxiv), arxiv + [None] * len(crossref)):
        for rec in (a, b):
            if not rec:
                continue
            keys = {k for k in (
                f"doi:{rec.get('doi', '').lower()}" if rec.get("doi") else "",
                f"arxiv:{rec.get('arxiv_id', '').lower()}" if rec.get("arxiv_id") else "",
                "title:" + re.sub(r"[^a-z0-9]+", "", rec.get("title", "").lower())[:80],
            ) if k and k != "title:"}
            if keys & seen:
                continue
            seen |= keys
            out.append(rec)
    return out[:limit]


def format_records(records: list[dict]) -> str:
    """One line per record — what the model reads — ending with the source
    string to hand fetch_paper."""
    lines = []
    for rec in records:
        authors = [a for a in rec.get("authors") or [] if a]
        who = ", ".join(authors[:3]) + (f" (+{len(authors) - 3})" if len(authors) > 3 else "")
        title = rec.get("title", "")
        url = (f"https://doi.org/{quote(rec['doi'], safe='/')}" if rec.get("doi") else
               f"https://arxiv.org/abs/{quote(rec['arxiv_id'], safe='/')}" if rec.get("arxiv_id") else "")
        # A ready-to-use title link keeps search recommendations actionable.
        label = re.sub(r"([\\\[\]])", r"\\\1", title).replace("\n", " ")
        heading = f"[{label}]({url})" if url else f'"{title}"'
        parts = [heading + (f" — {who}" if who else "")]
        when = ", ".join(p for p in (rec.get("year", ""), rec.get("venue", "")) if p)
        if when:
            parts[0] += f" ({when})"
        if rec.get("doi"):
            parts.append(f"doi:{rec['doi']}")
        if rec.get("arxiv_id"):
            parts.append(f"arXiv:{rec['arxiv_id']} (PDF: https://arxiv.org/pdf/{rec['arxiv_id']})")
        source = f"arXiv:{rec['arxiv_id']}" if rec.get("arxiv_id") else (
            f"doi:{rec['doi']}" if rec.get("doi") else "")
        if source:
            parts.append(f'→ fetch_paper(source="{source}")')
        lines.append("- " + " · ".join(parts))
    return "\n".join(lines)


# ----------------------------------------------------------------- fetch

def _read_bounded(url: str, cap: int, headers: dict, timeout: int = 30) -> tuple[str, str, bytes]:
    """``(final_url, content_type, body)`` through the SSRF guard, refusing
    bodies over ``cap`` bytes (by Content-Length up front, else while
    reading)."""
    req = URLRequest(url, headers=headers)
    with guarded_urlopen(req, timeout=timeout) as resp:
        ctype = (resp.headers.get("Content-Type") or "").lower()
        length = resp.headers.get("Content-Length")
        if length and length.isdigit() and int(length) > cap:
            raise FetchError(f"document too large ({int(length) // 1_000_000} MB, cap {cap // 1_000_000} MB)")
        chunks, total = [], 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                raise FetchError(f"document too large (over {cap // 1_000_000} MB)")
            chunks.append(chunk)
        return resp.geturl(), ctype, b"".join(chunks)


_BLOCK_TAG_RE = re.compile(
    r"</?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|"
    r"blockquote|pre|dd|dt|dl|figure|figcaption|main|nav|aside)\b[^>]*>", re.I)
_DROP_RE = re.compile(r"<(head|script|style|noscript|svg|template)\b.*?</\1\s*>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def html_text(raw: bytes, ctype: str = "") -> tuple[str, str]:
    """``(title, readable text)`` of an HTML page: scripts/styles dropped,
    block tags turned into line breaks, entities unescaped, whitespace
    collapsed. Deliberately simple — a paper's abstract page, not a news
    site's layout, is what the agent reads here."""
    m = re.search(r"charset=([\w-]+)", ctype or "")
    text = raw.decode(m.group(1) if m else "utf-8", "replace")
    title = _TITLE_RE.search(text)
    title = re.sub(r"\s+", " ", html.unescape(title.group(1))).strip() if title else ""
    text = _DROP_RE.sub(" ", text)
    text = _BLOCK_TAG_RE.sub("\n", text)
    text = html.unescape(_TAG_RE.sub(" ", text))
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return title, text


def _remember(source: str, doc: dict) -> dict:
    with _cache_lock:
        _cache.pop(doc["url"], None)
        _cache[doc["url"]] = doc
        _aliases[source] = doc["url"]
        total = sum(d["chars"] for d in _cache.values())
        while _cache and (len(_cache) > _CACHE_MAX_DOCS or total > _CACHE_MAX_CHARS):
            old = _cache.pop(next(iter(_cache)))  # insertion order = least recently used
            total -= old["chars"]
            for key in [k for k, v in _aliases.items() if v == old["url"]]:
                del _aliases[key]
    return doc


def cached(source: str) -> dict | None:
    with _cache_lock:
        url = _aliases.get(source) or source
        doc = _cache.get(url)
        if doc:  # LRU touch
            _cache.pop(url)
            _cache[url] = doc
        return doc


def _source_url(source: str) -> str:
    """The URL a non-PDF fallback fetches for a source string."""
    kind, ident = identifier(source)
    if kind == "doi":
        return f"https://doi.org/{ident}"
    if kind == "arxiv":
        return f"https://arxiv.org/abs/{ident}"
    return source if source.lower().startswith(("http://", "https://")) else ""


def fetch_document(source: str) -> dict:
    """The document behind ``source`` (a DOI, arXiv id or URL) as
    ``{"url", "kind": "pdf"|"html", "title", "pages": [text per page],
    "chars"}`` — from the cache when it was fetched before. Raises
    FetchError with a model-readable reason."""
    source = (source or "").strip()
    if not source:
        raise FetchError("empty source — pass a DOI, an arXiv id or an http(s) URL")
    doc = cached(source)
    if doc:
        return doc
    if not _source_url(source):
        raise FetchError("source must be a DOI (10.…), an arXiv id (2301.12345) or an http(s) URL")
    from .routers.pdf import BROWSER_HEADERS, resolve_source

    reason = ""
    try:
        pdf_url = resolve_source(source)["source_url"]
    except HTTPException as e:
        reason, pdf_url = str(e.detail), ""
    if pdf_url:
        try:
            final_url, ctype, data = _read_bounded(pdf_url, FETCH_MAX_BYTES, BROWSER_HEADERS)
        except FetchError:
            raise
        except HTTPError as e:
            raise FetchError(f"the PDF at {pdf_url} answered HTTP {e.code}")
        except (URLError, OSError, ValueError) as e:
            raise FetchError(f"could not fetch the PDF at {pdf_url}: {e}")
        if "application/pdf" in ctype or data[:5] == b"%PDF-":
            try:
                pages = extract_pages(data)
            except Exception as e:
                log.warning(f"[ai_web] extraction failed for {final_url}: {e}")
                raise FetchError(f"the PDF at {final_url} could not be read ({e})")
            if not any(p.strip() for p in pages):
                raise FetchError(f"the PDF at {final_url} has no text layer (a scan?)")
            return _remember(source, {"url": pdf_url, "kind": "pdf", "title": "",
                                      "pages": pages, "chars": sum(len(p) for p in pages)})
        reason = f"{pdf_url} is not a PDF ({ctype or 'no content type'})"
    # No PDF: the source's own page, if it is one, as readable text.
    page_url = _source_url(source)
    try:
        final_url, ctype, data = _read_bounded(page_url, HTML_MAX_BYTES, {
            **BROWSER_HEADERS, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"})
    except FetchError:
        raise
    except HTTPError as e:
        raise FetchError(f"no PDF ({reason}) and the page {page_url} answered HTTP {e.code}"
                         + (" — the site blocks server-side fetching" if e.code in (401, 403) else ""))
    except (URLError, OSError, ValueError) as e:
        raise FetchError(f"no PDF ({reason}) and {page_url} could not be fetched: {e}")
    if "html" not in ctype and "xml" not in ctype:
        raise FetchError(f"no PDF ({reason}) and {page_url} is not a web page ({ctype or 'no content type'})")
    title, text = html_text(data, ctype)
    if not text:
        raise FetchError(f"no PDF ({reason}) and the page {page_url} has no readable text")
    return _remember(source, {"url": final_url, "kind": "html", "title": title,
                              "pages": [text], "chars": len(text), "note": reason})


def window(doc: dict, limit: int, offset: int = 0, start_page: int = 1) -> tuple[str, int | None, int]:
    """``(text, next_offset, total)``: ``limit`` chars of the document from
    ``offset`` chars after the start of PDF page ``start_page`` (1-based; every
    page's text is prefixed ``[p. N]`` so the model can cite pages), the offset
    a follow-up read continues from (None = the document ended inside this
    window), and the total chars from start_page on."""
    pages = doc["pages"]
    start = max(1, min(start_page, len(pages)))
    if doc["kind"] == "pdf":
        full = "\n\n".join(f"[p. {n}]\n{t}" for n, t in enumerate(pages[start - 1:], start) if t.strip())
    else:
        full = "\n\n".join(pages)
    text = full[offset:offset + limit]
    next_offset = offset + limit if len(full) > offset + limit else None
    return text, next_offset, len(full)


def clear_cache():
    with _cache_lock:
        _cache.clear()
        _aliases.clear()

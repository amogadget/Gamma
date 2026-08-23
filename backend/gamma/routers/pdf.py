"""External PDF resolution and proxying (with optional local caching).

Resolution handles the common academic-link shapes: bare arXiv ids and DOIs
pasted without a URL are promoted to one first, arXiv abstract URLs are
rewritten to their PDF, DOI links that land on paywalled/bot-blocking publisher
pages fall back to an open-access copy via the Unpaywall API, and failures come
back as human-readable messages (publishers like APS return 403 to any
server-side fetch — that's their bot protection, not a bug here).
"""

import hashlib
import json
import re
import sqlite3
import urllib.parse
from urllib.error import HTTPError, URLError
from urllib.request import Request as URLRequest

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel

from .. import flatten_queue
from ..auth import require_user, resolve_user, share_scope_doc
from ..db import user_db_path, user_uploads_dir
from ..logbuf import log
from ..net_guard import guarded_urlopen
from ..server_settings import can_store

router = APIRouter(prefix="/api", tags=["pdf"])

# Identifier sent to Unpaywall's polite pool (its API requires an email
# parameter). A fixed project address — deliberately not configurable, so the
# open-access fallback needs zero setup.
CONTACT_EMAIL = "gamma-pdf-annotator@users.noreply.github.com"

# Realistic browser headers get past simple UA filters (many hosts 403 bare bots)
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

_ARXIV_ABS_RE = re.compile(r"arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)", re.I)
_ARXIV_DOI_RE = re.compile(r"10\.48550/arxiv\.([0-9]{4}\.[0-9]{4,5})", re.I)
_DOI_URL_RE = re.compile(r"(?:dx\.)?doi\.org/(10\.\d{4,9}/[^\s?#]+)", re.I)

# Bare identifiers pasted straight from a paper: "2301.12345" / "arXiv:2301.12345v2"
# (plus old-style "hep-th/9901001") and "10.1103/PhysRevLett…" / "doi:10.…".
_BARE_ARXIV_RE = re.compile(
    r"^(?:arxiv:\s*)?([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z][a-z-]*(?:\.[a-z]{2})?/[0-9]{7}(?:v\d+)?)$", re.I)
_BARE_DOI_RE = re.compile(r"^(?:doi:\s*)?(10\.\d{4,9}/\S+)$", re.I)


def _identifier_to_url(text: str) -> str:
    """Turn a pasted bare identifier into a fetchable URL: an arXiv id goes
    straight to its PDF, a DOI through doi.org (whose page then feeds the
    citation_pdf_url / Unpaywall fallbacks). URL-shaped input is untouched."""
    if "://" in text:
        return text
    m = _BARE_ARXIV_RE.match(text)
    if m:
        return f"https://arxiv.org/pdf/{m.group(1)}"
    m = _BARE_DOI_RE.match(text)
    if m:
        return f"https://doi.org/{m.group(1)}"
    return text


def _meta_content(html: str, name: str) -> str:
    """Value of a <meta name=... content=...> tag (either attribute order)."""
    m = re.search(rf'<meta[^>]+name=["\']{re.escape(name)}["\'][^>]*content=["\']([^"\']+)["\']', html, re.I)
    if not m:
        m = re.search(rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*name=["\']{re.escape(name)}["\']', html, re.I)
    return m.group(1).strip() if m else ""


def _open_access_pdf_for_doi(doi: str) -> tuple[str, str]:
    """(pdf_url, version) of the best legal open-access copy for a DOI, via
    Unpaywall. Prefers the published PDF over accepted manuscripts over
    preprints — repositories often only hold the submitted version."""
    try:
        url = f"https://api.unpaywall.org/v2/{urllib.parse.quote(doi)}?email={urllib.parse.quote(CONTACT_EMAIL)}"
        req = URLRequest(url, headers={"User-Agent": "gamma-pdf-annotator/1.0"})
        with guarded_urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        locs = [loc for loc in (data.get("oa_locations") or []) if loc.get("url_for_pdf")]
        order = {"publishedVersion": 0, "acceptedVersion": 1, "submittedVersion": 2}
        locs.sort(key=lambda loc: order.get(loc.get("version"), 3))
        if not locs:
            return "", ""
        return locs[0]["url_for_pdf"], locs[0].get("version") or ""
    except Exception as e:
        log.warning(f"[resolve-pdf] unpaywall lookup failed: {e}")
        return "", ""


class ResolvePdfRequest(BaseModel):
    source_url: str
    allow_oa: bool = True  # substitute an open-access copy when the publisher PDF is unavailable


# Plain `def` on purpose: FastAPI runs sync endpoints in its threadpool, so the
# (potentially slow) upstream fetches here don't block the event loop.
@router.post("/resolve-pdf")
def resolve_pdf(payload: ResolvePdfRequest, request: Request):
    require_user(request)
    url = _identifier_to_url((payload.source_url or "").strip())

    # arXiv abstract pages (and arXiv DOIs) go straight to the PDF
    m = _ARXIV_ABS_RE.search(url) or _ARXIV_DOI_RE.search(url)
    if m:
        url = f"https://arxiv.org/pdf/{m.group(1)}"

    def try_resolve(u: str):
        """(final_url, content_type, body). Body is only read for non-PDF
        responses (capped) so HTML pages can be inspected for PDF pointers."""
        req = URLRequest(u, headers=BROWSER_HEADERS)
        with guarded_urlopen(req, timeout=20) as resp:
            ctype = resp.headers.get("Content-Type", "").lower()
            body = b"" if "application/pdf" in ctype else resp.read(600_000)
            return resp.geturl(), ctype, body

    blocked = False
    content_type = ""
    final_url = url
    body = b""
    try:
        final_url, content_type, body = try_resolve(url)
        if "application/pdf" in content_type:
            return {"source_url": final_url}
    except HTTPError as e:
        if e.code not in (401, 403, 418, 429):
            raise HTTPException(status_code=400, detail=f"upstream HTTP error: {e.code}")
        blocked = True
    except URLError as e:
        raise HTTPException(status_code=400, detail=f"upstream URL error: {e.reason}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"resolve failed: {str(e)}")

    # Landed on an HTML article page (nature.com/articles/…, journal abstract
    # pages, …). Publishers advertise the "Download PDF" target in the
    # citation_pdf_url meta tag — the same tag Google Scholar reads.
    html = body.decode("utf-8", "replace") if body else ""
    if html:
        pdf_url = _meta_content(html, "citation_pdf_url")
        if pdf_url:
            pdf_url = urllib.parse.urljoin(final_url, pdf_url)
            try:
                _, ct2, _ = try_resolve(pdf_url)
                if "application/pdf" in ct2:
                    # Return the canonical URL, not the redirect target — hosts
                    # like nature.com append one-time tokens on redirect, and the
                    # doc id is a hash of this URL, so it must stay stable.
                    return {"source_url": pdf_url}
            except Exception as e:
                log.warning(f"[resolve-pdf] citation_pdf_url fetch failed: {e}")

    # For DOI links (or pages that state their DOI), the publisher PDF is
    # usually paywalled or bot-blocked — look for a legal open-access copy.
    doi_m = _DOI_URL_RE.search(url)
    doi = urllib.parse.unquote(doi_m.group(1)).rstrip(".,;") if doi_m else ""
    if not doi and html:
        doi = (_meta_content(html, "citation_doi") or _meta_content(html, "dc.identifier")).strip()
        doi = re.sub(r"^doi:\s*", "", doi, flags=re.I)
        if not re.match(r"^10\.\d{4,9}/", doi):
            doi = ""
    if doi:
        if not payload.allow_oa:
            raise HTTPException(
                status_code=400,
                detail="The publisher's PDF isn't accessible server-side (usually a paywall). "
                "Open-access fallback is disabled in your settings — download the PDF in "
                "your browser and drop it onto Gamma.",
            )
        oa_url, oa_version = _open_access_pdf_for_doi(doi)
        if oa_url:
            note = ""
            if oa_version and oa_version != "publishedVersion":
                pretty = {
                    "acceptedVersion": "accepted manuscript",
                    "submittedVersion": "preprint (submitted version)",
                }.get(oa_version, oa_version)
                note = (
                    f"The publisher's PDF is paywalled — loaded the open-access {pretty} instead. "
                    "For the published version, download it in your browser and replace the "
                    "source file via the page's source button."
                )
            try:
                final_url, content_type, _ = try_resolve(oa_url)
                if "application/pdf" in content_type:
                    return {"source_url": final_url, "note": note}
            except Exception:
                pass
            return {"source_url": oa_url, "note": note}  # let the proxy give it a try
        raise HTTPException(
            status_code=400,
            detail="This leads to a publisher page whose PDF isn't accessible server-side "
            "(usually a paywall), and no open-access copy was found. Open the link in your "
            "browser instead — if you can download the PDF there, drop the file onto Gamma.",
        )
    if blocked:
        raise HTTPException(
            status_code=400,
            detail="This site blocks server-side fetching. Download the PDF in your browser and drop it onto the page.",
        )
    raise HTTPException(
        status_code=400,
        detail=f"Couldn't find a PDF behind this link (got {content_type or 'no content type'}, "
        "and the page doesn't advertise a PDF). Download it in your browser and drop it onto Gamma.",
    )


def _share_allows_source(user: str, scope_doc_id: str, source_url: str) -> bool:
    """A share link may only proxy the exact source URL recorded on its own
    document's page block."""
    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        row = conn.execute(
            "SELECT json_extract(properties, '$.source_url'), "
            "json_extract(properties, '$.sourceUrl') FROM unified_blocks "
            "WHERE json_extract(properties, '$.doc_id') = ?",
            (scope_doc_id,),
        ).fetchone()
    return bool(row) and source_url in {v for v in row if v}


@router.get("/pdf")
def proxy_pdf(source_url: str, request: Request):
    user = resolve_user(request)
    scope = share_scope_doc(request)
    if scope is not None and not _share_allows_source(user, scope, source_url):
        raise HTTPException(status_code=403, detail="not accessible via this share link")
    uploads = user_uploads_dir(user)
    pdf_doc_id = hashlib.sha256(source_url.encode()).hexdigest()[:24]
    local_path = uploads / f"{pdf_doc_id}.pdf"
    want_save = request.query_params.get("save") == "1"

    # If a local copy exists, redirect to the uploads route (supports Range requests)
    if local_path.exists():
        return RedirectResponse(f"/api/uploads/{pdf_doc_id}.pdf", status_code=302)

    # Download from source. Streamed through to the client as upstream bytes
    # arrive — buffering the whole file first meant the browser saw zero bytes
    # (and no progress) until the entire upstream download finished, which on
    # a slow link looked like a hang.
    try:
        req = URLRequest(source_url, headers=BROWSER_HEADERS)
        resp = guarded_urlopen(req, timeout=30)
    except HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(
                status_code=400,
                detail="This site blocks server-side fetching. Please download the PDF in your browser and drop it onto the page.",
            )
        raise HTTPException(status_code=400, detail=f"upstream HTTP error: {e.code}")
    except URLError as e:
        raise HTTPException(status_code=400, detail=f"upstream URL error: {e.reason}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"pdf proxy failed: {str(e)}")

    content_type = resp.headers.get("Content-Type", "").lower()
    if "application/pdf" not in content_type:
        resp.close()
        raise HTTPException(status_code=400, detail=f"final URL is not a PDF: {content_type}")
    final_url = resp.geturl()
    length = resp.headers.get("Content-Length") or ""

    def stream():
        # Saving buffers chunks on the side and writes the file only after a
        # complete download — a client abort mid-stream must not leave a
        # truncated PDF in uploads (it would shadow the source forever).
        chunks = [] if want_save else None
        complete = False
        try:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    complete = True
                    break
                if chunks is not None:
                    chunks.append(chunk)
                yield chunk
        finally:
            resp.close()
            if chunks is not None and complete:
                data = b"".join(chunks)
                # best-effort cache: over the user's storage limits, just skip
                # the save — the PDF still streamed through fine
                if can_store(user, len(data)):
                    uploads.mkdir(parents=True, exist_ok=True)
                    local_path.write_bytes(data)
                    # Same treatment as a direct upload: MRC scans fetched from
                    # the web get a flattened copy in the background.
                    flatten_queue.schedule(user, local_path.stem)
                else:
                    log.info(f"[pdf] not caching {pdf_doc_id} ({len(data)} bytes): over storage limits")

    headers = {"Cache-Control": "public, max-age=3600", "X-Source-Url": final_url}
    if length.isdigit():
        headers["Content-Length"] = length
    return StreamingResponse(stream(), media_type="application/pdf", headers=headers)

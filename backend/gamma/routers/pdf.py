"""External PDF resolution and proxying (with optional local caching).

Resolution handles the common academic-link shapes: arXiv abstract URLs are
rewritten to their PDF, DOI links that land on paywalled/bot-blocking publisher
pages fall back to an open-access copy via the Unpaywall API, and failures come
back as human-readable messages (publishers like APS return 403 to any
server-side fetch — that's their bot protection, not a bug here).
"""

import hashlib
import json
import re
import urllib.parse
from urllib.error import HTTPError, URLError
from urllib.request import Request as URLRequest, urlopen

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel

from ..auth import require_user, resolve_user
from ..db import user_uploads_dir

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
        url = (f"https://api.unpaywall.org/v2/{urllib.parse.quote(doi)}"
               f"?email={urllib.parse.quote(CONTACT_EMAIL)}")
        req = URLRequest(url, headers={"User-Agent": "gamma-pdf-annotator/1.0"})
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        locs = [l for l in (data.get("oa_locations") or []) if l.get("url_for_pdf")]
        order = {"publishedVersion": 0, "acceptedVersion": 1, "submittedVersion": 2}
        locs.sort(key=lambda l: order.get(l.get("version"), 3))
        if not locs:
            return "", ""
        return locs[0]["url_for_pdf"], locs[0].get("version") or ""
    except Exception as e:
        print(f"[resolve-pdf] unpaywall lookup failed: {e}")
        return "", ""


class ResolvePdfRequest(BaseModel):
    source_url: str
    allow_oa: bool = True  # substitute an open-access copy when the publisher PDF is unavailable


# Plain `def` on purpose: FastAPI runs sync endpoints in its threadpool, so the
# (potentially slow) upstream fetches here don't block the event loop.
@router.post("/resolve-pdf")
def resolve_pdf(payload: ResolvePdfRequest, request: Request):
    require_user(request)
    url = (payload.source_url or "").strip()

    # arXiv abstract pages (and arXiv DOIs) go straight to the PDF
    m = _ARXIV_ABS_RE.search(url) or _ARXIV_DOI_RE.search(url)
    if m:
        url = f"https://arxiv.org/pdf/{m.group(1)}"

    def try_resolve(u: str):
        """(final_url, content_type, body). Body is only read for non-PDF
        responses (capped) so HTML pages can be inspected for PDF pointers."""
        req = URLRequest(u, headers=BROWSER_HEADERS)
        with urlopen(req, timeout=20) as resp:
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
                print(f"[resolve-pdf] citation_pdf_url fetch failed: {e}")

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
                pretty = {"acceptedVersion": "accepted manuscript",
                          "submittedVersion": "preprint (submitted version)"}.get(oa_version, oa_version)
                note = (f"The publisher's PDF is paywalled — loaded the open-access {pretty} instead. "
                        "For the published version, download it in your browser and replace the "
                        "source file via the page's source button.")
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
            detail="This site blocks server-side fetching. Download the PDF in your browser "
                   "and drop it onto the page.",
        )
    raise HTTPException(
        status_code=400,
        detail=f"Couldn't find a PDF behind this link (got {content_type or 'no content type'}, "
               "and the page doesn't advertise a PDF). Download it in your browser and drop it onto Gamma.")


@router.get("/pdf")
def proxy_pdf(source_url: str, request: Request):
    user = resolve_user(request)
    uploads = user_uploads_dir(user)
    pdf_doc_id = hashlib.sha256(source_url.encode()).hexdigest()[:24]
    local_path = uploads / f"{pdf_doc_id}.pdf"
    want_save = request.query_params.get("save") == "1"

    # If a local copy exists, redirect to the uploads route (supports Range requests)
    if local_path.exists():
        return RedirectResponse(f"/api/uploads/{pdf_doc_id}.pdf", status_code=302)

    # Download from source
    try:
        req = URLRequest(source_url, headers=BROWSER_HEADERS)
        with urlopen(req, timeout=30) as resp:
            final_url = resp.geturl()
            content_type = resp.headers.get("Content-Type", "").lower()
            data = resp.read()

        if "application/pdf" not in content_type:
            raise HTTPException(status_code=400, detail=f"final URL is not a PDF: {content_type}")

        if want_save:
            uploads.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(data)

        return Response(
            content=data,
            media_type="application/pdf",
            headers={
                "Cache-Control": "public, max-age=3600",
                "X-Source-Url": final_url,
            },
        )
    except HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(
                status_code=400,
                detail="This site blocks server-side fetching. Please download the PDF in your browser and drop it onto the page.",
            )
        raise HTTPException(status_code=400, detail=f"upstream HTTP error: {e.code}")
    except URLError as e:
        raise HTTPException(status_code=400, detail=f"upstream URL error: {e.reason}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"pdf proxy failed: {str(e)}")

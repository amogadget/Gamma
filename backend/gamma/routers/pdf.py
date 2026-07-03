"""External PDF resolution and proxying (with optional local caching)."""

import hashlib
from urllib.error import HTTPError, URLError
from urllib.request import Request as URLRequest, urlopen

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel

from ..auth import require_user, resolve_user
from ..db import user_uploads_dir

router = APIRouter(prefix="/api", tags=["pdf"])


class ResolvePdfRequest(BaseModel):
    source_url: str


@router.post("/resolve-pdf")
async def resolve_pdf(payload: ResolvePdfRequest, request: Request):
    require_user(request)
    try:
        req = URLRequest(
            payload.source_url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8",
            },
        )
        with urlopen(req, timeout=20) as resp:
            final_url = resp.geturl()
            content_type = resp.headers.get("Content-Type", "").lower()

        if "application/pdf" not in content_type:
            raise HTTPException(status_code=400, detail=f"final URL is not a PDF: {content_type}")

        return {"source_url": final_url}
    except HTTPError as e:
        raise HTTPException(status_code=400, detail=f"upstream HTTP error: {e.code}")
    except URLError as e:
        raise HTTPException(status_code=400, detail=f"upstream URL error: {e.reason}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"resolve failed: {str(e)}")


@router.get("/pdf")
async def proxy_pdf(source_url: str, request: Request):
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
        req = URLRequest(
            source_url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/pdf,*/*;q=0.8",
            },
        )
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

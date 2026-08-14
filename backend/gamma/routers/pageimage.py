"""Server-rendered page previews — a first-paint shortcut, not a viewer.

pdf.js is JavaScript; Chrome's own viewer is PDFium in C++, which is why it
feels instant and we do not. Opening a paper cold and jumping to page 30
measured 4.5-8 s before any text was on screen, most of it serial range
requests followed by a JS decode.

pdfium renders one page here in 11-51 ms, so the client can ask for a JPEG of
exactly the page it is about to show, paint that, and let pdf.js finish
underneath. The preview is thrown away the moment the real canvas paints — it
never participates in selection, search or highlight anchoring, all of which
stay on pdf.js.

Alignment is the thing that has to be exact or the swap visibly jumps. The
scale is derived from the page's own size, the same /MediaBox pdf.js measures
its viewport from (verified equal to six decimal places), so the image's aspect
matches the box it is dropped into and stretching it to 100%/100% is a no-op.
"""

import io
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from ..auth import resolve_user
from ..db import user_uploads_dir
from ..logbuf import log
from ..pdfium_lock import PDFIUM_LOCK
from ..storage import find_upload_file

router = APIRouter(prefix="/api", tags=["pageimage"])

WIDTHS = (960, 1280, 1600)  # only these, so the cache cannot be fanned out
MAX_PAGE = 5000
QUALITY = 72
CACHE_DIR_NAME = "pagecache"  # beside uploads/, NOT inside it: the orphan
# sweep walks uploads/ and would delete these
CACHE_BUDGET = 512 * 1024 * 1024  # per user; ~1700 pages at 300 KB


def _evict(root: Path):
    """Drop the least recently used previews once the budget is exceeded.

    Rebuildable data — a deleted entry costs one re-render (11-51 ms), so this
    is deliberately crude and only runs after a write.
    """
    try:
        files = [(f.stat().st_mtime, f.stat().st_size, f) for f in root.rglob("*.jpg") if f.is_file()]
    except OSError:
        return
    total = sum(s for _, s, _ in files)
    if total <= CACHE_BUDGET:
        return
    for _mt, size, f in sorted(files):  # oldest first
        try:
            f.unlink()
            total -= size
        except OSError:
            pass
        if total <= CACHE_BUDGET * 0.9:  # under with headroom, so this is rare
            break


def _cache_path(user: str, doc_id: str, page: int, width: int) -> Path:
    return user_uploads_dir(user).parent / CACHE_DIR_NAME / doc_id / f"{page}@{width}.jpg"


def _render(pdf_path: Path, page: int, width: int) -> bytes:
    import pypdfium2 as pdfium

    # Hold the lock only across the pdfium calls (open → render → to_pil).
    # The PIL JPEG encode is pure Pillow — it needs no pdfium, and keeping it
    # outside the lock lets previews serialize only the native part.
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(str(pdf_path))
        try:
            if page < 1 or page > len(doc):
                raise HTTPException(status_code=404, detail="page out of range")
            pg = doc[page - 1]
            w, _h = pg.get_size()
            if w <= 0:
                raise HTTPException(status_code=400, detail="bad page size")
            img = pg.render(scale=width / w).to_pil()
        finally:
            try:
                doc.close()
            except Exception:
                pass
    buf = io.BytesIO()
    img.convert("L" if img.mode in ("L", "1") else "RGB").save(buf, "JPEG", quality=QUALITY, optimize=True)
    return buf.getvalue()


def dims_path(user: str, doc_id: str) -> Path:
    return _cache_path(user, doc_id, 0, 0).with_name("dims.json")


def ensure_dims(user: str, doc_id: str, pdf_path) -> bool:
    """Compute and cache a document's page sizes. Safe to call repeatedly.

    Walking 332 pages costs ~1.2 s, which the first reader should not have to
    pay — the upload/flatten worker calls this so the file is ready before
    anyone opens it.
    """
    import json as _json
    import pypdfium2 as pdfium

    out = dims_path(user, doc_id)
    if out.exists():
        return True
    # The whole compute-and-write is atomic under the lock: two callers
    # (flatten worker + a page-dims request) could otherwise both see no
    # cache, both write the same `.part`, and one hits FileNotFoundError on
    # `tmp.replace`. Re-check inside the lock for the same reason.
    with PDFIUM_LOCK:
        if out.exists():
            return True
        try:
            doc = pdfium.PdfDocument(str(pdf_path))
            try:
                dims = [[round(v, 2) for v in doc[i].get_size()] for i in range(len(doc))]
            finally:
                try:
                    doc.close()
                except Exception:
                    pass
        except Exception as e:
            log.warning(f"[page-dims] {doc_id} failed: {e}")
            return False
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".part")
        tmp.write_text(_json.dumps({"pages": len(dims), "dims": dims}, separators=(",", ":")))
        tmp.replace(out)
        return True


@router.get("/page-dims/{doc_id}")
def page_dims(doc_id: str, request: Request):
    """Every page's size in PDF points, so the client can lay the document out
    before pdf.js has parsed anything.

    Otherwise the page boxes wait on the xref, the page tree, and eight serial
    getPage round trips — 2.5 s of blank screen on a cold open, and nowhere to
    put a preview until it finishes. This is one 0.4 KB gzipped response.

    It also makes every height exact from the first frame, which retires the
    estimate-then-refine loop and the layout churn it caused underneath a
    scroll restore.
    """
    user = resolve_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="not signed in")
    if not doc_id or not all(c in "0123456789abcdef-" for c in doc_id.replace("-flat", "")):
        raise HTTPException(status_code=400, detail="bad doc id")

    cached = dims_path(user, doc_id)
    if not cached.exists():
        pdf_path = find_upload_file(f"{doc_id}.pdf", request)
        if not pdf_path:
            raise HTTPException(status_code=404, detail="not found")
        if not ensure_dims(user, doc_id, pdf_path):
            raise HTTPException(status_code=500, detail="could not read page sizes")
    return FileResponse(
        cached, media_type="application/json", headers={"Cache-Control": "public, max-age=2592000, immutable"}
    )


# Sync def on purpose: rendering is CPU-bound, and FastAPI runs sync endpoints
# in its threadpool so a slow page cannot stall the event loop.
@router.get("/page-image/{doc_id}/{page}")
def page_image(doc_id: str, page: int, request: Request, w: int = 1280):
    user = resolve_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="not signed in")
    if not doc_id or not all(c in "0123456789abcdef-" for c in doc_id.replace("-flat", "")):
        raise HTTPException(status_code=400, detail="bad doc id")
    if page < 1 or page > MAX_PAGE:
        raise HTTPException(status_code=400, detail="bad page")
    width = min(WIDTHS, key=lambda x: abs(x - w))

    cached = _cache_path(user, doc_id, page, width)
    if not cached.exists():
        pdf_path = find_upload_file(f"{doc_id}.pdf", request)
        if not pdf_path:
            raise HTTPException(status_code=404, detail="not found")
        try:
            data = _render(Path(pdf_path), page, width)
        except HTTPException:
            raise
        except Exception as e:
            log.warning(f"[page-image] {doc_id} p{page} failed: {e}")
            raise HTTPException(status_code=500, detail="render failed")
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(cached)  # only ever served complete
        _evict(cached.parent.parent)

    # doc_id is a content hash and the width is one of a fixed set, so this
    # bitmap can never change meaning — cache it as hard as the uploads it
    # comes from.
    return FileResponse(
        cached, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=2592000, immutable"}
    )

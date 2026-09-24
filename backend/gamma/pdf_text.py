"""Shared PDF text extraction.

Platform provider first (pypdfium2 on desktop, gamma_ios_pdf on iOS), PyPDF2
fallback only when it can't open the file: an empty provider result is an answer
(scanned pages have no text layer for PyPDF2 to find either), not a failure.
Used by the AI context builder, metadata lookup, /pdf-text-status, and the
search indexer, so extraction fixes land once.
"""

import re
import io
import struct
import threading
import zlib

from .logbuf import log
from . import pdf_provider

# Sentinel the AI context builder hands to the model when extraction raised.
# Compare against the constant, never a rewritten literal.
PDF_EXTRACT_FAILED = "(PDF text extraction failed)"

# Hard ceiling on pages read from one PDF. Deliberately far above any real
# document: pages past the cap are invisible everywhere (not in the search
# index, not reachable by read_page) and look exactly like the end of the
# file, so a cap that actually bites silently hides content. It exists only
# to stop a pathological file from parsing forever.
MAX_PAGES = 5000

# pdfium is not thread-safe. Sync endpoints run in FastAPI's threadpool and the
# search indexer parses in a background thread, so two extractions can overlap
# — and when they do, pdfium fails BOTH with "Failed to load page", even for
# different files. Every extraction therefore goes through one lock; the AI
# context builder would otherwise hand the model "(PDF text extraction failed)"
# and it would answer from memory. Callers of iter_page_texts must hold it —
# extract_pages/extract_text/page_count do.
#
# The lock alone is not enough. pypdfium2 closes a page or document it still
# owns from a weakref finalizer, and its objects sit in reference cycles, so
# a page that was merely dropped is closed by the CYCLIC GC — later, on
# whatever thread happens to allocate (a sync round parsing JSON, a request
# handler), outside this lock, while another thread is inside pdfium. That
# is a native crash of the whole server (Windows exit 0x80000003), seen when
# an offline copy pulled a library of PDFs and their manifests were walked
# in the background. Two rules follow: every page/textpage/document made
# here is closed EXPLICITLY, inside the lock, as soon as it is done with
# (a closed object's finalizer is dead, the GC never touches pdfium for it);
# and, as a net under any object that still reaches a finalizer,
# pypdfium2's finalizer template is wrapped at import to take the same lock
# (_serialize_finalizers) — a finalizer on the walking thread re-enters the
# RLock, one on any other thread waits its turn.
_lock = threading.RLock()


def _serialize_finalizers() -> None:
    if pdf_provider.is_ios():
        return  # The native adapter owns its lifetimes; never import PDFium here.
    try:
        import pypdfium2.internal.bases as bases
    except Exception:  # noqa: BLE001 — pypdfium2 missing or reshaped: nothing to wrap
        return
    inner = getattr(bases, "_close_template", None)
    if inner is None or getattr(inner, "_gamma_locked", False):
        return

    def locked_close(*args, **kwargs):
        with _lock:
            return inner(*args, **kwargs)

    locked_close._gamma_locked = True
    bases._close_template = locked_close


_serialize_finalizers()


def _open(src):
    """Open a platform document, or PyPDF2 if the provider cannot read it.

    Empty text is not failure. On iOS only input/open errors permit fallback;
    a missing native bridge or programming error must not masquerade as a bad
    PDF. Desktop keeps its existing broad PDFium-open fallback.
    """
    ios = pdf_provider.is_ios()
    name = "gamma_ios_pdf" if ios else "pypdfium2"
    # Import/link failures on iOS are deployment errors, never PDF input errors.
    provider = pdf_provider.load_provider() if ios else None
    try:
        if provider is None:
            provider = pdf_provider.load_provider()
        return ("ios" if ios else "pdfium"), provider.PdfDocument(src)
    except Exception as e:
        if ios and not isinstance(e, (ValueError, OSError)):
            raise
        log.warning(f"[pdf-text] {name} open failed ({e}), falling back to PyPDF2")
        from PyPDF2 import PdfReader
        return "pypdf2", PdfReader(io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else str(src))


def _warn_truncated(total: int, max_pages: int):
    if total > max_pages:
        log.warning(f"[pdf-text] {total}-page PDF truncated to {max_pages} pages")


def iter_page_texts(src, max_pages: int = MAX_PAGES, start_page: int = 1):
    """Yield per-page text for pages ``start_page``..``max_pages`` (1-based).
    src is a path str or PDF bytes. Hold ``_lock`` while consuming this."""
    kind, pdf = _open(src)
    if kind == "pypdf2":
        _warn_truncated(len(pdf.pages), max_pages)
        for i, pg in enumerate(pdf.pages):
            if i >= max_pages:
                return
            if i + 1 < start_page:
                continue
            try:
                yield pg.extract_text() or ""
            except Exception:
                yield ""
        return
    try:
        _warn_truncated(len(pdf), max_pages)
        for i in range(max(0, start_page - 1), min(len(pdf), max_pages)):
            page = pdf[i]
            tp = page.get_textpage()
            try:
                yield tp.get_text_bounded() or ""
            finally:
                tp.close()
                page.close()
    finally:
        pdf.close()


def extract_pages(src, max_pages: int = MAX_PAGES) -> list[str]:
    """All page texts as a list (the search indexer's shape)."""
    with _lock:
        return list(iter_page_texts(src, max_pages))


def extract_text(src, char_limit: int, empty_page_cap: int = 50,
                 start_page: int = 1, label_pages: bool = False) -> str:
    """Concatenated text for AI context. Stops early once char_limit is
    gathered, or after empty_page_cap consecutive textless pages — a scanned
    book shouldn't cost a full parse just to learn it has no text.
    start_page (1-based) skips the pages before it, so a read can jump
    straight to where a search hit landed."""
    return extract_text_pages(src, char_limit, empty_page_cap, start_page, label_pages)[0]



PAGE_LABEL_RE = re.compile(r"(?m)^\[PDF page (\d+)\]\n")


def page_label(page_no, continued: bool = False) -> str:
    """The `[PDF page N]` line that heads a page's text in AI context (the
    model cites these physical numbers, never printed ones)."""
    return f"[PDF page {page_no}{'; continued' if continued else ''}]\n"

def extract_text_pages(src, char_limit: int, empty_page_cap: int = 50,
                       start_page: int = 1, label_pages: bool = False) -> tuple[str, int]:
    """extract_text plus how many PDF pages the text spans (counted from
    start_page, empty pages included) — what the chat's coverage report
    tells the user: "pages 1–9 of 22"."""
    parts, total, empties, pages = [], 0, 0, 0
    with _lock:
        for t in iter_page_texts(src, start_page=start_page):
            pages += 1
            if t.strip():
                empties = 0
                if label_pages:
                    t = page_label(start_page + pages - 1) + t
                parts.append(t)
                total += len(t)
                if total >= char_limit:
                    break
            else:
                empties += 1
                if empties >= empty_page_cap:
                    break
    return "\n\n".join(parts), pages


def page_sizes(src) -> list[tuple[float, float]]:
    """``(width, height)`` in PDF points of every page, rotation applied — the
    same box pdf.js measures its scale-1 viewport from, so a layout built
    from these is exact. Empty when the file is unreadable. No text
    extraction; holds the pdfium lock like every other walk."""
    with _lock:
        try:
            kind, pdf = _open(src)
            if kind == "pypdf2":
                out = []
                for pg in pdf.pages:
                    box = pg.mediabox
                    w, h = float(box.width), float(box.height)
                    if (int(pg.get("/Rotate") or 0) // 90) % 2:
                        w, h = h, w
                    out.append((w, h))
                return out
            try:
                out = []
                for i in range(len(pdf)):
                    page = pdf[i]
                    try:
                        out.append(tuple(page.get_size()))
                    finally:
                        page.close()
                return out
            finally:
                pdf.close()
        except Exception as e:
            log.warning(f"[pdf-text] page sizes failed: {e}")
            return []


def page_count(src) -> int:
    """How many pages a PDF has (0 = unreadable). No text extraction."""
    with _lock:
        try:
            kind, pdf = _open(src)
            if kind == "pypdf2":
                return len(pdf.pages)
            try:
                return len(pdf)
            finally:
                pdf.close()
        except Exception as e:
            log.warning(f"[pdf-text] page count failed: {e}")
            return 0


# Longest side, in pixels, of a page picture handed to a vision model (past
# ~1.6k px providers downscale anyway; below it small print gets unreadable).
RENDER_MAX_SIDE = 1568


def _png(width: int, height: int, channels: int, rows) -> bytes:
    """A plain PNG (8-bit RGB / RGBA, filter 0) — no Pillow needed."""
    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))
    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6 if channels == 4 else 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


def _encode_bitmap(bitmap) -> tuple[bytes, str]:
    """``(bytes, media type)`` of a rendered pdfium bitmap: JPEG through
    Pillow when it is installed (a scan is a photo — several times smaller),
    else a PNG written here."""
    try:
        from PIL import Image  # noqa: F401 — optional
    except ImportError:
        width, height, stride = bitmap.width, bitmap.height, bitmap.stride
        channels = bitmap.n_channels
        data = bytes(bitmap.buffer)
        rows = (data[y * stride:y * stride + width * channels] for y in range(height))
        return _png(width, height, channels, rows), "image/png"
    buf = io.BytesIO()
    bitmap.to_pil().convert("RGB").save(buf, "JPEG", quality=85)
    return buf.getvalue(), "image/jpeg"


def outline(src) -> list[tuple[int, str, int]]:
    """The PDF's own table of contents (its bookmarks) as ``(level, title,
    1-based page)`` in document order; entries without a page destination
    are skipped. [] when the file has none or can't be read."""
    with _lock:
        try:
            kind, pdf = _open(src)
            if kind == "pypdf2":
                return []
            try:
                entries = []
                for item in pdf.get_toc():
                    dest = item.get_dest()
                    index = dest.get_index() if dest else None
                    title = (item.get_title() or "").strip()
                    if index is not None and title:
                        entries.append((item.level, title, index + 1))
                return entries
            finally:
                pdf.close()
        except Exception as e:
            log.warning(f"[pdf-text] outline read failed: {e}")
            return []


# A cropped region is rendered sharper than a whole page (a formula is small),
# but never past this zoom — 4× = 288 dpi.
_CROP_MAX_SCALE = 4.0


def render_page(src, page_no: int, max_side: int = RENDER_MAX_SIDE, box=None):
    """Rasterize one page (1-based) for a vision model: ``(image, pages)``
    where image is ``(bytes, media_type, width, height)`` — the page scaled
    so its longer side is ``max_side`` px — or None when the page number is
    out of range; ``(None, 0)`` when the file can't be rendered (unreadable,
    or only PyPDF2 could open it). ``box`` = ``(x0, y0, x1, y1)`` as
    fractions of the page, top-left origin, renders just that region (its
    longer side at ``max_side`` px, zoom capped). Holds the pdfium lock like
    every walk."""
    with _lock:
        try:
            kind, pdf = _open(src)
            if kind == "pypdf2":
                return None, 0
            try:
                total = len(pdf)
                if page_no < 1 or page_no > total:
                    return None, total
                page = pdf[page_no - 1]
                try:
                    w, h = page.get_size()
                    crop = (0, 0, 0, 0)
                    scale = max_side / max(w, h, 1)
                    if box:
                        x0, y0, x1, y1 = box
                        # pdfium crops by the amount cut off each side
                        # (left, bottom, right, top) in PDF units.
                        crop = (x0 * w, (1 - y1) * h, (1 - x1) * w, y0 * h)
                        scale = min(max_side / max((x1 - x0) * w, (y1 - y0) * h, 1),
                                    _CROP_MAX_SCALE)
                    bitmap = page.render(scale=scale, crop=crop, rev_byteorder=True)
                    try:
                        data, media_type = _encode_bitmap(bitmap)
                        return (data, media_type, bitmap.width, bitmap.height), total
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            finally:
                pdf.close()
        except Exception as e:
            log.warning(f"[pdf-text] page render failed: {e}")
            return None, 0

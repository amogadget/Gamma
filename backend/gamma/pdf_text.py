"""Shared PDF text extraction.

pypdfium2 first (proper word spacing and unicode), PyPDF2 fallback — but only
when pdfium can't open the file at all: an empty pdfium result is an answer
(scanned pages have no text layer for PyPDF2 to find either), not a failure.
Used by the AI context builder, metadata lookup, /pdf-text-status, and the
search indexer, so extraction fixes land once.
"""

import io
import threading

from .logbuf import log
from .pdfium_lock import PDFIUM_LOCK

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
_lock = threading.RLock()


def iter_page_texts(src, max_pages: int = MAX_PAGES, start_page: int = 1):
    """Yield page text from ``start_page`` (1-based), capped by ``max_pages``.

    PDFium access is serialized by the fork-wide lock and converted to plain
    strings before yielding, so callers never hold the native library open.
    """
    try:
        import pypdfium2 as pdfium
    except Exception as error:
        log.warning(f"[pdf-text] pypdfium2 import failed ({error}), falling back to PyPDF2")
        pdfium = None
    if pdfium is not None:
        texts = None
        with PDFIUM_LOCK:
            try:
                pdf = pdfium.PdfDocument(src)
            except Exception as error:
                log.warning(f"[pdf-text] pypdfium2 open failed ({error}), falling back to PyPDF2")
                pdf = None
            if pdf is not None:
                texts = []
                try:
                    if len(pdf) > max_pages:
                        log.warning(f"[pdf-text] {len(pdf)}-page PDF truncated to {max_pages} pages")
                    for i in range(max(0, start_page - 1), min(len(pdf), max_pages)):
                        page = pdf[i]
                        text_page = page.get_textpage()
                        try:
                            texts.append(text_page.get_text_bounded() or "")
                        finally:
                            text_page.close()
                            page.close()
                finally:
                    pdf.close()
        if texts is not None:
            yield from texts
            return

    from PyPDF2 import PdfReader

    reader = PdfReader(io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else str(src))
    if len(reader.pages) > max_pages:
        log.warning(f"[pdf-text] {len(reader.pages)}-page PDF truncated to {max_pages} pages")
    for i, page in enumerate(reader.pages):
        if i >= max_pages:
            return
        if i + 1 < start_page:
            continue
        try:
            yield page.extract_text() or ""
        except Exception:
            yield ""


def extract_pages(src, max_pages: int = MAX_PAGES) -> list[str]:
    """All page texts as a list (the search indexer's shape)."""
    with _lock:
        return list(iter_page_texts(src, max_pages))


def extract_text(src, char_limit: int, empty_page_cap: int = 50,
                 start_page: int = 1) -> str:
    """Concatenated text for AI context. Stops early once char_limit is
    gathered, or after empty_page_cap consecutive textless pages — a scanned
    book shouldn't cost a full parse just to learn it has no text.
    start_page (1-based) skips the pages before it, so a read can jump
    straight to where a search hit landed."""
    parts, total, empties = [], 0, 0
    with _lock:
        for t in iter_page_texts(src, start_page=start_page):
            if t.strip():
                empties = 0
                parts.append(t)
                total += len(t)
                if total >= char_limit:
                    break
            else:
                empties += 1
                if empties >= empty_page_cap:
                    break
    return "\n\n".join(parts)


def page_count(src) -> int:
    """How many pages a PDF has (0 = unreadable). No text extraction."""
    with _lock:
        try:
            import pypdfium2 as pdfium
            with PDFIUM_LOCK:
                pdf = pdfium.PdfDocument(src)
                try:
                    return len(pdf)
                finally:
                    pdf.close()
        except Exception:
            try:
                from PyPDF2 import PdfReader
                return len(PdfReader(
                    io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else str(src)).pages)
            except Exception as e:
                log.warning(f"[pdf-text] page count failed: {e}")
                return 0

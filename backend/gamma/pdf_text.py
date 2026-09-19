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


def _open(src):
    """Open a PDF as ``("pdfium", doc)``, or ``("pypdf2", reader)`` when
    pdfium can't open the file at all. src is a path str or PDF bytes."""
    try:
        import pypdfium2 as pdfium
        return "pdfium", pdfium.PdfDocument(src)
    except Exception as e:
        log.warning(f"[pdf-text] pypdfium2 open failed ({e}), falling back to PyPDF2")
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
                    t = f"[PDF page {start_page + pages - 1}]\n{t}"
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
                return [tuple(pdf[i].get_size()) for i in range(len(pdf))]
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

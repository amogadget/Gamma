"""Shared PDF text extraction.

pypdfium2 first (proper word spacing and unicode), PyPDF2 fallback — but only
when pdfium can't open the file at all: an empty pdfium result is an answer
(scanned pages have no text layer for PyPDF2 to find either), not a failure.
Used by the AI context builder, metadata lookup, /pdf-text-status, and the
search indexer, so extraction fixes land once.
"""

import io

# Sentinel the AI context builder hands to the model when extraction raised.
# Compare against the constant, never a rewritten literal.
PDF_EXTRACT_FAILED = "(PDF text extraction failed)"


def iter_page_texts(src, max_pages: int = 400):
    """Yield per-page text (1-based order). src is a path str or PDF bytes."""
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(src)
    except Exception as e:
        print(f"[pdf-text] pypdfium2 open failed ({e}), falling back to PyPDF2")
        from PyPDF2 import PdfReader
        reader = PdfReader(io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else str(src))
        for i, pg in enumerate(reader.pages):
            if i >= max_pages:
                return
            try:
                yield pg.extract_text() or ""
            except Exception:
                yield ""
        return
    try:
        for i in range(min(len(pdf), max_pages)):
            page = pdf[i]
            tp = page.get_textpage()
            try:
                yield tp.get_text_bounded() or ""
            finally:
                tp.close()
                page.close()
    finally:
        pdf.close()


def extract_pages(src, max_pages: int = 400) -> list[str]:
    """All page texts as a list (the search indexer's shape)."""
    return list(iter_page_texts(src, max_pages))


def extract_text(src, char_limit: int, empty_page_cap: int = 50) -> str:
    """Concatenated text for AI context. Stops early once char_limit is
    gathered, or after empty_page_cap consecutive textless pages — a scanned
    book shouldn't cost a full parse just to learn it has no text."""
    parts, total, empties = [], 0, 0
    for t in iter_page_texts(src):
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

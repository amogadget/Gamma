"""A process-wide lock for pdfium (pypdfium2).

pdfium is NOT thread-safe. It is used from request threads (page previews,
text extraction) AND from background threads (the flatten worker, the search
indexer). When two threads touch pdfium at once the whole process dies with a
segfault, so every pdfium session goes through this lock.
"""

import threading

PDFIUM_LOCK = threading.Lock()

"""Read-only PDF provider selection; PDF writers remain PyPDF2 everywhere.

Only embedded iOS uses the PDFKit/CoreGraphics adapter. In particular, macOS
still uses real PDFium. Never register the native adapter as ``pypdfium2``:
its occupancy bounds are raster estimates, not PDFium object enumeration.
"""

import sys


def is_ios() -> bool:
    return sys.platform == "ios"


def load_provider():
    """Load the platform provider, lazily; injectable by tests without native code.

    A missing iOS bridge is an installation error, not an unreadable PDF. It
    must never cause a silent switch to PDFium or synthetic PDF information.
    """
    if is_ios():
        import gamma_ios_pdf
        return gamma_ios_pdf
    import pypdfium2
    return pypdfium2

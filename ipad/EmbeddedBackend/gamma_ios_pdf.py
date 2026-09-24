"""Explicit, read-only PDF provider for embedded CPython on iOS.

Requires the real ``_gamma_ios_pdf`` built-in extension. Import failure is an
error, not synthetic text/geometry. Backend selection belongs at the three
PDFium consumer sites under an explicit sys.platform == 'ios' branch; this
module does not patch sys.modules or replace any PDF writer.

Bridge contract: owning document capsule; zero-based pages; page_geometry ->
{crop: (left,bottom,right,top), rotation: 0|90|180|270, width, height}; render ->
{width,height,stride,n_channels:4,buffer:bytes}, top-down opaque RGBA. All native
PDFKit work/releases are serialized with a GIL-free native lock and pools.
Python views hold their document alive and become invalid on document close.
Bitmaps own detached bytes and can outlive documents. No native page/text
objects are retained by the views. Pillow is optional, imported only by to_pil.

Occupancy is a 512px raster estimate (8px cells + 1px expansion), NOT PDFium
object parity. Includes text, images, vector paths and nested forms, excludes
uniform edge-median background. Faint/subpixel content and edge-like imagery
can be missed. It cannot guarantee collision-free overlays; conservative cell
bounds reduce, but do not eliminate, that risk. Bounds are unrotated PDF user
coordinates including crop offsets; pdf_notes._frame applies display rotation.
No OCR, password unlock, annotation rendering, editing, or writing is offered.
"""
from __future__ import annotations

import math
import operator
import os

import _gamma_ios_pdf as _native

MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_RENDER_SIDE = 4096
MAX_RENDER_PIXELS = 8 * 1024 * 1024


class _Context:
    def __enter__(self):
        self._check()
        return self

    def __exit__(self, *_):
        self.close()


class PdfDocument(_Context):
    def __init__(self, source):
        self._handle = None
        if isinstance(source, (bytes, bytearray, memoryview)):
            if not 0 < memoryview(source).nbytes <= MAX_INPUT_BYTES:
                raise ValueError("PDF input exceeds 256 MiB limit or is empty")
            self._handle = _native.open_data(bytes(source))
        else:
            # bytes are PDF data, not filenames. Use a str/PathLike for paths.
            self._handle = _native.open_path(os.fspath(source))

    def _check(self):
        if self._handle is None:
            raise ValueError("PDF document is closed")
        return self._handle

    def __len__(self):
        return _native.page_count(self._check())

    def __getitem__(self, index):
        index = operator.index(index)
        if index < 0 or index >= len(self):
            raise IndexError("PDF page index out of range")
        return _Page(self, index)

    def get_toc(self):
        """Preorder bookmarks, with zero-based levels and page destinations."""
        return iter(_Bookmark(self, *entry) for entry in
                    _native.outline(self._check()))

    def close(self):
        handle = self._handle
        if handle is not None:
            # Native close is serialized and idempotent, including concurrent
            # readers. The capsule destructor is the fallback for unclosed docs.
            _native.close(handle)
            self._handle = None


class _Bookmark:
    def __init__(self, document, level, title, index):
        self._document, self.level, self._title, self._index = document, level, title, index

    def get_title(self):
        self._document._check()
        return self._title

    def get_dest(self):
        self._document._check()
        return self if self._index is not None else None

    def get_index(self):
        self._document._check()
        return self._index


class _Page(_Context):
    def __init__(self, document, index):
        self._document = document
        self._index = index

    def _check(self):
        if self._document is None:
            raise ValueError("PDF page is closed")
        return self._document._check()

    def close(self):
        self._document = None

    def get_size(self):
        info = _native.page_geometry(self._check(), self._index)
        return info["width"], info["height"]

    def get_textpage(self):
        self._check()
        return _TextPage(self)

    def render(self, scale=1, rev_byteorder=True, crop=(0, 0, 0, 0)):
        if rev_byteorder is not True:
            raise ValueError("gamma_ios_pdf exposes RGBA only (rev_byteorder=True)")
        scale = float(scale)
        if not math.isfinite(scale) or scale <= 0:
            raise ValueError("PDF render scale must be positive and finite")
        w, h = self.get_size()
        # Check before calling native; native independently enforces all caps.
        sw, sh = w * scale, h * scale
        if not math.isfinite(sw) or not math.isfinite(sh):
            raise ValueError("PDF raster exceeds pixel limit")
        crop = tuple(float(v) for v in crop)
        if len(crop) != 4 or any(not math.isfinite(v) or v < 0 for v in crop):
            raise ValueError("PDF crop must contain four finite nonnegative margins")
        left, bottom, right, top = crop
        if left + right >= w or bottom + top >= h:
            raise ValueError("PDF crop leaves no page area")
        margins = tuple(v * scale for v in crop)
        if any(not math.isfinite(v) for v in margins):
            raise ValueError("PDF raster exceeds pixel limit")
        # Match PDFium's rounding: ceil full dimensions and each margin.
        l, b, r, t = map(math.ceil, margins)
        width, height = math.ceil(sw) - l - r, math.ceil(sh) - b - t
        if (min(width, height) < 1 or max(width, height) > MAX_RENDER_SIDE
                or width * height > MAX_RENDER_PIXELS):
            raise ValueError("PDF raster exceeds pixel limit")
        if any(crop):
            return _Bitmap(_native.render(self._check(), self._index, scale, *crop))
        return _Bitmap(_native.render(self._check(), self._index, scale))

    def get_objects(self, max_depth=1):
        if max_depth != 1:
            raise ValueError("Only estimated page occupancy (max_depth=1) is supported")
        return iter(_OccupancyCell(bounds) for bounds in
                    _native.occupancy(self._check(), self._index))


class _TextPage(_Context):
    def __init__(self, page):
        self._page = page

    def _check(self):
        if self._page is None:
            raise ValueError("PDF text page is closed")
        return self._page._check()

    def get_text_bounded(self):
        return _native.page_text(self._check(), self._page._index)

    def close(self):
        self._page = None


class _OccupancyCell:
    def __init__(self, bounds):
        self._bounds = tuple(bounds)

    def get_bounds(self):
        return self._bounds


class _Bitmap(_Context):
    def __init__(self, raster):
        self.width = operator.index(raster["width"])
        self.height = operator.index(raster["height"])
        self.stride = operator.index(raster["stride"])
        self.n_channels = operator.index(raster["n_channels"])
        self.buffer = bytes(raster["buffer"])
        if (min(self.width, self.height) <= 0
                or max(self.width, self.height) > MAX_RENDER_SIDE
                or self.width * self.height > MAX_RENDER_PIXELS
                or self.n_channels != 4 or self.stride != self.width * 4
                or len(self.buffer) != self.stride * self.height):
            raise ValueError("Invalid native PDF RGBA buffer")

    def _check(self):
        if self.buffer is None:
            raise ValueError("PDF bitmap is closed")

    def to_pil(self):
        self._check()
        from PIL import Image
        return Image.frombytes("RGBA", (self.width, self.height), self.buffer,
                               "raw", "RGBA", self.stride, 1)

    def close(self):
        self.buffer = None

"""Burn Gamma highlight blocks into a PDF as standard /Highlight annotations,
so the exported file shows the highlights (with notes as annotation popups) in
Acrobat, SumatraPDF, Preview, browsers, etc.

Coordinate round-trip: the viewer stores rects in top-left-origin page-render
pixels together with the render size (``width``/``height``), i.e. effectively
normalized coordinates in pdf.js viewport space. pdf.js viewports are based on
the crop box and apply /Rotate, so the inverse mapping here must too. This is
the exact reverse of what routers/imports.py does when reading embedded
annotations (which come straight from PDF user space).

No appearance streams (/AP) are written — every mainstream viewer synthesizes
the marker look for /Highlight annotations from /QuadPoints + /C.
"""

import io
import re

from PyPDF2 import PdfReader, PdfWriter
from PyPDF2.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    TextStringObject,
)

_RGBA_RE = re.compile(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)")
_HEX_RE = re.compile(r"#([0-9a-fA-F]{6})$")
DEFAULT_COLOR = (1.0, 226 / 255, 143 / 255, 0.65)  # the viewer's yellow


def parse_css_color(value):
    """CSS color string (as stored on highlight blocks) → (r, g, b, alpha) in 0..1."""
    m = _RGBA_RE.match((value or "").strip())
    if m:
        r, g, b = (min(int(v), 255) / 255 for v in m.groups()[:3])
        a = min(float(m.group(4)), 1.0) if m.group(4) else 1.0
        return (r, g, b, a)
    m = _HEX_RE.match((value or "").strip())
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)) + (1.0,)
    return DEFAULT_COLOR


def _viewer_rect_to_pdf(rect, rotation, crop):
    """One stored viewer rect → (x1, y1, x2, y2) in PDF user space (bottom-left
    origin). ``crop`` is (cx0, cy0, cx1, cy1); ``rotation`` a multiple of 90."""
    cx0, cy0, cx1, cy1 = crop
    cw, ch = cx1 - cx0, cy1 - cy0
    w = float(rect.get("width") or 0) or 1.0
    h = float(rect.get("height") or 0) or 1.0
    pts = []
    for vx, vy in ((rect["x1"], rect["y1"]), (rect["x2"], rect["y2"])):
        u, v = float(vx) / w, float(vy) / h  # normalized, v measured from the top
        if rotation == 90:
            px, py = cx0 + v * cw, cy0 + u * ch
        elif rotation == 180:
            px, py = cx1 - u * cw, cy0 + v * ch
        elif rotation == 270:
            px, py = cx1 - v * cw, cy1 - u * ch
        else:
            px, py = cx0 + u * cw, cy1 - v * ch
        pts.append((px, py))
    (ax, ay), (bx, by) = pts
    return (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))


def _highlight_annotation(rects, color, note, author):
    r, g, b, alpha = color
    quads, xs, ys = [], [], []
    for x1, y1, x2, y2 in rects:
        # Quad order: upper-left, upper-right, lower-left, lower-right.
        quads.extend((x1, y2, x2, y2, x1, y1, x2, y1))
        xs.extend((x1, x2))
        ys.extend((y1, y2))
    annot = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Highlight"),
        NameObject("/Rect"): ArrayObject(
            FloatObject(v) for v in (min(xs), min(ys), max(xs), max(ys))
        ),
        NameObject("/QuadPoints"): ArrayObject(FloatObject(v) for v in quads),
        NameObject("/C"): ArrayObject((FloatObject(r), FloatObject(g), FloatObject(b))),
        NameObject("/CA"): FloatObject(round(alpha, 3)),
        NameObject("/F"): NumberObject(4),  # print
    })
    if note:
        annot[NameObject("/Contents")] = TextStringObject(note)
    if author:
        annot[NameObject("/T")] = TextStringObject(author)
    return annot


def highlight_note_text(block, children_by_id):
    """The annotation popup text: the highlight's own comment plus its nested
    notes as an indented bullet list."""

    def walk(bid, depth):
        lines = []
        for child in children_by_id.get(bid, []):
            text = (child.get("content") or "").strip()
            if text:
                lines.append("  " * depth + "- " + text)
            lines.extend(walk(child["id"], depth + 1))
        return lines

    parts = []
    own = (block.get("content") or "").strip()
    if own:
        parts.append(own)
    parts.extend(walk(block["id"], 0))
    return "\n".join(parts)


def annotate_pdf(pdf_bytes: bytes, highlights, author: str = "") -> tuple[bytes, int]:
    """Return (annotated pdf bytes, number of annotations written).

    ``highlights``: [{position: <pdf_position dict>, color: <css string>,
    note: <str>}]. Positions with no usable rects or an out-of-range page are
    skipped rather than failing the whole export.
    """
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    writer.append(reader)

    written = 0
    for h in highlights:
        pos = h.get("position") or {}
        page_num = pos.get("pageNumber") or (pos.get("boundingRect") or {}).get("pageNumber")
        if not page_num or page_num < 1 or page_num > len(writer.pages):
            continue
        viewer_rects = pos.get("rects") or ([pos["boundingRect"]] if pos.get("boundingRect") else [])
        viewer_rects = [r for r in viewer_rects if r and r.get("x1") is not None]
        if not viewer_rects:
            continue
        page = writer.pages[page_num - 1]
        crop = tuple(float(v) for v in (page.cropbox.left, page.cropbox.bottom,
                                        page.cropbox.right, page.cropbox.top))
        try:
            rotation = int(page.rotation) % 360
        except Exception:
            rotation = 0
        pdf_rects = [_viewer_rect_to_pdf(r, rotation, crop) for r in viewer_rects]
        annot = _highlight_annotation(pdf_rects, parse_css_color(h.get("color")),
                                      h.get("note") or "", author)
        writer.add_annotation(page_number=page_num - 1, annotation=annot)
        written += 1

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue(), written
